/**
 * Terminal Manager
 *
 * Wraps client-side terminal operations per ACP spec.
 * Agents request terminals from the client, which manages actual execution.
 *
 * Per ACP spec: https://agentclientprotocol.com/protocol/terminals
 * - Terminals are client-provided capabilities
 * - Agent requests terminals via terminal/create
 * - Client manages process execution
 * - Agent controls via TerminalHandle
 */

import type {
  CreateTerminalRequest,
  TerminalHandle,
  EnvVariable,
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
 * Client interface for terminal operations
 * This is the subset of AgentSideConnection needed for terminals
 */
export interface TerminalClient {
  createTerminal(params: CreateTerminalRequest): Promise<TerminalHandle>;
}

/**
 * Terminal Manager
 *
 * Manages terminal operations using ACP client-side model.
 * Validates against agent policies and tracks active terminals.
 */
export class TerminalManager {
  private config: TerminalManagerConfig;
  private logger: Logger;
  private client: TerminalClient;
  private activeTerminals = new Map<string, TerminalMetadata>();

  constructor(
    config: TerminalManagerConfig,
    client: TerminalClient,
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
   */
  canCreateTerminals(): boolean {
    return this.config.clientSupportsTerminals;
  }

  /**
   * Request client to create a terminal
   * Per ACP spec: terminal/create
   *
   * @param sessionId - The session ID for this request
   * @param params - Terminal creation parameters
   * @returns TerminalHandle for controlling the terminal
   * @throws ProtocolError if client doesn't support terminals
   * @throws ToolError if validation fails or limits exceeded
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

      return handle;
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
   * Note: Actual release is handled by TerminalHandle.release()
   * This method is just for tracking cleanup
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
