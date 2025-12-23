/**
 * ToolRegistry - Manages available tools and capabilities
 *
 * This class provides a registry for all available tools that can be
 * called through the ACP protocol, including filesystem and cursor-specific tools.
 */

import type { ToolKind, ToolCallLocation } from '@agentclientprotocol/sdk';
import {
  ToolError,
  type AdapterConfig,
  type Logger,
  type Tool,
  type ToolProvider,
  type ToolCall,
  type ToolResult,
} from '../types';
import { CursorToolsProvider } from './cursor-tools';
import type { ToolCallManager } from './tool-call-manager';

export class ToolRegistry {
  private config: AdapterConfig;
  private logger: Logger;
  private providers = new Map<string, ToolProvider>();
  private tools = new Map<string, Tool>();
  private toolCallManager?: ToolCallManager;

  constructor(config: AdapterConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;

    this.logger.debug('ToolRegistry initialized');

    // Initialize built-in tool providers
    this.initializeProviders();
  }

  /**
   * Set the tool call manager for reporting tool execution
   */
  setToolCallManager(manager: ToolCallManager): void {
    this.toolCallManager = manager;
    this.logger.debug('ToolCallManager registered with ToolRegistry');
  }

  /**
   * Registers a tool provider
   */
  registerProvider(provider: ToolProvider): void {
    this.logger.debug(`Registering tool provider: ${provider.name}`);

    this.providers.set(provider.name, provider);

    // Register all tools from the provider
    const tools = provider.getTools();
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
      this.logger.debug(`Registered tool: ${tool.name}`);
    }
  }

  /**
   * Unregisters a tool provider
   */
  unregisterProvider(providerName: string): void {
    this.logger.debug(`Unregistering tool provider: ${providerName}`);

    const provider = this.providers.get(providerName);
    if (!provider) {
      this.logger.warn(`Tool provider not found: ${providerName}`);
      return;
    }

    // Unregister all tools from the provider
    const tools = provider.getTools();
    for (const tool of tools) {
      this.tools.delete(tool.name);
      this.logger.debug(`Unregistered tool: ${tool.name}`);
    }

    this.providers.delete(providerName);
  }

  /**
   * Gets all available tools
   */
  getTools(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Gets a specific tool by name
   */
  getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * Gets all registered providers
   */
  getProviders(): ToolProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * Checks if a tool is available
   */
  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Executes a tool call (legacy method without sessionId)
   */
  async executeTool(toolCall: ToolCall): Promise<ToolResult> {
    // Call the new method with undefined sessionId (no tool call reporting)
    return this.executeToolWithSession(toolCall, undefined);
  }

  /**
   * Executes a tool call with session context and tool call reporting
   * Per ACP spec: Reports tool execution via session/update notifications
   */
  async executeToolWithSession(
    toolCall: ToolCall,
    sessionId?: string
  ): Promise<ToolResult> {
    this.logger.debug(`Executing tool: ${toolCall.name}`, {
      id: toolCall.id,
      parameters: toolCall.parameters,
      sessionId,
    });

    const startTime = Date.now();

    // Report tool call if we have a session and tool call manager
    let toolCallId: string | undefined;
    const shouldReportToolCalls = sessionId && this.toolCallManager;

    try {
      const tool = this.tools.get(toolCall.name);
      if (!tool) {
        const duration = Date.now() - startTime;
        return {
          success: false,
          error: `Tool not found: ${toolCall.name}`,
          metadata: {
            toolName: toolCall.name,
            duration,
            executedAt: new Date(),
          },
        };
      }

      // Validate parameters
      const validationError = this.validateToolParameters(
        tool,
        toolCall.parameters
      );
      if (validationError) {
        const duration = Date.now() - startTime;
        return {
          success: false,
          error: `Invalid parameters for ${toolCall.name}: ${validationError}`,
          metadata: {
            toolName: toolCall.name,
            duration,
            executedAt: new Date(),
          },
        };
      }

      // Per ACP spec: Tool call lifecycle is pending -> in_progress -> completed/failed
      // See: https://agentclientprotocol.com/protocol/prompt-turn#5-tool-invocation-and-status-reporting
      if (shouldReportToolCalls) {
        const toolKind = this.getToolKind(toolCall.name);
        const locations = this.extractLocations(toolCall.parameters);
        const reportOptions: {
          title: string;
          kind: ToolKind;
          status: 'pending';
          rawInput: Record<string, any>;
          locations?: ToolCallLocation[];
        } = {
          title: this.getToolTitle(toolCall.name, toolCall.parameters),
          kind: toolKind,
          status: 'pending',
          rawInput: toolCall.parameters,
        };
        if (locations.length > 0) {
          reportOptions.locations = locations;
        }

        // Step 1: Report tool call with pending status
        toolCallId = await this.toolCallManager!.reportToolCall(
          sessionId!,
          toolCall.name,
          reportOptions
        );

        // Step 2: Update to in_progress when execution starts
        await this.toolCallManager!.updateToolCall(sessionId!, toolCallId, {
          status: 'in_progress',
        });
      }

      // Step 3: Execute the tool
      // Per ACP spec: Inject sessionId into parameters for ACP operations
      // The _sessionId parameter is used by ACP-compliant tools (filesystem, etc.)
      const paramsWithSession = sessionId
        ? {
            ...toolCall.parameters,
            _sessionId: sessionId,
          }
        : toolCall.parameters;

      const result = await tool.handler(paramsWithSession);

      const duration = Date.now() - startTime;
      this.logger.debug(`Tool executed in ${duration}ms: ${toolCall.name}`);

      // Report tool call completion
      if (shouldReportToolCalls && toolCallId) {
        if (result.success) {
          // Check if tool result includes diffs (from cursor-tools)
          let content;
          if (
            result.metadata?.['diffs'] &&
            Array.isArray(result.metadata['diffs'])
          ) {
            content = this.toolCallManager!.convertDiffContent(
              result.metadata['diffs']
            );
          }

          await this.toolCallManager!.completeToolCall(sessionId!, toolCallId, {
            rawOutput: result.result,
            ...(content && { content }),
          });
        } else {
          await this.toolCallManager!.failToolCall(sessionId!, toolCallId, {
            error: result.error || 'Unknown error',
            rawOutput: result.result,
          });
        }
      }

      return {
        ...result,
        metadata: {
          ...result.metadata,
          toolName: toolCall.name,
          duration,
          executedAt: new Date(),
          ...(toolCallId && { toolCallId }),
        },
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(
        `Tool execution failed after ${duration}ms: ${toolCall.name}`,
        error
      );

      const errorMessage =
        error instanceof ToolError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);

      // Report tool call failure
      if (shouldReportToolCalls && toolCallId) {
        await this.toolCallManager!.failToolCall(sessionId!, toolCallId, {
          error: errorMessage,
        });
      } else if (shouldReportToolCalls && !toolCallId) {
        // If we didn't get a toolCallId yet, report the failure
        const toolKind = this.getToolKind(toolCall.name);
        const locations = this.extractLocations(toolCall.parameters);
        const reportOptions: {
          title: string;
          kind: ToolKind;
          status: 'failed';
          rawInput: Record<string, any>;
          locations?: ToolCallLocation[];
        } = {
          title: this.getToolTitle(toolCall.name, toolCall.parameters),
          kind: toolKind,
          status: 'failed',
          rawInput: toolCall.parameters,
        };
        if (locations.length > 0) {
          reportOptions.locations = locations;
        }
        toolCallId = await this.toolCallManager!.reportToolCall(
          sessionId!,
          toolCall.name,
          reportOptions
        );
        await this.toolCallManager!.failToolCall(sessionId!, toolCallId, {
          error: errorMessage,
        });
      }

      return {
        success: false,
        error: errorMessage,
        metadata: {
          toolName: toolCall.name,
          duration,
          executedAt: new Date(),
          ...(toolCallId && { toolCallId }),
        },
      };
    }
  }

  /**
   * Extract file locations from tool parameters
   * Per ACP spec: Enable clients to track which files the agent is accessing
   */
  private extractLocations(
    parameters: Record<string, any>
  ): ToolCallLocation[] {
    const locations: ToolCallLocation[] = [];

    // Extract file path from different parameter names
    if (parameters['path']) {
      locations.push({ path: parameters['path'] });
    } else if (parameters['sourcePath']) {
      locations.push({ path: parameters['sourcePath'] });
    }

    // For move/copy operations, also include destination
    if (parameters['destinationPath'] || parameters['destination']) {
      locations.push({
        path: parameters['destinationPath'] || parameters['destination'],
      });
    }

    // For tools that work with multiple files
    if (parameters['files'] && Array.isArray(parameters['files'])) {
      parameters['files'].forEach((file: string) => {
        locations.push({ path: file });
      });
    }

    return locations;
  }

  /**
   * Get the ACP tool kind for a tool name
   * Per ACP spec: ToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other"
   */
  private getToolKind(toolName: string): ToolKind {
    // Map tool names to ACP tool kinds
    const kindMap: Record<string, ToolKind> = {
      // Filesystem tools - read
      read_file: 'read',
      copy_file: 'read',
      list_directory: 'read',
      get_file_info: 'read',

      // Filesystem tools - edit
      write_file: 'edit',
      append_file: 'edit',
      create_file: 'edit',
      patch_file: 'edit',

      // Filesystem tools - delete
      delete_file: 'delete',
      remove_file: 'delete',
      remove_directory: 'delete',

      // Filesystem tools - move
      move_file: 'move',
      rename_file: 'move',

      // Search tools
      search_codebase: 'search',
      search_files: 'search',
      grep: 'search',
      find_files: 'search',
      find_references: 'search',
      find_definitions: 'search',

      // Execute tools
      run_tests: 'execute',
      run_command: 'execute',
      execute_command: 'execute',
      run_script: 'execute',
      shell: 'execute',

      // Fetch tools (network/HTTP operations)
      fetch_url: 'fetch',
      http_request: 'fetch',
      download_file: 'fetch',
      api_request: 'fetch',
      web_search: 'fetch',

      // Think tools (reasoning/planning)
      think: 'think',
      reason: 'think',
      plan: 'think',
      analyze: 'think',

      // Switch mode tools
      switch_mode: 'switch_mode',
      set_mode: 'switch_mode',
      change_mode: 'switch_mode',

      // Cursor-specific tools
      analyze_code: 'read',
      apply_code_changes: 'edit',
      get_project_info: 'read',
      explain_code: 'think',
    };

    return kindMap[toolName] || 'other';
  }

  /**
   * Generate a human-readable title for a tool call
   */
  private getToolTitle(
    toolName: string,
    parameters: Record<string, any>
  ): string {
    // Create descriptive titles based on tool and parameters
    switch (toolName) {
      // Read operations
      case 'read_file':
        return `Reading file: ${parameters['path'] || 'unknown'}`;
      case 'copy_file':
        return `Copying file: ${parameters['source'] || 'unknown'}`;
      case 'list_directory':
        return `Listing directory: ${parameters['path'] || 'unknown'}`;
      case 'get_file_info':
        return `Getting file info: ${parameters['path'] || 'unknown'}`;

      // Edit operations
      case 'write_file':
        return `Writing file: ${parameters['path'] || 'unknown'}`;
      case 'append_file':
        return `Appending to file: ${parameters['path'] || 'unknown'}`;
      case 'create_file':
        return `Creating file: ${parameters['path'] || 'unknown'}`;
      case 'patch_file':
        return `Patching file: ${parameters['path'] || 'unknown'}`;
      case 'apply_code_changes':
        return `Applying ${Array.isArray(parameters['changes']) ? parameters['changes'].length : 0} code changes`;

      // Delete operations
      case 'delete_file':
      case 'remove_file':
        return `Deleting file: ${parameters['path'] || 'unknown'}`;
      case 'remove_directory':
        return `Removing directory: ${parameters['path'] || 'unknown'}`;

      // Move operations
      case 'move_file':
      case 'rename_file':
        return `Moving file: ${parameters['source'] || parameters['from'] || 'unknown'} → ${parameters['destination'] || parameters['to'] || 'unknown'}`;

      // Search operations
      case 'search_codebase':
        return `Searching codebase: ${parameters['query'] || 'unknown'}`;
      case 'search_files':
      case 'grep':
        return `Searching for: ${parameters['pattern'] || parameters['query'] || 'unknown'}`;
      case 'find_files':
        return `Finding files: ${parameters['pattern'] || 'unknown'}`;
      case 'find_references':
        return `Finding references: ${parameters['symbol'] || 'unknown'}`;
      case 'find_definitions':
        return `Finding definitions: ${parameters['symbol'] || 'unknown'}`;

      // Execute operations
      case 'run_tests':
        return `Running tests: ${parameters['test_pattern'] || 'all'}`;
      case 'run_command':
      case 'execute_command':
      case 'shell':
        return `Running: ${parameters['command'] || 'unknown'}`;
      case 'run_script':
        return `Running script: ${parameters['script'] || 'unknown'}`;

      // Fetch operations
      case 'fetch_url':
      case 'http_request':
        return `Fetching: ${parameters['url'] || 'unknown'}`;
      case 'download_file':
        return `Downloading: ${parameters['url'] || 'unknown'}`;
      case 'api_request':
        return `API request: ${parameters['endpoint'] || parameters['url'] || 'unknown'}`;
      case 'web_search':
        return `Web search: ${parameters['query'] || 'unknown'}`;

      // Think operations
      case 'think':
      case 'reason':
        return `Thinking: ${parameters['topic'] || parameters['question'] || 'reasoning'}`;
      case 'plan':
        return `Planning: ${parameters['goal'] || 'next steps'}`;
      case 'analyze':
      case 'analyze_code':
        return `Analyzing: ${parameters['file_path'] || parameters['target'] || 'unknown'}`;
      case 'explain_code':
        return `Explaining code: ${parameters['file_path'] || 'unknown'}`;

      // Switch mode operations
      case 'switch_mode':
      case 'set_mode':
      case 'change_mode':
        return `Switching to mode: ${parameters['mode'] || parameters['mode_id'] || 'unknown'}`;

      // Cursor-specific
      case 'get_project_info':
        return 'Getting project information';

      default:
        return `Executing tool: ${toolName}`;
    }
  }

  /**
   * Gets tool capabilities for ACP initialization
   */
  getCapabilities(): Record<string, any> {
    const capabilities: Record<string, any> = {
      tools: Array.from(this.tools.keys()),
      providers: Array.from(this.providers.keys()),
    };

    // Add capability flags based on available tools
    capabilities['filesystem'] =
      this.hasTool('read_file') || this.hasTool('write_file');
    capabilities['cursor'] =
      this.hasTool('search_codebase') || this.hasTool('analyze_code');

    return capabilities;
  }

  /**
   * Gets metrics about tool usage
   */
  getMetrics(): Record<string, any> {
    return {
      totalTools: this.tools.size,
      totalProviders: this.providers.size,
      enabledProviders: Array.from(this.providers.keys()),
      // TODO: Add execution metrics, usage stats, etc.
    };
  }

  /**
   * Validates tool configuration
   *
   * Note: Some tools (like filesystem) may not be available immediately during
   * initialization because they depend on client capabilities. This validation
   * only checks for critical configuration errors, not runtime availability.
   */
  validateConfiguration(): string[] {
    const errors: string[] = [];

    // Check if filesystem tools are configured correctly
    // Note: Filesystem tools may not be registered yet if client capabilities
    // haven't been received. They will be registered after initialization.
    // We only validate that if filesystem is enabled, the provider is registered.
    // The provider may return 0 tools if capabilities aren't available yet.
    if (this.config.tools.filesystem.enabled) {
      const hasFilesystemProvider = this.providers.has('filesystem');

      // Only error if provider is not registered at all
      // The provider may not offer tools yet (waiting for client capabilities)
      if (!hasFilesystemProvider) {
        errors.push(
          'Filesystem tools enabled but filesystem provider not registered'
        );
      }
    }

    // Check if terminal configuration is valid (terminals are client-side, not tools)
    if (this.config.tools.terminal.enabled) {
      if (this.config.tools.terminal.maxProcesses <= 0) {
        errors.push('Terminal enabled but maxProcesses is invalid');
      }
    }

    // Check if cursor tools are configured correctly
    if (this.config.tools.cursor?.enabled !== false) {
      if (!this.hasTool('search_codebase') && !this.hasTool('analyze_code')) {
        errors.push('Cursor tools enabled but not properly registered');
      }
    }

    return errors;
  }

  /**
   * Reloads tool providers based on configuration
   */
  async reload(): Promise<void> {
    this.logger.info('Reloading tool registry');

    try {
      // Clear existing providers and tools
      this.providers.clear();
      this.tools.clear();

      // Re-initialize providers
      this.initializeProviders();

      this.logger.info('Tool registry reloaded successfully');
    } catch (error) {
      this.logger.error('Failed to reload tool registry', error);
      throw new ToolError(
        `Failed to reload tools: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        error instanceof Error ? error : undefined
      );
    }
  }

  // Private helper methods

  private initializeProviders(): void {
    this.logger.debug('Initializing built-in tool providers');

    // Note: Filesystem tools are NOT initialized here anymore
    // Per ACP spec: FilesystemToolProvider now requires AgentSideConnection
    // and ClientCapabilities, which are only available after the connection
    // is established. The adapter will initialize filesystem tools after
    // connection setup via registerProvider().
    // See: src/adapter/cursor-agent-adapter.ts

    // Note: Terminal operations are NOT registered as tools
    // Per ACP spec: Terminals are client-provided capabilities that agents
    // request via the client connection (terminal/create, etc.), not
    // agent-provided tools. See: TerminalManager for ACP-compliant operations.

    // Initialize cursor-specific tools
    if (this.config.tools.cursor?.enabled !== false) {
      const cursorProvider = new CursorToolsProvider(this.config, this.logger);
      this.registerProvider(cursorProvider);
    }
  }

  private validateToolParameters(
    tool: Tool,
    parameters: Record<string, any>
  ): string | null {
    // Handle null/undefined parameters
    if (parameters === null || parameters === undefined) {
      return 'Parameters are required and must be an object';
    }

    if (typeof parameters !== 'object' || Array.isArray(parameters)) {
      return 'Parameters must be an object';
    }

    // Basic parameter validation
    const required = tool.parameters.required || [];

    for (const param of required) {
      if (!(param in parameters)) {
        return `Missing required parameter: ${param}`;
      }
      // Check if the parameter value is null or undefined
      if (parameters[param] === null || parameters[param] === undefined) {
        return `Parameter ${param} cannot be null or undefined`;
      }
    }

    // TODO: Implement more sophisticated parameter validation
    // - Type checking
    // - Format validation
    // - Range checking
    // - Custom validators

    return null;
  }

  /**
   * Cleanup all tool providers
   */
  async cleanup(): Promise<void> {
    this.logger.debug('Cleaning up tool registry');

    // Call cleanup on each provider that has a cleanup method
    for (const [name, provider] of this.providers) {
      if (typeof (provider as any).cleanup === 'function') {
        try {
          this.logger.debug(`Cleaning up provider: ${name}`);
          await (provider as any).cleanup();
        } catch (error) {
          this.logger.warn(`Failed to cleanup provider ${name}`, error);
        }
      }
    }

    this.logger.debug('Tool registry cleanup completed');
  }
}
