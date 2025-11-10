/**
 * Terminal Utilities
 *
 * Common patterns and helper functions for terminal usage.
 * All functions use ACP-compliant terminal operations.
 *
 * Per ACP spec: https://agentclientprotocol.com/protocol/terminals
 */

import type {
  TerminalHandle,
  TerminalOutputResponse,
  WaitForTerminalExitResponse,
  EnvVariable,
} from '@agentclientprotocol/sdk';
import type { TerminalManager } from './terminal-manager';
import type { ToolCallManager } from './tool-call-manager';
import type { Logger } from '../types';
import { ToolError } from '../types';

/**
 * Result from executing a simple command
 */
export interface SimpleCommandResult {
  /**
   * The terminal output
   */
  output: string;

  /**
   * Exit code (if command completed normally)
   */
  exitCode?: number | null;

  /**
   * Signal that terminated the process (if killed by signal)
   */
  signal?: string | null;

  /**
   * Whether output was truncated due to byte limit
   */
  truncated?: boolean;
}

/**
 * Execute a command and return output (simple case)
 *
 * Per ACP spec: https://agentclientprotocol.com/protocol/terminals#executing-commands
 *
 * This is a convenience wrapper for simple commands that:
 * - Executes a command via terminal/create
 * - Waits for completion via terminal/wait_for_exit
 * - Gets output via terminal/output
 * - Automatically releases terminal via TerminalHandle.release()
 *
 * @param terminalManager - The terminal manager instance
 * @param sessionId - The session ID (required per ACP spec)
 * @param command - The command to execute
 * @param args - Command arguments
 * @param options - Optional parameters (cwd, env, outputByteLimit)
 * @returns SimpleCommandResult with output, exit code, signal, and truncation status
 *
 * @example
 * ```typescript
 * const result = await executeSimpleCommand(
 *   terminalManager,
 *   'session-1',
 *   'echo',
 *   ['hello world']
 * );
 * console.log(result.output); // "hello world\n"
 * console.log(result.exitCode); // 0
 * ```
 */
export async function executeSimpleCommand(
  terminalManager: TerminalManager,
  sessionId: string,
  command: string,
  args: string[] = [],
  options?: {
    cwd?: string;
    env?: EnvVariable[];
    outputByteLimit?: number;
  }
): Promise<SimpleCommandResult> {
  // Create terminal and ensure cleanup
  const terminal = await terminalManager.createTerminal(sessionId, {
    command,
    args,
    ...(options?.cwd && { cwd: options.cwd }),
    ...(options?.env && { env: options.env }),
    ...(options?.outputByteLimit && {
      outputByteLimit: options.outputByteLimit,
    }),
  });

  try {
    // Wait for command to complete
    // Per ACP spec: terminal/wait_for_exit
    const exitStatus: WaitForTerminalExitResponse =
      await terminal.waitForExit();

    // Get final output
    // Per ACP spec: terminal/output
    const outputResponse: TerminalOutputResponse =
      await terminal.currentOutput();

    return {
      output: outputResponse.output,
      exitCode: exitStatus.exitCode ?? null,
      signal: exitStatus.signal ?? null,
      truncated: outputResponse.truncated,
    };
  } finally {
    // Release terminal (both client-side and manager tracking)
    // ManagedTerminalHandle.release() handles both cleanup operations
    await terminal.release();
  }
}

/**
 * Result from executing a command with timeout
 */
export interface TimeoutCommandResult {
  /**
   * The terminal output
   */
  output: string;

  /**
   * Exit code (if command completed normally)
   */
  exitCode?: number | null;

  /**
   * Signal that terminated the process (if killed by signal)
   */
  signal?: string | null;

  /**
   * Whether output was truncated due to byte limit
   */
  truncated?: boolean;

  /**
   * Whether command timed out
   */
  timedOut: boolean;
}

/**
 * Execute command with timeout
 *
 * Per ACP spec: https://agentclientprotocol.com/protocol/terminals#building-a-timeout
 *
 * Implements the ACP-recommended timeout pattern:
 * 1. Create terminal with terminal/create
 * 2. Race between timeout and terminal/wait_for_exit
 * 3. If timeout expires, call terminal/kill
 * 4. Get output via terminal/output
 * 5. Release terminal via terminal/release
 *
 * @param terminalManager - The terminal manager instance
 * @param sessionId - The session ID (required per ACP spec)
 * @param command - The command to execute
 * @param args - Command arguments
 * @param timeoutMs - Maximum execution time in milliseconds
 * @param options - Optional parameters (cwd, env, outputByteLimit)
 * @returns TimeoutCommandResult with output, exit status, and timeout flag
 *
 * @example
 * ```typescript
 * const result = await executeWithTimeout(
 *   terminalManager,
 *   'session-1',
 *   'sleep',
 *   ['10'],
 *   2000 // 2 second timeout
 * );
 * if (result.timedOut) {
 *   console.log('Command timed out');
 * }
 * ```
 */
export async function executeWithTimeout(
  terminalManager: TerminalManager,
  sessionId: string,
  command: string,
  args: string[],
  timeoutMs: number,
  options?: {
    cwd?: string;
    env?: EnvVariable[];
    outputByteLimit?: number;
  }
): Promise<TimeoutCommandResult> {
  // Create terminal and ensure cleanup
  const terminal = await terminalManager.createTerminal(sessionId, {
    command,
    args,
    ...(options?.cwd && { cwd: options.cwd }),
    ...(options?.env && { env: options.env }),
    ...(options?.outputByteLimit && {
      outputByteLimit: options.outputByteLimit,
    }),
  });

  try {
    // Create timeout promise
    const timeoutPromise = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), timeoutMs)
    );

    // Race between command completion and timeout
    // Per ACP spec: terminal/wait_for_exit
    const exitPromise = terminal
      .waitForExit()
      .then((status: WaitForTerminalExitResponse) => ({
        type: 'completed' as const,
        status,
      }));

    const result = await Promise.race([exitPromise, timeoutPromise]);

    let timedOut = false;
    let exitStatus: WaitForTerminalExitResponse | null = null;

    if (result === 'timeout') {
      // Command timed out - kill it
      // Per ACP spec: terminal/kill
      timedOut = true;
      await terminal.kill();

      // Try to get exit status after kill (may not have one yet)
      try {
        const status = await Promise.race([
          terminal.waitForExit(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
        ]);
        if (status) {
          exitStatus = status;
        }
      } catch {
        // Ignore errors getting exit status after timeout
      }
    } else {
      exitStatus = result.status;
    }

    // Get final output
    // Per ACP spec: terminal/output
    const outputResponse: TerminalOutputResponse =
      await terminal.currentOutput();

    return {
      output: outputResponse.output,
      exitCode: exitStatus?.exitCode ?? null,
      signal: exitStatus?.signal ?? null,
      truncated: outputResponse.truncated,
      timedOut,
    };
  } finally {
    // Release terminal (both client-side and manager tracking)
    // ManagedTerminalHandle.release() handles both cleanup operations
    await terminal.release();
  }
}

/**
 * Options for executing with progress
 */
export interface ExecuteWithProgressOptions {
  /**
   * Title for the tool call
   */
  title?: string;

  /**
   * Working directory
   */
  cwd?: string;

  /**
   * Environment variables
   */
  env?: EnvVariable[];

  /**
   * Output byte limit
   */
  outputByteLimit?: number;

  /**
   * Interval for polling output (milliseconds)
   * Default: 1000 (1 second)
   */
  pollIntervalMs?: number;
}

/**
 * Execute command with live progress updates
 *
 * Per ACP spec: https://agentclientprotocol.com/protocol/terminals#embedding-in-tool-calls
 *
 * Creates a terminal and embeds it in a tool call, allowing the client
 * to display live output as it's generated. The tool call is automatically
 * updated with completion status.
 *
 * This is the recommended way to run commands that produce output,
 * as it provides the best user experience with real-time feedback.
 *
 * @param terminalManager - The terminal manager instance
 * @param toolCallManager - The tool call manager for reporting progress
 * @param sessionId - The session ID (required per ACP spec)
 * @param command - The command to execute
 * @param args - Command arguments
 * @param options - Options including title, cwd, env, outputByteLimit, pollIntervalMs
 * @returns SimpleCommandResult with output, exit code, signal, and truncation status
 *
 * @example
 * ```typescript
 * await executeWithProgress(
 *   terminalManager,
 *   toolCallManager,
 *   'session-1',
 *   'npm',
 *   ['test'],
 *   {
 *     title: 'Running tests',
 *     cwd: '/project',
 *   }
 * );
 * ```
 */
export async function executeWithProgress(
  terminalManager: TerminalManager,
  toolCallManager: ToolCallManager,
  sessionId: string,
  command: string,
  args: string[],
  options: ExecuteWithProgressOptions = {}
): Promise<SimpleCommandResult> {
  // Create terminal
  const terminal = await terminalManager.createTerminal(sessionId, {
    command,
    args,
    ...(options.cwd && { cwd: options.cwd }),
    ...(options.env && { env: options.env }),
    ...(options.outputByteLimit && {
      outputByteLimit: options.outputByteLimit,
    }),
  });

  const cleanup = () => {
    terminalManager.releaseTerminal(terminal.id);
  };

  try {
    // Report tool call with terminal embedded
    const toolCallId = await toolCallManager.reportToolCall(
      sessionId,
      'execute_command',
      {
        title: options.title ?? `$ ${command} ${args.join(' ')}`,
        kind: 'edit', // Default to edit, can be overridden by caller
        status: 'in_progress',
        rawInput: { command, args, cwd: options.cwd },
      }
    );

    // Embed terminal in tool call for live output streaming
    const terminalContent = toolCallManager.createTerminalContent(terminal.id);
    await toolCallManager.updateToolCall(sessionId, toolCallId, {
      content: terminalContent,
    });

    // Optional: Poll for output updates (client already streams, but can be useful for logging)
    const pollInterval = options.pollIntervalMs ?? 1000;
    let pollTimer: NodeJS.Timeout | undefined;

    if (pollInterval > 0) {
      pollTimer = setInterval(() => {
        terminalManager.updateActivity(terminal.id);
      }, pollInterval);
    }

    // Wait for command to complete
    // Per ACP spec: terminal/wait_for_exit
    const exitStatus: WaitForTerminalExitResponse =
      await terminal.waitForExit();

    if (pollTimer) {
      clearInterval(pollTimer);
    }

    // Get final output
    // Per ACP spec: terminal/output
    const outputResponse: TerminalOutputResponse =
      await terminal.currentOutput();

    // Update tool call with completion status
    if (exitStatus.exitCode === 0) {
      await toolCallManager.completeToolCall(sessionId, toolCallId, {
        title: `✓ Command completed successfully`,
        content: terminalContent, // Keep terminal content visible
        rawOutput: {
          exitCode: exitStatus.exitCode,
          outputLength: outputResponse.output.length,
          truncated: outputResponse.truncated,
        },
      });
    } else {
      await toolCallManager.failToolCall(sessionId, toolCallId, {
        title: `✗ Command failed (exit code ${exitStatus.exitCode ?? 'unknown'})`,
        error: `Command exited with code ${exitStatus.exitCode ?? 'unknown'}${exitStatus.signal ? ` (signal: ${exitStatus.signal})` : ''}`,
        rawOutput: {
          exitCode: exitStatus.exitCode,
          signal: exitStatus.signal,
          outputLength: outputResponse.output.length,
          truncated: outputResponse.truncated,
        },
      });
    }

    return {
      output: outputResponse.output,
      exitCode: exitStatus.exitCode ?? null,
      signal: exitStatus.signal ?? null,
      truncated: outputResponse.truncated,
    };
  } catch (error) {
    // Try to get any output before cleanup
    let errorOutput = '';
    try {
      const outputResponse: TerminalOutputResponse =
        await terminal.currentOutput();
      errorOutput = outputResponse.output;
    } catch {
      // Ignore errors getting output
    }

    throw new ToolError(
      `Terminal command failed: ${error instanceof Error ? error.message : String(error)}${errorOutput ? `\n\nOutput:\n${errorOutput}` : ''}`,
      'terminal',
      error instanceof Error ? error : undefined
    );
  } finally {
    cleanup();
    // Ensure terminal is released (only once, even if there was an error)
    // Per ACP spec: terminal/release must be called when done
    try {
      await terminal.release();
    } catch {
      // Ignore errors during cleanup (e.g., if already released)
    }
  }
}

/**
 * Execute multiple commands sequentially in the same directory
 *
 * Useful for multi-step operations like:
 * - npm install && npm test
 * - git pull && npm run build
 *
 * @example
 * ```typescript
 * const results = await executeSequential(
 *   terminalManager,
 *   'session-1',
 *   '/project',
 *   [
 *     { command: 'npm', args: ['install'] },
 *     { command: 'npm', args: ['test'] },
 *   ]
 * );
 * ```
 */
export async function executeSequential(
  terminalManager: TerminalManager,
  sessionId: string,
  cwd: string,
  commands: Array<{ command: string; args?: string[] }>,
  options?: {
    env?: EnvVariable[];
    outputByteLimit?: number;
    stopOnError?: boolean; // Default: true
  }
): Promise<SimpleCommandResult[]> {
  const results: SimpleCommandResult[] = [];
  const stopOnError = options?.stopOnError ?? true;

  for (const cmd of commands) {
    const result = await executeSimpleCommand(
      terminalManager,
      sessionId,
      cmd.command,
      cmd.args ?? [],
      {
        cwd,
        ...(options?.env && { env: options.env }),
        ...(options?.outputByteLimit !== undefined && {
          outputByteLimit: options.outputByteLimit,
        }),
      }
    );

    results.push(result);

    // Stop if command failed and stopOnError is true
    if (stopOnError && result.exitCode !== 0) {
      break;
    }
  }

  return results;
}

/**
 * Stream terminal output to a callback
 *
 * Polls the terminal for output and calls the callback with chunks.
 * Useful for custom progress reporting or logging.
 *
 * @example
 * ```typescript
 * await streamTerminalOutput(
 *   terminal,
 *   logger,
 *   (output) => {
 *     console.log('New output:', output);
 *   },
 *   { pollIntervalMs: 500 }
 * );
 * ```
 */
export async function streamTerminalOutput(
  terminal: TerminalHandle,
  logger: Logger,
  onOutput: (output: string, isComplete: boolean) => void,
  options?: {
    pollIntervalMs?: number;
  }
): Promise<SimpleCommandResult> {
  const pollInterval = options?.pollIntervalMs ?? 1000;
  let lastOutputLength = 0;
  let isRunning = true;

  // Start polling
  const pollPromise = (async () => {
    while (isRunning) {
      try {
        const outputResponse: TerminalOutputResponse =
          await terminal.currentOutput();
        const currentOutput = outputResponse.output;

        // Send new output if any
        if (currentOutput.length > lastOutputLength) {
          const newOutput = currentOutput.slice(lastOutputLength);
          lastOutputLength = currentOutput.length;
          onOutput(newOutput, false);
        }

        // Check if command completed
        if (outputResponse.exitStatus) {
          isRunning = false;
          onOutput('', true);
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      } catch (error) {
        logger.error('Error polling terminal output', { error });
        isRunning = false;
        break;
      }
    }
  })();

  // Wait for completion
  // Per ACP spec: terminal/wait_for_exit
  const exitStatus: WaitForTerminalExitResponse = await terminal.waitForExit();
  isRunning = false;
  await pollPromise;

  // Get final output
  // Per ACP spec: terminal/output
  const finalOutput: TerminalOutputResponse = await terminal.currentOutput();

  // Send any remaining output
  if (finalOutput.output.length > lastOutputLength) {
    const remainingOutput = finalOutput.output.slice(lastOutputLength);
    onOutput(remainingOutput, true);
  }

  return {
    output: finalOutput.output,
    exitCode: exitStatus.exitCode ?? null,
    signal: exitStatus.signal ?? null,
    truncated: finalOutput.truncated,
  };
}
