/**
 * Permissions Handler
 *
 * Handles permission requests per ACP spec.
 * Allows agents to request user permission before executing sensitive operations.
 */

import type {
  Request,
  Request1,
  RequestPermissionRequest,
  PermissionOption,
} from '@agentclientprotocol/sdk';
import type { Error as JsonRpcError } from '@agentclientprotocol/sdk';
import { ProtocolError, type Logger, type PermissionOutcome } from '../types';
import { validateObjectParams, createErrorResponse } from '../utils/json-rpc';

export interface PermissionHandlerOptions {
  logger: Logger;
}

export interface PendingPermissionRequest {
  requestId: string | number;
  sessionId: string;
  resolve: (outcome: PermissionOutcome) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class PermissionsHandler {
  private logger: Logger;
  private pendingRequests = new Map<
    string | number,
    PendingPermissionRequest
  >();
  private readonly defaultTimeout = 300000; // 5 minutes

  constructor(options: PermissionHandlerOptions) {
    this.logger = options.logger;
  }

  /**
   * Create a permission request and wait for response
   * This is called by the ToolCallManager when it needs permission
   *
   * Returns a Promise that will be resolved when the client responds
   */
  async createPermissionRequest(
    params: RequestPermissionRequest
  ): Promise<PermissionOutcome> {
    // Generate a unique request ID
    const requestId = `perm_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

    this.logger.debug('Creating permission request', {
      requestId,
      sessionId: params.sessionId,
      toolCallId: params.toolCall.toolCallId,
    });

    return new Promise<PermissionOutcome>((resolve, reject) => {
      // Set timeout
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        this.logger.warn('Permission request timed out', {
          requestId,
          sessionId: params.sessionId,
        });
        // Default to reject on timeout
        resolve({ outcome: 'selected', optionId: 'reject-once' });
      }, this.defaultTimeout);

      // Store pending request
      this.pendingRequests.set(requestId, {
        requestId,
        sessionId: params.sessionId,
        resolve,
        reject,
        timeout,
      });
    });
  }

  /**
   * Process a session/request_permission request
   * This is called by the adapter when it receives a permission request from an agent
   *
   * Note: In the ACP spec, the Agent calls this method on the Client.
   * However, in our architecture, we need to return a request ID and handle
   * the response asynchronously.
   */
  async handlePermissionRequest(request: Request | Request1): Promise<{
    jsonrpc: '2.0';
    id: string | number | null;
    result?: any | null;
    error?: JsonRpcError;
  }> {
    // Per JSON-RPC 2.0: Validate params is an object (not array/primitive)
    const validation = validateObjectParams(
      request.params,
      'session/request_permission'
    );
    if (!validation.valid) {
      return createErrorResponse(request.id, validation.error);
    }

    const params = validation.params;

    if (!params['sessionId'] || typeof params['sessionId'] !== 'string') {
      throw new ProtocolError('sessionId is required and must be a string');
    }

    if (!params['toolCall'] || typeof params['toolCall'] !== 'object') {
      throw new ProtocolError('toolCall is required and must be an object');
    }

    if (!Array.isArray(params['options']) || params['options'].length === 0) {
      throw new ProtocolError(
        'options is required and must be a non-empty array'
      );
    }

    // Validate options
    for (const option of params['options'] as any[]) {
      if (!this.isValidPermissionOption(option)) {
        throw new ProtocolError(
          `Invalid permission option: ${JSON.stringify(option)}`
        );
      }
    }

    this.logger.debug('Processing permission request', {
      requestId: request.id,
      sessionId: params['sessionId'],
      toolCallId: (params['toolCall'] as any).toolCallId,
      optionCount: (params['options'] as any[]).length,
    });

    // In a real implementation, this would:
    // 1. Display the permission request to the user
    // 2. Wait for user response
    // 3. Return the outcome
    //
    // For now, we'll implement a simple default behavior:
    // - Allow file reads by default
    // - Require explicit permission for edits/deletes/executes

    const outcome = this.getDefaultPermissionOutcome(
      (params['toolCall'] as any).kind || 'other',
      params['options'] as any[]
    );

    this.logger.debug('Permission request outcome', {
      requestId: request.id,
      sessionId: params['sessionId'],
      outcome,
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
      id: request.id,
      result: {
        outcome,
      },
    };
  }

  /**
   * Resolve a pending permission request with an outcome
   */
  resolvePermissionRequest(
    requestId: string | number,
    outcome: PermissionOutcome
  ): boolean {
    const pending = this.pendingRequests.get(requestId);

    if (!pending) {
      this.logger.warn('Permission request not found', { requestId });
      return false;
    }

    // Clear timeout
    clearTimeout(pending.timeout);

    // Resolve the promise
    pending.resolve(outcome);

    // Remove from pending
    this.pendingRequests.delete(requestId);

    this.logger.debug('Permission request resolved', {
      requestId,
      sessionId: pending.sessionId,
      outcome,
    });

    return true;
  }

  /**
   * Cancel all pending permission requests for a session
   */
  cancelSessionPermissionRequests(sessionId: string): void {
    this.logger.info('Cancelling permission requests for session', {
      sessionId,
    });

    const cancelled: Array<string | number> = [];

    for (const [requestId, pending] of this.pendingRequests) {
      if (pending.sessionId === sessionId) {
        clearTimeout(pending.timeout);
        pending.resolve({ outcome: 'cancelled' });
        cancelled.push(requestId);
      }
    }

    // Remove cancelled requests
    for (const requestId of cancelled) {
      this.pendingRequests.delete(requestId);
    }

    this.logger.debug('Session permission requests cancelled', {
      sessionId,
      count: cancelled.length,
    });
  }

  /**
   * Get default permission outcome based on tool kind
   * This is a simple default implementation - production systems
   * should implement actual user prompts
   */
  private getDefaultPermissionOutcome(
    toolKind: string,
    options: PermissionOption[]
  ): PermissionOutcome {
    // Find allow_once option (preferred default)
    const allowOnceOption = options.find((opt) => opt.kind === 'allow_once');
    if (allowOnceOption) {
      // Auto-allow safe operations
      if (
        toolKind === 'read' ||
        toolKind === 'search' ||
        toolKind === 'think' ||
        toolKind === 'fetch'
      ) {
        return { outcome: 'selected', optionId: allowOnceOption.optionId };
      }
    }

    // Find reject_once option for potentially dangerous operations
    const rejectOnceOption = options.find((opt) => opt.kind === 'reject_once');
    if (rejectOnceOption) {
      // Require explicit permission for dangerous operations
      if (
        toolKind === 'edit' ||
        toolKind === 'delete' ||
        toolKind === 'execute' ||
        toolKind === 'move'
      ) {
        this.logger.warn(
          'Rejecting potentially dangerous operation by default',
          { toolKind }
        );
        return { outcome: 'selected', optionId: rejectOnceOption.optionId };
      }
    }

    // Fallback: use first option
    return { outcome: 'selected', optionId: options[0]!.optionId };
  }

  /**
   * Validate permission option
   */
  private isValidPermissionOption(option: any): option is PermissionOption {
    if (!option || typeof option !== 'object') {
      return false;
    }

    if (typeof option.optionId !== 'string' || !option.optionId) {
      return false;
    }

    if (typeof option.name !== 'string' || !option.name) {
      return false;
    }

    if (
      option.kind !== 'allow_once' &&
      option.kind !== 'allow_always' &&
      option.kind !== 'reject_once' &&
      option.kind !== 'reject_always'
    ) {
      return false;
    }

    return true;
  }

  /**
   * Get metrics about permission requests
   */
  getMetrics(): Record<string, any> {
    return {
      pendingRequests: this.pendingRequests.size,
    };
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    this.logger.debug('Cleaning up permissions handler');

    // Cancel all pending requests
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.resolve({ outcome: 'cancelled' });
      this.pendingRequests.delete(requestId);
    }
  }
}
