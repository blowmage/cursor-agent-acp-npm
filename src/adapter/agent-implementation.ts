/**
 * Agent Implementation for ACP SDK
 *
 * Implements the Agent interface from @agentclientprotocol/sdk,
 * delegating to the existing adapter handler methods.
 *
 * This enables the adapter to use AgentSideConnection for bi-directional
 * communication, allowing file system tools to call client methods.
 */

import type {
  Agent,
  AgentSideConnection,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  SetSessionModelRequest,
  SetSessionModelResponse,
  AuthenticateRequest,
  AuthenticateResponse,
  PromptRequest,
  PromptResponse,
  CancelNotification,
} from '@agentclientprotocol/sdk';
import type { CursorAgentAdapter } from './cursor-agent-adapter';
import type { Logger } from '../types';

/**
 * Agent implementation that delegates to CursorAgentAdapter
 *
 * This class implements the Agent interface required by AgentSideConnection,
 * allowing the adapter to use the SDK's connection management and enabling
 * bi-directional communication for file system operations.
 */
export class CursorAgentImplementation implements Agent {
  private adapter: CursorAgentAdapter;
  private connection: AgentSideConnection;
  private logger: Logger;

  constructor(
    adapter: CursorAgentAdapter,
    connection: AgentSideConnection,
    logger: Logger
  ) {
    this.adapter = adapter;
    this.connection = connection;
    this.logger = logger;

    this.logger.debug('CursorAgentImplementation created');
  }

  /**
   * Initialize the agent connection
   * Per ACP spec: https://agentclientprotocol.com/protocol/initialization
   */
  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.logger.debug('Agent.initialize called', { params });

    try {
      const result = await this.adapter.handleInitializeFromAgent(
        params,
        this.connection
      );
      return result;
    } catch (error) {
      this.logger.error('Agent.initialize failed', { error, params });
      throw error;
    }
  }

  /**
   * Create a new session
   * Per ACP spec: https://agentclientprotocol.com/protocol/session-setup
   */
  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    this.logger.debug('Agent.newSession called', { params });

    try {
      const result = await this.adapter.handleNewSessionFromAgent(params);
      return result;
    } catch (error) {
      this.logger.error('Agent.newSession failed', { error, params });
      throw error;
    }
  }

  /**
   * Load an existing session
   * Per ACP spec: https://agentclientprotocol.com/protocol/session-setup#loading-sessions
   */
  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    this.logger.debug('Agent.loadSession called', { params });

    try {
      const result = await this.adapter.handleLoadSessionFromAgent(params);
      return result;
    } catch (error) {
      this.logger.error('Agent.loadSession failed', { error, params });
      throw error;
    }
  }

  /**
   * Set session mode
   * Per ACP spec: https://agentclientprotocol.com/protocol/session-modes
   */
  async setSessionMode(
    params: SetSessionModeRequest
  ): Promise<SetSessionModeResponse | void> {
    this.logger.debug('Agent.setSessionMode called', { params });

    try {
      const result = await this.adapter.handleSetSessionModeFromAgent(params);
      return result;
    } catch (error) {
      this.logger.error('Agent.setSessionMode failed', { error, params });
      throw error;
    }
  }

  /**
   * Set session model (UNSTABLE)
   */
  async setSessionModel(
    params: SetSessionModelRequest
  ): Promise<SetSessionModelResponse | void> {
    this.logger.debug('Agent.setSessionModel called', { params });

    try {
      const result = await this.adapter.handleSetSessionModelFromAgent(params);
      return result;
    } catch (error) {
      this.logger.error('Agent.setSessionModel failed', { error, params });
      throw error;
    }
  }

  /**
   * Authenticate
   * Per ACP spec: https://agentclientprotocol.com/protocol/initialization
   */
  async authenticate(
    params: AuthenticateRequest
  ): Promise<AuthenticateResponse | void> {
    this.logger.debug('Agent.authenticate called', { params });

    try {
      // Currently not implemented - no authentication required
      this.logger.info('Authentication not required for this agent');
      return undefined;
    } catch (error) {
      this.logger.error('Agent.authenticate failed', { error, params });
      throw error;
    }
  }

  /**
   * Process a prompt
   * Per ACP spec: https://agentclientprotocol.com/protocol/prompt-turn
   */
  async prompt(params: PromptRequest): Promise<PromptResponse> {
    this.logger.debug('Agent.prompt called', {
      sessionId: params.sessionId,
    });

    try {
      const result = await this.adapter.handlePromptFromAgent(params);
      return result;
    } catch (error) {
      this.logger.error('Agent.prompt failed', {
        error,
        sessionId: params.sessionId,
      });
      throw error;
    }
  }

  /**
   * Cancel ongoing operations
   * Per ACP spec: https://agentclientprotocol.com/protocol/prompt-turn#cancellation
   */
  async cancel(params: CancelNotification): Promise<void> {
    this.logger.debug('Agent.cancel called', { params });

    try {
      await this.adapter.handleCancelFromAgent(params);
    } catch (error) {
      this.logger.error('Agent.cancel failed', { error, params });
      // Don't throw - cancellation should be best-effort
    }
  }

  /**
   * Extension method handler
   */
  async extMethod(
    method: string,
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    this.logger.debug('Agent.extMethod called', { method, params });

    this.logger.warn('Extension methods not implemented', { method });
    throw new Error(`Extension method not supported: ${method}`);
  }

  /**
   * Extension notification handler
   */
  async extNotification(
    method: string,
    params: Record<string, unknown>
  ): Promise<void> {
    this.logger.debug('Agent.extNotification called', { method, params });

    this.logger.info('Extension notification received but not handled', {
      method,
    });
    // Notifications don't return anything - just log and ignore
  }
}
