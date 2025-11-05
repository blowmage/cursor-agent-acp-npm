/**
 * Prompt Processing Handler
 *
 * Handles ACP prompt requests, content processing, and streaming responses.
 * This module manages the core conversation flow between ACP clients and Cursor CLI.
 */

import {
  ProtocolError,
  SessionError,
  type AcpRequest,
  type AcpResponse,
  type SessionPromptParams,
  type ContentBlock,
  type ConversationMessage,
  type StreamChunk,
  type StreamProgress,
  type Logger,
  type AdapterConfig,
} from '../types';
import type { SessionManager } from '../session/manager';
import type { CursorCliBridge } from '../cursor/cli-bridge';
import { ContentProcessor } from './content';

export interface PromptHandlerOptions {
  sessionManager: SessionManager;
  cursorBridge: CursorCliBridge;
  config: AdapterConfig;
  logger: Logger;
  sendNotification: (notification: import('../types').AcpNotification) => void;
}

export interface StreamOptions {
  enabled: boolean;
  chunkSize?: number;
  progressCallback?: (progress: StreamProgress) => void;
}

export class PromptHandler {
  private readonly sessionManager: SessionManager;
  private readonly cursorBridge: CursorCliBridge;
  private readonly contentProcessor: ContentProcessor;
  private readonly config: AdapterConfig;
  private readonly logger: Logger;
  private readonly activeStreams = new Map<string, AbortController>();
  // Per-session request queue to serialize concurrent requests to the same session
  private readonly sessionQueues = new Map<string, Promise<any>>();
  // Track all active abort controllers per session for cancellation
  private readonly activeSessionRequests = new Map<
    string,
    Set<AbortController>
  >();
  private readonly sendNotification: (
    notification: import('../types').AcpNotification
  ) => void;

  constructor(options: PromptHandlerOptions) {
    this.sessionManager = options.sessionManager;
    this.cursorBridge = options.cursorBridge;
    this.config = options.config;
    this.logger = options.logger;
    this.sendNotification = options.sendNotification;
    this.contentProcessor = new ContentProcessor({
      config: this.config,
      logger: this.logger,
    });
  }

  /**
   * Returns a random element from an array
   */
  private getRandomTitle(): string {
    const titles = [
      'Crunching the numbers (and my will to live)...',
      'Hold on, consulting the magic 8-ball...',
      'Doing the thing...',
      'Asking the hamsters to run faster...',
      'Spinning up the chaos engines...',
      'Bribing the servers...',
      'Waking up the code gremlins...',
      'Sacrificing a rubber duck to the programming gods...',
      'Convincing the database to cooperate...',
      'Rolling the dice...',
      'Summoning the data from the void...',
      'Teaching the robots to behave...',
      'Turning it off and on again...',
      'Threatening the API with a timeout...',
      'Hoping this works...',
      'Doing some wizardry...',
      'Making the computers think harder...',
    ];
    return titles[Math.floor(Math.random() * titles.length)]!;
  }

  /**
   * Process a session/prompt request
   * Per ACP spec: Process prompt and return stopReason when complete.
   * Send session/update notifications during processing.
   */
  async processPrompt(request: AcpRequest): Promise<AcpResponse> {
    const { id, params } = request;

    try {
      // Validate request parameters
      const promptParams = this.validatePromptParams(params);

      this.logger.debug('Processing prompt request', {
        sessionId: promptParams.sessionId,
        contentBlocks: promptParams.content.length,
        streaming: promptParams.stream,
      });

      // Queue requests per session to prevent concurrent Cursor CLI calls
      // to the same session which can cause hangs/timeouts
      const sessionId = promptParams.sessionId;
      const existingQueue = this.sessionQueues.get(sessionId);

      const processRequest = async (): Promise<AcpResponse> => {
        // Load session to ensure it exists and is valid
        await this.sessionManager.loadSession(sessionId);

        // Mark session as processing to prevent cleanup during long-running operations
        this.sessionManager.markSessionProcessing(sessionId);

        // Create a unique tool call ID for tracking this prompt processing
        const processingToolCallId = `processing_${id}`;
        let heartbeatCount = 0;

        // Send initial tool call to indicate processing has started
        // Per ACP spec: Tool calls provide real-time feedback about execution progress
        // This prevents the client from assuming the agent is unresponsive
        this.sendNotification({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: promptParams.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: processingToolCallId,
              title: this.getRandomTitle(),
              kind: 'other',
              status: 'in_progress',
            },
          },
        });

        // Set up periodic heartbeat to keep client aware of ongoing activity
        // Updates the tool call with progress messages every 12 seconds
        // Also updates session activity to prevent expiration during long-running operations
        const heartbeatInterval = setInterval(async () => {
          heartbeatCount++;
          const elapsed = heartbeatCount * 12;

          // Update session activity to prevent expiration during processing
          try {
            // Touch the session to update lastActivity without changing metadata
            await this.sessionManager.updateSession(sessionId, {});
          } catch (error) {
            // If session no longer exists, stop heartbeat
            this.logger.warn('Session not found during heartbeat', {
              sessionId,
              error: error instanceof Error ? error.message : String(error),
            });
            clearInterval(heartbeatInterval);
            return;
          }

          this.sendNotification({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: promptParams.sessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: processingToolCallId,
                title: `Processing your request... (${elapsed}s)`,
                status: 'in_progress',
              },
            },
          });
        }, 12000); // 12 seconds

        try {
          // Process and AWAIT completion to get stopReason
          // This sends additional session/update notifications during processing
          let stopReason: string;

          if (promptParams.stream) {
            stopReason = await this.processStreamingPromptAsync(
              promptParams,
              id.toString()
            );
          } else {
            stopReason = await this.processRegularPromptAsync(promptParams);
          }

          // Mark the processing tool call as completed
          this.sendNotification({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: promptParams.sessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: processingToolCallId,
                title: 'Request completed',
                status: 'completed',
              },
            },
          });

          return {
            jsonrpc: '2.0' as const,
            id,
            result: {
              stopReason,
            },
          };
        } catch (error) {
          // Mark the processing tool call as failed if an error occurs
          this.sendNotification({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: promptParams.sessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: processingToolCallId,
                title: 'Processing failed',
                status: 'failed',
              },
            },
          });
          throw error;
        } finally {
          // Always clear the heartbeat interval
          clearInterval(heartbeatInterval);
          // Always unmark session as processing
          this.sessionManager.unmarkSessionProcessing(sessionId);
        }
      };

      // Chain this request after any existing queue for this session
      const queuedRequest = existingQueue
        ? existingQueue
            .then(() => processRequest())
            .catch((err) => {
              // Log error from previous request but continue processing this one
              this.logger.debug(
                'Previous queued request failed, continuing with next',
                {
                  sessionId,
                  error: err instanceof Error ? err.message : String(err),
                }
              );
              return processRequest();
            })
            .finally(() => {
              // Remove from queue when done (only if we're still the head of queue)
              const currentQueue = this.sessionQueues.get(sessionId);
              if (currentQueue === queuedRequest) {
                this.sessionQueues.delete(sessionId);
                this.logger.debug('Session queue cleared', { sessionId });
              }
            })
        : processRequest().finally(() => {
            // Remove from queue when done (only if we're still the head of queue)
            const currentQueue = this.sessionQueues.get(sessionId);
            if (currentQueue === queuedRequest) {
              this.sessionQueues.delete(sessionId);
              this.logger.debug('Session queue cleared', { sessionId });
            }
          });

      // Update the queue
      this.sessionQueues.set(sessionId, queuedRequest);

      // Wait for our turn and execute
      return await queuedRequest;
    } catch (error) {
      this.logger.error('Error processing prompt request', {
        error,
        requestId: id,
      });

      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: error instanceof SessionError ? -32001 : -32603,
          message: error instanceof Error ? error.message : 'Unknown error',
          data:
            error instanceof Error
              ? { name: error.name, stack: error.stack }
              : undefined,
        },
      };
    }
  }

  /**
   * Process a regular (non-streaming) prompt asynchronously
   * Sends session/update notifications as content is processed
   * Returns stopReason when complete
   */
  private async processRegularPromptAsync(
    params: SessionPromptParams
  ): Promise<string> {
    const { sessionId, content, metadata } = params;

    try {
      // Load session to get working directory
      const session = await this.sessionManager.loadSession(sessionId);
      const workingDir =
        (session.metadata['cwd'] as string | undefined) || process.cwd();

      this.logger.debug('Processing prompt with working directory', {
        sessionId,
        cwd: workingDir,
      });

      // Add user message to session
      const userMessage: ConversationMessage = {
        id: this.generateMessageId(),
        role: 'user',
        content,
        timestamp: new Date(),
        metadata: metadata || {},
      };

      await this.sessionManager.addMessage(sessionId, userMessage);

      // Process content blocks and prepare for Cursor CLI
      const processedContent =
        await this.contentProcessor.processContent(content);

      // Send to Cursor CLI with working directory
      const cursorResponse = await this.cursorBridge.sendPrompt({
        sessionId,
        content: processedContent,
        metadata: { ...metadata, cwd: workingDir },
      });

      if (!cursorResponse.success) {
        throw new ProtocolError(
          `Cursor CLI error: ${cursorResponse.error || 'Unknown error'}`
        );
      }

      // Process Cursor's response content
      const responseContent = await this.contentProcessor.parseResponse(
        cursorResponse.stdout || ''
      );

      // Add assistant message to session
      const assistantMessage: ConversationMessage = {
        id: this.generateMessageId(),
        role: 'assistant',
        content: responseContent,
        timestamp: new Date(),
        metadata: cursorResponse.metadata || {},
      };

      await this.sessionManager.addMessage(sessionId, assistantMessage);

      // Send content via session/update notifications (per ACP spec)
      // Each agent_message_chunk contains a single ContentBlock
      for (const block of responseContent) {
        const acpContent = this.convertContentBlockToAcp(block);
        this.sendNotification({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: acpContent,
            },
          },
        });
      }

      // Return stopReason - the response will include this
      // No need to send a separate completion notification
      this.logger.debug('Regular prompt processing complete', { sessionId });
      return 'end_turn';
    } catch (error) {
      this.logger.error('Error in regular prompt processing', {
        error,
        sessionId,
      });
      // Return appropriate stopReason based on error
      return 'refusal';
    }
  }

  /**
   * Process a streaming prompt asynchronously
   * Sends session/update notifications as chunks arrive
   * Returns stopReason when complete
   */
  private async processStreamingPromptAsync(
    params: SessionPromptParams,
    requestId: string
  ): Promise<string> {
    const { sessionId, content, metadata } = params;

    // Create abort controller for this stream
    const abortController = new AbortController();
    this.activeStreams.set(requestId, abortController);

    // Track this controller per session for cancellation
    if (!this.activeSessionRequests.has(sessionId)) {
      this.activeSessionRequests.set(sessionId, new Set());
    }
    this.activeSessionRequests.get(sessionId)!.add(abortController);

    try {
      // Load session to get working directory
      const session = await this.sessionManager.loadSession(sessionId);
      const workingDir =
        (session.metadata['cwd'] as string | undefined) || process.cwd();

      this.logger.debug('Processing streaming prompt with working directory', {
        sessionId,
        cwd: workingDir,
      });

      // Add user message to session
      const userMessage: ConversationMessage = {
        id: this.generateMessageId(),
        role: 'user',
        content,
        timestamp: new Date(),
        ...(metadata !== undefined && { metadata }),
      };

      await this.sessionManager.addMessage(sessionId, userMessage);

      // Process content blocks
      const processedContent =
        await this.contentProcessor.processContent(content);

      // Start streaming response
      const responseContent: ContentBlock[] = [];
      const assistantMessageId = this.generateMessageId();

      // Initialize streaming state in content processor
      this.contentProcessor.startStreaming();

      // Send streaming request to Cursor CLI with working directory
      const streamResponse = await this.cursorBridge.sendStreamingPrompt({
        sessionId,
        content: processedContent,
        ...(metadata !== undefined && {
          metadata: { ...metadata, cwd: workingDir },
        }),
        abortSignal: abortController.signal,
        onChunk: async (chunk: StreamChunk) => {
          if (chunk.type === 'content') {
            // Process chunk - may return null for partial blocks
            const contentBlock = await this.contentProcessor.processStreamChunk(
              chunk.data
            );

            if (contentBlock) {
              responseContent.push(contentBlock);
              this.logger.debug('Streaming chunk processed', {
                type: contentBlock.type,
                size: this.getContentSize(contentBlock),
              });

              // Send notification immediately for each chunk (per ACP spec)
              // Each agent_message_chunk contains a single ContentBlock
              const acpContent = this.convertContentBlockToAcp(contentBlock);
              this.sendNotification({
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                  sessionId,
                  update: {
                    sessionUpdate: 'agent_message_chunk',
                    content: acpContent,
                  },
                },
              });
            }
          } else if (chunk.type === 'error') {
            throw new ProtocolError(`Stream error: ${chunk.data}`);
          }
        },
        onProgress: (progress: StreamProgress) => {
          this.logger.debug('Stream progress', progress);
        },
      });

      // Finalize streaming to flush any remaining partial content
      const finalBlock = this.contentProcessor.finalizeStreaming();
      if (finalBlock) {
        responseContent.push(finalBlock);
        const acpContent = this.convertContentBlockToAcp(finalBlock);
        this.sendNotification({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: acpContent,
            },
          },
        });
      }

      if (!streamResponse.success) {
        throw new ProtocolError(
          `Streaming error: ${streamResponse.error || 'Unknown error'}`
        );
      }

      // Add final assistant message to session
      const assistantMessage: ConversationMessage = {
        id: assistantMessageId,
        role: 'assistant',
        content: responseContent,
        timestamp: new Date(),
        ...(streamResponse.metadata !== undefined && {
          metadata: streamResponse.metadata,
        }),
      };

      await this.sessionManager.addMessage(sessionId, assistantMessage);

      // Return stopReason - the response will include this
      // No need to send a separate completion notification
      this.logger.debug('Streaming prompt processing complete', { sessionId });
      return 'end_turn';
    } catch (error) {
      this.logger.error('Error in streaming prompt processing', {
        error,
        sessionId,
      });

      // Check if cancelled via abort signal
      if (abortController.signal.aborted) {
        return 'cancelled';
      }

      // Return appropriate stopReason based on error
      return 'refusal';
    } finally {
      // Clean up stream tracking
      this.activeStreams.delete(requestId);

      // Clean up session request tracking
      const controllers = this.activeSessionRequests.get(sessionId);
      if (controllers) {
        controllers.delete(abortController);
        if (controllers.size === 0) {
          this.activeSessionRequests.delete(sessionId);
        }
      }
    }
  }

  /**
   * Cancel an active streaming request
   */
  async cancelStream(requestId: string): Promise<boolean> {
    const controller = this.activeStreams.get(requestId);
    if (controller) {
      controller.abort();
      this.activeStreams.delete(requestId);
      this.logger.debug('Stream cancelled', { requestId });
      return true;
    }
    return false;
  }

  /**
   * Cancel all active requests for a session
   * Per ACP spec: Agent MUST stop all operations for the session
   */
  async cancelSession(sessionId: string): Promise<void> {
    this.logger.info('Cancelling all requests for session', { sessionId });

    // Get all abort controllers for this session
    const controllers = this.activeSessionRequests.get(sessionId);
    if (controllers && controllers.size > 0) {
      this.logger.debug('Aborting session requests', {
        sessionId,
        count: controllers.size,
      });

      // Abort all controllers
      controllers.forEach((controller) => {
        controller.abort();
      });

      // Clear the set
      controllers.clear();
      this.activeSessionRequests.delete(sessionId);

      this.logger.info('Session requests cancelled', { sessionId });
    } else {
      this.logger.debug('No active requests found for session', { sessionId });
    }
  }

  /**
   * Get active stream count
   */
  getActiveStreamCount(): number {
    return this.activeStreams.size;
  }

  /**
   * Validate prompt parameters
   */
  private validatePromptParams(params: any): SessionPromptParams {
    if (!params || typeof params !== 'object') {
      throw new ProtocolError('Invalid prompt parameters');
    }

    const { sessionId, content, prompt, stream, metadata } = params;

    if (!sessionId || typeof sessionId !== 'string') {
      throw new ProtocolError('sessionId is required and must be a string');
    }

    // Accept both 'content' and 'prompt' field names for compatibility
    // Zed uses 'prompt', but we normalize it to 'content' internally
    const contentArray = content || prompt;

    if (!Array.isArray(contentArray) || contentArray.length === 0) {
      throw new ProtocolError(
        'content/prompt is required and must be a non-empty array'
      );
    }

    // Validate content blocks
    for (const block of contentArray) {
      if (!this.isValidContentBlock(block)) {
        throw new ProtocolError(
          `Invalid content block: ${JSON.stringify(block)}`
        );
      }
    }

    return {
      sessionId,
      content: contentArray, // Normalize to 'content' internally
      stream: Boolean(stream),
      metadata: metadata || {},
    };
  }

  /**
   * Check if content block is valid
   * Accepts both old format (text/code/data) and new format (value)
   */
  private isValidContentBlock(block: any): block is ContentBlock {
    if (!block || typeof block !== 'object' || !block.type) {
      return false;
    }

    switch (block.type) {
      case 'text':
        // Accept both 'text' (from Zed) and 'value' (ACP spec) fields
        return (
          typeof block.text === 'string' || typeof block.value === 'string'
        );
      case 'code':
        // Accept both 'code' (from Zed) and 'value' (ACP spec) fields
        return (
          typeof block.code === 'string' || typeof block.value === 'string'
        );
      case 'image':
        // Accept both 'data' (from Zed) and 'value' (ACP spec) fields
        return (
          (typeof block.data === 'string' || typeof block.value === 'string') &&
          typeof block.mimeType === 'string'
        );
      default:
        return false;
    }
  }

  /**
   * Generate a unique message ID
   */
  private generateMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Convert a ContentBlock to ACP ContentBlock format
   * Per ACP spec: single content block object (not array)
   */
  private convertContentBlockToAcp(block: ContentBlock): any {
    switch (block.type) {
      case 'text':
        return {
          type: 'text',
          text: block.value,
        };
      case 'code':
        return {
          type: 'text', // Code is sent as text with language annotation
          text: block.value,
          annotations: block.language
            ? {
                language: block.language,
              }
            : undefined,
        };
      case 'image':
        return {
          type: 'image',
          data: block.value,
          mimeType: block.mimeType,
        };
      default:
        return {
          type: 'text',
          text: String(block),
        };
    }
  }

  /**
   * Get content size for logging
   */
  private getContentSize(block: ContentBlock): number {
    switch (block.type) {
      case 'text':
        return block.value.length;
      case 'code':
        return block.value.length;
      case 'image':
        return block.value.length;
      default:
        return 0;
    }
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    // Cancel all active streams
    for (const [requestId, controller] of this.activeStreams) {
      controller.abort();
      this.logger.debug('Cancelled stream during cleanup', { requestId });
    }
    this.activeStreams.clear();

    this.logger.debug('PromptHandler cleanup completed');
  }
}
