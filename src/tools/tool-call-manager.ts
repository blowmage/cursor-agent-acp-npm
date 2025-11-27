/**
 * Tool Call Manager
 *
 * Centralizes tool call tracking and reporting per ACP spec.
 * Manages tool call notifications, permission requests, and state tracking.
 *
 * All notifications now use SDK types for full compliance.
 *
 * SECURITY NOTE: All _meta fields in notifications are visible to clients.
 * Do not include sensitive information (secrets, internal paths, etc.).
 * Only include debugging/monitoring data that is safe to expose.
 */

import type {
  ToolKind,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  PermissionOption,
  SessionNotification,
  ContentBlock,
} from '@agentclientprotocol/sdk';

import {
  type Logger,
  type PermissionOutcome,
  type RequestPermissionParams,
} from '../types';

/**
 * Internal tracking info for active tool calls
 *
 * Note: This is an internal implementation type for tracking tool call state.
 * For protocol-level types, see:
 * - Per ACP schema: https://agentclientprotocol.com/protocol/schema#toolcall
 * - SDK types: ToolCall, ToolCallUpdate, ToolCallStatus, SessionNotification
 *
 * This manager uses SDK-compliant SessionNotification structures for
 * all protocol communications while maintaining internal state here.
 */
export interface ToolCallInfo {
  toolCallId: string;
  sessionId: string;
  toolName: string;
  status: ToolCallStatus;
  startTime: Date;
  endTime?: Date;
  // Store the last SDK-compliant notification sent for this tool call
  lastNotification: SessionNotification;
  cleanupTimeoutId?: NodeJS.Timeout;
}

export interface ToolCallManagerOptions {
  logger: Logger;
  sendNotification: (notification: {
    jsonrpc: '2.0';
    method: string;
    params?: any;
  }) => void;
  requestPermission?:
    | ((params: RequestPermissionParams) => Promise<PermissionOutcome>)
    | undefined;
}

export class ToolCallManager {
  private logger: Logger;
  private sendNotification: (notification: {
    jsonrpc: '2.0';
    method: string;
    params?: any;
  }) => void;
  private requestPermission:
    | ((params: RequestPermissionParams) => Promise<PermissionOutcome>)
    | undefined;
  private activeToolCalls = new Map<string, ToolCallInfo>();
  private toolCallCounter = 0;
  private notificationSequence = 0;

  constructor(options: ToolCallManagerOptions) {
    this.logger = options.logger;
    this.sendNotification = options.sendNotification;
    this.requestPermission = options.requestPermission;
  }

  /**
   * Generate a unique tool call ID
   */
  generateToolCallId(toolName: string): string {
    this.toolCallCounter++;
    return `tool_${toolName}_${Date.now()}_${this.toolCallCounter}`;
  }

  /**
   * Report a new tool call to the client
   * Per ACP spec: Send session/update notification with tool_call
   * Now uses SDK types with _meta support
   * Defaults to in_progress status
   */
  async reportToolCall(
    sessionId: string,
    toolName: string,
    options: {
      title: string;
      kind: ToolKind;
      status?: ToolCallStatus;
      rawInput?: Record<string, any>;
      locations?: ToolCallLocation[];
    }
  ): Promise<string> {
    const toolCallId = this.generateToolCallId(toolName);
    const now = new Date();
    const status = options.status || 'in_progress'; // Better default

    // Build SDK-compliant SessionNotification
    const notification: SessionNotification = {
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId,
        title: options.title,
        kind: options.kind,
        status,
        ...(options.locations && { locations: options.locations }),
        ...(options.rawInput && { rawInput: options.rawInput }),
        _meta: {
          toolName,
          startTime: now.toISOString(),
          source: 'tool-call-manager',
        },
      },
      _meta: {
        timestamp: now.toISOString(),
        notificationSequence: this.notificationSequence++,
      },
    };

    // Store tool call info
    const toolCallInfo: ToolCallInfo = {
      toolCallId,
      sessionId,
      toolName,
      status,
      startTime: now,
      lastNotification: notification,
    };

    this.activeToolCalls.set(toolCallId, toolCallInfo);

    this.logger.debug('Reporting tool call', {
      toolCallId,
      sessionId,
      toolName,
      kind: options.kind,
      status,
    });

    // Send SDK-compliant notification
    this.sendNotification({
      jsonrpc: '2.0',
      method: 'session/update',
      params: notification,
    });

    return toolCallId;
  }

  /**
   * Update an existing tool call
   * Per ACP spec: Send session/update notification with tool_call_update
   * Now uses SDK types with _meta support
   */
  async updateToolCall(
    sessionId: string,
    toolCallId: string,
    updates: {
      title?: string;
      status?: ToolCallStatus;
      content?: ToolCallContent[];
      locations?: ToolCallLocation[];
      rawOutput?: Record<string, any>;
    }
  ): Promise<void> {
    const toolCallInfo = this.activeToolCalls.get(toolCallId);

    if (!toolCallInfo) {
      this.logger.warn('Tool call not found for update', {
        toolCallId,
        sessionId,
      });
      return;
    }

    const now = new Date();

    // Update stored info
    if (updates.status) {
      toolCallInfo.status = updates.status;

      // Mark end time if completed or failed
      if (updates.status === 'completed' || updates.status === 'failed') {
        toolCallInfo.endTime = now;
      }
    }

    this.logger.debug('Updating tool call', {
      toolCallId,
      sessionId,
      toolName: toolCallInfo.toolName,
      updates,
    });

    // Build SDK-compliant update (only include fields being updated)
    const updatePayload: SessionNotification['update'] = {
      sessionUpdate: 'tool_call_update',
      toolCallId,
      ...(updates.title !== undefined && { title: updates.title }),
      ...(updates.status !== undefined && { status: updates.status }),
      ...(updates.content !== undefined && { content: updates.content }),
      ...(updates.locations !== undefined && { locations: updates.locations }),
      ...(updates.rawOutput !== undefined && { rawOutput: updates.rawOutput }),
      _meta: {
        updateTime: now.toISOString(),
        source: 'tool-call-manager',
      },
    };

    // Build full notification
    const notification: SessionNotification = {
      sessionId,
      update: updatePayload,
      _meta: {
        timestamp: now.toISOString(),
        notificationSequence: this.notificationSequence++,
      },
    };

    // Store last notification
    toolCallInfo.lastNotification = notification;

    // Send SDK-compliant notification
    this.sendNotification({
      jsonrpc: '2.0',
      method: 'session/update',
      params: notification,
    });
  }

  /**
   * Request permission from the user before executing a tool
   * Per ACP spec: Call session/request_permission method
   */
  async requestToolPermission(
    sessionId: string,
    toolCallId: string,
    options: PermissionOption[]
  ): Promise<PermissionOutcome> {
    if (!this.requestPermission) {
      this.logger.warn(
        'Permission request not supported - no requestPermission handler provided'
      );
      // Default to allow once
      return { outcome: 'selected', optionId: 'allow-once' };
    }

    const toolCallInfo = this.activeToolCalls.get(toolCallId);

    if (!toolCallInfo) {
      this.logger.warn('Tool call not found for permission request', {
        toolCallId,
        sessionId,
      });
      // Default to reject
      return { outcome: 'selected', optionId: 'reject-once' };
    }

    this.logger.debug('Requesting permission for tool call', {
      toolCallId,
      sessionId,
      toolName: toolCallInfo.toolName,
      optionCount: options.length,
    });

    try {
      // Pass the tool call update from the last notification
      const outcome = await this.requestPermission({
        sessionId,
        toolCall: toolCallInfo.lastNotification.update as any, // Cast for compatibility
        options,
      });

      if (!outcome) {
        this.logger.warn('Permission request returned no outcome', {
          toolCallId,
          sessionId,
        });
        // Default to reject if no outcome
        return { outcome: 'selected', optionId: 'reject-once' };
      }

      this.logger.debug('Permission request result', {
        toolCallId,
        sessionId,
        outcome,
      });

      return outcome;
    } catch (error) {
      this.logger.error('Permission request failed', {
        error,
        toolCallId,
        sessionId,
      });
      // Default to reject on error
      return { outcome: 'selected', optionId: 'reject-once' };
    }
  }

  /**
   * Convert ContentBlock diffs (from cursor-tools) to ToolCallContent
   * Enables rich diff display in clients
   */
  convertDiffContent(diffBlocks: ContentBlock[]): ToolCallContent[] {
    const toolCallContent: ToolCallContent[] = [];

    for (const block of diffBlocks) {
      if (
        block.type === 'resource' &&
        block.resource.mimeType === 'text/x-diff'
      ) {
        // Parse unified diff to extract path, old text, new text
        try {
          const diffPath = block.resource.uri.replace('diff://', '');
          // Handle both text and blob resources
          const diffText = 'text' in block.resource ? block.resource.text : '';
          const parsed = this.parseUnifiedDiff(diffPath, diffText);

          const diffContent: ToolCallContent = {
            type: 'diff',
            path: parsed.path,
            oldText: parsed.oldText,
            newText: parsed.newText,
          };

          // Only add _meta if it exists (for exactOptionalPropertyTypes)
          if (block.annotations?._meta) {
            diffContent._meta = block.annotations._meta;
          }

          toolCallContent.push(diffContent);
        } catch (error) {
          // If parsing fails, wrap as regular content
          this.logger.warn('Failed to parse diff content', { error });
          toolCallContent.push({
            type: 'content',
            content: block,
          });
        }
      } else {
        // Wrap other content types in content wrapper
        toolCallContent.push({
          type: 'content',
          content: block,
        });
      }
    }

    return toolCallContent;
  }

  /**
   * Create terminal content for tool call updates
   * Enables streaming terminal output to clients
   *
   * Usage example:
   * ```
   * const content = toolCallManager.createTerminalContent('term-123');
   * await toolCallManager.updateToolCall(sessionId, toolCallId, { content });
   * ```
   */
  createTerminalContent(terminalId: string): ToolCallContent[] {
    return [
      {
        type: 'terminal',
        terminalId,
      },
    ];
  }

  /**
   * Parse unified diff format to extract old/new content
   * Simple parser - extracts content from unified diff format
   */
  private parseUnifiedDiff(
    path: string,
    diffText: string
  ): {
    path: string;
    oldText: string | null;
    newText: string;
  } {
    const lines = diffText.split('\n');
    const oldLines: string[] = [];
    const newLines: string[] = [];
    let inHunk = false;

    for (const line of lines) {
      // Skip diff headers
      if (line.startsWith('---') || line.startsWith('+++')) {
        continue;
      }

      // Start of hunk
      if (line.startsWith('@@')) {
        inHunk = true;
        continue;
      }

      if (inHunk) {
        if (line.startsWith('-')) {
          // Old line (removed)
          oldLines.push(line.substring(1));
        } else if (line.startsWith('+')) {
          // New line (added)
          newLines.push(line.substring(1));
        } else if (line.startsWith(' ')) {
          // Context line (unchanged) - appears in both
          const contextLine = line.substring(1);
          oldLines.push(contextLine);
          newLines.push(contextLine);
        }
      }
    }

    // Determine if this is a new file (no old content)
    const isNewFile =
      oldLines.length === 0 || oldLines.every((line) => line.trim() === '');

    return {
      path,
      oldText: isNewFile ? null : oldLines.join('\n'),
      newText: newLines.join('\n'),
    };
  }

  /**
   * Mark a tool call as completed with output
   * Now supports content parameter for rich output
   */
  async completeToolCall(
    sessionId: string,
    toolCallId: string,
    options: {
      title?: string;
      content?: ToolCallContent[];
      rawOutput?: Record<string, any>;
    }
  ): Promise<void> {
    await this.updateToolCall(sessionId, toolCallId, {
      ...options,
      status: 'completed',
    });

    // Clean up after a delay to allow for inspection
    const toolCallInfo = this.activeToolCalls.get(toolCallId);
    if (toolCallInfo) {
      // Clear any existing timeout first
      if (toolCallInfo.cleanupTimeoutId) {
        clearTimeout(toolCallInfo.cleanupTimeoutId);
      }

      toolCallInfo.cleanupTimeoutId = setTimeout(() => {
        this.activeToolCalls.delete(toolCallId);
      }, 30000); // 30 seconds
    }
  }

  /**
   * Mark a tool call as failed with error
   */
  async failToolCall(
    sessionId: string,
    toolCallId: string,
    options: {
      title?: string;
      error: string;
      rawOutput?: Record<string, any>;
    }
  ): Promise<void> {
    // Include error in content
    const content: ToolCallContent[] = [
      {
        type: 'content',
        content: {
          type: 'text',
          text: `Error: ${options.error}`,
        },
      },
    ];

    const updateOptions: {
      title?: string;
      status?: ToolCallStatus;
      content?: ToolCallContent[];
      rawOutput?: Record<string, any>;
    } = {
      title: options.title || 'Tool execution failed',
      status: 'failed',
      content,
    };

    // Only include rawOutput if it's defined
    if (options.rawOutput !== undefined) {
      updateOptions.rawOutput = options.rawOutput;
    }

    await this.updateToolCall(sessionId, toolCallId, updateOptions);

    // Clean up after a delay to allow for inspection
    const toolCallInfo = this.activeToolCalls.get(toolCallId);
    if (toolCallInfo) {
      // Clear any existing timeout first
      if (toolCallInfo.cleanupTimeoutId) {
        clearTimeout(toolCallInfo.cleanupTimeoutId);
      }

      toolCallInfo.cleanupTimeoutId = setTimeout(() => {
        this.activeToolCalls.delete(toolCallId);
      }, 30000); // 30 seconds
    }
  }

  /**
   * Get info about an active tool call
   */
  getToolCallInfo(toolCallId: string): ToolCallInfo | undefined {
    return this.activeToolCalls.get(toolCallId);
  }

  /**
   * Get all active tool calls for a session
   */
  getSessionToolCalls(sessionId: string): ToolCallInfo[] {
    const toolCalls: ToolCallInfo[] = [];
    for (const toolCall of this.activeToolCalls.values()) {
      if (toolCall.sessionId === sessionId) {
        toolCalls.push(toolCall);
      }
    }
    return toolCalls;
  }

  /**
   * Cancel all tool calls for a session
   */
  async cancelSessionToolCalls(sessionId: string): Promise<void> {
    this.logger.info('Cancelling all tool calls for session', { sessionId });

    const toolCalls = this.getSessionToolCalls(sessionId);

    for (const toolCall of toolCalls) {
      if (toolCall.status === 'pending' || toolCall.status === 'in_progress') {
        await this.updateToolCall(sessionId, toolCall.toolCallId, {
          status: 'failed',
          title: 'Cancelled by user',
        });
      }

      // Clear any pending cleanup timeout
      if (toolCall.cleanupTimeoutId) {
        clearTimeout(toolCall.cleanupTimeoutId);
      }

      this.activeToolCalls.delete(toolCall.toolCallId);
    }

    this.logger.debug('Session tool calls cancelled', {
      sessionId,
      count: toolCalls.length,
    });
  }

  /**
   * Get metrics about tool calls
   */
  getMetrics(): Record<string, any> {
    const statusCounts: Record<ToolCallStatus, number> = {
      pending: 0,
      in_progress: 0,
      completed: 0,
      failed: 0,
    };

    for (const toolCall of this.activeToolCalls.values()) {
      statusCounts[toolCall.status]++;
    }

    return {
      activeToolCalls: this.activeToolCalls.size,
      statusCounts,
      totalToolCalls: this.toolCallCounter,
    };
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    this.logger.debug('Cleaning up tool call manager');

    // Clear all pending cleanup timeouts before clearing the map
    for (const toolCall of this.activeToolCalls.values()) {
      if (toolCall.cleanupTimeoutId) {
        clearTimeout(toolCall.cleanupTimeoutId);
      }
    }

    this.activeToolCalls.clear();
  }
}
