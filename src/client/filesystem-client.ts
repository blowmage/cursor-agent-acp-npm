/**
 * ACP-Compliant File System Client
 *
 * Provides file system operations that call client-side methods via the ACP
 * connection, accessing the client's file system (including unsaved editor changes).
 *
 * Per ACP spec: https://agentclientprotocol.com/protocol/file-system
 */

import type { ClientConnection } from './client-connection';
import type { Logger } from '../types';

export interface ReadFileOptions {
  sessionId: string;
  path: string;
  line?: number;
  limit?: number;
}

export interface WriteFileOptions {
  sessionId: string;
  path: string;
  content: string;
}

/**
 * Interface for ACP-compliant file system operations
 */
export interface FileSystemClient {
  /**
   * Read text file from client's file system
   *
   * Per ACP spec: Calls fs/read_text_file on the client to access files
   * in the client's workspace, including any unsaved changes in the editor.
   *
   * @param options - Read options including sessionId, path, line, limit
   * @returns File content (full or partial based on line/limit)
   * @throws Error if client doesn't support fs.readTextFile or file doesn't exist
   */
  readTextFile(options: ReadFileOptions): Promise<string>;

  /**
   * Write text file to client's file system
   *
   * Per ACP spec: Calls fs/write_text_file on the client to write files
   * in the client's workspace. Client handles directory creation and permissions.
   *
   * @param options - Write options including sessionId, path, content
   * @throws Error if client doesn't support fs.writeTextFile or path is invalid
   */
  writeTextFile(options: WriteFileOptions): Promise<void>;
}

/**
 * ACP-compliant file system client implementation
 *
 * Uses ClientConnection to call client methods for file operations,
 * ensuring access to the client's file system including unsaved changes.
 */
export class AcpFileSystemClient implements FileSystemClient {
  constructor(
    private connection: ClientConnection,
    private logger: Logger
  ) {
    this.logger.debug('AcpFileSystemClient initialized');
  }

  async readTextFile(options: ReadFileOptions): Promise<string> {
    const { sessionId, path, line, limit } = options;

    this.logger.debug('Reading text file via ACP', {
      sessionId,
      path,
      line,
      limit,
    });

    try {
      // Call ACP client method per spec
      // Per ACP: Only include line/limit if they are defined and not null
      const response = await this.connection.readTextFile({
        sessionId,
        path,
        ...(line !== undefined && line !== null && { line }),
        ...(limit !== undefined && limit !== null && { limit }),
      });

      this.logger.debug('Text file read successfully via ACP', {
        path,
        contentLength: response.content.length,
        lines: response.content.split('\n').length,
      });

      return response.content;
    } catch (error) {
      this.logger.error('Failed to read text file via ACP', {
        error,
        sessionId,
        path,
        line,
        limit,
      });

      // Re-throw with context
      throw new Error(
        `Failed to read file '${path}': ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async writeTextFile(options: WriteFileOptions): Promise<void> {
    const { sessionId, path, content } = options;

    this.logger.debug('Writing text file via ACP', {
      sessionId,
      path,
      contentLength: content.length,
      lines: content.split('\n').length,
    });

    try {
      // Call ACP client method per spec
      await this.connection.writeTextFile({
        sessionId,
        path,
        content,
      });

      this.logger.debug('Text file written successfully via ACP', {
        path,
        contentLength: content.length,
      });
    } catch (error) {
      this.logger.error('Failed to write text file via ACP', {
        error,
        sessionId,
        path,
        contentLength: content.length,
      });

      // Re-throw with context
      throw new Error(
        `Failed to write file '${path}': ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
