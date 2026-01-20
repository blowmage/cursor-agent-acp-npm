/**
 * Unit tests for Terminal Utilities
 *
 * Tests helper functions for common terminal patterns
 */

import {
  executeSimpleCommand,
  executeWithTimeout,
  executeSequential,
} from '../../src/tools/terminal-utils';
import { TerminalManager } from '../../src/tools/terminal-manager';
import type { Logger } from '../../src/types';
import type {
  TerminalHandle,
  CreateTerminalRequest,
  AgentSideConnection,
} from '@agentclientprotocol/sdk';

// Mock logger
const createMockLogger = (): Logger => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
});

// Mock TerminalHandle with configurable behavior
class MockTerminalHandle implements TerminalHandle {
  id: string;
  private sessionId: string;
  private released = false;
  private exitCode: number;
  private signal: string | null;
  private output: string;
  private waitTime: number;

  constructor(
    id: string,
    sessionId: string,
    options: {
      exitCode?: number;
      signal?: string | null;
      output?: string;
      waitTime?: number;
    } = {}
  ) {
    this.id = id;
    this.sessionId = sessionId;
    this.exitCode = options.exitCode ?? 0;
    this.signal = options.signal ?? null;
    this.output = options.output ?? 'test output';
    this.waitTime = options.waitTime ?? 0;
  }

  async currentOutput() {
    if (this.released) {
      throw new Error('Terminal already released');
    }
    return {
      output: this.output,
      truncated: false,
      exitStatus: null,
    };
  }

  async waitForExit() {
    if (this.released) {
      throw new Error('Terminal already released');
    }
    // Simulate command execution time
    if (this.waitTime > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.waitTime));
    }
    return {
      exitCode: this.exitCode,
      signal: this.signal,
    };
  }

  async kill() {
    if (this.released) {
      throw new Error('Terminal already released');
    }
    this.signal = 'SIGTERM';
    return {};
  }

  async release() {
    this.released = true;
  }

  [Symbol.asyncDispose]() {
    return this.release();
  }
}

// Mock AgentSideConnection
const createMockClient = (
  handleFactory?: (params: CreateTerminalRequest) => TerminalHandle
): Partial<AgentSideConnection> => {
  return {
    createTerminal: jest
      .fn()
      .mockImplementation(async (params: CreateTerminalRequest) => {
        if (handleFactory) {
          return handleFactory(params);
        }
        return new MockTerminalHandle('term-123', params.sessionId);
      }),
  } as Partial<AgentSideConnection>;
};

describe('Terminal Utilities', () => {
  describe('executeSimpleCommand', () => {
    it('should execute command and return output', async () => {
      const client = createMockClient();
      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 5 },
        client as AgentSideConnection,
        createMockLogger()
      );

      const result = await executeSimpleCommand(manager, 'session-1', 'echo', [
        'hello',
      ]);

      expect(result.output).toBe('test output');
      expect(result.exitCode).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.truncated).toBe(false);
    });

    it('should pass through cwd and env options', async () => {
      const client = createMockClient();
      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 5 },
        client as AgentSideConnection,
        createMockLogger()
      );

      await executeSimpleCommand(manager, 'session-1', 'npm', ['test'], {
        cwd: '/project',
        env: [{ name: 'NODE_ENV', value: 'test' }],
        outputByteLimit: 10000,
      });

      expect(client.createTerminal).toHaveBeenCalledWith({
        sessionId: 'session-1',
        command: 'npm',
        args: ['test'],
        cwd: '/project',
        env: [{ name: 'NODE_ENV', value: 'test' }],
        outputByteLimit: 10000n,
      });
    });

    it('should handle command failure', async () => {
      const client = createMockClient((params) => {
        return new MockTerminalHandle('term-123', params.sessionId, {
          exitCode: 1,
          output: 'error output',
        });
      });

      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 5 },
        client as AgentSideConnection,
        createMockLogger()
      );

      const result = await executeSimpleCommand(
        manager,
        'session-1',
        'false' // Command that fails
      );

      expect(result.exitCode).toBe(1);
      expect(result.output).toBe('error output');
    });

    it('should automatically release terminal', async () => {
      const client = createMockClient();
      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 5 },
        client as AgentSideConnection,
        createMockLogger()
      );

      expect(manager.getActiveTerminalCount()).toBe(0);

      await executeSimpleCommand(manager, 'session-1', 'echo', ['hello']);

      // Terminal should be removed from tracking after completion
      expect(manager.getActiveTerminalCount()).toBe(0);
    });
  });

  describe('executeWithTimeout', () => {
    it('should execute command within timeout', async () => {
      const client = createMockClient((params) => {
        return new MockTerminalHandle('term-123', params.sessionId, {
          waitTime: 50, // Quick execution
          output: 'completed',
        });
      });

      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 5 },
        client as AgentSideConnection,
        createMockLogger()
      );

      const result = await executeWithTimeout(
        manager,
        'session-1',
        'echo',
        ['hello'],
        1000 // 1 second timeout
      );

      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.output).toBe('completed');
    });

    it('should timeout long-running command', async () => {
      const client = createMockClient((params) => {
        return new MockTerminalHandle('term-123', params.sessionId, {
          waitTime: 2000, // Longer than timeout
          output: 'partial output',
        });
      });

      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 5 },
        client as AgentSideConnection,
        createMockLogger()
      );

      const result = await executeWithTimeout(
        manager,
        'session-1',
        'sleep',
        ['10'],
        100 // Short timeout
      );

      expect(result.timedOut).toBe(true);
      expect(result.output).toBe('partial output');
    });

    it('should kill command on timeout', async () => {
      let killCalled = false;

      const client = createMockClient((params) => {
        const handle = new MockTerminalHandle('term-123', params.sessionId, {
          waitTime: 2000, // Longer than timeout
        });

        // Spy on kill method
        const originalKill = handle.kill.bind(handle);
        handle.kill = async () => {
          killCalled = true;
          return originalKill();
        };

        return handle;
      });

      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 5 },
        client as AgentSideConnection,
        createMockLogger()
      );

      await executeWithTimeout(
        manager,
        'session-1',
        'sleep',
        ['10'],
        100 // Short timeout
      );

      expect(killCalled).toBe(true);
    });

    it('should handle command that completes just before timeout', async () => {
      const client = createMockClient((params) => {
        return new MockTerminalHandle('term-123', params.sessionId, {
          waitTime: 90, // Just under timeout
          exitCode: 0,
        });
      });

      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 5 },
        client as AgentSideConnection,
        createMockLogger()
      );

      const result = await executeWithTimeout(
        manager,
        'session-1',
        'echo',
        ['hello'],
        100 // Tight timeout
      );

      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
    });
  });

  describe('executeSequential', () => {
    it('should execute commands in sequence', async () => {
      const executionOrder: string[] = [];

      const client = createMockClient((params) => {
        executionOrder.push(params.command);
        return new MockTerminalHandle(
          'term-' + executionOrder.length,
          params.sessionId,
          {
            output: `output from ${params.command}`,
          }
        );
      });

      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 5 },
        client as AgentSideConnection,
        createMockLogger()
      );

      const results = await executeSequential(
        manager,
        'session-1',
        '/project',
        [
          { command: 'npm', args: ['install'] },
          { command: 'npm', args: ['test'] },
          { command: 'npm', args: ['run', 'build'] },
        ]
      );

      expect(results).toHaveLength(3);
      expect(executionOrder).toEqual(['npm', 'npm', 'npm']);
      expect(results[0].output).toBe('output from npm');
      expect(results[1].output).toBe('output from npm');
      expect(results[2].output).toBe('output from npm');
    });

    it('should stop on error by default', async () => {
      const executionOrder: string[] = [];

      const client = createMockClient((params) => {
        executionOrder.push(params.command);

        // Second command fails
        const exitCode = executionOrder.length === 2 ? 1 : 0;

        return new MockTerminalHandle(
          'term-' + executionOrder.length,
          params.sessionId,
          {
            exitCode,
            output: `output from ${params.command}`,
          }
        );
      });

      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 5 },
        client as AgentSideConnection,
        createMockLogger()
      );

      const results = await executeSequential(
        manager,
        'session-1',
        '/project',
        [
          { command: 'npm', args: ['install'] },
          { command: 'npm', args: ['test'] }, // This will fail
          { command: 'npm', args: ['run', 'build'] }, // Should not execute
        ]
      );

      // Should have stopped after second command
      expect(results).toHaveLength(2);
      expect(executionOrder).toEqual(['npm', 'npm']);
      expect(results[1].exitCode).toBe(1);
    });

    it('should continue on error when stopOnError is false', async () => {
      const executionOrder: string[] = [];

      const client = createMockClient((params) => {
        executionOrder.push(params.command);

        // Second command fails
        const exitCode = executionOrder.length === 2 ? 1 : 0;

        return new MockTerminalHandle(
          'term-' + executionOrder.length,
          params.sessionId,
          {
            exitCode,
          }
        );
      });

      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 5 },
        client as AgentSideConnection,
        createMockLogger()
      );

      const results = await executeSequential(
        manager,
        'session-1',
        '/project',
        [
          { command: 'npm', args: ['install'] },
          { command: 'npm', args: ['test'] }, // This will fail
          { command: 'npm', args: ['run', 'build'] }, // Should still execute
        ],
        { stopOnError: false }
      );

      // Should have executed all three commands
      expect(results).toHaveLength(3);
      expect(executionOrder).toEqual(['npm', 'npm', 'npm']);
      expect(results[1].exitCode).toBe(1);
      expect(results[2].exitCode).toBe(0);
    });

    it('should pass environment variables to all commands', async () => {
      const client = createMockClient();
      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 5 },
        client as AgentSideConnection,
        createMockLogger()
      );

      await executeSequential(
        manager,
        'session-1',
        '/project',
        [
          { command: 'npm', args: ['install'] },
          { command: 'npm', args: ['test'] },
        ],
        {
          env: [
            { name: 'NODE_ENV', value: 'test' },
            { name: 'CI', value: 'true' },
          ],
        }
      );

      // Check that env was passed to all commands
      const calls = (client.createTerminal as jest.Mock).mock.calls;
      expect(calls[0][0].env).toEqual([
        { name: 'NODE_ENV', value: 'test' },
        { name: 'CI', value: 'true' },
      ]);
      expect(calls[1][0].env).toEqual([
        { name: 'NODE_ENV', value: 'test' },
        { name: 'CI', value: 'true' },
      ]);
    });

    it('should handle empty command list', async () => {
      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 5 },
        createMockClient(),
        createMockLogger()
      );

      const results = await executeSequential(
        manager,
        'session-1',
        '/project',
        []
      );

      expect(results).toEqual([]);
    });
  });
});
