/**
 * CursorCliBridge - Interface with cursor-agent CLI
 *
 * This class provides a bridge to the cursor-agent CLI, handling
 * command execution, authentication, and session management.
 */

import { spawn, ChildProcess } from 'child_process';
import {
  CursorError,
  type AdapterConfig,
  type Logger,
  type CursorCommandOptions,
  type CursorResponse,
  type CursorSession,
  type CursorAuthStatus,
  type StreamChunk,
  type StreamProgress,
} from '../types';

export interface PromptOptions {
  sessionId: string;
  content: ProcessedContent;
  metadata?: Record<string, any> | undefined;
}

export interface StreamingPromptOptions extends PromptOptions {
  abortSignal?: AbortSignal | undefined;
  onChunk?: ((chunk: StreamChunk) => Promise<void>) | undefined;
  onProgress?: ((progress: StreamProgress) => void) | undefined;
}

export interface ProcessedContent {
  value: string;
  metadata: Record<string, any>;
}

export class CursorCliBridge {
  private config: AdapterConfig;
  private logger: Logger;
  private activeSessions = new Map<string, CursorSession>();
  private activeProcesses = new Map<string, ChildProcess>();

  constructor(config: AdapterConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;

    this.logger.debug('CursorCliBridge initialized', {
      timeout: config.cursor.timeout,
      retries: config.cursor.retries,
    });
  }

  /**
   * Checks if cursor-agent CLI is available and authenticated
   */
  async checkAuthentication(): Promise<CursorAuthStatus> {
    this.logger.debug('Checking cursor-agent authentication status');

    try {
      const response = await this.executeCommand(['status']);

      if (!response.success) {
        return {
          authenticated: false,
          error: response.error || 'Authentication check failed',
        };
      }

      // Parse cursor-agent status output
      try {
        const statusOutput = response.stdout || '';

        // Look for authentication indicators in the output
        const lines = statusOutput.split('\n');
        let user: string | undefined;
        let email: string | undefined;
        let plan: string | undefined;

        for (const line of lines) {
          if (line.includes('User:') || line.includes('user:')) {
            user = line.split(':')[1]?.trim();
          } else if (line.includes('Email:') || line.includes('email:')) {
            email = line.split(':')[1]?.trim();
          } else if (line.includes('Plan:') || line.includes('plan:')) {
            plan = line.split(':')[1]?.trim();
          }
        }

        // If we got user info, we're authenticated
        const authenticated = Boolean(
          user || email || statusOutput.includes('Signed in')
        );

        const result: CursorAuthStatus = {
          authenticated,
        };
        if (user) {
          result.user = user;
        }
        if (email) {
          result.email = email;
        }
        if (plan) {
          result.plan = plan;
        }
        return result;
      } catch (parseError) {
        // If parsing fails, assume authenticated if command succeeded
        return {
          authenticated: true,
        };
      }
    } catch (error) {
      this.logger.error('Authentication check failed', error);
      return {
        authenticated: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Gets the cursor-agent version
   */
  async getVersion(): Promise<string> {
    this.logger.debug('Getting cursor-agent version');

    try {
      const response = await this.executeCommand(['--version']);

      if (!response.success) {
        throw new CursorError(`Failed to get version: ${response.error}`);
      }

      // Parse version from output - cursor-agent returns version in format like "1.2.3"
      const versionOutput = response.stdout?.trim() || '';
      const versionMatch = versionOutput.match(/\d+\.\d+\.\d+/);

      return versionMatch ? versionMatch[0] : versionOutput || 'unknown';
    } catch (error) {
      this.logger.error('Failed to get cursor-agent version', error);
      throw error instanceof CursorError
        ? error
        : new CursorError(
            `Version check failed: ${error instanceof Error ? error.message : String(error)}`,
            error instanceof Error ? error : undefined
          );
    }
  }

  /**
   * Executes a cursor-agent command
   */
  async executeCommand(
    command: string[],
    options: CursorCommandOptions = {}
  ): Promise<CursorResponse> {
    const commandStr = `cursor-agent ${command.join(' ')}`;
    this.logger.debug(`Executing command: ${commandStr}`, options);

    const startTime = Date.now();

    try {
      // Retry logic
      let lastError: Error | null = null;
      let attempt = 0;
      const maxAttempts = this.config.cursor.retries + 1;

      while (attempt < maxAttempts) {
        try {
          const response = await this.executeSingleCommand(command, options);

          const duration = Date.now() - startTime;
          this.logger.debug(
            `Command completed in ${duration}ms: ${commandStr}`
          );

          return response;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          attempt++;

          if (attempt < maxAttempts) {
            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000); // Exponential backoff
            this.logger.debug(
              `Command failed, retrying in ${delay}ms (attempt ${attempt}/${maxAttempts})`
            );
            await this.sleep(delay);
          }
        }
      }

      throw new CursorError(
        `Command failed after ${maxAttempts} attempts: ${commandStr}`,
        lastError || undefined
      );
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(
        `Command failed after ${duration}ms: ${commandStr}`,
        error
      );
      throw error instanceof CursorError
        ? error
        : new CursorError(
            `Command execution failed: ${error instanceof Error ? error.message : String(error)}`,
            error instanceof Error ? error : undefined
          );
    }
  }

  /**
   * Starts an interactive cursor-agent session
   */
  async startInteractiveSession(sessionId?: string): Promise<CursorSession> {
    const id = sessionId || this.generateSessionId();
    this.logger.debug(`Starting interactive session: ${id}`);

    try {
      // Create a new chat session using cursor-agent
      let chatId: string;

      if (sessionId && sessionId !== 'new') {
        // Use existing session ID
        chatId = sessionId;
      } else {
        // Create a new chat
        const createResponse = await this.executeCommand(['create-chat']);
        if (!createResponse.success) {
          throw new CursorError(
            `Failed to create chat: ${createResponse.error}`
          );
        }

        // Extract chat ID from response
        chatId = createResponse.stdout?.trim() || this.generateSessionId();
      }

      const session: CursorSession = {
        id: chatId,
        status: 'active',
        lastActivity: new Date(),
        metadata: {
          created: new Date(),
          type: 'interactive',
          cursorChatId: chatId,
        },
      };

      this.activeSessions.set(id, session);
      this.logger.info(
        `Interactive session started: ${id} (cursor chat: ${chatId})`
      );

      return session;
    } catch (error) {
      this.logger.error(`Failed to start interactive session: ${id}`, error);
      throw new CursorError(
        `Failed to start interactive session: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Sends input to an interactive session
   */
  async sendSessionInput(sessionId: string, input: string): Promise<string> {
    this.logger.debug(`Sending input to session ${sessionId}: ${input}`);

    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new CursorError(`Session not found: ${sessionId}`);
    }

    try {
      // TODO: Implement actual session input handling
      session.lastActivity = new Date();

      // Mock response for now
      const response = `Processed: ${input}`;
      this.logger.debug(`Session ${sessionId} response: ${response}`);

      return response;
    } catch (error) {
      this.logger.error(`Failed to send input to session ${sessionId}`, error);
      throw new CursorError(
        `Session input failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Closes an interactive session
   */
  async closeSession(sessionId: string): Promise<void> {
    this.logger.debug(`Closing session: ${sessionId}`);

    const session = this.activeSessions.get(sessionId);
    if (!session) {
      this.logger.warn(`Session not found for closing: ${sessionId}`);
      return;
    }

    try {
      // Clean up process if exists
      const process = this.activeProcesses.get(sessionId);
      if (process) {
        process.kill();
        this.activeProcesses.delete(sessionId);
      }

      // Update session status
      session.status = 'inactive';
      this.activeSessions.delete(sessionId);

      this.logger.info(`Session closed: ${sessionId}`);
    } catch (error) {
      this.logger.error(`Failed to close session: ${sessionId}`, error);
      throw new CursorError(
        `Failed to close session: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Lists active cursor sessions
   */
  getActiveSessions(): CursorSession[] {
    return Array.from(this.activeSessions.values());
  }

  /**
   * Closes all resources and cleans up
   */
  async close(): Promise<void> {
    this.logger.info('Closing CursorCliBridge');

    try {
      // Close all active sessions
      const sessionIds = Array.from(this.activeSessions.keys());
      const closePromises = sessionIds.map((id) => this.closeSession(id));

      await Promise.all(closePromises);

      // Kill any remaining processes
      for (const [sessionId, process] of this.activeProcesses) {
        this.logger.debug(`Killing process for session: ${sessionId}`);
        process.kill('SIGTERM');
      }

      this.activeProcesses.clear();
      this.activeSessions.clear();

      this.logger.info('CursorCliBridge closed successfully');
    } catch (error) {
      this.logger.error('Error closing CursorCliBridge', error);
      throw new CursorError(
        `Failed to close bridge: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  // Private helper methods

  private async executeSingleCommand(
    command: string[],
    options: CursorCommandOptions
  ): Promise<CursorResponse> {
    const timeoutMs = options.timeout || this.config.cursor.timeout;
    const workingDir = options.cwd || process.cwd();

    this.logger.debug(`Spawning cursor-agent with timeout ${timeoutMs}ms`, {
      command,
      cwd: workingDir,
    });

    return new Promise((resolve, reject) => {
      this.logger.info(`About to spawn: cursor-agent ${command.join(' ')}`);

      const childProcess = spawn('cursor-agent', command, {
        cwd: workingDir,
        env: { ...process.env, ...options.env },
        // Don't use spawn's timeout option - it causes issues with cursor-agent
        // We handle timeout manually with setTimeout below
        // Use 'ignore' for stdin since cursor-agent gets input from args, not stdin
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.logger.debug('Process spawned', { pid: childProcess.pid });

      let stdout = '';
      let stderr = '';

      const startTime = Date.now();

      // Log all process events
      childProcess.on('spawn', () => {
        this.logger.debug('Process spawn event fired');
      });

      childProcess.on('exit', (code, signal) => {
        this.logger.debug('Process exit event', { code, signal });
      });

      if (childProcess.stdout) {
        childProcess.stdout.on('data', (data: Buffer) => {
          const chunk = data.toString();
          stdout += chunk;
          this.logger.debug('Received stdout chunk', {
            length: chunk.length,
            preview: chunk.substring(0, 100),
          });
        });
      } else {
        this.logger.warn('No stdout stream available');
      }

      if (childProcess.stderr) {
        childProcess.stderr.on('data', (data: Buffer) => {
          const chunk = data.toString();
          stderr += chunk;
          this.logger.debug('Received stderr chunk', {
            length: chunk.length,
            preview: chunk.substring(0, 100),
          });
        });
      } else {
        this.logger.warn('No stderr stream available');
      }

      // No need to handle stdin - it's set to 'ignore' in spawn options
      // cursor-agent gets its input from command-line args

      childProcess.on('close', (code: number | null) => {
        const duration = Date.now() - startTime;
        this.logger.debug(`cursor-agent process closed after ${duration}ms`, {
          exitCode: code,
          stdoutLength: stdout.length,
          stderrLength: stderr.length,
        });

        const response: CursorResponse = {
          success: code === 0,
          stdout,
          stderr,
          exitCode: code || 0,
        };

        if (code !== 0) {
          response.error = stderr || `Process exited with code ${code}`;
        }

        resolve(response);
      });

      childProcess.on('error', (error: Error) => {
        const duration = Date.now() - startTime;
        this.logger.error(
          `cursor-agent process error after ${duration}ms: ${error.message}`
        );
        reject(new CursorError(`Process error: ${error.message}`, error));
      });

      // Handle timeout
      const timeoutHandle = setTimeout(() => {
        if (!childProcess.killed) {
          const duration = Date.now() - startTime;
          this.logger.error(
            `cursor-agent command timed out after ${duration}ms (limit: ${timeoutMs}ms)`,
            {
              command,
              stdout: stdout.substring(0, 500),
              stderr: stderr.substring(0, 500),
            }
          );
          childProcess.kill('SIGTERM');
          reject(new CursorError(`Command timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      // Clear timeout when process exits
      childProcess.on('exit', () => {
        clearTimeout(timeoutHandle);
      });
    });
  }

  private generateSessionId(): string {
    return `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Send a prompt to Cursor CLI
   */
  async sendPrompt(options: PromptOptions): Promise<CursorResponse> {
    const { sessionId, content, metadata } = options;

    this.logger.debug('Sending prompt to Cursor CLI', {
      sessionId,
      contentLength: content.value.length,
      hasMetadata: Boolean(metadata),
    });

    try {
      // Extract working directory from metadata
      const workingDir =
        (metadata?.['cwd'] as string | undefined) || process.cwd();

      this.logger.info('Sending prompt to Cursor CLI', {
        sessionId,
        cwd: workingDir,
      });

      // Create a temporary file for the prompt content
      const tempFile = `/tmp/cursor-prompt-${Date.now()}.txt`;
      const fs = await import('fs/promises');
      await fs.writeFile(tempFile, content.value, 'utf8');

      try {
        // Use cursor-agent with print mode for programmatic access
        const args = [
          '--print',
          '--output-format',
          'json',
          '--force', // Allow commands unless explicitly denied
          content.value,
        ];

        // If we have a sessionId, try to resume that chat
        if (sessionId && sessionId !== 'new') {
          args.unshift('--resume', sessionId);
        }

        this.logger.debug('Executing cursor-agent command', {
          args,
          cwd: workingDir,
        });
        this.logger.info(
          `Running: cursor-agent ${args.join(' ')} (cwd: ${workingDir})`
        );

        const response = await this.executeCommand(args, { cwd: workingDir });

        this.logger.debug('cursor-agent response', {
          success: response.success,
          exitCode: response.exitCode,
          stdoutLength: response.stdout?.length || 0,
          stderrLength: response.stderr?.length || 0,
          error: response.error,
        });

        if (!response.success) {
          this.logger.error('cursor-agent failed', {
            exitCode: response.exitCode,
            stderr: response.stderr,
            error: response.error,
          });
          throw new CursorError(
            `Cursor agent failed: ${response.error || response.stderr}`
          );
        }

        // Parse JSON response if available
        let parsedResponse;
        let actualResponseText = response.stdout || '';

        try {
          parsedResponse = response.stdout ? JSON.parse(response.stdout) : null;

          // Extract the actual response text from the parsed JSON
          if (parsedResponse && typeof parsedResponse === 'object') {
            // cursor-agent can return response in different fields
            if (parsedResponse.result) {
              actualResponseText = parsedResponse.result;
            } else if (parsedResponse.response) {
              actualResponseText = parsedResponse.response;
            } else if (parsedResponse.content) {
              actualResponseText = parsedResponse.content;
            } else if (parsedResponse.message) {
              actualResponseText = parsedResponse.message;
            }
          }
        } catch {
          // If JSON parsing fails, treat as plain text
          parsedResponse = { content: response.stdout, type: 'text' };
          actualResponseText = response.stdout || '';
        }

        return {
          ...response,
          stdout: actualResponseText, // Override stdout with the extracted text
          metadata: {
            ...metadata,
            processedAt: new Date().toISOString(),
            contentLength: content.value.length,
          },
        };
      } finally {
        // Clean up temporary file
        try {
          await fs.unlink(tempFile);
        } catch {
          // Ignore cleanup errors
        }
      }
    } catch (error) {
      this.logger.error('Failed to send prompt to Cursor CLI', error);
      throw error instanceof CursorError
        ? error
        : new CursorError(
            `Prompt failed: ${error instanceof Error ? error.message : String(error)}`,
            error instanceof Error ? error : undefined
          );
    }
  }

  /**
   * Send a streaming prompt to Cursor CLI
   */
  async sendStreamingPrompt(
    options: StreamingPromptOptions
  ): Promise<CursorResponse> {
    const { sessionId, content, metadata, abortSignal, onChunk, onProgress } =
      options;

    this.logger.debug('Sending streaming prompt to Cursor CLI', {
      sessionId,
      contentLength: content.value.length,
      hasAbortSignal: Boolean(abortSignal),
      hasChunkHandler: Boolean(onChunk),
      hasProgressHandler: Boolean(onProgress),
    });

    try {
      // Extract working directory from metadata
      const workingDir =
        (metadata?.['cwd'] as string | undefined) || process.cwd();

      this.logger.info('Sending streaming prompt to Cursor CLI', {
        sessionId,
        cwd: workingDir,
      });

      const args = [
        'agent',
        '--print',
        '--output-format',
        'stream-json',
        '--stream-partial-output',
        '--force',
        content.value,
      ];

      // If we have a sessionId, try to resume that chat
      if (sessionId && sessionId !== 'new') {
        args.unshift('--resume', sessionId);
      }

      let responseContent = '';
      let processedChunks = 0;

      // Execute streaming command
      const streamOptions: any = {
        cwd: workingDir,
        onData: async (chunk: string) => {
          processedChunks++;
          responseContent += chunk;

          // Try to parse as JSON stream
          try {
            const jsonChunk = JSON.parse(chunk);
            if (onChunk) {
              await onChunk({
                type: 'content',
                data: jsonChunk,
              });
            }
          } catch {
            // If not JSON, send as plain text
            if (onChunk) {
              await onChunk({
                type: 'content',
                data: chunk,
              });
            }
          }

          if (onProgress) {
            onProgress({
              step: 'streaming',
              current: processedChunks,
              progress: processedChunks,
              message: `Received chunk ${processedChunks}`,
            });
          }
        },
      };
      if (abortSignal) {
        streamOptions.abortSignal = abortSignal;
      }

      const response = await this.executeStreamingCommand(args, streamOptions);

      // Send completion chunk
      if (onChunk) {
        await onChunk({
          type: 'done',
          data: { complete: true },
        });
      }

      return {
        success: response.success,
        stdout: responseContent,
        stderr: response.stderr || '',
        exitCode: response.exitCode || 0,
        metadata: {
          ...metadata,
          processedAt: new Date().toISOString(),
          contentLength: content.value.length,
          chunks: processedChunks,
          streaming: true,
        },
      };
    } catch (error) {
      this.logger.error('Failed to send streaming prompt to Cursor CLI', error);

      // Send error chunk if handler exists
      if (onChunk) {
        try {
          await onChunk({
            type: 'error',
            data: error instanceof Error ? error.message : String(error),
          });
        } catch (chunkError) {
          this.logger.error('Failed to send error chunk', chunkError);
        }
      }

      throw error instanceof CursorError
        ? error
        : new CursorError(
            `Streaming prompt failed: ${error instanceof Error ? error.message : String(error)}`,
            error instanceof Error ? error : undefined
          );
    }
  }

  /**
   * Execute a streaming command with real-time data processing
   */
  private async executeStreamingCommand(
    command: string[],
    options: {
      abortSignal?: AbortSignal;
      onData?: (chunk: string) => Promise<void>;
      cwd?: string;
    } = {}
  ): Promise<CursorResponse> {
    const { abortSignal, onData, cwd } = options;

    return new Promise((resolve, reject) => {
      const childProcess = spawn('cursor-agent', command, {
        // Use 'ignore' for stdin since cursor-agent gets input from args
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
        cwd: cwd || process.cwd(),
      });

      let stdout = '';
      let stderr = '';

      if (childProcess.stdout) {
        childProcess.stdout.on('data', async (data: Buffer) => {
          const chunk = data.toString();
          stdout += chunk;

          // Check for abort signal
          if (abortSignal?.aborted) {
            childProcess.kill('SIGTERM');
            reject(new CursorError('Streaming command aborted'));
            return;
          }

          if (onData) {
            try {
              await onData(chunk);
            } catch (error) {
              this.logger.error('Error in data handler', error);
            }
          }
        });
      }

      if (childProcess.stderr) {
        childProcess.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });
      }

      // No need to handle stdin - it's set to 'ignore' in spawn options

      childProcess.on('close', (code: number | null) => {
        const response: CursorResponse = {
          success: code === 0,
          stdout,
          stderr,
          exitCode: code || 0,
        };

        if (code !== 0) {
          response.error = stderr || `Process exited with code ${code}`;
        }

        resolve(response);
      });

      childProcess.on('error', (error: Error) => {
        reject(new CursorError(`Process error: ${error.message}`, error));
      });

      // Handle timeout
      const timeout = setTimeout(() => {
        if (!childProcess.killed) {
          childProcess.kill('SIGTERM');
          reject(new CursorError('Streaming command timed out'));
        }
      }, this.config.cursor.timeout);

      childProcess.on('close', () => {
        clearTimeout(timeout);
      });

      // Handle abort signal
      if (abortSignal) {
        abortSignal.addEventListener('abort', () => {
          if (!childProcess.killed) {
            childProcess.kill('SIGTERM');
          }
        });
      }
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
