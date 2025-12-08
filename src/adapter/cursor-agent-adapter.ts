/**
 * Cursor Agent ACP Adapter - Main Entry Point
 *
 * This is the main adapter class that orchestrates all components:
 * - ACP protocol handling (initialization, sessions, prompts)
 * - Cursor CLI integration
 * - Tool registry and execution
 * - Stdio transport handling (per ACP spec)
 */

import {
  AgentSideConnection,
  ndJsonStream,
  type Request,
  type Request1,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type SetSessionModelRequest,
  type SetSessionModelResponse,
  type SessionModeState,
  type SessionModelState,
  type SessionNotification,
  type CancelNotification,
  type PromptRequest,
  type PromptResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from '@agentclientprotocol/sdk';
import type { Error as JsonRpcError } from '@agentclientprotocol/sdk';
import { CursorAgentImplementation } from './agent-implementation';
import {
  AdapterError,
  ProtocolError,
  type AdapterConfig,
  type AdapterOptions,
  type Logger,
  type SessionListParams,
  type SessionUpdateParams,
  type SessionDeleteParams,
  type SessionMetadata,
  type ToolCallParams,
} from '../types';
import { createLogger } from '../utils/logger';
import { validateConfig } from '../utils/config';
import { validateObjectParams, createErrorResponse } from '../utils/json-rpc';
import { SessionManager } from '../session/manager';
import { CursorCliBridge } from '../cursor/cli-bridge';
import { ToolRegistry } from '../tools/registry';
import { ToolCallManager } from '../tools/tool-call-manager';
import { InitializationHandler } from '../protocol/initialization';
import { PromptHandler } from '../protocol/prompt';
import { PermissionsHandler } from '../protocol/permissions';
import type { ClientConnection } from '../client/client-connection';
import { AcpFileSystemClient } from '../client/filesystem-client';
import { FilesystemToolProvider } from '../tools/filesystem';
import { SlashCommandsRegistry } from '../tools/slash-commands';
import { ExtensionRegistry } from '../tools/extension-registry';

export class CursorAgentAdapter implements ClientConnection {
  private config: AdapterConfig;
  private logger: Logger;
  private isRunning = false;
  private startTime?: Date;

  // Core components
  private sessionManager?: SessionManager;
  private cursorBridge?: CursorCliBridge;
  private toolRegistry?: ToolRegistry;
  private toolCallManager?: ToolCallManager;
  private permissionsHandler?: PermissionsHandler;
  private initializationHandler?: InitializationHandler;
  private promptHandler?: PromptHandler;
  private slashCommandsRegistry?: SlashCommandsRegistry;
  private extensionRegistry?: ExtensionRegistry;

  // ACP-compliant file system client
  private fileSystemClient?: AcpFileSystemClient;

  // SDK connection for bi-directional communication
  private agentConnection?: AgentSideConnection;

  constructor(config: AdapterConfig, options: AdapterOptions = {}) {
    this.config = config;
    this.logger =
      options.logger ||
      createLogger({
        level: config.logLevel,
      });

    this.logger.debug('CursorAgentAdapter created', { config });

    // Validate configuration
    const validation = validateConfig(this.config);
    if (!validation.valid) {
      throw new AdapterError(
        `Invalid configuration: ${validation.errors.join(', ')}`,
        'CONFIG_ERROR'
      );
    }
  }

  /**
   * Initialize all adapter components
   */
  async initialize(): Promise<void> {
    if (this.isRunning) {
      throw new AdapterError('Adapter is already running', 'ADAPTER_RUNNING');
    }

    try {
      this.logger.info('Initializing Cursor Agent ACP Adapter...');

      // Initialize core components
      await this.initializeComponents();

      // Verify Cursor CLI integration
      await this.verifyCursorIntegration();

      // Validate tool configuration
      this.validateToolConfiguration();

      this.logger.info('Adapter initialization completed successfully');
    } catch (error) {
      this.logger.error('Adapter initialization failed', error);
      await this.cleanup();
      throw new AdapterError(
        `Initialization failed: ${error instanceof Error ? error.message : String(error)}`,
        'INIT_ERROR',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Start the adapter with stdio transport (for ACP clients)
   *
   * Per ACP Transport Specification: https://agentclientprotocol.com/protocol/transports
   *
   * Stdio is the default and recommended transport for the Agent Client Protocol.
   * This implementation strictly follows the ACP spec:
   *
   * ## Transport Requirements:
   * - Client launches the agent as a subprocess
   * - Agent reads JSON-RPC messages from stdin
   * - Agent writes JSON-RPC messages to stdout
   * - Messages are delimited by newlines (\n)
   * - Messages MUST NOT contain embedded newlines
   * - stderr is used for logging (UTF-8 strings only)
   * - Only valid ACP messages on stdin/stdout
   *
   * ## Implementation Details:
   * - Uses SDK's AgentSideConnection for protocol handling
   * - Uses ndJsonStream for newline-delimited JSON-RPC
   * - Converts Node.js streams to Web Streams API
   * - Handles stdin buffering before stream initialization
   * - Proper cleanup on connection close or error
   * - Enables bi-directional communication for file system operations
   *
   * ## Error Handling:
   * - Malformed JSON triggers connection error
   * - Stream errors are logged and propagated
   * - Graceful shutdown on connection close
   *
   * @throws {AdapterError} If adapter is already running or stdio setup fails
   */
  async startStdio(): Promise<void> {
    if (this.isRunning) {
      throw new AdapterError('Adapter is already running', 'ADAPTER_RUNNING');
    }

    try {
      this.logger.info(
        'Starting ACP adapter with stdio transport (per ACP spec)'
      );
      this.startTime = new Date();
      this.isRunning = true;

      // Create Web Streams for stdout
      // Per ACP spec: JSON-RPC messages written to stdout, delimited by newlines
      const output = new WritableStream<Uint8Array>({
        write(chunk) {
          process.stdout.write(chunk);
        },
      });

      // Buffer for pre-existing stdin data before stream starts
      // Ensures no messages are lost during initialization
      const stdinBuffer: Buffer[] = [];
      let started = false;
      const preDataListener = (chunk: Buffer) => {
        stdinBuffer.push(chunk);
      };
      process.stdin.on('data', preDataListener);

      // Define handlers in outer scope for proper cleanup in cancel()
      let dataHandler: ((chunk: Buffer) => void) | null = null;
      let endHandler: (() => void) | null = null;
      let errorHandler: ((err: Error) => void) | null = null;

      // Create Web Streams for stdin
      // Per ACP spec: JSON-RPC messages read from stdin, delimited by newlines
      const input = new ReadableStream<Uint8Array>({
        start(controller) {
          started = true;
          // Remove temporary buffer listener
          process.stdin.removeListener('data', preDataListener);

          // Drain any buffered data to prevent message loss
          for (const chunk of stdinBuffer) {
            controller.enqueue(new Uint8Array(chunk));
          }
          stdinBuffer.length = 0;

          // Set up permanent stream handlers
          dataHandler = (chunk: Buffer) => {
            controller.enqueue(new Uint8Array(chunk));
          };
          endHandler = () => {
            controller.close();
          };
          errorHandler = (err: Error) => {
            controller.error(err);
          };

          // Attach handlers to stdin stream
          process.stdin.on('data', dataHandler);
          process.stdin.on('end', endHandler);
          process.stdin.on('error', errorHandler);
        },
        cancel() {
          // Per ACP spec: Clean up resources on connection close
          // Remove listeners to prevent memory leaks
          if (started && dataHandler && endHandler && errorHandler) {
            process.stdin.removeListener('data', dataHandler);
            process.stdin.removeListener('end', endHandler);
            process.stdin.removeListener('error', errorHandler);
            dataHandler = null;
            endHandler = null;
            errorHandler = null;
          }
        },
      });

      // Use SDK's ndJsonStream for newline-delimited JSON-RPC
      // Per ACP spec: Messages delimited by \n, no embedded newlines allowed
      const stream = ndJsonStream(output, input);

      this.logger.debug('Creating AgentSideConnection with stdio transport');

      // Create SDK AgentSideConnection with our Agent implementation
      // This handles all JSON-RPC 2.0 protocol details per ACP spec
      this.agentConnection = new AgentSideConnection((conn) => {
        this.logger.debug(
          'AgentSideConnection established - stdio transport active'
        );
        return new CursorAgentImplementation(this, conn, this.logger);
      }, stream);

      this.logger.info(
        'Adapter started successfully with stdio transport (ACP compliant)'
      );

      // Wait for connection to close
      // Per ACP spec: Connection lifecycle managed by client
      await this.agentConnection.closed;

      this.logger.info('Stdio connection closed, shutting down adapter');
      await this.shutdown();
    } catch (error) {
      this.isRunning = false;
      this.logger.error('Failed to start stdio transport', error);
      throw new AdapterError(
        `Failed to start stdio transport: ${error instanceof Error ? error.message : String(error)}`,
        'STARTUP_ERROR',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Shutdown the adapter gracefully
   */
  async shutdown(): Promise<void> {
    try {
      this.logger.info('Shutting down ACP adapter...');

      // Cleanup components
      await this.cleanup();

      this.isRunning = false;
      this.logger.info('ACP adapter shut down successfully');
    } catch (error) {
      this.logger.error('Error during shutdown', error);
      throw new AdapterError(
        `Failed to shutdown adapter: ${error instanceof Error ? error.message : String(error)}`,
        'SHUTDOWN_ERROR',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get the slash commands registry
   * Per ACP spec: Provides access to register and manage slash commands
   *
   * @returns SlashCommandsRegistry instance
   *
   * @example
   * ```typescript
   * const registry = adapter.getSlashCommandsRegistry();
   * registry.registerCommand('web', 'Search the web', 'query');
   * ```
   */
  getSlashCommandsRegistry(): SlashCommandsRegistry {
    if (!this.slashCommandsRegistry) {
      throw new AdapterError(
        'Slash commands registry not initialized',
        'COMPONENT_ERROR'
      );
    }
    return this.slashCommandsRegistry;
  }

  /**
   * Update available commands for a session
   * Per ACP spec: Sends available_commands_update notification dynamically
   *
   * @param sessionId - The session ID to send the update to
   *
   * @example
   * ```typescript
   * // Update commands dynamically during a session
   * adapter.updateAvailableCommands(sessionId);
   * ```
   */
  updateAvailableCommands(sessionId: string): void {
    if (!this.sessionManager) {
      throw new AdapterError(
        'Session manager not initialized',
        'COMPONENT_ERROR'
      );
    }

    // Verify session exists using public API
    if (!this.sessionManager.hasSession(sessionId)) {
      this.logger.warn('Cannot update commands for non-existent session', {
        sessionId,
      });
      return;
    }

    // Send the update
    this.sendAvailableCommandsUpdate(sessionId);
  }

  /**
   * Process ACP request and return response
   */
  async processRequest(request: Request | Request1): Promise<{
    jsonrpc: '2.0';
    id: string | number | null;
    result?: any | null;
    error?: JsonRpcError;
  }> {
    this.logger.debug('Processing ACP request', {
      method: request.method,
      id: request.id,
    });

    try {
      switch (request.method) {
        case 'initialize':
          return await this.handleInitialize(request);

        case 'session/new':
          return await this.handleSessionNew(request);

        case 'session/load':
          return await this.handleSessionLoad(request);

        case 'session/set_mode':
          return await this.handleSetSessionMode(request);

        case 'session/set_model':
          return await this.handleSetSessionModel(request);

        case 'session/list':
          return await this.handleSessionList(request);

        case 'session/update':
          return await this.handleSessionUpdate(request);

        case 'session/delete':
          return await this.handleSessionDelete(request);

        case 'session/prompt':
          return await this.handleSessionPrompt(request);

        case 'session/cancel':
          return await this.handleSessionCancel(request);

        case 'session/request_permission':
          return await this.handleRequestPermission(request);

        case 'tools/list':
          return await this.handleToolsList(request);

        case 'tools/call':
          return await this.handleToolCall(request);

        default:
          // Per ACP spec: Check if this is an extension method (starts with _)
          if (request.method.startsWith('_')) {
            return await this.handleExtensionMethod(request);
          }
          throw new ProtocolError(`Unknown method: ${request.method}`);
      }
    } catch (error) {
      this.logger.error('Request processing failed', { error, request });

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
        error: {
          code: error instanceof ProtocolError ? -32601 : -32603,
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
   * Get adapter status and metrics
   */
  getStatus(): {
    running: boolean;
    uptime?: number;
    config: AdapterConfig;
    components: Record<string, boolean>;
    metrics: Record<string, any>;
  } {
    const uptime = this.startTime
      ? Date.now() - this.startTime.getTime()
      : undefined;

    const result: any = {
      running: this.isRunning,
      config: this.config,
      components: {
        sessionManager: Boolean(this.sessionManager),
        cursorBridge: Boolean(this.cursorBridge),
        toolRegistry: Boolean(this.toolRegistry),
        toolCallManager: Boolean(this.toolCallManager),
        permissionsHandler: Boolean(this.permissionsHandler),
        initializationHandler: Boolean(this.initializationHandler),
        promptHandler: Boolean(this.promptHandler),
      },
      metrics: {
        sessions: this.sessionManager?.getMetrics() || {},
        tools: this.toolRegistry?.getMetrics() || {},
        toolCalls: this.toolCallManager?.getMetrics() || {},
        permissions: this.permissionsHandler?.getMetrics() || {},
      },
    };

    if (uptime !== undefined) {
      result.uptime = uptime;
    }

    return result;
  }

  // Private methods

  private async initializeComponents(): Promise<void> {
    // Initialize SessionManager
    this.sessionManager = new SessionManager(this.config, this.logger);

    // Initialize CursorCliBridge
    this.cursorBridge = new CursorCliBridge(this.config, this.logger);

    // Initialize SlashCommandsRegistry
    this.slashCommandsRegistry = new SlashCommandsRegistry(this.logger);
    this.registerDefaultCommands();

    // Initialize ExtensionRegistry
    this.extensionRegistry = new ExtensionRegistry(this.logger);

    // Set up onChange callback to send available_commands_update notifications
    // Per ACP spec: "The Agent can update the list of available commands at any time"
    // Note: We'll only send notifications for active sessions
    this.slashCommandsRegistry.onChange(() => {
      // When commands change, send updates to all active sessions
      if (!this.sessionManager) {
        this.logger.debug(
          'Session manager not available, skipping command update notifications'
        );
        return;
      }

      this.sessionManager
        .listSessions()
        .then((result) => {
          result.items.forEach((session) => {
            this.sendAvailableCommandsUpdate(session.id);
          });
          this.logger.debug(
            'Slash commands updated, notified all active sessions'
          );
        })
        .catch((error) => {
          this.logger.warn('Failed to send command updates to sessions', {
            error,
          });
        });
    });

    // Initialize PermissionsHandler
    this.permissionsHandler = new PermissionsHandler({
      logger: this.logger,
    });

    // Initialize ToolCallManager with permissions support
    this.toolCallManager = new ToolCallManager({
      logger: this.logger,
      sendNotification: this.sendNotification.bind(this),
      requestPermission: async (params) => {
        if (!this.permissionsHandler) {
          throw new ProtocolError('Permissions handler not initialized');
        }
        return this.permissionsHandler.createPermissionRequest(params);
      },
    });

    // Initialize ToolRegistry
    this.toolRegistry = new ToolRegistry(this.config, this.logger);

    // Connect ToolCallManager to ToolRegistry
    this.toolRegistry.setToolCallManager(this.toolCallManager);

    // Initialize protocol handlers
    this.initializationHandler = new InitializationHandler(
      this.config,
      this.logger
    );

    // Set extension registry getter for advertising custom capabilities
    this.initializationHandler.setExtensionRegistryGetter(() => {
      return this.extensionRegistry;
    });

    // Set Cursor CLI bridge getter for connectivity testing during initialization
    // This allows InitializationHandler to check if cursor-agent CLI is available
    this.initializationHandler.setCursorBridgeGetter(() => {
      return this.cursorBridge || undefined;
    });

    this.promptHandler = new PromptHandler({
      sessionManager: this.sessionManager,
      cursorBridge: this.cursorBridge,
      config: this.config,
      logger: this.logger,
      sendNotification: this.sendNotification.bind(this),
      slashCommandsRegistry: this.slashCommandsRegistry,
    });

    // Initialize ACP-compliant file system client
    // Per ACP spec: This adapter implements ClientConnection to enable
    // filesystem tools to call client methods (fs/read_text_file, fs/write_text_file)
    this.fileSystemClient = new AcpFileSystemClient(this, this.logger);

    // Register filesystem tool provider if enabled
    // Per ACP spec: Only offer filesystem tools if client supports them
    // (checked during tool registration based on clientCapabilities)
    if (this.config.tools.filesystem.enabled) {
      const filesystemProvider = new FilesystemToolProvider(
        this.config,
        this.logger,
        null, // Client capabilities set after initialization
        this.fileSystemClient
      );
      // Note: Provider will check capabilities and only offer tools if supported
      this.toolRegistry.registerProvider(filesystemProvider);
    }

    this.logger.debug('All components initialized');
  }

  /**
   * Register default slash commands
   * Per ACP spec: Agents MAY advertise available commands
   */
  private registerDefaultCommands(): void {
    if (!this.slashCommandsRegistry) {
      return;
    }

    // Register example commands - these can be customized or extended
    // Per ACP spec: Commands provide quick access to specific agent capabilities
    this.slashCommandsRegistry.registerCommand(
      'plan',
      'Create a detailed implementation plan',
      'description of what to plan'
    );

    // Register model switching command
    // Allows users to change the session model during conversation
    const availableModels = this.sessionManager?.getAvailableModels() || [];
    const modelNames = availableModels.map((m) => m.id).join(', ');
    this.slashCommandsRegistry.registerCommand(
      'model',
      `Switch to a different model. Available: ${modelNames}`,
      'model-id'
    );

    // Note: Additional commands can be registered here or dynamically during runtime
    this.logger.debug('Default slash commands registered', {
      count: this.slashCommandsRegistry.getCommandCount(),
    });
  }

  /**
   * Send available_commands_update notification to client
   * Per ACP spec: Agents MAY send this notification after creating/loading a session
   *
   * @param sessionId - The session ID
   */
  private sendAvailableCommandsUpdate(sessionId: string): void {
    if (!this.slashCommandsRegistry) {
      this.logger.debug(
        'Slash commands registry not initialized, skipping notification'
      );
      return;
    }

    const commands = this.slashCommandsRegistry.getCommands();
    if (commands.length === 0) {
      this.logger.debug(
        'No commands registered, skipping available_commands_update notification'
      );
      return;
    }

    // Build SDK-compliant SessionNotification
    // Per ACP spec: sessionUpdate must be 'available_commands_update' and use 'availableCommands' field
    const notification: SessionNotification = {
      sessionId,
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: commands,
      },
      _meta: {
        timestamp: new Date().toISOString(),
      },
    };

    this.logger.debug('Sending available_commands_update notification', {
      sessionId,
      commandCount: commands.length,
      commandNames: commands.map((c) => c.name),
    });

    this.sendNotification({
      jsonrpc: '2.0',
      method: 'session/update',
      params: notification,
    });
  }

  /**
   * Verify Cursor CLI integration (non-blocking)
   *
   * Per ACP spec: Initialization should succeed to communicate capabilities.
   * Errors should occur when features are actually used, not during initialization.
   *
   * This method logs warnings but does not throw errors, allowing the agent
   * to start and communicate its capabilities to the client. The actual
   * cursor-agent availability check happens during ACP initialization and
   * is reflected in the agentCapabilities response.
   */
  private async verifyCursorIntegration(): Promise<void> {
    if (!this.cursorBridge) {
      this.logger.warn(
        'CursorCliBridge not initialized - cursor-agent features will be unavailable'
      );
      return;
    }

    try {
      // Check if cursor-agent is available
      const version = await this.cursorBridge.getVersion();
      this.logger.info(`Cursor CLI version: ${version}`);

      // Check authentication status
      const authStatus = await this.cursorBridge.checkAuthentication();
      if (!authStatus.authenticated) {
        this.logger.warn(
          'Cursor CLI not authenticated - cursor-agent features requiring authentication will be unavailable',
          authStatus
        );
        this.logger.warn('To authenticate, run: `cursor-agent login`');
      } else {
        this.logger.info('Cursor CLI authenticated', {
          user: authStatus.user,
          email: authStatus.email,
        });
      }
    } catch (error) {
      // Per ACP spec: Don't fail initialization if cursor-agent is unavailable
      // The agent should still start and communicate limited capabilities
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Check if this is a "command not found" error
      const isNotFoundError =
        errorMessage.includes('ENOENT') ||
        errorMessage.includes('not found') ||
        errorMessage.includes('command not found') ||
        errorMessage.includes('spawn cursor-agent ENOENT');

      if (isNotFoundError) {
        this.logger.warn(
          'cursor-agent CLI not found in PATH - cursor-agent features will be unavailable'
        );
        this.logger.warn(
          'To install cursor-agent CLI, visit: https://cursor.sh/docs/agent'
        );
      } else {
        this.logger.warn(
          'Cursor CLI verification failed - cursor-agent features may be unavailable',
          { error: errorMessage }
        );
      }

      // Don't throw - let the agent start and communicate capabilities
      // The initialization handler will properly advertise limited capabilities
    }
  }

  private validateToolConfiguration(): void {
    if (!this.toolRegistry) {
      throw new AdapterError('ToolRegistry not initialized', 'COMPONENT_ERROR');
    }

    const errors = this.toolRegistry.validateConfiguration();
    if (errors.length > 0) {
      throw new AdapterError(
        `Tool configuration errors: ${errors.join(', ')}`,
        'CONFIG_ERROR'
      );
    }

    this.logger.info(
      `Tools initialized: ${this.toolRegistry.getTools().length} tools available`
    );
  }

  /**
   * Send a notification to the client via stdout
   */
  sendNotification(notification: {
    jsonrpc: '2.0';
    method: string;
    params?: any;
  }): void {
    const notificationStr = JSON.stringify(notification);
    this.logger.debug('Sending notification to client', {
      method: notification.method,
      notificationLength: notificationStr.length,
      fullNotification: notificationStr,
    });
    process.stdout.write(`${notificationStr}\n`);
  }

  // ACP Method handlers

  private async handleInitialize(request: Request | Request1): Promise<{
    jsonrpc: '2.0';
    id: string | number | null;
    result?: any | null;
    error?: JsonRpcError;
  }> {
    if (!this.initializationHandler) {
      throw new ProtocolError('Initialization handler not available');
    }

    const params =
      (request.params as InitializeRequest) || ({} as InitializeRequest);

    // Pass the entire params object to InitializationHandler
    // It will validate protocolVersion and handle all fields properly
    const result = await this.initializationHandler.initialize(params);

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
      result,
    };
  }

  private async handleSessionNew(request: Request | Request1): Promise<{
    jsonrpc: '2.0';
    id: string | number | null;
    result?: any | null;
    error?: JsonRpcError;
  }> {
    if (!this.sessionManager) {
      throw new ProtocolError('Session manager not available');
    }

    const params: NewSessionRequest & { metadata?: Partial<SessionMetadata> } =
      (request.params as NewSessionRequest & {
        metadata?: Partial<SessionMetadata>;
      }) || ({} as NewSessionRequest & { metadata?: Partial<SessionMetadata> });

    // Per ACP spec: cwd is required
    if (typeof params.cwd !== 'string' || params.cwd.trim() === '') {
      throw new ProtocolError(
        'cwd (working directory) is required and must be a non-empty string'
      );
    }

    // Per ACP spec: mcpServers is required (can be empty array)
    const mcpServers = params.mcpServers || [];

    // Validate cwd is an absolute path
    const cwd = params.cwd;
    if (typeof cwd !== 'string') {
      throw new ProtocolError('cwd must be a string (per ACP spec)');
    }
    if (!cwd.startsWith('/') && !cwd.match(/^[A-Za-z]:[/\\]/)) {
      throw new ProtocolError('cwd must be an absolute path (per ACP spec)');
    }

    // Per ACP spec: session/new includes cwd (working directory) parameter
    // Store this in metadata so we can use it when executing commands
    const metadata = {
      ...(params.metadata || {}),
      cwd: cwd, // Capture working directory
      mcpServers: mcpServers, // Store MCP server configurations
    };

    // Validate metadata before creating session
    this.validateSessionMetadata(metadata);

    const sessionData = await this.sessionManager.createSession(metadata);

    this.logger.info('Session created with working directory and MCP servers', {
      sessionId: sessionData.id,
      cwd: cwd,
      mcpServerCount: mcpServers.length,
      mcpServerNames: mcpServers.map((s: any) => s.name || 'unnamed'),
    });

    // TODO: Connect to MCP servers specified in mcpServers array
    // For now, we accept the configuration but don't connect
    if (mcpServers.length > 0) {
      this.logger.warn(
        'MCP server connections are not yet implemented. ' +
          'Server configurations stored but not connected. ' +
          'Servers will be available when MCP integration is completed.',
        {
          mcpServerCount: mcpServers.length,
          serverTypes: mcpServers.map((s: any) => s.type || 'unknown'),
          serverNames: mcpServers.map((s: any) => s.name || 'unnamed'),
        }
      );
    }

    // Build mode and model state using helper methods
    const modes: SessionModeState | null = this.buildSessionModeState(
      sessionData.id
    );
    const models: SessionModelState | null = this.buildSessionModelState(
      sessionData.id
    );

    // Per ACP spec: NewSessionResponse with typed response
    const response: NewSessionResponse = {
      sessionId: sessionData.id,
      modes,
      models,
      _meta: {
        createdAt: sessionData.createdAt.toISOString(),
        cwd,
        mcpServerCount: mcpServers.length,
        ...(mcpServers.length > 0 && {
          mcpStatus: 'not-implemented',
          mcpServers: mcpServers.map((s: any) => ({
            name: s.name || 'unnamed',
            type: s.type || 'unknown',
            status: 'pending-implementation',
          })),
        }),
      },
    };

    // Per ACP spec: Agent MAY send available_commands_update notification after creating a session
    this.sendAvailableCommandsUpdate(sessionData.id);

    return {
      jsonrpc: '2.0' as const,
      id: request.id!,
      result: response,
    };
  }

  private async handleSessionLoad(request: Request | Request1): Promise<{
    jsonrpc: '2.0';
    id: string | number | null;
    result?: any | null;
    error?: JsonRpcError;
  }> {
    if (!this.sessionManager) {
      throw new ProtocolError('Session manager not available');
    }

    const params: LoadSessionRequest & { metadata?: Partial<SessionMetadata> } =
      (request.params as LoadSessionRequest & {
        metadata?: Partial<SessionMetadata>;
      }) ||
      ({} as LoadSessionRequest & { metadata?: Partial<SessionMetadata> });
    if (!params.sessionId) {
      throw new ProtocolError('sessionId is required');
    }

    // Per ACP spec: cwd and mcpServers are required parameters
    if (!params.cwd) {
      throw new ProtocolError('cwd is required');
    }

    if (!params.mcpServers) {
      throw new ProtocolError('mcpServers is required');
    }

    const sessionId = params.sessionId;
    const cwd = params.cwd;
    const mcpServers = params.mcpServers;

    // Validate cwd is an absolute path
    if (typeof cwd !== 'string') {
      throw new ProtocolError('cwd must be a string (per ACP spec)');
    }
    if (!cwd.startsWith('/') && !cwd.match(/^[A-Za-z]:[/\\]/)) {
      throw new ProtocolError('cwd must be an absolute path (per ACP spec)');
    }

    this.logger.info('Loading session with parameters', {
      sessionId,
      cwd,
      mcpServerCount: mcpServers.length,
    });

    // Load the session data
    const sessionData = await this.sessionManager.loadSession(sessionId);

    // Update session metadata with new cwd and mcpServers
    await this.sessionManager.updateSession(sessionId, {
      cwd,
      mcpServers,
      ...params.metadata,
    });

    // Per ACP spec: Agent MUST replay entire conversation via session/update notifications
    // Stream each message in the conversation history
    for (const message of sessionData.conversation) {
      // Determine the session update type based on message role
      let sessionUpdateType: string;
      if (message.role === 'user') {
        sessionUpdateType = 'user_message_chunk';
      } else if (message.role === 'assistant' || message.role === 'system') {
        sessionUpdateType = 'agent_message_chunk';
      } else {
        // Skip unknown message types
        continue;
      }

      // Guard: skip if content is missing or not an array
      if (!message.content || !Array.isArray(message.content)) continue;
      // Stream each content block as a separate notification
      for (const contentBlock of message.content) {
        // Convert content block to ACP format - use SDK ContentBlock directly
        const contentData = { ...contentBlock };

        const notification = {
          jsonrpc: '2.0' as const,
          method: 'session/update',
          params: {
            sessionId: sessionId,
            update: {
              sessionUpdate: sessionUpdateType,
              content: contentData,
            },
          },
        };

        // Send the notification to the client
        this.sendNotification(notification);
      }
    }

    // Build mode and model state using helper methods
    const modes: SessionModeState | null =
      this.buildSessionModeState(sessionId);
    const models: SessionModelState | null =
      this.buildSessionModelState(sessionId);

    // Per ACP spec: LoadSessionResponse with mode and model state
    const response: LoadSessionResponse = {
      modes,
      models,
      _meta: {
        sessionId: sessionData.id,
        loadedAt: new Date().toISOString(),
        messageCount: sessionData.state.messageCount,
        lastActivity: sessionData.state.lastActivity.toISOString(),
        cwd,
        mcpServerCount: mcpServers.length,
      },
    };

    // Per ACP spec: Agent MAY send available_commands_update notification after loading a session
    this.sendAvailableCommandsUpdate(sessionId);

    return {
      jsonrpc: '2.0' as const,
      id: request.id!,
      result: response,
    };
  }

  private async handleSetSessionMode(request: Request | Request1): Promise<{
    jsonrpc: '2.0';
    id: string | number | null;
    result?: SetSessionModeResponse;
    error?: JsonRpcError;
  }> {
    if (!this.sessionManager) {
      throw new ProtocolError('Session manager not available');
    }

    const params = request.params as SetSessionModeRequest;

    if (!params.sessionId) {
      throw new ProtocolError('sessionId is required');
    }

    if (!params.modeId) {
      throw new ProtocolError('modeId is required');
    }

    // Set the new mode (returns previous mode)
    const previousMode = await this.sessionManager.setSessionMode(
      params.sessionId,
      params.modeId
    );

    this.logger.info('Session mode changed', {
      sessionId: params.sessionId,
      previousMode,
      newMode: params.modeId,
    });

    const response: SetSessionModeResponse = {
      _meta: {
        previousMode,
        newMode: params.modeId,
        changedAt: new Date().toISOString(),
      },
    };

    return {
      jsonrpc: '2.0' as const,
      id: request.id!,
      result: response,
    };
  }

  private async handleSetSessionModel(request: Request | Request1): Promise<{
    jsonrpc: '2.0';
    id: string | number | null;
    result?: SetSessionModelResponse;
    error?: JsonRpcError;
  }> {
    if (!this.sessionManager) {
      throw new ProtocolError('Session manager not available');
    }

    const params = request.params as SetSessionModelRequest;

    if (!params.sessionId) {
      throw new ProtocolError('sessionId is required');
    }

    if (!params.modelId) {
      throw new ProtocolError('modelId is required');
    }

    // Get previous model for tracking
    const previousModel = this.sessionManager.getSessionModel(params.sessionId);

    // Set the new model
    await this.sessionManager.setSessionModel(params.sessionId, params.modelId);

    this.logger.info('Session model changed', {
      sessionId: params.sessionId,
      previousModel,
      newModel: params.modelId,
    });

    const response: SetSessionModelResponse = {
      _meta: {
        previousModel,
        newModel: params.modelId,
        changedAt: new Date().toISOString(),
      },
    };

    return {
      jsonrpc: '2.0' as const,
      id: request.id!,
      result: response,
    };
  }

  private async handleSessionList(request: Request | Request1): Promise<{
    jsonrpc: '2.0';
    id: string | number | null;
    result?: any | null;
    error?: JsonRpcError;
  }> {
    if (!this.sessionManager) {
      throw new ProtocolError('Session manager not available');
    }

    const params =
      (request.params as SessionListParams) || ({} as SessionListParams);
    const result = await this.sessionManager.listSessions(
      params.limit,
      params.offset,
      params.filter
    );

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
        sessions: result.items,
        total: result.total,
        hasMore: result.hasMore,
      },
    };
  }

  private async handleSessionUpdate(request: Request | Request1): Promise<{
    jsonrpc: '2.0';
    id: string | number | null;
    result?: any | null;
    error?: JsonRpcError;
  }> {
    if (!this.sessionManager) {
      throw new ProtocolError('Session manager not available');
    }

    const params: SessionUpdateParams =
      (request.params as unknown as SessionUpdateParams) ||
      ({} as SessionUpdateParams);
    if (!params.sessionId) {
      throw new ProtocolError('sessionId is required');
    }

    await this.sessionManager.updateSession(
      params.sessionId,
      params.metadata || {}
    );
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
        sessionId: params.sessionId,
        updated: true,
      },
    };
  }

  private async handleSessionDelete(request: Request | Request1): Promise<{
    jsonrpc: '2.0';
    id: string | number | null;
    result?: any | null;
    error?: JsonRpcError;
  }> {
    if (!this.sessionManager) {
      throw new ProtocolError('Session manager not available');
    }

    const params =
      (request.params as SessionDeleteParams) || ({} as SessionDeleteParams);
    if (!params.sessionId) {
      throw new ProtocolError('sessionId is required');
    }

    await this.sessionManager.deleteSession(params.sessionId);

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
        sessionId: params.sessionId,
        deleted: true,
      },
    };
  }

  private async handleSessionPrompt(request: Request | Request1): Promise<{
    jsonrpc: '2.0';
    id: string | number | null;
    result?: any | null;
    error?: JsonRpcError;
  }> {
    if (!this.promptHandler) {
      throw new ProtocolError('Prompt handler not available');
    }
    return this.promptHandler.processPrompt(request);
  }

  private async handleSessionCancel(request: Request | Request1): Promise<{
    jsonrpc: '2.0';
    id: string | number | null;
    result?: any | null;
    error?: JsonRpcError;
  }> {
    if (!this.promptHandler) {
      throw new ProtocolError('Prompt handler not available');
    }

    const params =
      (request.params as CancelNotification) || ({} as CancelNotification);
    const sessionId = params.sessionId;

    if (!sessionId || typeof sessionId !== 'string') {
      throw new ProtocolError('sessionId is required and must be a string');
    }

    this.logger.info('Handling session cancellation notification', {
      sessionId,
    });

    // Per ACP spec: session/cancel is a notification (no response expected)
    // Agent MUST stop all operations and respond to the original session/prompt
    // request with the 'cancelled' stop reason (handled in PromptHandler)
    await this.promptHandler.cancelSession(sessionId);

    // Cancel all active tool calls for this session
    if (this.toolCallManager) {
      await this.toolCallManager.cancelSessionToolCalls(sessionId);
    }

    // Cancel all pending permission requests for this session
    if (this.permissionsHandler) {
      this.permissionsHandler.cancelSessionPermissionRequests(sessionId);
    }

    // Per JSON-RPC 2.0 spec: Notifications do not receive responses
    // However, if the client incorrectly sent this as a request (with id),
    // we still need to return a response to avoid leaving the client hanging
    // This is a defensive implementation for non-compliant clients
    if (request.id !== undefined && request.id !== null) {
      this.logger.warn(
        'Received session/cancel with id field - should be a notification per ACP spec',
        { sessionId, id: request.id }
      );
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
        result: null,
      };
    }

    // For proper notifications (no id), return a dummy response
    // This won't be sent to the client because processStdioMessage/HTTP handler
    // already checks isNotification() and skips sending responses for notifications
    return <
      {
        jsonrpc: '2.0';
        id: string | number | null;
        result?: any | null;
        error?: JsonRpcError;
      }
    >{
      jsonrpc: '2.0',
      id: null,
      result: null,
    };
  }

  private async handleToolsList(request: Request | Request1): Promise<{
    jsonrpc: '2.0';
    id: string | number | null;
    result?: any | null;
    error?: JsonRpcError;
  }> {
    if (!this.toolRegistry) {
      throw new ProtocolError('Tool registry not available');
    }

    const tools = this.toolRegistry.getTools();

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
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
      },
    };
  }

  private async handleToolCall(request: Request | Request1): Promise<{
    jsonrpc: '2.0';
    id: string | number | null;
    result?: any | null;
    error?: JsonRpcError;
  }> {
    if (!this.toolRegistry) {
      throw new ProtocolError('Tool registry not available');
    }

    const params =
      (request.params as unknown as ToolCallParams) || ({} as ToolCallParams);
    if (!params.name) {
      throw new ProtocolError('tool name is required');
    }

    // Extract sessionId if provided (for tool call reporting)
    // Check multiple parameter name variants for compatibility
    const sessionId =
      params.parameters?.['sessionId'] ||
      params.parameters?.['session_id'] ||
      params.parameters?.['_sessionId'];

    const toolCall = {
      id: (request.id ?? 'unknown').toString(),
      name: params.name,
      parameters: params.parameters || {},
    };

    // Use executeToolWithSession for tool call reporting
    const result = await this.toolRegistry.executeToolWithSession(
      toolCall,
      sessionId
    );

    // If the tool execution failed, return an error response
    if (!result.success) {
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
        error: {
          code: -32603,
          message: result.error || 'Tool execution failed',
          data: result.metadata,
        },
      };
    }

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
      result,
    };
  }

  private async handleRequestPermission(request: Request | Request1): Promise<{
    jsonrpc: '2.0';
    id: string | number | null;
    result?: any | null;
    error?: JsonRpcError;
  }> {
    if (!this.permissionsHandler) {
      throw new ProtocolError('Permissions handler not available');
    }

    return await this.permissionsHandler.handlePermissionRequest(request);
  }

  // ============================================================================
  // ClientConnection Implementation - ACP File System Methods
  // ============================================================================

  /**
   * ClientConnection implementation: Call fs/read_text_file on the client
   * Per ACP spec: https://agentclientprotocol.com/protocol/file-system
   *
   * ✅ Fully functional using SDK's AgentSideConnection with validation!
   */
  async readTextFile(
    params: ReadTextFileRequest
  ): Promise<ReadTextFileResponse> {
    this.logger.debug(
      'Calling client method: fs/read_text_file via SDK',
      params
    );

    if (!this.agentConnection) {
      throw new ProtocolError(
        'AgentSideConnection not established. Connection must be initialized before calling client methods.'
      );
    }

    try {
      // Validate params before sending to client
      this.validateReadTextFileParams(params);

      // Use SDK's AgentSideConnection to call client method
      // This handles JSON-RPC request/response automatically!
      const response = await this.agentConnection.readTextFile(params);

      // Validate response structure per ACP spec
      this.validateReadTextFileResponse(response);

      this.logger.debug('fs/read_text_file succeeded', {
        path: params.path,
        contentLength: response.content.length,
        hasLineRange: params.line !== undefined || params.limit !== undefined,
      });

      return response;
    } catch (error) {
      this.logger.error('fs/read_text_file failed', {
        error,
        path: params.path,
        sessionId: params.sessionId,
      });
      throw error;
    }
  }

  /**
   * ClientConnection implementation: Call fs/write_text_file on the client
   * Per ACP spec: https://agentclientprotocol.com/protocol/file-system
   *
   * ✅ Fully functional using SDK's AgentSideConnection with validation!
   */
  async writeTextFile(
    params: WriteTextFileRequest
  ): Promise<WriteTextFileResponse> {
    this.logger.debug(
      'Calling client method: fs/write_text_file via SDK',
      params
    );

    if (!this.agentConnection) {
      throw new ProtocolError(
        'AgentSideConnection not established. Connection must be initialized before calling client methods.'
      );
    }

    try {
      // Validate params before sending to client
      this.validateWriteTextFileParams(params);

      // Use SDK's AgentSideConnection to call client method
      // This handles JSON-RPC request/response automatically!
      const response = await this.agentConnection.writeTextFile(params);

      // Validate response structure per ACP spec
      this.validateWriteTextFileResponse(response);

      this.logger.debug('fs/write_text_file succeeded', {
        path: params.path,
        contentLength: params.content.length,
      });

      return response;
    } catch (error) {
      this.logger.error('fs/write_text_file failed', {
        error,
        path: params.path,
        sessionId: params.sessionId,
      });
      throw error;
    }
  }

  // ============================================================================
  // Validation Methods for ACP File System Operations
  // ============================================================================

  /**
   * Validate readTextFile request parameters per ACP spec
   */
  private validateReadTextFileParams(params: ReadTextFileRequest): void {
    if (!params.sessionId || typeof params.sessionId !== 'string') {
      throw new ProtocolError('sessionId is required and must be a string');
    }

    if (!params.path || typeof params.path !== 'string') {
      throw new ProtocolError('path is required and must be a string');
    }

    if (params.line !== undefined) {
      if (typeof params.line !== 'number' || params.line < 1) {
        throw new ProtocolError('line must be a positive integer (1-based)');
      }
    }

    if (params.limit !== undefined) {
      if (typeof params.limit !== 'number' || params.limit < 1) {
        throw new ProtocolError('limit must be a positive integer');
      }
    }
  }

  /**
   * Validate readTextFile response per ACP spec
   */
  private validateReadTextFileResponse(response: ReadTextFileResponse): void {
    if (!response || typeof response !== 'object') {
      throw new ProtocolError('Invalid response: expected object');
    }

    if (typeof response.content !== 'string') {
      throw new ProtocolError('Invalid response: content must be a string');
    }
  }

  /**
   * Validate writeTextFile request parameters per ACP spec
   */
  private validateWriteTextFileParams(params: WriteTextFileRequest): void {
    if (!params.sessionId || typeof params.sessionId !== 'string') {
      throw new ProtocolError('sessionId is required and must be a string');
    }

    if (!params.path || typeof params.path !== 'string') {
      throw new ProtocolError('path is required and must be a string');
    }

    if (params.content === undefined || params.content === null) {
      throw new ProtocolError('content is required');
    }

    if (typeof params.content !== 'string') {
      throw new ProtocolError('content must be a string');
    }
  }

  /**
   * Validate writeTextFile response per ACP spec
   */
  private validateWriteTextFileResponse(response: WriteTextFileResponse): void {
    if (!response || typeof response !== 'object') {
      throw new ProtocolError('Invalid response: expected object');
    }
    // WriteTextFileResponse can be an empty object per ACP spec
  }

  // ============================================================================
  // Private Helper Methods for Session Setup
  // ============================================================================

  /**
   * Builds session mode state for responses
   * Per ACP spec: Returns available modes and current mode
   * Uses SDK SessionModeState type for ACP compliance
   */
  private buildSessionModeState(sessionId: string): SessionModeState | null {
    if (!this.sessionManager) {
      return null;
    }

    // Per ACP spec: Return SessionModeState with currentModeId and availableModes
    return this.sessionManager.getSessionModeState(sessionId);
  }

  /**
   * Builds session model state for responses
   * Per ACP spec (UNSTABLE): Returns available models and current model
   */
  private buildSessionModelState(sessionId: string): SessionModelState | null {
    if (!this.sessionManager) {
      return null;
    }

    const availableModels = this.sessionManager.getAvailableModels();
    const currentModel = this.sessionManager.getSessionModel(sessionId);

    return {
      availableModels: availableModels.map((model) => ({
        modelId: model.id,
        name: model.name,
      })),
      currentModelId: currentModel,
    };
  }

  /**
   * Validates session metadata fields
   * Throws ProtocolError for invalid metadata, logs warnings for edge cases
   */
  private validateSessionMetadata(metadata: Partial<SessionMetadata>): void {
    if (metadata.name !== undefined) {
      if (typeof metadata.name !== 'string') {
        throw new ProtocolError('Session name must be a string');
      }
      if (metadata.name.length > 200) {
        this.logger.warn(
          'Session name exceeds recommended length of 200 characters',
          {
            length: metadata.name.length,
          }
        );
      }
    }

    if (metadata.tags !== undefined) {
      if (!Array.isArray(metadata.tags)) {
        throw new ProtocolError('Session tags must be an array');
      }
      for (const tag of metadata.tags) {
        if (typeof tag !== 'string') {
          throw new ProtocolError('Session tags must be strings');
        }
      }
    }

    // Validate mode if provided
    if (metadata.mode !== undefined) {
      if (typeof metadata.mode !== 'string') {
        throw new ProtocolError('Session mode must be a string');
      }
      const availableModes = this.sessionManager?.getAvailableModes() || [];
      if (!availableModes.find((m) => m.id === metadata.mode)) {
        throw new ProtocolError(
          `Invalid mode: ${metadata.mode}. Available modes: ${availableModes.map((m) => m.id).join(', ')}`
        );
      }
    }

    // Validate model if provided
    if (metadata.model !== undefined) {
      if (typeof metadata.model !== 'string') {
        throw new ProtocolError('Session model must be a string');
      }
      const availableModels = this.sessionManager?.getAvailableModels() || [];
      if (!availableModels.find((m) => m.id === metadata.model)) {
        throw new ProtocolError(
          `Invalid model: ${metadata.model}. Available models: ${availableModels.map((m) => m.id).join(', ')}`
        );
      }
    }
  }

  // ============================================================================
  // Public Handler Methods for Agent Implementation
  // ============================================================================
  // These methods are called by CursorAgentImplementation and adapt the
  // existing handler methods to work with the SDK's Agent interface.

  /**
   * Handle initialize from Agent implementation
   * Updates filesystem provider with connection after initialization
   */
  async handleInitializeFromAgent(
    params: InitializeRequest,
    connection: AgentSideConnection
  ): Promise<InitializeResponse> {
    const response = await this.handleInitialize({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params,
    } as unknown as Request);

    // Store the connection for filesystem operations
    this.agentConnection = connection;

    // Per ACP spec: After initialization, update filesystem provider with client capabilities
    if (this.toolRegistry && this.fileSystemClient) {
      const clientCapabilities =
        this.initializationHandler?.getClientCapabilities();

      // Re-register filesystem provider with actual client capabilities
      if (this.config.tools.filesystem.enabled && clientCapabilities) {
        // Unregister old provider (if any)
        this.toolRegistry.unregisterProvider('filesystem');

        // Register new provider with capabilities
        const filesystemProvider = new FilesystemToolProvider(
          this.config,
          this.logger,
          clientCapabilities,
          this.fileSystemClient
        );
        this.toolRegistry.registerProvider(filesystemProvider);

        this.logger.info(
          'Filesystem provider updated with client capabilities',
          {
            canRead: clientCapabilities.fs?.readTextFile ?? false,
            canWrite: clientCapabilities.fs?.writeTextFile ?? false,
          }
        );
      }
    }

    return response.result as InitializeResponse;
  }

  /**
   * Handle newSession from Agent implementation
   */
  async handleNewSessionFromAgent(
    params: NewSessionRequest
  ): Promise<NewSessionResponse> {
    const response = await this.handleSessionNew({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/new',
      params,
    } as unknown as Request);

    return response.result as NewSessionResponse;
  }

  /**
   * Handle loadSession from Agent implementation
   */
  async handleLoadSessionFromAgent(
    params: LoadSessionRequest
  ): Promise<LoadSessionResponse> {
    const response = await this.handleSessionLoad({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/load',
      params,
    } as unknown as Request);

    return response.result as LoadSessionResponse;
  }

  /**
   * Handle setSessionMode from Agent implementation
   * Per ACP spec: When agent changes mode, must send current_mode_update notification
   */
  async handleSetSessionModeFromAgent(
    params: SetSessionModeRequest
  ): Promise<SetSessionModeResponse | void> {
    if (!this.sessionManager) {
      throw new ProtocolError('Session manager not available');
    }

    // Set the mode (this validates and updates the session)
    const previousModeId = await this.sessionManager.setSessionMode(
      params.sessionId,
      params.modeId
    );

    // Per ACP spec: Agent MUST send current_mode_update notification when changing mode
    // See: https://agentclientprotocol.com/protocol/session-modes#from-the-agent
    if (this.agentConnection) {
      const notification: SessionNotification = {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'current_mode_update',
          currentModeId: params.modeId,
        },
      };

      try {
        await this.agentConnection.sessionUpdate(notification);
        this.logger.debug('Sent current_mode_update notification', {
          sessionId: params.sessionId,
          modeId: params.modeId,
        });
      } catch (error) {
        this.logger.warn('Failed to send current_mode_update notification', {
          error,
          sessionId: params.sessionId,
          modeId: params.modeId,
        });
        // Don't fail the mode change if notification fails
      }
    }

    // Return response per ACP spec
    const response: SetSessionModeResponse = {
      _meta: {
        previousMode: previousModeId,
        newMode: params.modeId,
        changedAt: new Date().toISOString(),
      },
    };

    return response;
  }

  /**
   * Handle setSessionModel from Agent implementation
   * Per ACP spec (UNSTABLE): Model state is sent in session responses but notifications not yet supported
   */
  async handleSetSessionModelFromAgent(
    params: SetSessionModelRequest
  ): Promise<SetSessionModelResponse | void> {
    if (!this.sessionManager) {
      throw new ProtocolError('Session manager not available');
    }

    // Get previous model for tracking
    const previousModelId = this.sessionManager.getSessionModel(
      params.sessionId
    );

    // Set the model (this validates and updates the session)
    await this.sessionManager.setSessionModel(params.sessionId, params.modelId);

    // NOTE: Per ACP spec, current_model_update is not yet in the SDK's SessionUpdate union
    // Model state is communicated via session/new and session/load responses, but dynamic
    // updates during a session are not yet officially supported. Clients will need to
    // track model changes via set_model responses or re-query session state.
    //
    // Once the SDK adds support for current_model_update notification, uncomment:
    // if (this.agentConnection) {
    //   const notification: SessionNotification = {
    //     sessionId: params.sessionId,
    //     update: {
    //       sessionUpdate: 'current_model_update',
    //       currentModelId: params.modelId,
    //     },
    //   };
    //   await this.agentConnection.sessionUpdate(notification);
    // }

    this.logger.info('Session model changed', {
      sessionId: params.sessionId,
      previousModel: previousModelId,
      newModel: params.modelId,
    });

    // Return response per ACP spec
    const response: SetSessionModelResponse = {
      _meta: {
        previousModel: previousModelId,
        newModel: params.modelId,
        changedAt: new Date().toISOString(),
      },
    };

    return response;
  }

  /**
   * Handle prompt from Agent implementation
   */
  async handlePromptFromAgent(params: PromptRequest): Promise<PromptResponse> {
    const response = await this.handleSessionPrompt({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/prompt',
      params,
    } as unknown as Request);

    return response.result as PromptResponse;
  }

  /**
   * Handle cancel from Agent implementation
   */
  async handleCancelFromAgent(params: CancelNotification): Promise<void> {
    await this.handleSessionCancel({
      jsonrpc: '2.0',
      id: null,
      method: 'session/cancel',
      params,
    } as unknown as Request);
  }

  private async cleanup(): Promise<void> {
    this.logger.debug('Cleaning up adapter components');

    // Cleanup in reverse order of initialization
    if (this.promptHandler) {
      await this.promptHandler.cleanup();
    }

    // Cleanup permissions handler
    if (this.permissionsHandler) {
      await this.permissionsHandler.cleanup();
    }

    // Cleanup tool call manager
    if (this.toolCallManager) {
      await this.toolCallManager.cleanup();
    }

    // Cleanup tool registry (cleans up all tool providers)
    if (this.toolRegistry) {
      await this.toolRegistry.cleanup();
    }

    if (this.cursorBridge) {
      await this.cursorBridge.close();
    }

    if (this.sessionManager) {
      await this.sessionManager.cleanup();
    }

    // Cleanup extension registry
    if (this.extensionRegistry) {
      this.extensionRegistry.clear();
    }
    this.logger.debug('Cleanup completed');
  }

  /**
   * Handle extension method request
   * Per ACP spec: Extension methods start with underscore and follow JSON-RPC 2.0 semantics
   *
   * @param request - The extension method request
   * @returns JSON-RPC response with result or error
   */
  private async handleExtensionMethod(request: Request | Request1): Promise<{
    jsonrpc: '2.0';
    id: string | number | null;
    result?: Record<string, unknown> | null;
    error?: JsonRpcError;
  }> {
    if (!this.extensionRegistry) {
      this.logger.warn('Extension registry not initialized');
      return createErrorResponse(request.id, {
        code: -32601,
        message: 'Method not found',
      });
    }

    const methodName = request.method;

    // Per JSON-RPC 2.0: Validate params is an object (not array/primitive)
    // ExtensionRegistry expects object params
    const validation = validateObjectParams(request.params, methodName);
    if (!validation.valid) {
      this.logger.debug('Invalid params type for extension method', {
        method: methodName,
        error: validation.error,
      });
      return createErrorResponse(request.id, validation.error);
    }

    const paramsObj = validation.params;

    // Check if method is registered
    if (!this.extensionRegistry.hasMethod(methodName)) {
      this.logger.debug('Extension method not found', { method: methodName });
      return createErrorResponse(request.id, {
        code: -32601,
        message: 'Method not found',
      });
    }

    try {
      // Call the extension method - returns ExtMethodResponse (Record<string, unknown>)
      const result = await this.extensionRegistry.callMethod(
        methodName,
        paramsObj
      );

      return {
        jsonrpc: '2.0',
        id: request.id,
        result,
      };
    } catch (error) {
      this.logger.error('Extension method execution failed', {
        method: methodName,
        error,
      });

      // Return proper JSON-RPC error
      const errorData: Record<string, unknown> | undefined =
        error instanceof Error
          ? {
              name: error.name,
              ...(error.stack && { stack: error.stack }),
            }
          : undefined;

      return createErrorResponse(request.id, {
        code: -32603,
        message: error instanceof Error ? error.message : 'Internal error',
        ...(errorData && { data: errorData }),
      });
    }
  }

  /**
   * Get the extension registry
   * Per ACP spec: Provides access to register extension methods and notifications
   *
   * @returns ExtensionRegistry instance
   */
  getExtensionRegistry(): ExtensionRegistry {
    if (!this.extensionRegistry) {
      throw new AdapterError(
        'Extension registry not initialized',
        'COMPONENT_ERROR'
      );
    }
    return this.extensionRegistry;
  }
}
