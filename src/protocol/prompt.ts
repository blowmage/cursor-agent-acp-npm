/**
 * Prompt Processing Handler
 *
 * Handles ACP prompt requests, content processing, and streaming responses.
 * This module manages the core conversation flow between ACP clients and Cursor CLI.
 */

import type {
  Request,
  Request1,
  ContentBlock,
  PromptRequest,
  PromptResponse,
  PlanEntry,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import type { Error as JsonRpcError } from '@agentclientprotocol/sdk';
import type { SlashCommandsRegistry } from '../tools/slash-commands';
import {
  ProtocolError,
  SessionError,
  type ConversationMessage,
  type StreamChunk,
  type StreamProgress,
  type Logger,
  type AdapterConfig,
} from '../types';
import type { SessionManager } from '../session/manager';
import type { CursorCliBridge } from '../cursor/cli-bridge';
import { ContentProcessor } from './content';

// Stop reason constants per ACP spec
// These are the only valid values for PromptResponse.stopReason
const STOP_REASON = {
  END_TURN: 'end_turn' as const,
  MAX_TOKENS: 'max_tokens' as const,
  MAX_TURN_REQUESTS: 'max_turn_requests' as const,
  REFUSAL: 'refusal' as const,
  CANCELLED: 'cancelled' as const,
} satisfies Record<string, PromptResponse['stopReason']>;

export interface PromptHandlerOptions {
  sessionManager: SessionManager;
  cursorBridge: CursorCliBridge;
  config: AdapterConfig;
  logger: Logger;
  sendNotification: (notification: {
    jsonrpc: '2.0';
    method: string;
    params?: any;
  }) => void;
  slashCommandsRegistry?: SlashCommandsRegistry;
}

export interface StreamOptions {
  enabled: boolean;
  chunkSize?: number;
  progressCallback?: (progress: StreamProgress) => void;
}

// Prompt processing configuration
export interface PromptProcessingConfig {
  echoUserMessages?: boolean; // Echo user messages via user_message_chunk
  sendPlan?: boolean; // Send plan notifications (if multi-step processing)
  reportToolCalls?: boolean; // Report tool call lifecycle via tool_call notifications
  collectDetailedMetrics?: boolean; // Collect comprehensive metrics
  annotateContent?: boolean; // Add annotations to content blocks
  markInternalContent?: boolean; // Mark assistant-only content
}

// Content annotation options
export interface ContentAnnotationOptions {
  priority?: number; // 1-5, higher = more important
  audience?: Array<'user' | 'assistant'>; // Who should see this content
  confidence?: number; // 0-1, confidence score
  source?: string; // Content source identifier
  category?: string; // Content category (e.g., 'code', 'explanation', 'error')
}

// Tool call lifecycle support
export interface ToolCallInfo {
  id: string;
  kind: 'filesystem' | 'terminal' | 'other';
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  rawInput?: Record<string, any>;
  rawOutput?: Record<string, any>;
  content?: ContentBlock[];
}

// Comprehensive metrics for prompt processing
export interface PromptMetrics {
  // Timing
  startTime: number;
  endTime: number;
  totalDurationMs: number;
  cursorProcessingMs?: number;
  contentProcessingMs?: number;
  streamingDurationMs?: number;

  // Content
  inputBlocks: number;
  inputSize: number;
  outputBlocks: number;
  outputSize: number;
  contentTypes: Record<string, number>; // Count by type

  // Tool usage
  toolCallsInitiated: number;
  toolCallsCompleted: number;
  toolCallsFailed: number;
  toolCallDurations: Record<string, number>; // Tool name -> duration

  // Streaming (if applicable)
  chunksStreamed?: number;
  averageChunkSize?: number;
  streamingLatency?: number; // Time to first chunk

  // Session
  heartbeatsSent: number;
  sessionMessageCount: number;

  // Performance
  peakMemoryMb?: number;
  avgCpuPercent?: number;
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
  private readonly sendNotification: (notification: {
    jsonrpc: '2.0';
    method: string;
    params?: any;
  }) => void;
  private readonly slashCommandsRegistry: SlashCommandsRegistry | undefined;
  // Processing configuration
  private readonly processingConfig: PromptProcessingConfig = {
    echoUserMessages: true,
    sendPlan: false, // Disabled by default (requires multi-step planning)
    reportToolCalls: true, // Enabled by default for ACP compliance
    collectDetailedMetrics: true,
    annotateContent: true, // Enabled by default
    markInternalContent: false, // Disabled (most content is user-facing)
  };

  constructor(options: PromptHandlerOptions) {
    this.sessionManager = options.sessionManager;
    this.cursorBridge = options.cursorBridge;
    this.config = options.config;
    this.logger = options.logger;
    this.sendNotification = options.sendNotification;
    this.slashCommandsRegistry = options.slashCommandsRegistry;
    this.contentProcessor = new ContentProcessor({
      config: this.config,
      logger: this.logger,
    });
  }

  /**
   * Returns a random element from an array
   */
  private getRandomProcessingText(): string {
    const texts = [
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
    return texts[Math.floor(Math.random() * texts.length)]!;
  }

  /**
   * Determine the appropriate stop reason based on execution context with detailed metadata
   * Per ACP spec: Returns one of 5 valid stop reasons with rich context
   */
  private determineStopReason(
    error: Error | null,
    aborted: boolean,
    responseMetadata?: Record<string, any>
  ): {
    stopReason: PromptResponse['stopReason'];
    stopReasonDetails?: Record<string, any>;
  } {
    // Cancelled by client via session/cancel
    if (aborted) {
      return {
        stopReason: STOP_REASON.CANCELLED,
        stopReasonDetails: {
          cancelledAt: new Date().toISOString(),
          cancelMethod: 'session/cancel',
          ...(responseMetadata?.['cancelReason'] && {
            reason: responseMetadata['cancelReason'],
          }),
        },
      };
    }

    // Check for token limit reached from Cursor response
    if (
      responseMetadata?.['reason'] === 'max_tokens' ||
      responseMetadata?.['tokenLimitReached']
    ) {
      return {
        stopReason: STOP_REASON.MAX_TOKENS,
        stopReasonDetails: {
          tokensUsed: responseMetadata?.['tokensUsed'],
          tokenLimit: responseMetadata?.['tokenLimit'],
          contentTruncated: true,
          ...(responseMetadata?.['partialCompletion'] && {
            partialCompletion: responseMetadata['partialCompletion'],
          }),
        },
      };
    }

    // Check for turn limit reached from Cursor response
    if (
      responseMetadata?.['reason'] === 'max_turn_requests' ||
      responseMetadata?.['turnLimitReached']
    ) {
      return {
        stopReason: STOP_REASON.MAX_TURN_REQUESTS,
        stopReasonDetails: {
          turnsUsed: responseMetadata?.['turnsUsed'],
          turnLimit: responseMetadata?.['turnLimit'],
          toolCallsMade: responseMetadata?.['toolCallsMade'],
        },
      };
    }

    // Explicit refusal or error occurred
    if (error || responseMetadata?.['refused'] || responseMetadata?.['error']) {
      // Determine specific refusal subtype for better client handling
      let reason: string;
      if (error) {
        // Categorize errors by type
        if (
          error.name === 'AuthenticationError' ||
          error.message.includes('authentication')
        ) {
          reason = 'authentication';
        } else if (
          error.name === 'RateLimitError' ||
          error.message.includes('rate limit')
        ) {
          reason = 'rate_limit';
        } else if (
          error.name === 'TimeoutError' ||
          error.message.includes('timeout')
        ) {
          reason = 'timeout';
        } else {
          reason = 'error'; // Generic system error
        }
      } else if (responseMetadata?.['safeguardTriggered']) {
        reason = 'content_policy'; // Content safety filter
      } else if (responseMetadata?.['capabilityUnavailable']) {
        reason = 'capability_limit'; // Required capability not available
      } else {
        reason = 'refused'; // Generic refusal
      }

      return {
        stopReason: STOP_REASON.REFUSAL,
        stopReasonDetails: {
          reason, // Specific refusal subtype (error, content_policy, capability_limit, refused, etc.)
          refusalType: error ? 'error' : 'refused', // Keep for backward compatibility
          ...(error && {
            errorName: error.name,
            errorMessage: error.message,
            errorStack: error.stack?.split('\n').slice(0, 3).join('\n'), // First 3 lines
          }),
          ...(responseMetadata?.['refusalReason'] && {
            refusalReason: responseMetadata['refusalReason'],
          }),
          ...(responseMetadata?.['safeguardTriggered'] && {
            safeguard: responseMetadata['safeguardTriggered'],
          }),
        },
      };
    }

    // Normal completion
    return {
      stopReason: STOP_REASON.END_TURN,
      stopReasonDetails: {
        completionType: 'normal',
        contentBlocks: responseMetadata?.['messageBlocks'],
      },
    };
  }

  /**
   * Echo user message back to client
   * Per ACP spec: Agent SHOULD echo user messages via user_message_chunk
   */
  private echoUserMessage(sessionId: string, content: ContentBlock[]): void {
    if (!this.processingConfig.echoUserMessages) {
      return;
    }

    this.logger.debug('Echoing user message', {
      sessionId,
      blocks: content.length,
    });

    for (const block of content) {
      // Annotate user content
      const annotationOptions = this.getDefaultAnnotations(block.type, true);
      const annotatedBlock = this.annotateContentBlock(
        block,
        annotationOptions
      );

      this.sendNotification({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'user_message_chunk',
            content: annotatedBlock,
          },
        },
      });
    }
  }

  /**
   * Calculate total content size for metrics
   */
  private calculateContentSize(blocks: ContentBlock[]): number {
    let totalSize = 0;
    for (const block of blocks) {
      totalSize += this.getContentSize(block);
    }
    return totalSize;
  }

  /**
   * Collect comprehensive metrics for prompt processing
   * Per ACP best practices: Track detailed metrics for observability
   * Note: Public infrastructure method ready for external integration
   */
  public collectMetrics(
    startTime: number,
    endTime: number,
    inputContent: ContentBlock[],
    outputContent: ContentBlock[],
    heartbeatCount: number,
    toolCalls?: ToolCallInfo[]
  ): PromptMetrics {
    const contentTypes: Record<string, number> = {};

    // Count content types in output
    for (const block of outputContent) {
      contentTypes[block.type] = (contentTypes[block.type] || 0) + 1;
    }

    // Get session message count if available
    // Note: We'll get this from the session state in the calling context
    // This is a placeholder for now - should be passed as a parameter
    const sessionMessageCount = 0;

    const metrics: PromptMetrics = {
      startTime,
      endTime,
      totalDurationMs: endTime - startTime,
      inputBlocks: inputContent.length,
      inputSize: this.calculateContentSize(inputContent),
      outputBlocks: outputContent.length,
      outputSize: this.calculateContentSize(outputContent),
      contentTypes,
      toolCallsInitiated: toolCalls?.length || 0,
      toolCallsCompleted:
        toolCalls?.filter((t) => t.status === 'completed').length || 0,
      toolCallsFailed:
        toolCalls?.filter((t) => t.status === 'failed').length || 0,
      toolCallDurations: {},
      heartbeatsSent: heartbeatCount,
      sessionMessageCount,
    };

    // Add tool call durations if available
    if (toolCalls) {
      for (const toolCall of toolCalls) {
        if (
          toolCall.status === 'completed' &&
          toolCall.rawOutput?.['durationMs']
        ) {
          metrics.toolCallDurations[toolCall.title] =
            toolCall.rawOutput['durationMs'];
        }
      }
    }

    return metrics;
  }

  /**
   * Annotate content block with metadata
   * Adds annotations per ACP spec for content visibility, priority, etc.
   */
  private annotateContentBlock(
    block: ContentBlock,
    options: ContentAnnotationOptions
  ): ContentBlock {
    if (!this.processingConfig.annotateContent) {
      return block;
    }

    const annotations: Record<string, any> = block.annotations
      ? { ...block.annotations }
      : {};

    // Add audience (user vs assistant)
    if (options['audience']) {
      annotations['audience'] = options['audience'];
    } else if (this.processingConfig.markInternalContent) {
      // Default to user-visible unless marked as internal
      annotations['audience'] = ['user'];
    }

    // Add priority (1-5)
    if (options['priority'] !== undefined) {
      annotations['priority'] = Math.max(1, Math.min(5, options['priority']));
    }

    // Add timestamp
    annotations['lastModified'] = new Date().toISOString();

    // Add custom metadata
    const meta: Record<string, any> = annotations['_meta'] || {};

    if (options['confidence'] !== undefined) {
      meta['confidence'] = Math.max(0, Math.min(1, options['confidence']));
    }

    if (options['source']) {
      meta['source'] = options['source'];
    }

    if (options['category']) {
      meta['category'] = options['category'];
    }

    if (Object.keys(meta).length > 0) {
      annotations['_meta'] = meta;
    }

    return {
      ...block,
      annotations: Object.keys(annotations).length > 0 ? annotations : null,
    };
  }

  /**
   * Create annotation options based on content type and context
   */
  private getDefaultAnnotations(
    blockType: string,
    isUserContent: boolean
  ): ContentAnnotationOptions {
    const options: ContentAnnotationOptions = {
      source: isUserContent ? 'user_input' : 'cursor_agent',
      audience: isUserContent ? ['user', 'assistant'] : ['user'],
    };

    // Add category based on content type
    switch (blockType) {
      case 'text':
        options.category = 'text';
        break;
      case 'image':
        options.category = 'media';
        break;
      case 'resource':
        options.category = 'resource';
        break;
      case 'diff':
        options.category = 'code';
        break;
      default:
        options.category = 'other';
    }

    return options;
  }

  /**
   * Report tool call initiation
   * Per ACP spec: Inform client when agent begins using a tool
   * Note: Public infrastructure method ready for integration with ToolCallManager
   */
  public reportToolCall(sessionId: string, toolCall: ToolCallInfo): void {
    if (!this.processingConfig.reportToolCalls) {
      return;
    }

    this.logger.debug('Reporting tool call', {
      sessionId,
      toolCallId: toolCall.id,
      kind: toolCall.kind,
    });

    this.sendNotification({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: toolCall.id,
          kind: toolCall.kind,
          title: toolCall.title,
          status: toolCall.status,
          ...(toolCall.rawInput && { rawInput: toolCall.rawInput }),
          ...(toolCall.content && { content: toolCall.content }),
        },
      },
    });
  }

  /**
   * Update tool call status and results
   * Per ACP spec: Inform client when tool completes or fails
   * Note: Public infrastructure method ready for integration with ToolCallManager
   */
  public updateToolCall(
    sessionId: string,
    toolCallId: string,
    update: Partial<ToolCallInfo>
  ): void {
    if (!this.processingConfig.reportToolCalls) {
      return;
    }

    this.logger.debug('Updating tool call', {
      sessionId,
      toolCallId,
      status: update.status,
    });

    this.sendNotification({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          ...(update.status && { status: update.status }),
          ...(update.rawOutput && { rawOutput: update.rawOutput }),
          ...(update.content && { content: update.content }),
        },
      },
    });
  }

  /**
   * Internal method to send plan notification to client
   * Per ACP spec: sessionUpdate must be 'plan' and use 'entries' field.
   * The agent MUST send a complete list of all plan entries in each update.
   * The client MUST replace the entire plan with each update.
   *
   * @param sessionId - The session ID
   * @param entries - Complete list of plan entries
   */
  private _sendPlanNotification(sessionId: string, entries: PlanEntry[]): void {
    // Build SDK-compliant SessionNotification
    // Per ACP spec: sessionUpdate must be 'plan' and use 'entries' field
    const notification: SessionNotification = {
      sessionId,
      update: {
        sessionUpdate: 'plan',
        entries: entries.map((entry) => ({
          content: entry.content,
          priority: entry.priority,
          status: entry.status,
          ...(entry._meta && { _meta: entry._meta }),
        })),
      },
      _meta: {
        timestamp: new Date().toISOString(),
        // Optionally add notification sequence if tracking is needed
      },
    };

    this.sendNotification({
      jsonrpc: '2.0',
      method: 'session/update',
      params: notification,
    });
  }

  /**
   * Send plan to client
   * Per ACP spec: Inform client of multi-step operation plan
   * The agent MUST send a complete list of all plan entries in each update.
   * The client MUST replace the entire plan with each update.
   *
   * @param sessionId - The session ID
   * @param entries - Complete list of plan entries (must include all entries, not just updates)
   */
  public sendPlan(sessionId: string, entries: PlanEntry[]): void {
    if (!this.processingConfig.sendPlan || entries.length === 0) {
      return;
    }

    this.logger.debug('Sending plan', {
      sessionId,
      stepCount: entries.length,
    });

    this._sendPlanNotification(sessionId, entries);
  }

  /**
   * Update plan to client
   * Per ACP spec: The agent MUST send a complete list of all plan entries in each update.
   * The client MUST replace the entire plan with each update.
   *
   * This method sends the complete plan state. If you need to update individual entries,
   * maintain the complete plan state externally and pass the full entries array here.
   *
   * @param sessionId - The session ID
   * @param entries - Complete list of all plan entries with their current status
   */
  public updatePlan(sessionId: string, entries: PlanEntry[]): void {
    if (!this.processingConfig.sendPlan) {
      return;
    }

    this.logger.debug('Updating plan', {
      sessionId,
      entryCount: entries.length,
    });

    this._sendPlanNotification(sessionId, entries);
  }

  /**
   * Process a session/prompt request
   * Per ACP spec: Process prompt and return stopReason when complete.
   * Send session/update notifications during processing.
   */
  async processPrompt(request: Request | Request1): Promise<{
    jsonrpc: '2.0';
    id: string | number | null;
    result?: any | null;
    error?: JsonRpcError;
  }> {
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

      const processRequest = async (): Promise<{
        jsonrpc: '2.0';
        id: string | number | null;
        result?: any | null;
        error?: JsonRpcError;
      }> => {
        // Track timing for metrics
        const startTime = Date.now();

        // Load session to ensure it exists and is valid
        const session = await this.sessionManager.loadSession(sessionId);

        // Mark session as processing to prevent cleanup during long-running operations
        this.sessionManager.markSessionProcessing(sessionId);

        let heartbeatCount = 0;
        const processingText = this.getRandomProcessingText();

        // Send initial thought chunk to indicate processing has started
        // Per ACP spec: agent_thought_chunk is for progress updates
        this.sendNotification({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: promptParams.sessionId,
            update: {
              sessionUpdate: 'agent_thought_chunk',
              content: {
                type: 'text',
                text: processingText,
              },
            },
          },
        });

        // Set up periodic heartbeat to keep client aware of ongoing activity
        // Sends agent_thought_chunk progress messages every 12 seconds
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

          // Send progress update via agent_thought_chunk with enhanced metadata
          this.sendNotification({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: promptParams.sessionId,
              update: {
                sessionUpdate: 'agent_thought_chunk',
                content: {
                  type: 'text',
                  text: `${processingText} (${elapsed}s)`,
                  annotations: {
                    _meta: {
                      heartbeat: true,
                      elapsedSeconds: elapsed,
                      heartbeatNumber: heartbeatCount,
                    },
                  },
                },
              },
            },
          });
        }, 12000); // 12 seconds

        try {
          // Process and AWAIT completion to get stopReason and metadata
          // This sends additional session/update notifications during processing
          let processingError: Error | null = null;
          let responseMetadata: Record<string, any> = {};
          let aborted = false;

          try {
            if (promptParams.stream) {
              const result = await this.processStreamingPromptAsync(
                promptParams,
                (id ?? 'unknown').toString()
              );
              responseMetadata = result.metadata || {};
              aborted = result.aborted || false;
            } else {
              const result = await this.processRegularPromptAsync(promptParams);
              responseMetadata = result.metadata || {};
            }
          } catch (err) {
            processingError =
              err instanceof Error ? err : new Error(String(err));
            // Don't rethrow - we'll determine the appropriate stop reason
          }

          // Determine the appropriate stop reason based on execution context with detailed metadata
          const stopData = this.determineStopReason(
            processingError,
            aborted,
            responseMetadata
          );

          // Calculate processing metrics
          const endTime = Date.now();
          const processingDurationMs = endTime - startTime;

          // Build proper PromptResponse with rich metadata
          const response: PromptResponse = {
            stopReason: stopData.stopReason,
            _meta: {
              // Timing information
              processingStartedAt: new Date(startTime).toISOString(),
              processingEndedAt: new Date(endTime).toISOString(),
              processingDurationMs,

              // Session information
              sessionId,
              ...(session.state?.messageCount !== undefined && {
                sessionMessageCount: session.state.messageCount,
              }),

              // Processing details
              streaming: promptParams.stream,
              heartbeatsCount: heartbeatCount,

              // Content metrics (if collected)
              ...(responseMetadata['contentMetrics'] && {
                contentMetrics: responseMetadata['contentMetrics'],
              }),

              // Stop reason details from enhanced determination
              ...(stopData.stopReasonDetails && {
                stopReasonDetails: stopData.stopReasonDetails,
              }),
            },
          };

          // If there was an error but we're returning a response, log it
          if (processingError) {
            this.logger.warn('Prompt processing completed with error', {
              sessionId,
              stopReason: stopData.stopReason,
              error: processingError.message,
              details: stopData.stopReasonDetails,
            });
          }

          return {
            jsonrpc: '2.0' as const,
            id: id!,
            result: response,
          };
        } catch (error) {
          // This catch block is for unexpected errors during the try block above
          // (not from processPromptAsync, which we already caught)
          this.logger.error('Unexpected error in prompt processing', {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
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

      return <
        {
          jsonrpc: '2.0';
          id: string | number | null;
          result?: any | null;
          error?: JsonRpcError;
        }
      >{
        jsonrpc: '2.0',
        id: id!,
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
   * Detect slash command in content blocks
   * Per ACP spec: Commands appear as regular text content starting with "/"
   *
   * @param content - Array of content blocks to check
   * @returns Command name and input text, or null if no command detected
   */
  private detectSlashCommand(content: ContentBlock[]): {
    command: string;
    input: string;
  } | null {
    // Look for text content blocks that start with "/"
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        const text = block.text.trim();
        if (text.startsWith('/')) {
          // Extract command name (until space or end) and remaining input
          const match = text.match(/^\/(\S+)(?:\s+(.*))?$/);
          if (match) {
            const command = match[1]!;
            const input = match[2] || '';
            this.logger.debug('Detected slash command', { command, input });
            return { command, input };
          }
        }
      }
    }
    return null;
  }

  /**
   * Process a slash command
   * Per ACP spec: Commands are processed as part of regular prompt flow
   *
   * @param sessionId - The session ID
   * @param command - Command name
   * @param input - Command input text
   * @returns True if command was processed, false if not recognized
   */
  private async processSlashCommand(
    sessionId: string,
    command: string,
    input: string
  ): Promise<boolean> {
    if (!this.slashCommandsRegistry) {
      this.logger.debug('Slash commands registry not available');
      return false;
    }

    // Check if command exists
    if (!this.slashCommandsRegistry.hasCommand(command)) {
      this.logger.debug('Unknown slash command', { command });
      return false;
    }

    const commandDef = this.slashCommandsRegistry.getCommand(command);
    if (!commandDef) {
      return false;
    }

    this.logger.info('Processing slash command', {
      sessionId,
      command,
      input,
      description: commandDef.description,
    });

    // For now, commands are processed by forwarding to Cursor CLI
    // The command text is included as part of the regular prompt
    // Future enhancements could add specialized command handlers here

    // Log command execution
    this.logger.debug('Slash command will be processed as part of prompt', {
      command,
      input,
    });

    return true;
  }

  /**
   * Process a regular (non-streaming) prompt asynchronously
   * Sends session/update notifications as content is processed
   * Returns result with metadata
   */
  private async processRegularPromptAsync(
    params: Omit<PromptRequest, 'prompt'> & {
      sessionId: string;
      content: ContentBlock[];
      stream?: boolean;
      metadata?: Record<string, any>;
    }
  ): Promise<{ metadata: Record<string, any> }> {
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

      // Detect slash command in content
      // Per ACP spec: Commands are included as regular user messages
      const commandInfo = this.detectSlashCommand(content);
      if (commandInfo) {
        const commandProcessed = await this.processSlashCommand(
          sessionId,
          commandInfo.command,
          commandInfo.input
        );
        if (commandProcessed) {
          this.logger.debug('Slash command detected and acknowledged', {
            command: commandInfo.command,
          });
        }
      }

      // Add user message to session
      const userMessage: ConversationMessage = {
        id: this.generateMessageId(),
        role: 'user',
        content,
        timestamp: new Date(),
        metadata: metadata || {},
      };

      await this.sessionManager.addMessage(sessionId, userMessage);

      // Echo user message back to client
      this.echoUserMessage(sessionId, content);

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
      // With annotations
      for (const block of responseContent) {
        const acpContent = this.convertContentBlockToAcp(block);

        // Annotate agent content
        const annotationOptions = this.getDefaultAnnotations(
          acpContent.type,
          false
        );
        const annotatedContent = this.annotateContentBlock(
          acpContent,
          annotationOptions
        );

        this.sendNotification(<
          {
            jsonrpc: '2.0';
            method: string;
            params?: any;
          }
        >{
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: annotatedContent,
            },
          },
        });
      }

      // Collect detailed metrics if enabled
      const detailedMetrics = this.processingConfig.collectDetailedMetrics
        ? {
            contentMetrics: {
              inputBlocks: content.length,
              inputSize: this.calculateContentSize(content),
              outputBlocks: responseContent.length,
              outputSize: this.calculateContentSize(responseContent),
            },
          }
        : {};

      // Return metadata - stopReason will be determined by caller
      this.logger.debug('Regular prompt processing complete', { sessionId });
      return {
        metadata: {
          messageBlocks: responseContent.length,
          success: true,
          ...detailedMetrics,
        },
      };
    } catch (error) {
      this.logger.error('Error in regular prompt processing', {
        error,
        sessionId,
      });
      // Re-throw to let caller determine stop reason
      throw error;
    }
  }

  /**
   * Process a streaming prompt asynchronously
   * Sends session/update notifications as chunks arrive
   * Returns result with metadata and aborted flag
   */
  private async processStreamingPromptAsync(
    params: Omit<PromptRequest, 'prompt'> & {
      sessionId: string;
      content: ContentBlock[];
      stream?: boolean;
      metadata?: Record<string, any>;
    },
    requestId: string
  ): Promise<{ metadata: Record<string, any>; aborted: boolean }> {
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

      // Echo user message back to client
      this.echoUserMessage(sessionId, content);

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
              // With annotations
              const acpContent = this.convertContentBlockToAcp(contentBlock);

              // Annotate agent content
              const annotationOptions = this.getDefaultAnnotations(
                acpContent.type,
                false
              );
              const annotatedContent = this.annotateContentBlock(
                acpContent,
                annotationOptions
              );

              this.sendNotification({
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                  sessionId,
                  update: {
                    sessionUpdate: 'agent_message_chunk',
                    content: annotatedContent,
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

        // Annotate agent content
        const annotationOptions = this.getDefaultAnnotations(
          acpContent.type,
          false
        );
        const annotatedContent = this.annotateContentBlock(
          acpContent,
          annotationOptions
        );

        this.sendNotification(<
          {
            jsonrpc: '2.0';
            method: string;
            params?: any;
          }
        >{
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: annotatedContent,
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

      // Collect detailed metrics if enabled
      const detailedMetrics = this.processingConfig.collectDetailedMetrics
        ? {
            contentMetrics: {
              inputBlocks: content.length,
              inputSize: this.calculateContentSize(content),
              outputBlocks: responseContent.length,
              outputSize: this.calculateContentSize(responseContent),
            },
          }
        : {};

      // Return metadata - stopReason will be determined by caller
      this.logger.debug('Streaming prompt processing complete', { sessionId });
      return {
        metadata: {
          messageBlocks: responseContent.length,
          success: true,
          ...detailedMetrics,
        },
        aborted: false,
      };
    } catch (error) {
      this.logger.error('Error in streaming prompt processing', {
        error,
        sessionId,
      });

      // Check if cancelled via abort signal
      if (abortController.signal.aborted) {
        return {
          metadata: {
            aborted: true,
            reason: 'User cancelled request',
          },
          aborted: true,
        };
      }

      // Re-throw to let caller determine stop reason
      throw error;
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
  private validatePromptParams(params: any): Omit<PromptRequest, 'prompt'> & {
    sessionId: string;
    content: ContentBlock[];
    stream?: boolean;
    metadata?: Record<string, any>;
  } {
    if (!params || typeof params !== 'object') {
      throw new ProtocolError('Invalid prompt parameters');
    }

    const { sessionId, content, stream, metadata } = params;

    if (!sessionId || typeof sessionId !== 'string') {
      throw new ProtocolError('sessionId is required and must be a string');
    }

    const contentArray = content;

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
   * Per ACP spec: text uses 'text', image/audio use 'data'
   *
   * Note: 'diff' and 'terminal' are NOT valid ContentBlock types.
   * They are ToolCallContent types only. See @agentclientprotocol/sdk
   */
  private isValidContentBlock(block: any): block is ContentBlock {
    if (!block || typeof block !== 'object' || !block.type) {
      return false;
    }

    switch (block.type) {
      case 'text':
        // Per ACP spec: uses 'text' field
        return typeof block.text === 'string';
      case 'image':
        // Per ACP spec: uses 'data' field
        return (
          typeof block.data === 'string' && typeof block.mimeType === 'string'
        );

      case 'audio':
        // Per ACP spec: Audio content
        return (
          typeof block.data === 'string' && typeof block.mimeType === 'string'
        );

      case 'resource':
        // Per ACP spec: Embedded resource
        if (!block.resource || typeof block.resource !== 'object') {
          return false;
        }
        if (typeof block.resource.uri !== 'string') {
          return false;
        }
        // Must have either text or blob
        return (
          typeof block.resource.text === 'string' ||
          typeof block.resource.blob === 'string'
        );

      case 'resource_link':
        // Per ACP spec: Resource link
        return typeof block.uri === 'string' && typeof block.name === 'string';

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
   * Uses correct field names: text for text, data for binary
   */
  private convertContentBlockToAcp(block: ContentBlock): any {
    switch (block.type) {
      case 'text':
        return {
          type: 'text',
          text: block.text,
          ...(block.annotations && { annotations: block.annotations }),
        };

      case 'image':
        return {
          type: 'image',
          data: block.data,
          mimeType: block.mimeType,
          ...(block.uri && { uri: block.uri }),
          ...(block.annotations && { annotations: block.annotations }),
        };

      case 'audio':
        return {
          type: 'audio',
          data: block.data,
          mimeType: block.mimeType,
          ...(block.annotations && { annotations: block.annotations }),
        };

      case 'resource':
        return {
          type: 'resource',
          resource: block.resource,
          ...(block.annotations && { annotations: block.annotations }),
        };

      case 'resource_link':
        return {
          type: 'resource_link',
          uri: block.uri,
          name: block.name,
          ...(block.mimeType && { mimeType: block.mimeType }),
          ...(block.title && { title: block.title }),
          ...(block.description && { description: block.description }),
          ...(block.size !== undefined && { size: block.size }),
          ...(block.annotations && { annotations: block.annotations }),
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
        return block.text.length;
      case 'image':
        return block.data.length;
      case 'audio':
        return block.data.length;
      case 'resource':
        return 'text' in block.resource
          ? block.resource.text.length
          : block.resource.blob.length;
      case 'resource_link':
        return block.uri.length + block.name.length;
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
