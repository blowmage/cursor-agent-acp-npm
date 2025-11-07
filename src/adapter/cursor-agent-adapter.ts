/**
 * Cursor Agent ACP Adapter - Main Entry Point
 *
 * This is the main adapter class that orchestrates all components:
 * - ACP protocol handling (initialization, sessions, prompts)
 * - Cursor CLI integration
 * - Tool registry and execution
 * - HTTP/stdio transport handling
 */

import { createServer, Server } from 'http';
import type {
  Request,
  Request1,
  InitializeRequest as InitializeParams,
  NewSessionRequest,
  NewSessionResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  SetSessionModelRequest,
  SetSessionModelResponse,
  SessionModeState,
  SessionModelState,
  CancelNotification,
} from '@agentclientprotocol/sdk';
import type { Error as JsonRpcError } from '@agentclientprotocol/sdk';
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
import { SessionManager } from '../session/manager';
import { CursorCliBridge } from '../cursor/cli-bridge';
import { ToolRegistry } from '../tools/registry';
import { ToolCallManager } from '../tools/tool-call-manager';
import { InitializationHandler } from '../protocol/initialization';
import { PromptHandler } from '../protocol/prompt';
import { PermissionsHandler } from '../protocol/permissions';

export class CursorAgentAdapter {
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

  // Transport servers
  private httpServer?: Server;

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
   */
  async startStdio(): Promise<void> {
    if (this.isRunning) {
      throw new AdapterError('Adapter is already running', 'ADAPTER_RUNNING');
    }

    try {
      this.logger.info('Starting ACP adapter with stdio transport');
      this.startTime = new Date();
      this.isRunning = true;

      // Setup stdio handlers
      this.setupStdioTransport();

      this.logger.info('Adapter started successfully with stdio transport');
    } catch (error) {
      this.isRunning = false;
      throw new AdapterError(
        `Failed to start stdio transport: ${error instanceof Error ? error.message : String(error)}`,
        'STARTUP_ERROR',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Start the adapter with HTTP transport
   */
  async startHttpServer(port: number): Promise<void> {
    if (this.isRunning) {
      throw new AdapterError('Adapter is already running', 'ADAPTER_RUNNING');
    }

    try {
      this.logger.info(
        `Starting ACP adapter with HTTP transport on port ${port}`
      );
      this.startTime = new Date();

      // Create HTTP server
      this.httpServer = createServer(this.handleHttpRequest.bind(this));

      await new Promise<void>((resolve, reject) => {
        this.httpServer!.listen(port, () => {
          this.isRunning = true;
          this.logger.info(`HTTP server listening on port ${port}`);
          resolve();
        });

        this.httpServer!.on('error', (error) => {
          reject(error);
        });
      });
    } catch (error) {
      this.isRunning = false;
      throw new AdapterError(
        `Failed to start HTTP server: ${error instanceof Error ? error.message : String(error)}`,
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

      // Close HTTP server if running
      if (this.httpServer) {
        await new Promise<void>((resolve) => {
          this.httpServer!.close(() => resolve());
        });
        delete this.httpServer;
      }

      // Always cleanup components (even if not formally started)
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

    this.promptHandler = new PromptHandler({
      sessionManager: this.sessionManager,
      cursorBridge: this.cursorBridge,
      config: this.config,
      logger: this.logger,
      sendNotification: this.sendNotification.bind(this),
    });

    this.logger.debug('All components initialized');
  }

  private async verifyCursorIntegration(): Promise<void> {
    if (!this.cursorBridge) {
      throw new AdapterError(
        'CursorCliBridge not initialized',
        'COMPONENT_ERROR'
      );
    }

    try {
      // Check if cursor-agent is available
      const version = await this.cursorBridge.getVersion();
      this.logger.info(`Cursor CLI version: ${version}`);

      // Check authentication status
      const authStatus = await this.cursorBridge.checkAuthentication();
      if (!authStatus.authenticated) {
        this.logger.warn('Cursor CLI not authenticated', authStatus);
      } else {
        this.logger.info('Cursor CLI authenticated', {
          user: authStatus.user,
          email: authStatus.email,
        });
      }
    } catch (error) {
      this.logger.error('Cursor CLI verification failed', error);
      throw new AdapterError(
        `Cursor CLI not available: ${error instanceof Error ? error.message : String(error)}`,
        'CURSOR_ERROR',
        error instanceof Error ? error : undefined
      );
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

  private setupStdioTransport(): void {
    let buffer = '';

    this.logger.debug('Setting up stdio transport', {
      stdinIsTTY: process.stdin.isTTY,
      stdoutIsTTY: process.stdout.isTTY,
      stderrIsTTY: process.stderr.isTTY,
      stdinReadable: process.stdin.readable,
      stdoutWritable: process.stdout.writable,
    });

    process.stdin.on('data', (data) => {
      buffer += data.toString();

      this.logger.debug('Received data on stdin', {
        dataLength: data.length,
        bufferLength: buffer.length,
      });

      // Process complete JSON-RPC messages
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.trim()) {
          this.processStdioMessage(line.trim());
        }
      }
    });

    process.stdin.on('end', () => {
      this.logger.info('Stdin closed, shutting down adapter');
      this.shutdown().catch((error) => {
        this.logger.error('Error during stdin shutdown', error);
        process.exit(1);
      });
    });
  }

  private async processStdioMessage(message: string): Promise<void> {
    const request: Request | Request1 = JSON.parse(message);

    // Per JSON-RPC 2.0 spec: Notifications (requests without id) do not receive responses
    if (this.isNotification(request)) {
      this.logger.debug('Processing notification (no response)', {
        method: request.method,
      });
      await this.processRequest(request);
      return;
    }

    const response = await this.processRequest(request);

    // Validate response before sending
    const responseStr = JSON.stringify(response);
    this.logger.debug('Sending response to Zed', {
      method: request.method,
      id: request.id,
      responseLength: responseStr.length,
      hasResult: !!response.result,
      hasError: !!response.error,
      fullResponse: responseStr,
    });

    // Send response to stdout
    process.stdout.write(`${responseStr}\n`);
  }

  private async handleHttpRequest(req: any, res: any): Promise<void> {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    try {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });

      req.on('end', async () => {
        try {
          const request: Request | Request1 = JSON.parse(body);

          // Per JSON-RPC 2.0 spec: Notifications (requests without id) do not receive responses
          if (this.isNotification(request)) {
            await this.processRequest(request);
            res.writeHead(204); // No Content
            res.end();
            return;
          }

          const response = await this.processRequest(request);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));
        } catch (error) {
          this.logger.error('Error processing HTTP request', { error, body });

          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: null,
              error: {
                code: -32700,
                message: 'Parse error',
                data: error instanceof Error ? error.message : String(error),
              },
            })
          );
        }
      });
    } catch (error) {
      this.logger.error('HTTP request error', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
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
      (request.params as InitializeParams) || ({} as InitializeParams);

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
        'MCP server connections are not yet implemented. Server configurations stored but not connected.',
        { mcpServerCount: mcpServers.length }
      );
    }

    // Build mode state per ACP spec
    const modes: SessionModeState = {
      availableModes: this.sessionManager.getAvailableModes().map((mode) => ({
        id: mode.id,
        name: mode.name,
        description: mode.description,
      })),
      currentModeId: sessionData.state.currentMode || 'ask',
    };

    // Build model state per ACP spec (UNSTABLE)
    const models: SessionModelState = {
      availableModels: this.sessionManager
        .getAvailableModels()
        .map((model) => ({
          modelId: model.id,
          name: model.name,
        })),
      currentModelId: sessionData.state.currentModel || 'cursor-default',
    };

    // Per ACP spec: NewSessionResponse with typed response
    const response: NewSessionResponse = {
      sessionId: sessionData.id,
      modes,
      models,
      _meta: {
        createdAt: sessionData.createdAt.toISOString(),
        cwd,
        mcpServerCount: mcpServers.length,
      },
    };

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

    // Build mode state per ACP spec
    const modes: SessionModeState = {
      availableModes: this.sessionManager.getAvailableModes().map((mode) => ({
        id: mode.id,
        name: mode.name,
        description: mode.description,
      })),
      currentModeId: sessionData.state.currentMode || 'ask',
    };

    // Build model state per ACP spec (UNSTABLE)
    const models: SessionModelState = {
      availableModels: this.sessionManager
        .getAvailableModels()
        .map((model) => ({
          modelId: model.id,
          name: model.name,
        })),
      currentModelId: sessionData.state.currentModel || 'cursor-default',
    };

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

    // Get previous mode for tracking
    const previousMode = this.sessionManager.getSessionMode(params.sessionId);

    // Set the new mode
    await this.sessionManager.setSessionMode(params.sessionId, params.modeId);

    this.logger.info('Session mode changed', {
      sessionId: params.sessionId,
      previousMode,
      newMode: params.modeId,
    });

    const response: SetSessionModeResponse = {
      _meta: {
        previousMode,
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
    const sessionId =
      params.parameters?.['sessionId'] || params.parameters?.['session_id'];

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

  /**
   * Check if an ACP request is a notification (no response expected)
   * Per JSON-RPC 2.0 spec: Notifications are requests without an id field
   */
  private isNotification(request: Request | Request1): boolean {
    return request.id === null || request.id === undefined;
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

    this.logger.debug('Cleanup completed');
  }
}
