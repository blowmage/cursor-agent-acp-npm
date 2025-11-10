/**
 * ACP-Compliant Filesystem Tool Provider
 *
 * Provides file system tools that use ACP client methods to access the
 * client's file system (including unsaved editor changes).
 *
 * @see {@link https://agentclientprotocol.com/protocol/file-system | ACP File System Specification}
 * @see {@link https://www.npmjs.com/package/@agentclientprotocol/sdk | ACP TypeScript SDK}
 *
 * ## ACP Compliance
 *
 * This implementation strictly follows the ACP standard by:
 * - ✅ Calling client methods (`fs/read_text_file`, `fs/write_text_file`)
 * - ✅ Checking client capabilities before offering tools
 * - ✅ Passing `sessionId` to all operations
 * - ✅ Accessing client's file system (not server's)
 * - ✅ Including unsaved editor changes (when supported by client)
 *
 * ## Capability Requirements
 *
 * Tools are only offered if the client advertises support in `clientCapabilities.fs`:
 * - `read_file` tool → requires `fs.readTextFile: true`
 * - `write_file` tool → requires `fs.writeTextFile: true`
 *
 * ## Security Model
 *
 * Security is enforced by the **client**, not this provider:
 * - Client validates paths and enforces sandboxing
 * - Client handles permissions and access controls
 * - Client manages file locks and concurrent access
 *
 * @example
 * ```typescript
 * // Register the filesystem provider
 * const fsClient = new AcpFileSystemClient(connection, logger);
 * const provider = new FilesystemToolProvider(
 *   config,
 *   logger,
 *   clientCapabilities,
 *   fsClient
 * );
 * toolRegistry.registerProvider(provider);
 * ```
 */

import type {
  AdapterConfig,
  Logger,
  Tool,
  ToolProvider,
  ToolResult,
} from '../types';
import type { FileSystemClient } from '../client/filesystem-client';
import type { ClientCapabilities } from '@agentclientprotocol/sdk';

export interface FileSystemConfig {
  enabled: boolean;
  // Retry configuration
  retries?: number;
  retryDelay?: number;
  // Timeout configuration
  timeout?: number;
  // Metrics
  enableMetrics?: boolean;
}

/**
 * ACP-compliant error for file system operations
 * Uses standard JSON-RPC error codes per ACP specification
 */
export class AcpFileSystemError extends Error {
  constructor(
    message: string,
    public readonly code: number = -32603,
    public readonly data?: unknown
  ) {
    super(message);
    this.name = 'AcpFileSystemError';
  }

  toJsonRpcError(): { code: number; message: string; data?: unknown } {
    const result: { code: number; message: string; data?: unknown } = {
      code: this.code,
      message: this.message,
    };
    if (this.data !== undefined) {
      result.data = this.data;
    }
    return result;
  }
}

/**
 * ACP-compliant file system tool provider
 *
 * Only offers tools when client advertises support for file system capabilities.
 * All operations go through the ACP connection to access the client's file system.
 */
export class FilesystemToolProvider implements ToolProvider {
  readonly name = 'filesystem';
  readonly description =
    'File system operations via ACP client methods (read/write text files)';

  private fsConfig: FileSystemConfig;

  constructor(
    config: AdapterConfig,
    private logger: Logger,
    private clientCapabilities: ClientCapabilities | null,
    private fileSystemClient: FileSystemClient
  ) {
    this.fsConfig = config.tools.filesystem;

    this.logger.debug('FilesystemToolProvider initialized (ACP-compliant)', {
      enabled: this.fsConfig.enabled,
      clientSupportsRead: this.clientCapabilities?.fs?.readTextFile ?? false,
      clientSupportsWrite: this.clientCapabilities?.fs?.writeTextFile ?? false,
    });
  }

  getTools(): Tool[] {
    if (!this.fsConfig.enabled) {
      this.logger.debug('Filesystem tools disabled by configuration');
      return [];
    }

    // Enhanced capability checking with better feedback
    if (!this.clientCapabilities) {
      this.logger.warn(
        'Client capabilities not yet initialized - filesystem tools unavailable'
      );
      return [];
    }

    if (!this.clientCapabilities.fs) {
      this.logger.info(
        'Client does not advertise file system capabilities - no fs tools offered',
        {
          availableCapabilities: Object.keys(this.clientCapabilities),
        }
      );
      return [];
    }

    const tools: Tool[] = [];
    const fsCapabilities = this.clientCapabilities.fs;

    this.logger.debug('Client file system capabilities detected', {
      readTextFile: fsCapabilities.readTextFile ?? false,
      writeTextFile: fsCapabilities.writeTextFile ?? false,
    });

    // read_file tool (requires fs.readTextFile capability)
    // Per ACP spec: fs/read_text_file method
    if (this.clientCapabilities.fs.readTextFile) {
      tools.push({
        name: 'read_file',
        description:
          'Read a text file from the client workspace (includes unsaved changes in editor). ' +
          'Can read full file or specific line ranges for efficiency.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description:
                'Absolute path to the file to read (relative to client workspace)',
            },
            line: {
              type: 'number',
              description:
                'Optional: Start reading from this line number (1-based). ' +
                'Useful for reading specific sections of large files.',
            },
            limit: {
              type: 'number',
              description:
                'Optional: Maximum number of lines to read. ' +
                'Useful for preventing memory issues with large files.',
            },
          },
          required: ['path'],
        },
        handler: this.readFile.bind(this),
      });
    } else {
      this.logger.debug(
        'Client does not support fs.readTextFile - read_file tool not offered'
      );
    }

    // write_file tool (requires fs.writeTextFile capability)
    // Per ACP spec: fs/write_text_file method
    if (this.clientCapabilities.fs.writeTextFile) {
      tools.push({
        name: 'write_file',
        description:
          'Write content to a text file in the client workspace. ' +
          'Client handles directory creation and permissions.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description:
                'Absolute path to the file to write (relative to client workspace)',
            },
            content: {
              type: 'string',
              description: 'Content to write to the file',
            },
          },
          required: ['path', 'content'],
        },
        handler: this.writeFile.bind(this),
      });
    } else {
      this.logger.debug(
        'Client does not support fs.writeTextFile - write_file tool not offered'
      );
    }

    this.logger.info(
      `Offering ${tools.length} ACP-compliant file system tools`,
      {
        canRead: this.clientCapabilities.fs.readTextFile ?? false,
        canWrite: this.clientCapabilities.fs.writeTextFile ?? false,
      }
    );

    return tools;
  }

  /**
   * Read file contents via ACP client method with retry logic
   *
   * Per ACP spec: Calls fs/read_text_file on the client
   */
  private async readFile(params: Record<string, any>): Promise<ToolResult> {
    const maxRetries = this.fsConfig.retries ?? 3;
    const retryDelay = this.fsConfig.retryDelay ?? 1000;
    const enableMetrics = this.fsConfig.enableMetrics ?? false;

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          this.logger.debug(`Retry attempt ${attempt}/${maxRetries}`, {
            path: params['path'],
          });
          await this.delay(retryDelay * attempt); // Exponential backoff
        }

        return await this._readFileOnce(params, enableMetrics);
      } catch (error) {
        lastError = error as Error;

        // Don't retry on validation errors
        if (this.isValidationError(error)) {
          throw error;
        }

        // Don't retry on file not found
        if (this.isFileNotFoundError(error)) {
          throw error;
        }

        // Don't retry on permission errors
        if (this.isPermissionError(error)) {
          throw error;
        }

        // Only retry on transient errors
        if (attempt === maxRetries) {
          this.logger.error('All retry attempts exhausted', {
            path: params['path'],
            attempts: attempt + 1,
            error: lastError,
          });
          throw lastError;
        }

        this.logger.warn('Transient error, will retry', {
          path: params['path'],
          attempt: attempt + 1,
          maxRetries,
          error: lastError.message,
        });
      }
    }

    throw lastError!;
  }

  /**
   * Single attempt to read file
   */
  private async _readFileOnce(
    params: Record<string, any>,
    enableMetrics: boolean
  ): Promise<ToolResult> {
    const startTime = enableMetrics ? performance.now() : 0;
    const operationId = enableMetrics
      ? `read_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
      : undefined;

    try {
      // Extract sessionId from tool execution context
      // Injected by ToolRegistry during tool execution
      const sessionId = params['_sessionId'];
      if (!sessionId) {
        throw new AcpFileSystemError(
          'Session ID is required for ACP file operations. ' +
            'This is an internal error - please report it.',
          -32602,
          { context: 'missing_session_id' }
        );
      }

      // Validate path parameter
      const path = params['path'];
      if (!path || typeof path !== 'string') {
        throw new AcpFileSystemError(
          'Valid file path is required. Path must be a non-empty string.',
          -32602,
          { context: 'invalid_path', provided: path }
        );
      }

      // Optional line parameter (1-based)
      const line = params['line'];
      if (line !== undefined && (typeof line !== 'number' || line < 1)) {
        throw new AcpFileSystemError(
          'Line number must be a positive integer (1-based)',
          -32602,
          { context: 'invalid_line', provided: line }
        );
      }

      // Optional limit parameter
      const limit = params['limit'];
      if (limit !== undefined && (typeof limit !== 'number' || limit < 1)) {
        throw new AcpFileSystemError(
          'Limit must be a positive integer',
          -32602,
          { context: 'invalid_limit', provided: limit }
        );
      }

      if (enableMetrics) {
        this.logger.debug('Starting fs/read_text_file operation', {
          operationId,
          path,
          sessionId,
          hasRange: line !== undefined || limit !== undefined,
        });
      } else {
        this.logger.debug('Reading file via ACP client method', {
          sessionId,
          path,
          line,
          limit,
        });
      }

      // Call ACP client method
      // Per ACP spec: This accesses the client's file system, including unsaved changes
      const content = await this.fileSystemClient.readTextFile({
        sessionId,
        path,
        line,
        limit,
      });

      const lineCount = content.split('\n').length;

      if (enableMetrics) {
        const duration = performance.now() - startTime;
        this.recordMetric('fs.read_text_file.success', duration, {
          path,
          contentLength: content.length,
          hasRange: line !== undefined || limit !== undefined,
        });

        this.logger.info('File read successfully via ACP', {
          operationId,
          duration: `${duration.toFixed(2)}ms`,
          path,
          contentLength: content.length,
          lineCount,
        });
      } else {
        this.logger.info('File read successfully via ACP', {
          path,
          contentLength: content.length,
          lineCount,
          partial: line !== undefined || limit !== undefined,
        });
      }

      // Per ACP spec: Return clean response with custom metadata in _meta
      return {
        success: true,
        result: {
          path,
          content,
          // Per ACP extensibility guidelines: Use _meta for implementation-specific fields
          _meta: {
            contentLength: content.length,
            lineCount,
            ...(line !== undefined && { startLine: line }),
            ...(limit !== undefined && { maxLines: limit }),
            source: 'acp-client',
            includesUnsavedChanges: true,
            acpMethod: 'fs/read_text_file',
            sessionId,
            ...(operationId ? { operationId } : {}),
          },
        },
      };
    } catch (error) {
      if (enableMetrics) {
        const duration = performance.now() - startTime;
        this.recordMetric('fs.read_text_file.error', duration, {
          path: params['path'],
          errorType: error instanceof Error ? error.name : 'unknown',
        });
      }

      this.logger.error('Failed to read file via ACP', {
        error,
        path: params['path'],
      });

      return {
        success: false,
        error:
          error instanceof Error
            ? this.enhanceFileSystemError(error, 'read', params['path']).message
            : String(error),
      };
    }
  }

  /**
   * Write file contents via ACP client method with retry logic
   *
   * Per ACP spec: Calls fs/write_text_file on the client
   */
  private async writeFile(params: Record<string, any>): Promise<ToolResult> {
    const maxRetries = this.fsConfig.retries ?? 3;
    const retryDelay = this.fsConfig.retryDelay ?? 1000;
    const enableMetrics = this.fsConfig.enableMetrics ?? false;

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          this.logger.debug(`Retry attempt ${attempt}/${maxRetries}`, {
            path: params['path'],
          });
          await this.delay(retryDelay * attempt);
        }

        return await this._writeFileOnce(params, enableMetrics);
      } catch (error) {
        lastError = error as Error;

        // Don't retry on validation errors
        if (this.isValidationError(error)) {
          throw error;
        }

        // Don't retry on permission errors
        if (this.isPermissionError(error)) {
          throw error;
        }

        if (attempt === maxRetries) {
          this.logger.error('All retry attempts exhausted', {
            path: params['path'],
            attempts: attempt + 1,
            error: lastError,
          });
          throw lastError;
        }

        this.logger.warn('Transient error, will retry', {
          path: params['path'],
          attempt: attempt + 1,
          maxRetries,
          error: lastError.message,
        });
      }
    }

    throw lastError!;
  }

  /**
   * Single attempt to write file
   */
  private async _writeFileOnce(
    params: Record<string, any>,
    enableMetrics: boolean
  ): Promise<ToolResult> {
    const startTime = enableMetrics ? performance.now() : 0;
    const operationId = enableMetrics
      ? `write_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
      : undefined;

    try {
      // Extract sessionId from tool execution context
      const sessionId = params['_sessionId'];
      if (!sessionId) {
        throw new AcpFileSystemError(
          'Session ID is required for ACP file operations. ' +
            'This is an internal error - please report it.',
          -32602,
          { context: 'missing_session_id' }
        );
      }

      // Validate path parameter
      const path = params['path'];
      if (!path || typeof path !== 'string') {
        throw new AcpFileSystemError(
          'Valid file path is required. Path must be a non-empty string.',
          -32602,
          { context: 'invalid_path', provided: path }
        );
      }

      // Validate content parameter
      const content = params['content'];
      if (content === undefined || content === null) {
        throw new AcpFileSystemError(
          'Content is required. To create an empty file, pass an empty string.',
          -32602,
          { context: 'missing_content' }
        );
      }

      // Convert content to string if needed
      const contentStr =
        typeof content === 'string' ? content : String(content);

      if (enableMetrics) {
        this.logger.debug('Starting fs/write_text_file operation', {
          operationId,
          path,
          sessionId,
          contentLength: contentStr.length,
        });
      } else {
        this.logger.debug('Writing file via ACP client method', {
          sessionId,
          path,
          contentLength: contentStr.length,
        });
      }

      // Call ACP client method
      // Per ACP spec: Client handles directory creation and permissions
      await this.fileSystemClient.writeTextFile({
        sessionId,
        path,
        content: contentStr,
      });

      if (enableMetrics) {
        const duration = performance.now() - startTime;
        this.recordMetric('fs.write_text_file.success', duration, {
          path,
          contentLength: contentStr.length,
        });

        this.logger.info('File written successfully via ACP', {
          operationId,
          duration: `${duration.toFixed(2)}ms`,
          path,
          contentLength: contentStr.length,
        });
      } else {
        this.logger.info('File written successfully via ACP', {
          path,
          contentLength: contentStr.length,
          lineCount: contentStr.split('\n').length,
        });
      }

      // Per ACP spec: Return clean response with custom metadata in _meta
      return {
        success: true,
        result: {
          path,
          written: true,
          // Per ACP extensibility guidelines: Use _meta for implementation-specific fields
          _meta: {
            contentLength: contentStr.length,
            lineCount: contentStr.split('\n').length,
            source: 'acp-client',
            acpMethod: 'fs/write_text_file',
            sessionId,
            ...(operationId ? { operationId } : {}),
          },
        },
      };
    } catch (error) {
      if (enableMetrics) {
        const duration = performance.now() - startTime;
        this.recordMetric('fs.write_text_file.error', duration, {
          path: params['path'],
          errorType: error instanceof Error ? error.name : 'unknown',
        });
      }

      this.logger.error('Failed to write file via ACP', {
        error,
        path: params['path'],
      });

      return {
        success: false,
        error:
          error instanceof Error
            ? this.enhanceFileSystemError(error, 'write', params['path'])
                .message
            : String(error),
      };
    }
  }

  // Helper methods

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private isValidationError(error: unknown): boolean {
    return (
      error instanceof AcpFileSystemError ||
      (error instanceof Error &&
        (error.message.includes('is required') ||
          error.message.includes('must be') ||
          error.message.includes('invalid')))
    );
  }

  private isFileNotFoundError(error: unknown): boolean {
    return (
      error instanceof Error &&
      (error.message.includes('not found') ||
        error.message.includes('does not exist') ||
        error.message.includes('ENOENT'))
    );
  }

  private isPermissionError(error: unknown): boolean {
    return (
      error instanceof Error &&
      (error.message.includes('permission denied') ||
        error.message.includes('access denied') ||
        error.message.includes('EACCES') ||
        error.message.includes('EPERM'))
    );
  }

  private enhanceFileSystemError(
    error: Error,
    operation: string,
    path: string
  ): Error {
    // Add more context to the error
    const enhanced = new Error(
      `File system ${operation} operation failed for '${path}': ${error.message}`
    );
    enhanced.name = error.name;
    if (error.stack) {
      enhanced.stack = error.stack;
    }
    return enhanced;
  }

  private recordMetric(
    name: string,
    duration: number,
    metadata: Record<string, any>
  ): void {
    // Log metrics for monitoring integration
    this.logger.debug('Metric recorded', {
      metric: name,
      duration: `${duration.toFixed(2)}ms`,
      ...metadata,
    });

    // Future: Could integrate with metrics collector (Prometheus, StatsD, etc.)
    // this.metricsCollector?.record(name, duration, metadata);
  }
}
