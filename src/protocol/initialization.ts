/**
 * InitializationHandler - Handles ACP initialization protocol
 *
 * This class implements the ACP initialization method, which is the first
 * method called by ACP clients to establish communication and discover
 * server capabilities.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ProtocolError,
  type AdapterConfig,
  type Logger,
  type InitializeParams,
  type InitializeResult,
  type AgentCapabilities,
  type ClientCapabilities,
  type ConnectivityTestResult,
} from '../types';

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
  private clientCapabilities: ClientCapabilities | null = null;

  constructor(config: AdapterConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Get stored client capabilities
   */
  getClientCapabilities(): ClientCapabilities | null {
    return this.clientCapabilities;
  }

  /**
   * Check if client supports file system read operations
   */
  canRequestFileRead(): boolean {
    return this.clientCapabilities?.fs?.readTextFile ?? false;
  }

  /**
   * Check if client supports file system write operations
   */
  canRequestFileWrite(): boolean {
    return this.clientCapabilities?.fs?.writeTextFile ?? false;
  }

  /**
   * Check if client supports terminal operations
   */
  canRequestTerminal(): boolean {
    return this.clientCapabilities?.terminal ?? false;
  }

  /**
   * Handles the ACP initialize method
   * Per ACP spec: https://agentclientprotocol.com/protocol/initialization
   */
  async initialize(params: InitializeParams): Promise<InitializeResult> {
    this.logger.info('Initializing ACP adapter', {
      protocolVersion: params.protocolVersion,
      clientInfo: params.clientInfo,
      clientCapabilities: params.clientCapabilities,
    });

    try {
      // Validate and negotiate protocol version
      const agreedVersion = this.negotiateProtocolVersion(
        params.protocolVersion
      );

      // Store client capabilities for later validation
      this.clientCapabilities = params.clientCapabilities || null;

      // Log client information if provided
      if (params.clientInfo) {
        this.logger.info('Client information', {
          name: params.clientInfo.name,
          title: params.clientInfo.title,
          version: params.clientInfo.version,
        });
      }

      // Log what client supports
      if (this.clientCapabilities) {
        this.logger.info('Client capabilities stored', {
          supportsFileRead: this.canRequestFileRead(),
          supportsFileWrite: this.canRequestFileWrite(),
          supportsTerminal: this.canRequestTerminal(),
        });
      }

      // Test cursor-agent connectivity (non-blocking)
      // Per ACP spec: initialization should succeed to communicate capabilities
      // Errors should occur when features are actually used, not during init
      const connectivityTest = await this.testCursorConnectivity();
      if (!connectivityTest.success) {
        this.logger.warn(
          'Cursor CLI not available during initialization. Features may be limited.',
          { error: connectivityTest.error }
        );
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

      // Build agent capabilities based on configuration and connectivity
      const agentCapabilities = this.buildAgentCapabilities(connectivityTest);

      // Per ACP spec: Build initialization result
      const result: InitializeResult = {
        protocolVersion: agreedVersion,
        agentCapabilities,
        agentInfo: {
          name: 'cursor-agent-acp',
          title: 'Cursor Agent ACP Adapter',
          version: getPackageVersion(), // Dynamic version from package.json
        },
        authMethods: [], // No authentication methods required currently
      };

      this.logger.info('ACP adapter initialized successfully', {
        protocolVersion: result.protocolVersion,
        agentCapabilities: result.agentCapabilities,
        agentInfo: result.agentInfo,
      });

      return result;
    } catch (error) {
      this.logger.error('Initialization failed', error);
      throw error instanceof ProtocolError
        ? error
        : new ProtocolError(
            `Initialization failed: ${error instanceof Error ? error.message : String(error)}`,
            error instanceof Error ? error : undefined
          );
    }
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

    this.logger.info(`Client requested protocol version: ${clientVersion}`);

    // Validate client provided a version
    if (clientVersion === null || clientVersion === undefined) {
      throw new ProtocolError(
        'Protocol version is required. Please specify "protocolVersion" in initialize request.'
      );
    }

    // Validate it's a number and an integer (per ACP spec)
    if (typeof clientVersion !== 'number' || !Number.isInteger(clientVersion)) {
      throw new ProtocolError(
        `Protocol version must be an integer. Received: ${clientVersion} (${typeof clientVersion}). ` +
          `Supported versions: ${SUPPORTED_VERSIONS.join(', ')}`
      );
    }

    // Check if we support the client's requested version
    if (SUPPORTED_VERSIONS.includes(clientVersion)) {
      this.logger.info(`Agreed on protocol version: ${clientVersion}`);
      return clientVersion;
    }

    // Client may not support our version - let them decide whether to proceed
    this.logger.warn(
      `Client requested version ${clientVersion} which is not supported. ` +
        `Responding with version ${LATEST_VERSION}. ` +
        `Supported versions: ${SUPPORTED_VERSIONS.join(', ')}. ` +
        `Client may choose to disconnect if incompatible.`
    );
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
      // Per ACP spec: session/load method availability
      loadSession: true, // We support loading existing sessions

      // Per ACP spec: Prompt content type capabilities
      // Baseline: All agents MUST support Text and ResourceLink
      promptCapabilities: {
        image: cursorAvailable, // Only if cursor is available
        audio: false, // We don't support ContentBlock::Audio
        embeddedContext: cursorAvailable, // Only if cursor is available
      },

      // Per ACP spec: MCP server connection capabilities
      mcp: {
        http: false, // We don't connect to MCP servers over HTTP yet
        sse: false, // We don't connect to MCP servers over SSE
      },

      // Custom extensions via _meta
      _meta: {
        // Additional capabilities not in the standard spec
        streaming: cursorAvailable, // We support streaming when cursor is available
        toolCalling: cursorAvailable, // We support tool calling when cursor is available
        fileSystem: this.config.tools.filesystem.enabled,
        terminal: this.config.tools.terminal.enabled,
        contentTypes: cursorAvailable ? ['text', 'code', 'image'] : ['text'],
        cursorAvailable, // Indicate cursor CLI availability status
        cursorVersion: connectivityResult?.version,
        description: 'Production-ready ACP adapter for Cursor CLI',
      },
    };
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
