/**
 * Terminal Tool Provider
 *
 * Provides secure terminal/shell command execution for the ACP adapter.
 * Includes command validation, timeout handling, and process management.
 */

import { spawn, ChildProcess } from 'child_process';
import {
  ToolError,
  type AdapterConfig,
  type Logger,
  type Tool,
  type ToolProvider,
  type ToolResult,
} from '../types';

export interface TerminalConfig {
  enabled: boolean;
  maxProcesses: number;
  defaultTimeout?: number;
  maxTimeout?: number; // Maximum allowed timeout value
  allowedCommands?: string[];
  forbiddenCommands?: string[];
  workingDirectory?: string;
}

export interface ShellSession {
  id: string;
  process: ChildProcess;
  workingDirectory: string;
  createdAt: Date;
  lastActivity: Date;
}

export class TerminalToolProvider implements ToolProvider {
  readonly name = 'terminal';
  readonly description =
    'Terminal command execution and shell session management';

  // @ts-expect-error - Intentionally unused, reserved for future use
  private _config: AdapterConfig;
  private logger: Logger;
  private terminalConfig: TerminalConfig;
  private activeSessions = new Map<string, ShellSession>();
  private activeProcesses = new Set<ChildProcess>();

  constructor(config: AdapterConfig, logger: Logger) {
    this._config = config;
    this.logger = logger;
    this.terminalConfig = config.tools.terminal;

    this.logger.debug('TerminalToolProvider initialized', {
      enabled: this.terminalConfig.enabled,
      maxProcesses: this.terminalConfig.maxProcesses,
    });

    // Cleanup process on exit
    process.on('exit', () => {
      this.cleanup().catch((err) => this.logger.error('Cleanup error on exit', err));
    });
    process.on('SIGINT', () => {
      this.cleanup().catch((err) => this.logger.error('Cleanup error on SIGINT', err));
    });
    process.on('SIGTERM', () => {
      this.cleanup().catch((err) => this.logger.error('Cleanup error on SIGTERM', err));
    });
  }

  getTools(): Tool[] {
    if (!this.terminalConfig.enabled) {
      this.logger.debug('Terminal tools disabled by configuration');
      return [];
    }

    return [
      {
        name: 'execute_command',
        description: 'Execute a shell command and return the output',
        parameters: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: 'The command to execute',
            },
            args: {
              type: 'array',
              items: { type: 'string', description: 'Command argument' },
              description: 'Command arguments (optional)',
            },
            working_directory: {
              type: 'string',
              description: 'Working directory for command execution',
            },
            timeout: {
              type: 'number',
              description: 'Timeout in milliseconds (default: 30000)',
            },
            capture_stderr: {
              type: 'boolean',
              description:
                'Whether to capture stderr separately (default: true)',
            },
          },
          required: ['command'],
        },
        handler: this.executeCommand.bind(this),
      },
      {
        name: 'start_shell_session',
        description: 'Start an interactive shell session',
        parameters: {
          type: 'object',
          properties: {
            shell: {
              type: 'string',
              description: 'Shell to use (bash, zsh, sh, etc.)',
            },
            working_directory: {
              type: 'string',
              description: 'Initial working directory',
            },
          },
        },
        handler: this.startShellSession.bind(this),
      },
      {
        name: 'send_to_shell',
        description: 'Send input to an active shell session',
        parameters: {
          type: 'object',
          properties: {
            session_id: {
              type: 'string',
              description: 'Shell session ID',
            },
            input: {
              type: 'string',
              description: 'Input to send to the shell',
            },
            timeout: {
              type: 'number',
              description: 'Timeout in milliseconds (default: 10000)',
            },
          },
          required: ['session_id', 'input'],
        },
        handler: this.sendToShell.bind(this),
      },
      {
        name: 'close_shell_session',
        description: 'Close an active shell session',
        parameters: {
          type: 'object',
          properties: {
            session_id: {
              type: 'string',
              description: 'Shell session ID to close',
            },
          },
          required: ['session_id'],
        },
        handler: this.closeShellSession.bind(this),
      },
      {
        name: 'list_processes',
        description: 'List active processes and shell sessions',
        parameters: {
          type: 'object',
          properties: {},
        },
        handler: this.listProcesses.bind(this),
      },
    ];
  }

  /**
   * Execute a single command
   */
  private async executeCommand(
    params: Record<string, any>
  ): Promise<ToolResult> {
    try {
      const command = this.validateCommand(params['command']);
      const args = params['args'] || [];
      const workingDirectory = params['working_directory'] || process.cwd();
      const timeout =
        params['timeout'] || this.terminalConfig.defaultTimeout || 30000;
      const captureStderr = params['capture_stderr'] !== false;

      // Validate timeout value
      if (timeout < 0) {
        throw new ToolError(
          'Timeout must be a positive number',
          'execute_command'
        );
      }

      // Enforce maximum timeout
      const maxTimeout = this.terminalConfig.maxTimeout || 300000; // 5 minutes default
      if (timeout > maxTimeout) {
        throw new ToolError(
          `Timeout exceeds maximum allowed (${maxTimeout}ms)`,
          'execute_command'
        );
      }

      this.logger.debug('Executing command', {
        command,
        args,
        workingDirectory,
        timeout,
      });

      // Check process limits
      if (this.activeProcesses.size >= this.terminalConfig.maxProcesses) {
        throw new ToolError(
          `Maximum number of processes reached (${this.terminalConfig.maxProcesses})`,
          'execute_command'
        );
      }

      const result = await this.runCommand(command, args, {
        cwd: workingDirectory,
        timeout,
        captureStderr,
      });

      return {
        success: result.success,
        result: {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          command: `${command} ${args.join(' ')}`.trim(),
          workingDirectory,
        },
        metadata: {
          executionTime: result.executionTime,
          timeout,
          pid: result.pid,
        },
      };
    } catch (error) {
      this.logger.error('Failed to execute command', {
        error,
        command: params['command'],
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Start an interactive shell session
   */
  private async startShellSession(
    params: Record<string, any>
  ): Promise<ToolResult> {
    try {
      const shell: string = params['shell'] || process.env['SHELL'] || 'bash';
      const workingDirectory: string =
        params['working_directory'] || process.cwd();

      this.logger.debug('Starting shell session', { shell, workingDirectory });

      // Check session limits
      if (this.activeSessions.size >= this.terminalConfig.maxProcesses) {
        throw new ToolError(
          `Maximum number of sessions reached (${this.terminalConfig.maxProcesses})`,
          'start_shell_session'
        );
      }

      const sessionId = this.generateSessionId();
      const childProcess = spawn(shell, ['-i'], {
        cwd: workingDirectory,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      const session: ShellSession = {
        id: sessionId,
        process: childProcess,
        workingDirectory,
        createdAt: new Date(),
        lastActivity: new Date(),
      };

      this.activeSessions.set(sessionId, session);
      this.activeProcesses.add(childProcess);

      // Handle process exit
      childProcess.on('exit', (code: number | null) => {
        this.logger.debug('Shell session exited', { sessionId, code });
        this.activeSessions.delete(sessionId);
        this.activeProcesses.delete(childProcess);
      });

      return {
        success: true,
        result: {
          sessionId,
          shell,
          workingDirectory,
          pid: childProcess.pid,
        },
        metadata: {
          createdAt: session.createdAt.toISOString(),
        },
      };
    } catch (error) {
      this.logger.error('Failed to start shell session', { error, params });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Send input to shell session
   */
  private async sendToShell(params: Record<string, any>): Promise<ToolResult> {
    try {
      const sessionId = params['session_id'];
      const input = params['input'];
      const timeout = params['timeout'] || 10000;

      // Validate timeout value
      if (timeout < 0) {
        throw new ToolError(
          'Timeout must be a positive number',
          'send_to_shell'
        );
      }

      // Enforce maximum timeout
      const maxTimeout = this.terminalConfig.maxTimeout || 300000; // 5 minutes default
      if (timeout > maxTimeout) {
        throw new ToolError(
          `Timeout exceeds maximum allowed (${maxTimeout}ms)`,
          'send_to_shell'
        );
      }

      const session = this.activeSessions.get(sessionId);
      if (!session) {
        throw new ToolError(
          `Shell session not found: ${sessionId}`,
          'send_to_shell'
        );
      }

      this.logger.debug('Sending input to shell', {
        sessionId,
        inputLength: input.length,
      });

      session.lastActivity = new Date();

      // Send input to process
      if (session.process.stdin) {
        session.process.stdin.write(`${input}\n`);
      } else {
        throw new ToolError(
          'Shell session stdin not available',
          'send_to_shell'
        );
      }

      // Collect output for a short period
      const output = await this.collectShellOutput(session.process, timeout);

      return {
        success: true,
        result: {
          sessionId,
          output: output.stdout,
          error: output.stderr,
          inputSent: input,
        },
        metadata: {
          timeout,
          outputLength: output.stdout.length,
        },
      };
    } catch (error) {
      this.logger.error('Failed to send to shell', {
        error,
        sessionId: params['session_id'],
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Close shell session
   */
  private async closeShellSession(
    params: Record<string, any>
  ): Promise<ToolResult> {
    try {
      const sessionId = params['session_id'];
      const session = this.activeSessions.get(sessionId);

      if (!session) {
        return {
          success: true,
          result: {
            sessionId,
            message: 'Session not found or already closed',
          },
        };
      }

      this.logger.debug('Closing shell session', { sessionId });

      // Graceful shutdown
      if (session.process.stdin) {
        session.process.stdin.write('exit\n');
        session.process.stdin.end();
      }

      // Force kill after timeout
      setTimeout(() => {
        if (!session.process.killed) {
          session.process.kill('SIGTERM');
        }
      }, 2000);

      this.activeSessions.delete(sessionId);
      this.activeProcesses.delete(session.process);

      return {
        success: true,
        result: {
          sessionId,
          closed: true,
        },
        metadata: {
          sessionDuration: Date.now() - session.createdAt.getTime(),
        },
      };
    } catch (error) {
      this.logger.error('Failed to close shell session', {
        error,
        sessionId: params['session_id'],
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * List active processes
   */
  private async listProcesses(): Promise<ToolResult> {
    try {
      const sessions = Array.from(this.activeSessions.values()).map(
        (session) => ({
          id: session.id,
          pid: session.process.pid,
          workingDirectory: session.workingDirectory,
          createdAt: session.createdAt.toISOString(),
          lastActivity: session.lastActivity.toISOString(),
          uptime: Date.now() - session.createdAt.getTime(),
        })
      );

      return {
        success: true,
        result: {
          activeSessions: sessions,
          totalProcesses: this.activeProcesses.size,
          maxProcesses: this.terminalConfig.maxProcesses,
        },
        metadata: {
          timestamp: new Date().toISOString(),
        },
      };
    } catch (error) {
      this.logger.error('Failed to list processes', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Validate command against security policies
   */
  private validateCommand(command: string): string {
    if (!command || typeof command !== 'string' || command.trim() === '') {
      throw new ToolError(
        'Invalid command: must be a non-empty string',
        'terminal'
      );
    }

    const trimmedCommand = command.trim();

    // Check forbidden commands
    if (this.terminalConfig.forbiddenCommands) {
      const isForbidden = this.terminalConfig.forbiddenCommands.some(
        (forbidden) =>
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
    if (
      this.terminalConfig.allowedCommands &&
      this.terminalConfig.allowedCommands.length > 0
    ) {
      const isAllowed = this.terminalConfig.allowedCommands.some((allowed) =>
        trimmedCommand.toLowerCase().startsWith(allowed.toLowerCase())
      );

      if (!isAllowed) {
        throw new ToolError(
          `Command not in allowed list: ${command}. Allowed: ${this.terminalConfig.allowedCommands.join(', ')}`,
          'terminal'
        );
      }
    }

    return trimmedCommand;
  }

  /**
   * Run command with timeout and output capture
   */
  private async runCommand(
    command: string,
    args: string[],
    options: {
      cwd: string;
      timeout: number;
      captureStderr: boolean;
    }
  ): Promise<{
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
    executionTime: number;
    pid?: number;
  }> {
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const childProcess = spawn(command, args, {
        cwd: options.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      this.activeProcesses.add(childProcess);

      let stdout = '';
      let stderr = '';

      if (childProcess.stdout) {
        childProcess.stdout.on('data', (data: Buffer) => {
          stdout += data.toString();
        });
      }

      if (childProcess.stderr) {
        childProcess.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });
      }

      childProcess.on('close', (code: number | null) => {
        this.activeProcesses.delete(childProcess);
        const executionTime = Date.now() - startTime;

        resolve({
          success: code === 0,
          stdout,
          stderr: options.captureStderr ? stderr : '',
          exitCode: code || 0,
          executionTime,
          ...(childProcess.pid !== undefined && { pid: childProcess.pid }),
        });
      });

      childProcess.on('error', (error: Error) => {
        this.activeProcesses.delete(childProcess);
        reject(new ToolError(`Process error: ${error.message}`, 'terminal'));
      });

      // Handle timeout
      let forceKillTimeoutId: NodeJS.Timeout | undefined;
      const timeoutId = setTimeout(() => {
        if (!childProcess.killed) {
          childProcess.kill('SIGTERM');

          // Force kill after additional timeout
          forceKillTimeoutId = setTimeout(() => {
            if (!childProcess.killed) {
              childProcess.kill('SIGKILL');
            }
          }, 2000);

          reject(
            new ToolError(
              `Command timed out after ${options.timeout}ms`,
              'terminal'
            )
          );
        }
      }, options.timeout);

      childProcess.on('close', () => {
        clearTimeout(timeoutId);
        if (forceKillTimeoutId) {
          clearTimeout(forceKillTimeoutId);
        }
      });
    });
  }

  /**
   * Collect output from shell session for a limited time
   */
  private async collectShellOutput(
    process: ChildProcess,
    timeout: number
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';

      const dataHandler = (data: Buffer) => {
        stdout += data.toString();
      };

      const errorHandler = (data: Buffer) => {
        stderr += data.toString();
      };

      if (process.stdout) {
        process.stdout.on('data', dataHandler);
      }

      if (process.stderr) {
        process.stderr.on('data', errorHandler);
      }

      setTimeout(() => {
        if (process.stdout) {
          process.stdout.removeListener('data', dataHandler);
        }
        if (process.stderr) {
          process.stderr.removeListener('data', errorHandler);
        }

        resolve({ stdout, stderr });
      }, timeout);
    });
  }

  /**
   * Generate unique session ID
   */
  private generateSessionId(): string {
    return `shell_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Cleanup all processes
   */
  async cleanup(): Promise<void> {
    this.logger.debug('Cleaning up terminal processes');

    // Close all shell sessions
    for (const [sessionId, session] of this.activeSessions) {
      this.logger.debug(`Terminating session: ${sessionId}`);
      if (!session.process.killed) {
        session.process.kill('SIGTERM');
      }
    }

    // Kill any remaining processes
    for (const process of this.activeProcesses) {
      if (!process.killed) {
        process.kill('SIGTERM');
      }
    }

    this.activeSessions.clear();
    this.activeProcesses.clear();
  }
}
