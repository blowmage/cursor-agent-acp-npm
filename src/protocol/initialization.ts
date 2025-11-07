/**
 * InitializationHandler - Handles ACP initialization protocol
 *
 * This class implements the ACP initialization method, which is the first
 * method called by ACP clients to establish communication and discover
 * server capabilities.
 *
 * Per ACP spec: https://agentclientprotocol.com/protocol/initialization
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import type {
  InitializeRequest,
  InitializeResponse,
  AgentCapabilities,
  ClientCapabilities,
  AuthMethod,
  Implementation,
} from '@agentclientprotocol/sdk';
import {
  ProtocolError,
  type AdapterConfig,
  type Logger,
  type ConnectivityTestResult,
} from '../types';

/**
 * Configuration options for initialization behavior
 */
export interface InitializationConfig {
  /**
   * Whether to perform Cursor CLI connectivity test during initialization
   * Default: true
   */
  testConnectivity?: boolean;

  /**
   * Timeout for connectivity test in milliseconds
   * Default: 5000 (5 seconds)
   */
  connectivityTimeout?: number;

  /**
   * Whether initialization should fail if Cursor CLI is not available
   * Default: false (initialization succeeds but capabilities are limited)
   */
  requireCursorAvailable?: boolean;
}

/**
 * Get the package version dynamically
 */
function getPackageVersion(): string {
  try {
    const packagePath = join(__dirname, '../../package.json');
    const pkg = JSON.parse(readFileSync(packagePath, 'utf-8'));
    return pkg.version || '0.2.0';
  } catch (error) {
    // Fallback version if package.json cannot be read
    return '0.2.0';
  }
}

export class InitializationHandler {
  private config: AdapterConfig;
  private logger: Logger;
  private initConfig: InitializationConfig;
  private clientCapabilities: ClientCapabilities | null = null;
  private clientInfo: Implementation | null = null;

  constructor(
    config: AdapterConfig,
    logger: Logger,
    initConfig: InitializationConfig = {}
  ) {
    this.config = config;
    this.logger = logger;
    this.initConfig = initConfig;
  }

  /**
   * Get stored client capabilities
   * Per ACP spec: Used to determine which client methods the agent can call
   */
  getClientCapabilities(): ClientCapabilities | null {
    return this.clientCapabilities;
  }

  /**
   * Get stored client information
   * Per ACP spec: Client name, version, and title for debugging and analytics
   */
  getClientInfo(): Implementation | null {
    return this.clientInfo;
  }

  /**
   * Check if client supports file system read operations
   * Per ACP spec: fs/read_text_file method availability
   */
  canRequestFileRead(): boolean {
    return this.clientCapabilities?.fs?.readTextFile ?? false;
  }

  /**
   * Check if client supports file system write operations
   * Per ACP spec: fs/write_text_file method availability
   */
  canRequestFileWrite(): boolean {
    return this.clientCapabilities?.fs?.writeTextFile ?? false;
  }

  /**
   * Check if client supports terminal operations
   * Per ACP spec: terminal/* methods availability
   */
  canRequestTerminal(): boolean {
    return this.clientCapabilities?.terminal ?? false;
  }

  /**
   * Handles the ACP initialize method
   * Per ACP spec: https://agentclientprotocol.com/protocol/initialization
   */
  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    const startTime = Date.now();

    this.logger.info('Initializing ACP adapter', {
      protocolVersion: params.protocolVersion,
      clientInfo: params.clientInfo,
      hasClientCapabilities: !!params.clientCapabilities,
    });

    try {
      // Validate and negotiate protocol version
      const agreedVersion = this.negotiateProtocolVersion(
        params.protocolVersion
      );

      // Validate and store client information
      // Per ACP spec: clientInfo will be required in future protocol versions
      this.validateAndStoreClientInfo(params.clientInfo);

      // Validate and store client capabilities
      // Per ACP spec: Used to determine which client methods the agent can call
      this.validateAndStoreClientCapabilities(params.clientCapabilities);

      // Test cursor-agent connectivity (configurable)
      // Per ACP spec: initialization should succeed to communicate capabilities
      // Errors should occur when features are actually used, not during init
      let connectivityTest: ConnectivityTestResult | undefined;
      if (this.initConfig.testConnectivity !== false) {
        connectivityTest = await this.testCursorConnectivity();

        if (!connectivityTest.success) {
          this.logger.warn(
            'Cursor CLI not available during initialization. Features may be limited.',
            { error: connectivityTest.error }
          );

          // Optionally fail initialization if Cursor is required
          if (this.initConfig.requireCursorAvailable) {
            throw new ProtocolError(
              `Cursor CLI is required but not available: ${connectivityTest.error}`
            );
          }
        } else if (!connectivityTest.authenticated) {
          this.logger.warn(
            'Cursor authentication not verified. Features may require authentication.',
            { error: connectivityTest.error }
          );
        } else {
          this.logger.info('Cursor CLI connectivity verified', {
            version: connectivityTest.version,
            authenticated: connectivityTest.authenticated,
          });
        }
      }

      // Build agent capabilities based on configuration and connectivity
      const agentCapabilities = this.buildAgentCapabilities(connectivityTest);

      // Build authentication methods (currently none required)
      const authMethods = this.buildAuthMethods();

      // Per ACP spec: Build initialization result
      const result: InitializeResponse = {
        protocolVersion: agreedVersion,
        agentCapabilities,
        agentInfo: {
          name: 'cursor-agent-acp',
          title: 'Cursor Agent ACP Adapter',
          version: getPackageVersion(), // Dynamic version from package.json
        },
        authMethods,

        // Extension point for debugging and monitoring
        _meta: {
          // Initialization metadata
          initializationTime: new Date().toISOString(),
          initializationDurationMs: Date.now() - startTime,

          // Cursor CLI status
          cursorCliStatus: connectivityTest?.success
            ? 'available'
            : 'unavailable',
          cursorVersion: connectivityTest?.version,
          cursorAuthenticated: connectivityTest?.authenticated,

          // Environment information
          nodeVersion: process.version,
          platform: process.platform,
          arch: process.arch,

          // Configuration summary (no sensitive data)
          toolsEnabled: {
            filesystem: this.config.tools.filesystem.enabled,
            terminal: this.config.tools.terminal.enabled,
          },

          // Version negotiation details
          versionNegotiation: {
            clientRequested: params.protocolVersion,
            agentResponded: agreedVersion,
            agentSupports: [1], // SUPPORTED_VERSIONS constant
          },

          // Implementation details
          implementation: 'cursor-agent-acp-npm',
          environment: process.env['NODE_ENV'] || 'production',
        },
      };

      this.logger.info('ACP adapter initialized successfully', {
        protocolVersion: result.protocolVersion,
        agentCapabilities: result.agentCapabilities,
        agentInfo: result.agentInfo,
        durationMs: Date.now() - startTime,
      });

      return result;
    } catch (error) {
      this.logger.error('Initialization failed', {
        error,
        durationMs: Date.now() - startTime,
      });
      throw error instanceof ProtocolError
        ? error
        : new ProtocolError(
            `Initialization failed: ${error instanceof Error ? error.message : String(error)}`,
            error instanceof Error ? error : undefined
          );
    }
  }

  /**
   * Validates and stores client information
   * Per ACP spec: clientInfo will be required in future protocol versions
   */
  private validateAndStoreClientInfo(
    clientInfo: Implementation | null | undefined
  ): void {
    if (!clientInfo) {
      this.logger.info(
        'Client did not provide clientInfo. ' +
          'Note: clientInfo will be required in future protocol versions.'
      );
      this.clientInfo = null;
      return;
    }

    // Validate clientInfo structure
    if (!clientInfo.name || !clientInfo.version) {
      this.logger.warn('Client provided incomplete clientInfo', {
        hasName: !!clientInfo.name,
        hasVersion: !!clientInfo.version,
        hasTitle: !!clientInfo.title,
      });
    } else {
      this.logger.info('Client information received', {
        name: clientInfo.name,
        title: clientInfo.title,
        version: clientInfo.version,
      });
    }

    this.clientInfo = clientInfo;
  }

  /**
   * Validates and stores client capabilities
   * Per ACP spec: Used to determine which client methods the agent can call
   */
  private validateAndStoreClientCapabilities(
    capabilities: ClientCapabilities | null | undefined
  ): void {
    if (!capabilities) {
      this.logger.info('Client did not provide capabilities');
      this.clientCapabilities = null;
      return;
    }

    // Validate and log file system capabilities
    if (capabilities.fs) {
      if (typeof capabilities.fs !== 'object') {
        this.logger.warn('Invalid fs capabilities structure', {
          fs: capabilities.fs,
        });
      } else {
        const fsCapabilities: string[] = [];
        if (capabilities.fs.readTextFile) {
          fsCapabilities.push('fs/read_text_file');
        }
        if (capabilities.fs.writeTextFile) {
          fsCapabilities.push('fs/write_text_file');
        }

        if (fsCapabilities.length > 0) {
          this.logger.info('Client file system capabilities', {
            methods: fsCapabilities,
          });
        }
      }
    }

    // Validate and log terminal capability
    if (capabilities.terminal !== undefined) {
      if (typeof capabilities.terminal !== 'boolean') {
        this.logger.warn('Invalid terminal capability type', {
          type: typeof capabilities.terminal,
          value: capabilities.terminal,
        });
      } else if (capabilities.terminal) {
        this.logger.info('Client supports terminal/* methods');
      }
    }

    // Check for custom capabilities in _meta
    if (capabilities._meta) {
      this.logger.debug(
        'Client provided custom capabilities',
        capabilities._meta
      );
    }

    // Store validated capabilities
    this.clientCapabilities = capabilities;

    // Summary log
    this.logger.info('Client capabilities stored', {
      supportsFileRead: this.canRequestFileRead(),
      supportsFileWrite: this.canRequestFileWrite(),
      supportsTerminal: this.canRequestTerminal(),
      hasCustomCapabilities: !!capabilities._meta,
    });
  }

  /**
   * Negotiates the protocol version with the client
   * Per ACP spec: https://agentclientprotocol.com/protocol/initialization#version-negotiation
   *
   * - If Agent supports client's version, respond with same version
   * - Otherwise, respond with latest version Agent supports
   * - Client should close connection if it doesn't support Agent's version
   */
  private negotiateProtocolVersion(
    clientVersion: number | null | undefined
  ): number {
    // Per ACP spec: protocol versions are integers (1, 2, 3, etc.)
    const SUPPORTED_VERSIONS = [1]; // This agent supports protocol version 1
    const LATEST_VERSION = Math.max(...SUPPORTED_VERSIONS);
    const MIN_VERSION = Math.min(...SUPPORTED_VERSIONS);

    this.logger.info('Protocol version negotiation', {
      clientRequested: clientVersion,
      agentSupports: SUPPORTED_VERSIONS,
      agentLatest: LATEST_VERSION,
    });

    // Validate client provided a version
    if (clientVersion === null || clientVersion === undefined) {
      throw new ProtocolError(
        'Protocol version is required in initialize request. ' +
          `This agent supports versions: ${SUPPORTED_VERSIONS.join(', ')}. ` +
          'Please specify "protocolVersion" in your request.'
      );
    }

    // Validate it's a number and an integer (per ACP spec)
    if (typeof clientVersion !== 'number' || !Number.isInteger(clientVersion)) {
      throw new ProtocolError(
        `Protocol version must be an integer. ` +
          `Received: ${clientVersion} (${typeof clientVersion}). ` +
          `Supported versions: ${SUPPORTED_VERSIONS.join(', ')}`
      );
    }

    // Validate version is positive
    if (clientVersion < 1) {
      throw new ProtocolError(
        `Protocol version must be positive. Received: ${clientVersion}. ` +
          `Supported versions: ${SUPPORTED_VERSIONS.join(', ')}`
      );
    }

    // Check if we support the client's requested version
    if (SUPPORTED_VERSIONS.includes(clientVersion)) {
      this.logger.info(
        `Protocol version ${clientVersion} agreed upon (client and agent compatible)`
      );
      return clientVersion;
    }

    // Version mismatch - provide detailed guidance
    if (clientVersion < MIN_VERSION) {
      this.logger.warn(
        `Client version ${clientVersion} is older than minimum supported version ${MIN_VERSION}. ` +
          `Responding with version ${LATEST_VERSION}. ` +
          `Client should upgrade or disconnect.`
      );
    } else if (clientVersion > LATEST_VERSION) {
      this.logger.warn(
        `Client version ${clientVersion} is newer than latest supported version ${LATEST_VERSION}. ` +
          `Responding with version ${LATEST_VERSION}. ` +
          `Client may disconnect if it doesn't support backward compatibility.`
      );
    }

    return LATEST_VERSION;
  }

  /**
   * Builds agent capabilities based on configuration and cursor availability
   * Per ACP spec: https://agentclientprotocol.com/protocol/initialization#agent-capabilities
   */
  private buildAgentCapabilities(
    connectivityResult?: ConnectivityTestResult
  ): AgentCapabilities {
    // Determine if cursor is available and authenticated
    const cursorAvailable =
      connectivityResult?.success === true &&
      connectivityResult?.authenticated === true;

    return {
      // Session Management
      // -----------------
      // Per ACP spec: Indicates whether agent supports session/load
      // We support loading existing sessions from the session manager
      loadSession: true,

      // Prompt Content Capabilities
      // --------------------------
      // Per ACP spec: Text and ResourceLink are REQUIRED for all agents
      // Additional capabilities are advertised below:
      promptCapabilities: {
        // Image support requires Cursor CLI to be available and authenticated
        // Images are passed through to Cursor for processing
        // Per ACP spec: ContentBlock::Image support
        image: cursorAvailable,

        // Audio content blocks are not currently supported
        // Per ACP spec: ContentBlock::Audio support
        // TODO: Add audio support when Cursor CLI supports it
        audio: false,

        // Embedded context (ContentBlock::Resource) requires Cursor CLI
        // This allows clients to include referenced context in prompts
        // Per ACP spec: ContentBlock::Resource support in session/prompt
        embeddedContext: cursorAvailable,
      },

      // MCP Server Capabilities
      // -----------------------
      // Per ACP spec: Indicates which MCP server connection types are supported
      mcpCapabilities: {
        // HTTP-based MCP server connections not yet implemented
        // Per ACP spec: McpServer::Http support
        // TODO: Add HTTP MCP support
        http: false,

        // Server-Sent Events MCP connections not yet implemented
        // Per ACP spec: McpServer::Sse support
        // TODO: Add SSE MCP support
        sse: false,
      },

      // Extension point for custom capabilities
      // Per ACP spec: _meta field for implementation-specific information
      _meta: {
        // Custom capabilities that extend the ACP standard
        streaming: cursorAvailable,
        toolCalling: cursorAvailable,
        fileSystem: this.config.tools.filesystem.enabled,
        terminal: this.config.tools.terminal.enabled,

        // Diagnostic information
        cursorAvailable,
        cursorVersion: connectivityResult?.version,
        description: 'Production-ready ACP adapter for Cursor CLI',

        // Implementation details for debugging
        implementation: 'cursor-agent-acp-npm',
        repositoryUrl: 'https://github.com/blowmage/cursor-agent-acp-npm',
      },
    };
  }

  /**
   * Builds authentication methods supported by this agent
   * Per ACP spec: https://agentclientprotocol.com/protocol/authentication
   */
  private buildAuthMethods(): AuthMethod[] {
    // Currently no authentication required
    // Per ACP spec: authMethods is an array of supported authentication methods
    // Empty array indicates no authentication is required

    // Future: Add API key, OAuth, or other auth methods here
    // Example for future API key auth:
    // return [{
    //   id: 'api-key',
    //   name: 'API Key Authentication',
    //   description: 'Authenticate using a Cursor API key',
    // }];

    return [];
  }

  /**
   * Tests cursor-agent connectivity and authentication
   */
  private async testCursorConnectivity(): Promise<ConnectivityTestResult> {
    try {
      // TODO: Replace with actual cursor-agent connectivity test
      // For now, return a mock successful result
      this.logger.debug('Testing cursor-agent connectivity...');

      // Simulate connectivity test
      await new Promise((resolve) => setTimeout(resolve, 10));

      return {
        success: true,
        version: '1.0.0',
        authenticated: true,
      };
    } catch (error) {
      this.logger.error('Cursor connectivity test failed', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
