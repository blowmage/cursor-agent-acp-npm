/**
 * Tool Call Manager
 *
 * Centralizes tool call tracking and reporting per ACP spec.
 * Manages tool call notifications, permission requests, and state tracking.
 */

import {
  type Logger,
  type ToolCallUpdate,
  type ToolCallStatus,
  type ToolKind,
  type ToolCallContent,
  type ToolCallLocation,
  type PermissionOption,
  type PermissionOutcome,
  type RequestPermissionParams,
  type AcpNotification,
} from '../types';

export interface ToolCallInfo {
  toolCallId: string;
  sessionId: string;
  toolName: string;
  status: ToolCallStatus;
  startTime: Date;
  endTime?: Date;
  update: ToolCallUpdate;
}

export interface ToolCallManagerOptions {
  logger: Logger;
  sendNotification: (notification: AcpNotification) => void;
  requestPermission?:
    | ((params: RequestPermissionParams) => Promise<PermissionOutcome>)
    | undefined;
}

export class ToolCallManager {
  private logger: Logger;
  private sendNotification: (notification: AcpNotification) => void;
  private requestPermission:
    | ((params: RequestPermissionParams) => Promise<PermissionOutcome>)
    | undefined;
  private activeToolCalls = new Map<string, ToolCallInfo>();
  private toolCallCounter = 0;

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

    const update: ToolCallUpdate = {
      toolCallId,
      title: options.title,
      kind: options.kind,
      status: options.status || 'pending',
      ...(options.rawInput && { rawInput: options.rawInput }),
      ...(options.locations && { locations: options.locations }),
    };

    // Store tool call info
    const toolCallInfo: ToolCallInfo = {
      toolCallId,
      sessionId,
      toolName,
      status: options.status || 'pending',
      startTime: new Date(),
      update,
    };

    this.activeToolCalls.set(toolCallId, toolCallInfo);

    this.logger.debug('Reporting tool call', {
      toolCallId,
      sessionId,
      toolName,
      kind: options.kind,
      status: options.status || 'pending',
    });

    // Send session/update notification
    this.sendNotification({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          ...update,
        },
      },
    });

    return toolCallId;
  }

  /**
   * Update an existing tool call
   * Per ACP spec: Send session/update notification with tool_call_update
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

    // Update stored info
    if (updates.status) {
      toolCallInfo.status = updates.status;

      // Mark end time if completed or failed
      if (updates.status === 'completed' || updates.status === 'failed') {
        toolCallInfo.endTime = new Date();
      }
    }

    // Merge updates
    toolCallInfo.update = {
      ...toolCallInfo.update,
      ...(updates.title !== undefined && { title: updates.title }),
      ...(updates.status !== undefined && { status: updates.status }),
      ...(updates.content !== undefined && { content: updates.content }),
      ...(updates.locations !== undefined && { locations: updates.locations }),
      ...(updates.rawOutput !== undefined && { rawOutput: updates.rawOutput }),
    };

    this.logger.debug('Updating tool call', {
      toolCallId,
      sessionId,
      toolName: toolCallInfo.toolName,
      updates,
    });

    // Send session/update notification
    const updatePayload: any = {
      sessionUpdate: 'tool_call_update',
      toolCallId,
    };

    // Only include fields that are being updated (per ACP spec)
    if (updates.title !== undefined) {
      updatePayload.title = updates.title;
    }
    if (updates.status !== undefined) {
      updatePayload.status = updates.status;
    }
    if (updates.content !== undefined) {
      updatePayload.content = updates.content;
    }
    if (updates.locations !== undefined) {
      updatePayload.locations = updates.locations;
    }
    if (updates.rawOutput !== undefined) {
      updatePayload.rawOutput = updates.rawOutput;
    }

    this.sendNotification({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: updatePayload,
      },
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
      const outcome = await this.requestPermission({
        sessionId,
        toolCall: toolCallInfo.update,
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
   * Mark a tool call as completed with output
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
    setTimeout(() => {
      this.activeToolCalls.delete(toolCallId);
    }, 30000); // 30 seconds
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
      status?: import('../types').ToolCallStatus;
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
    setTimeout(() => {
      this.activeToolCalls.delete(toolCallId);
    }, 30000); // 30 seconds
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
    this.activeToolCalls.clear();
  }
}
