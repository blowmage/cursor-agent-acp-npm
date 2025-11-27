/**
 * Terminal Manager
 *
 * Wraps client-side terminal operations per ACP spec.
 * Agents request terminals from the client, which manages actual execution.
 *
 * Per ACP spec: https://agentclientprotocol.com/protocol/terminals
 * Per ACP schema: https://agentclientprotocol.com/protocol/schema#terminal
 *
 * SDK Types Used:
 * - CreateTerminalRequest: Request to create a new terminal
 * - CreateTerminalResponse: Response with terminal ID and metadata
 * - TerminalHandle: Handle for interacting with terminal
 * - Terminal: Content type for terminal output in tool calls
 * - TerminalExitStatus: Exit status of completed commands
 * - EnvVariable: Environment variable definition
 *
 * Protocol Flow:
 * - Terminals are client-provided capabilities
 * - Agent requests terminals via terminal/create (client method)
 * - Client manages process execution and returns TerminalHandle
 * - Agent controls via TerminalHandle methods (write, kill, waitForExit, release)
 */

import type {
  CreateTerminalRequest,
  TerminalHandle,
  EnvVariable,
  AgentSideConnection,
} from '@agentclientprotocol/sdk';

import type { Logger } from '../types';
import { ProtocolError, ToolError } from '../types';

/**
 * Terminal manager configuration
 */
export interface TerminalManagerConfig {
  /**
   * Whether client supports terminal operations
   * Must be checked via clientCapabilities.terminal
   */
  clientSupportsTerminals: boolean;

  /**
   * Maximum number of concurrent terminals (agent-side policy)
   */
  maxConcurrentTerminals: number;

  /**
   * Default output byte limit for terminals
   */
  defaultOutputByteLimit?: number;

  /**
   * Maximum output byte limit (cap on what can be requested)
   */
  maxOutputByteLimit?: number;

  /**
   * Commands that are forbidden (agent-side security policy)
   */
  forbiddenCommands?: string[];

  /**
   * Commands that are allowed (if set, only these are allowed)
   */
  allowedCommands?: string[];

  /**
   * Default working directory for commands
   */
  defaultCwd?: string;

  /**
   * Default environment variables
   */
  defaultEnv?: EnvVariable[];
}

/**
 * Metadata for tracking active terminals
 */
interface TerminalMetadata {
  id: string;
  sessionId: string;
  command: string;
  args?: string[];
  createdAt: Date;
  lastActivity: Date;
}

/**
 * Wrapper for TerminalHandle that automatically cleans up manager tracking
 * when released via Symbol.asyncDispose or release()
 *
 * This ensures that when using `await using`, both the client-side terminal
 * and the manager's tracking are cleaned up automatically.
 *
 * Uses composition to wrap the TerminalHandle and delegate all calls to it,
 * while overriding release() and Symbol.asyncDispose to also clean up manager tracking.
 */
class ManagedTerminalHandle {
  readonly id: string;
  private handle: TerminalHandle;
  private manager: TerminalManager;
  private released = false;

  constructor(handle: TerminalHandle, manager: TerminalManager) {
    this.id = handle.id;
    this.handle = handle;
    this.manager = manager;
  }

  async currentOutput() {
    return this.handle.currentOutput();
  }

  async waitForExit() {
    return this.handle.waitForExit();
  }

  async kill() {
    return this.handle.kill();
  }

  async release() {
    if (this.released) {
      return;
    }
    this.released = true;
    await this.handle.release();
    this.manager.releaseTerminal(this.id);
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.release();
  }
}

/**
 * Terminal Manager
 *
 * Manages terminal operations using ACP client-side model.
 * Validates against agent policies and tracks active terminals.
 *
 * Per ACP spec: https://agentclientprotocol.com/protocol/terminals
 * - Terminals are client-provided capabilities
 * - Agent requests terminals via terminal/create
 * - Client manages process execution
 * - Agent controls via TerminalHandle
 */
export class TerminalManager {
  private config: TerminalManagerConfig;
  private logger: Logger;
  private client: AgentSideConnection;
  private activeTerminals = new Map<string, TerminalMetadata>();

  constructor(
    config: TerminalManagerConfig,
    client: AgentSideConnection,
    logger: Logger
  ) {
    this.config = config;
    this.client = client;
    this.logger = logger;

    this.logger.debug('TerminalManager initialized', {
      clientSupportsTerminals: config.clientSupportsTerminals,
      maxConcurrentTerminals: config.maxConcurrentTerminals,
    });
  }

  /**
   * Check if client supports terminal operations
   *
   * Per ACP spec: https://agentclientprotocol.com/protocol/terminals#checking-support
   * Agents MUST verify that the Client supports this capability before attempting
   * to call any terminal methods.
   *
   * @returns true if client supports terminals, false otherwise
   */
  canCreateTerminals(): boolean {
    return this.config.clientSupportsTerminals;
  }

  /**
   * Request client to create a terminal
   *
   * Per ACP spec: https://agentclientprotocol.com/protocol/terminals#executing-commands
   *
   * This method calls the client's `terminal/create` method via AgentSideConnection.
   * The client manages actual process execution, and returns a TerminalHandle for control.
   *
   * **Requirements:**
   * - Client MUST support terminals (checked via `clientCapabilities.terminal`)
   * - Agent MUST release terminal using `terminal/release` when done
   *
   * @param sessionId - The session ID for this request (required per ACP spec)
   * @param params - Terminal creation parameters matching CreateTerminalRequest
   * @returns TerminalHandle from SDK for controlling the terminal
   * @throws ProtocolError if client doesn't support terminals (per ACP spec)
   * @throws ToolError if validation fails or limits exceeded (agent-side policy)
   *
   * @example
   * ```typescript
   * const terminal = await terminalManager.createTerminal('session-1', {
   *   command: 'npm',
   *   args: ['test'],
   *   cwd: '/project',
   *   outputByteLimit: 1048576
   * });
   *
   * // Use terminal...
   * await terminal.release(); // MUST release per ACP spec
   * ```
   */
  async createTerminal(
    sessionId: string,
    params: {
      command: string;
      args?: string[];
      cwd?: string;
      env?: EnvVariable[];
      outputByteLimit?: number;
    }
  ): Promise<TerminalHandle> {
    // Check client capability first
    if (!this.config.clientSupportsTerminals) {
      throw new ProtocolError(
        'Client does not support terminal operations. ' +
          'The client must set terminal: true in clientCapabilities.'
      );
    }

    // Validate command against agent policies
    this.validateCommand(params.command);

    // Check concurrent limits
    if (this.activeTerminals.size >= this.config.maxConcurrentTerminals) {
      throw new ToolError(
        `Maximum concurrent terminals reached (${this.config.maxConcurrentTerminals})`,
        'terminal'
      );
    }

    // Validate and apply output byte limit
    const outputByteLimit = this.validateOutputByteLimit(
      params.outputByteLimit
    );

    this.logger.debug('Creating terminal', {
      sessionId,
      command: params.command,
      args: params.args,
      cwd: params.cwd,
      outputByteLimit,
    });

    // Build SDK-compliant request
    const request: CreateTerminalRequest = {
      sessionId,
      command: params.command,
      ...(params.args && params.args.length > 0 && { args: params.args }),
      ...(params.cwd && { cwd: params.cwd }),
      ...(params.env && params.env.length > 0 && { env: params.env }),
      ...(outputByteLimit !== undefined && { outputByteLimit }),
    };

    try {
      // Call client method (via AgentSideConnection)
      const handle = await this.client.createTerminal(request);

      // Track active terminal
      const metadata: TerminalMetadata = {
        id: handle.id,
        sessionId,
        command: params.command,
        ...(params.args && { args: params.args }),
        createdAt: new Date(),
        lastActivity: new Date(),
      };

      this.activeTerminals.set(handle.id, metadata);

      this.logger.info('Terminal created', {
        terminalId: handle.id,
        sessionId,
        command: params.command,
      });

      // Wrap handle to automatically clean up manager tracking on release
      // Type assertion needed because ManagedTerminalHandle wraps TerminalHandle
      // but doesn't implement all internal properties (like #private)
      return new ManagedTerminalHandle(
        handle,
        this
      ) as unknown as TerminalHandle;
    } catch (error) {
      this.logger.error('Failed to create terminal', {
        error,
        sessionId,
        command: params.command,
      });

      if (error instanceof ProtocolError) {
        throw error;
      }

      throw new ToolError(
        `Failed to create terminal: ${error instanceof Error ? error.message : String(error)}`,
        'terminal',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Update last activity time for a terminal
   */
  updateActivity(terminalId: string): void {
    const metadata = this.activeTerminals.get(terminalId);
    if (metadata) {
      metadata.lastActivity = new Date();
    }
  }

  /**
   * Release terminal and cleanup tracking
   *
   * Per ACP spec: https://agentclientprotocol.com/protocol/terminals#releasing-terminals
   * The Agent MUST call terminal/release when it's no longer needed.
   *
   * Note: Actual release is handled by TerminalHandle.release()
   * This method is just for tracking cleanup in the manager.
   *
   * @param terminalId - The terminal ID to release from tracking
   */
  releaseTerminal(terminalId: string): void {
    const metadata = this.activeTerminals.get(terminalId);
    if (!metadata) {
      this.logger.warn('Terminal not found for release', { terminalId });
      return;
    }

    this.activeTerminals.delete(terminalId);

    this.logger.debug('Terminal released from tracking', {
      terminalId,
      sessionId: metadata.sessionId,
      duration: Date.now() - metadata.createdAt.getTime(),
    });
  }

  /**
   * Get metadata for a terminal
   */
  getTerminalMetadata(terminalId: string): TerminalMetadata | undefined {
    return this.activeTerminals.get(terminalId);
  }

  /**
   * Get all active terminals for a session
   */
  getSessionTerminals(sessionId: string): TerminalMetadata[] {
    const terminals: TerminalMetadata[] = [];
    for (const metadata of this.activeTerminals.values()) {
      if (metadata.sessionId === sessionId) {
        terminals.push(metadata);
      }
    }
    return terminals;
  }

  /**
   * Get count of active terminals
   */
  getActiveTerminalCount(): number {
    return this.activeTerminals.size;
  }

  /**
   * Validate command against security policies
   *
   * Performs agent-side validation of commands before requesting terminal creation.
   * This is an agent-side security policy, separate from client-side security.
   *
   * @param command - The command to validate
   * @throws ToolError if command is invalid or violates security policies
   */
  private validateCommand(command: string): void {
    if (!command || typeof command !== 'string' || command.trim() === '') {
      throw new ToolError(
        'Invalid command: must be a non-empty string',
        'terminal'
      );
    }

    const trimmedCommand = command.trim();

    // Check forbidden commands
    if (
      this.config.forbiddenCommands &&
      this.config.forbiddenCommands.length > 0
    ) {
      const isForbidden = this.config.forbiddenCommands.some((forbidden) =>
        trimmedCommand.toLowerCase().includes(forbidden.toLowerCase())
      );

      if (isForbidden) {
        throw new ToolError(
          `Command contains forbidden pattern: ${command}`,
          'terminal'
        );
      }
    }

    // Check allowed commands (if specified)
    if (this.config.allowedCommands && this.config.allowedCommands.length > 0) {
      const isAllowed = this.config.allowedCommands.some((allowed) =>
        trimmedCommand.toLowerCase().startsWith(allowed.toLowerCase())
      );

      if (!isAllowed) {
        throw new ToolError(
          `Command not in allowed list: ${command}. ` +
            `Allowed: ${this.config.allowedCommands.join(', ')}`,
          'terminal'
        );
      }
    }
  }

  /**
   * Validate and apply output byte limit
   *
   * Per ACP spec: https://agentclientprotocol.com/protocol/terminals#executing-commands
   * The outputByteLimit parameter specifies the maximum number of output bytes to retain.
   * When exceeded, the Client truncates from the beginning at character boundaries.
   *
   * @param requested - The requested output byte limit
   * @returns The validated output byte limit (may be capped to maximum)
   * @throws ToolError if requested limit is negative
   */
  private validateOutputByteLimit(requested?: number): number | undefined {
    // If not requested, use default
    if (requested === undefined) {
      return this.config.defaultOutputByteLimit;
    }

    // Validate it's a positive number
    if (requested < 0) {
      throw new ToolError(
        'Output byte limit must be a positive number',
        'terminal'
      );
    }

    // Apply maximum limit if configured
    if (
      this.config.maxOutputByteLimit !== undefined &&
      requested > this.config.maxOutputByteLimit
    ) {
      this.logger.warn('Output byte limit capped to maximum', {
        requested,
        max: this.config.maxOutputByteLimit,
      });
      return this.config.maxOutputByteLimit;
    }

    return requested;
  }

  /**
   * Cleanup all tracked terminals
   * Note: This doesn't release actual terminals, just clears tracking
   * Actual terminals should be released by their handles
   */
  cleanup(): void {
    this.logger.debug('Cleaning up terminal manager', {
      activeTerminals: this.activeTerminals.size,
    });

    this.activeTerminals.clear();
  }

  /**
   * Get metrics about terminal usage
   */
  getMetrics(): {
    activeTerminals: number;
    maxConcurrentTerminals: number;
    terminalsBySession: Record<string, number>;
  } {
    const terminalsBySession: Record<string, number> = {};

    for (const metadata of this.activeTerminals.values()) {
      terminalsBySession[metadata.sessionId] =
        (terminalsBySession[metadata.sessionId] || 0) + 1;
    }

    return {
      activeTerminals: this.activeTerminals.size,
      maxConcurrentTerminals: this.config.maxConcurrentTerminals,
      terminalsBySession,
    };
  }
}
