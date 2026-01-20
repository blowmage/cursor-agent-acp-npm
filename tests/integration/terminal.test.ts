/**
 * Integration tests for Terminal operations
 *
 * Tests the complete flow of ACP-compliant terminal operations
 * including TerminalManager, utilities, and ToolCallManager integration
 */

import { TerminalManager } from '../../src/tools/terminal-manager';
import { executeWithProgress } from '../../src/tools/terminal-utils';
import { ToolCallManager } from '../../src/tools/tool-call-manager';
import type { Logger } from '../../src/types';
import type {
  TerminalHandle,
  CreateTerminalRequest,
  SessionNotification,
  AgentSideConnection,
} from '@agentclientprotocol/sdk';

// Mock logger
const createMockLogger = (): Logger => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
});

// Mock TerminalHandle that simulates realistic terminal behavior
class IntegrationMockTerminalHandle {
  id: string;
  private sessionId: string;
  private command: string;
  private released = false;
  private killed = false;
  private outputLines: string[] = [];
  private exitCode = 0;

  constructor(id: string, sessionId: string, command: string) {
    this.id = id;
    this.sessionId = sessionId;
    this.command = command;

    // Simulate command-specific output
    if (command === 'echo') {
      this.outputLines = ['hello world'];
      this.exitCode = 0;
    } else if (command === 'ls') {
      this.outputLines = ['file1.txt', 'file2.txt', 'dir/'];
      this.exitCode = 0;
    } else if (command === 'npm') {
      this.outputLines = [
        'npm info it worked if it ends with ok',
        'npm info using npm@9.0.0',
        'npm info using node@v18.0.0',
        'up to date, audited 100 packages in 1s',
        'found 0 vulnerabilities',
      ];
      this.exitCode = 0;
    } else if (command === 'false') {
      this.outputLines = [];
      this.exitCode = 1;
    } else {
      this.outputLines = ['command output'];
      this.exitCode = 0;
    }
  }

  async currentOutput() {
    if (this.released) {
      throw new Error('Terminal already released');
    }
    return {
      output: this.outputLines.join('\n'),
      truncated: false,
      exitStatus: this.killed
        ? {
            exitCode: null,
            signal: 'SIGTERM',
          }
        : null,
    };
  }

  async waitForExit() {
    if (this.released) {
      throw new Error('Terminal already released');
    }
    // Simulate brief execution time
    await new Promise((resolve) => setTimeout(resolve, 10));

    return {
      exitCode: this.killed ? null : this.exitCode,
      signal: this.killed ? 'SIGTERM' : null,
    };
  }

  async kill() {
    if (this.released) {
      throw new Error('Terminal already released');
    }
    this.killed = true;
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
const createMockClient = (): Partial<AgentSideConnection> & {
  createTerminal: jest.Mock<Promise<TerminalHandle>, [CreateTerminalRequest]>;
} => {
  let terminalCounter = 0;

  return {
    createTerminal: jest
      .fn()
      .mockImplementation(async (params: CreateTerminalRequest) => {
        terminalCounter++;
        const terminalId = `term-${terminalCounter}`;
        return new IntegrationMockTerminalHandle(
          terminalId,
          params.sessionId,
          params.command
        );
      }),
  };
};

describe('Terminal Integration Tests', () => {
  describe('TerminalManager with ToolCallManager integration', () => {
    it('should execute command with progress reporting', async () => {
      const client = createMockClient();
      const logger = createMockLogger();
      const terminalManager = new TerminalManager(
        {
          clientSupportsTerminals: true,
          maxConcurrentTerminals: 5,
        },
        client as AgentSideConnection,
        logger
      );

      const notifications: SessionNotification[] = [];
      const toolCallManager = new ToolCallManager({
        logger,
        sendNotification: (notification) => {
          notifications.push(notification.params as SessionNotification);
        },
      });

      const result = await executeWithProgress(
        terminalManager,
        toolCallManager,
        'session-1',
        'npm',
        ['install'],
        {
          title: 'Installing dependencies',
          cwd: '/project',
        }
      );

      // Verify result
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('npm info');

      // Verify notifications were sent
      expect(notifications.length).toBeGreaterThanOrEqual(2);

      // First notification: tool call report
      const firstNotification = notifications[0];
      expect(firstNotification.sessionId).toBe('session-1');
      expect(firstNotification.update.sessionUpdate).toBe('tool_call');
      expect(firstNotification.update.title).toBe('Installing dependencies');

      // Second notification: terminal content
      const secondNotification = notifications[1];
      expect(secondNotification.update.sessionUpdate).toBe('tool_call_update');
      expect(secondNotification.update.content).toBeDefined();
      expect(secondNotification.update.content?.[0].type).toBe('terminal');

      // Final notification: completion
      const lastNotification = notifications[notifications.length - 1];
      expect(lastNotification.update.sessionUpdate).toBe('tool_call_update');
      expect(lastNotification.update.status).toBe('completed');
    });

    it('should report failure on non-zero exit code', async () => {
      const client = createMockClient();
      const logger = createMockLogger();
      const terminalManager = new TerminalManager(
        {
          clientSupportsTerminals: true,
          maxConcurrentTerminals: 5,
        },
        client as AgentSideConnection,
        logger
      );

      const notifications: SessionNotification[] = [];
      const toolCallManager = new ToolCallManager({
        logger,
        sendNotification: (notification) => {
          notifications.push(notification.params as SessionNotification);
        },
      });

      const result = await executeWithProgress(
        terminalManager,
        toolCallManager,
        'session-1',
        'false', // Command that fails
        []
      );

      // Verify result
      expect(result.exitCode).toBe(1);

      // Verify failure was reported
      const lastNotification = notifications[notifications.length - 1];
      expect(lastNotification.update.status).toBe('failed');
      expect(lastNotification.update.title).toContain('failed');
    });

    it('should embed terminal ID in tool call content', async () => {
      const client = createMockClient();
      const logger = createMockLogger();
      const terminalManager = new TerminalManager(
        {
          clientSupportsTerminals: true,
          maxConcurrentTerminals: 5,
        },
        client as AgentSideConnection,
        logger
      );

      const notifications: SessionNotification[] = [];
      const toolCallManager = new ToolCallManager({
        logger,
        sendNotification: (notification) => {
          notifications.push(notification.params as SessionNotification);
        },
      });

      await executeWithProgress(
        terminalManager,
        toolCallManager,
        'session-1',
        'echo',
        ['hello']
      );

      // Find notification with terminal content
      const terminalNotification = notifications.find(
        (n) =>
          n.update.content &&
          n.update.content.length > 0 &&
          n.update.content[0].type === 'terminal'
      );

      expect(terminalNotification).toBeDefined();
      expect(terminalNotification!.update.content![0]).toMatchObject({
        type: 'terminal',
        terminalId: expect.stringMatching(/^term-\d+$/),
      });
    });
  });

  describe('Concurrent terminal operations', () => {
    it('should handle multiple terminals in same session', async () => {
      const client = createMockClient();
      const logger = createMockLogger();
      const terminalManager = new TerminalManager(
        {
          clientSupportsTerminals: true,
          maxConcurrentTerminals: 10,
        },
        client,
        logger
      );

      const toolCallManager = new ToolCallManager({
        logger,
        sendNotification: jest.fn(),
      });

      // Execute multiple commands concurrently
      const results = await Promise.all([
        executeWithProgress(
          terminalManager,
          toolCallManager,
          'session-1',
          'echo',
          ['hello']
        ),
        executeWithProgress(
          terminalManager,
          toolCallManager,
          'session-1',
          'ls',
          ['-la']
        ),
        executeWithProgress(
          terminalManager,
          toolCallManager,
          'session-1',
          'npm',
          ['--version']
        ),
      ]);

      expect(results).toHaveLength(3);
      expect(results[0].exitCode).toBe(0);
      expect(results[1].exitCode).toBe(0);
      expect(results[2].exitCode).toBe(0);
    });

    it('should enforce concurrent terminal limit', async () => {
      const client = createMockClient();
      const logger = createMockLogger();
      const terminalManager = new TerminalManager(
        {
          clientSupportsTerminals: true,
          maxConcurrentTerminals: 2,
        },
        client,
        logger
      );

      // Create two terminals (at limit)
      const handle1 = await terminalManager.createTerminal('session-1', {
        command: 'echo',
      });
      const handle2 = await terminalManager.createTerminal('session-1', {
        command: 'ls',
      });

      // Third should fail
      await expect(
        terminalManager.createTerminal('session-1', {
          command: 'npm',
        })
      ).rejects.toThrow('Maximum concurrent terminals reached');

      // Cleanup
      await handle1.release();
      await handle2.release();
      terminalManager.releaseTerminal(handle1.id);
      terminalManager.releaseTerminal(handle2.id);
    });

    it('should track terminals per session', async () => {
      const client = createMockClient();
      const logger = createMockLogger();
      const terminalManager = new TerminalManager(
        {
          clientSupportsTerminals: true,
          maxConcurrentTerminals: 10,
        },
        client,
        logger
      );

      // Create terminals in different sessions
      await terminalManager.createTerminal('session-1', { command: 'echo' });
      await terminalManager.createTerminal('session-1', { command: 'ls' });
      await terminalManager.createTerminal('session-2', { command: 'npm' });

      const session1Terminals =
        terminalManager.getSessionTerminals('session-1');
      const session2Terminals =
        terminalManager.getSessionTerminals('session-2');

      expect(session1Terminals).toHaveLength(2);
      expect(session2Terminals).toHaveLength(1);

      const metrics = terminalManager.getMetrics();
      expect(metrics.terminalsBySession).toEqual({
        'session-1': 2,
        'session-2': 1,
      });
    });
  });

  describe('Security and validation', () => {
    it('should reject forbidden commands', async () => {
      const client = createMockClient();
      const logger = createMockLogger();
      const terminalManager = new TerminalManager(
        {
          clientSupportsTerminals: true,
          maxConcurrentTerminals: 5,
          forbiddenCommands: ['rm', 'sudo', 'su'],
        },
        client,
        logger
      );

      await expect(
        terminalManager.createTerminal('session-1', {
          command: 'sudo apt update',
        })
      ).rejects.toThrow('Command contains forbidden pattern');

      await expect(
        terminalManager.createTerminal('session-1', {
          command: 'rm -rf /',
        })
      ).rejects.toThrow('Command contains forbidden pattern');
    });

    it('should enforce allowed commands whitelist', async () => {
      const client = createMockClient();
      const logger = createMockLogger();
      const terminalManager = new TerminalManager(
        {
          clientSupportsTerminals: true,
          maxConcurrentTerminals: 5,
          allowedCommands: ['npm', 'node', 'git'],
        },
        client,
        logger
      );

      // Should succeed for allowed command
      await expect(
        terminalManager.createTerminal('session-1', {
          command: 'npm install',
        })
      ).resolves.toBeDefined();

      // Should fail for disallowed command
      await expect(
        terminalManager.createTerminal('session-1', {
          command: 'echo hello',
        })
      ).rejects.toThrow('Command not in allowed list');
    });

    it('should enforce output byte limit', async () => {
      const client = createMockClient();
      const logger = createMockLogger();
      const terminalManager = new TerminalManager(
        {
          clientSupportsTerminals: true,
          maxConcurrentTerminals: 5,
          defaultOutputByteLimit: 5000,
          maxOutputByteLimit: 10000,
        },
        client,
        logger
      );

      // Request within limit
      await terminalManager.createTerminal('session-1', {
        command: 'echo',
        outputByteLimit: 8000,
      });

      expect(client.createTerminal).toHaveBeenLastCalledWith(
        expect.objectContaining({
          outputByteLimit: 8000n,
        })
      );

      // Request exceeding limit should be capped
      await terminalManager.createTerminal('session-1', {
        command: 'ls',
        outputByteLimit: 50000,
      });

      expect(client.createTerminal).toHaveBeenLastCalledWith(
        expect.objectContaining({
          outputByteLimit: 10000n, // Capped to max
        })
      );

      expect(logger.warn).toHaveBeenCalledWith(
        'Output byte limit capped to maximum',
        expect.objectContaining({
          requested: '50000',
          max: 10000,
        })
      );
    });
  });

  describe('Resource management', () => {
    it('should properly cleanup terminals', async () => {
      const client = createMockClient();
      const logger = createMockLogger();
      const terminalManager = new TerminalManager(
        {
          clientSupportsTerminals: true,
          maxConcurrentTerminals: 5,
        },
        client as AgentSideConnection,
        logger
      );

      // Create some terminals
      const handle1 = await terminalManager.createTerminal('session-1', {
        command: 'echo',
      });
      const handle2 = await terminalManager.createTerminal('session-1', {
        command: 'ls',
      });

      expect(terminalManager.getActiveTerminalCount()).toBe(2);

      // Release them
      await handle1.release();
      await handle2.release();
      terminalManager.releaseTerminal(handle1.id);
      terminalManager.releaseTerminal(handle2.id);

      expect(terminalManager.getActiveTerminalCount()).toBe(0);
    });

    it('should cleanup all terminals on manager cleanup', async () => {
      const client = createMockClient();
      const logger = createMockLogger();
      const terminalManager = new TerminalManager(
        {
          clientSupportsTerminals: true,
          maxConcurrentTerminals: 5,
        },
        client as AgentSideConnection,
        logger
      );

      // Create terminals
      await terminalManager.createTerminal('session-1', { command: 'echo' });
      await terminalManager.createTerminal('session-1', { command: 'ls' });
      await terminalManager.createTerminal('session-2', { command: 'npm' });

      expect(terminalManager.getActiveTerminalCount()).toBe(3);

      // Cleanup manager
      terminalManager.cleanup();

      expect(terminalManager.getActiveTerminalCount()).toBe(0);
    });

    it('should use await using for automatic cleanup', async () => {
      const client = createMockClient();
      const logger = createMockLogger();
      const terminalManager = new TerminalManager(
        {
          clientSupportsTerminals: true,
          maxConcurrentTerminals: 5,
        },
        client as AgentSideConnection,
        logger
      );

      // Create terminal and test automatic cleanup via ManagedTerminalHandle
      const terminal = await terminalManager.createTerminal('session-1', {
        command: 'echo',
      });

      expect(terminalManager.getActiveTerminalCount()).toBe(1);

      // Terminal is active
      await terminal.currentOutput();

      // Release terminal (ManagedTerminalHandle handles both client-side and manager cleanup)
      await terminal.release();

      // Verify terminal is released (client-side)
      await expect(terminal.currentOutput()).rejects.toThrow(
        'Terminal already released'
      );

      // Verify terminal is also removed from manager tracking (automatic cleanup via ManagedTerminalHandle)
      expect(terminalManager.getActiveTerminalCount()).toBe(0);
      expect(terminalManager.getTerminalMetadata(terminal.id)).toBeUndefined();
    });
  });

  describe('Error handling', () => {
    it('should handle client errors gracefully', async () => {
      const client: Partial<AgentSideConnection> = {
        createTerminal: jest.fn().mockRejectedValue(new Error('Network error')),
      };

      const logger = createMockLogger();
      const terminalManager = new TerminalManager(
        {
          clientSupportsTerminals: true,
          maxConcurrentTerminals: 5,
        },
        client as AgentSideConnection,
        logger
      );

      await expect(
        terminalManager.createTerminal('session-1', {
          command: 'echo',
        })
      ).rejects.toThrow('Failed to create terminal: Network error');

      expect(logger.error).toHaveBeenCalledWith(
        'Failed to create terminal',
        expect.objectContaining({
          sessionId: 'session-1',
        })
      );
    });

    it('should handle terminal handle errors', async () => {
      const client = createMockClient();
      const logger = createMockLogger();
      const terminalManager = new TerminalManager(
        {
          clientSupportsTerminals: true,
          maxConcurrentTerminals: 5,
        },
        client as AgentSideConnection,
        logger
      );

      const handle = await terminalManager.createTerminal('session-1', {
        command: 'echo',
      });

      // Release terminal
      await handle.release();

      // Try to use released terminal
      await expect(handle.currentOutput()).rejects.toThrow(
        'Terminal already released'
      );
    });
  });
});
