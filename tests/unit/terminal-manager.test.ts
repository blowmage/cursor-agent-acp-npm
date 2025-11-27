/**
 * Unit tests for TerminalManager
 *
 * Tests the ACP-compliant terminal management system
 */

import { TerminalManager } from '../../src/tools/terminal-manager';
import type { Logger } from '../../src/types';
import { ProtocolError, ToolError } from '../../src/types';
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

// Mock TerminalHandle (satisfies TerminalHandle interface)
class MockTerminalHandle {
  id: string;
  private sessionId: string;
  private released = false;

  constructor(id: string, sessionId: string) {
    this.id = id;
    this.sessionId = sessionId;
  }

  async currentOutput() {
    if (this.released) {
      throw new Error('Terminal already released');
    }
    return {
      output: 'test output',
      truncated: false,
      exitStatus: null,
    };
  }

  async waitForExit() {
    if (this.released) {
      throw new Error('Terminal already released');
    }
    return {
      exitCode: 0,
      signal: null,
    };
  }

  async kill() {
    if (this.released) {
      throw new Error('Terminal already released');
    }
    return {};
  }

  async release() {
    this.released = true;
  }

  [Symbol.asyncDispose]() {
    return this.release();
  }
}

// Mock AgentSideConnection with unique terminal IDs
let mockTerminalCounter = 0;
const createMockClient = (
  overrides?: Partial<Pick<AgentSideConnection, 'createTerminal'>>
): Partial<AgentSideConnection> => {
  return {
    createTerminal: jest
      .fn()
      .mockImplementation(async (params: CreateTerminalRequest) => {
        mockTerminalCounter++;
        return new MockTerminalHandle(
          `term-${mockTerminalCounter}`,
          params.sessionId
        );
      }),
    ...overrides,
  } as Partial<AgentSideConnection>;
};

describe('TerminalManager', () => {
  beforeEach(() => {
    // Reset terminal counter for consistent test IDs
    mockTerminalCounter = 0;
  });

  describe('constructor', () => {
    it('should initialize with config', () => {
      const logger = createMockLogger();
      const client = createMockClient();
      const config = {
        clientSupportsTerminals: true,
        maxConcurrentTerminals: 5,
      };

      const manager = new TerminalManager(
        config,
        client as AgentSideConnection,
        logger
      );

      expect(manager).toBeInstanceOf(TerminalManager);
      expect(logger.debug).toHaveBeenCalledWith(
        'TerminalManager initialized',
        expect.objectContaining({
          clientSupportsTerminals: true,
          maxConcurrentTerminals: 5,
        })
      );
    });
  });

  describe('canCreateTerminals', () => {
    it('should return true when client supports terminals', () => {
      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 5 },
        createMockClient(),
        createMockLogger()
      );

      expect(manager.canCreateTerminals()).toBe(true);
    });

    it('should return false when client does not support terminals', () => {
      const manager = new TerminalManager(
        { clientSupportsTerminals: false, maxConcurrentTerminals: 5 },
        createMockClient(),
        createMockLogger()
      );

      expect(manager.canCreateTerminals()).toBe(false);
    });
  });

  describe('createTerminal', () => {
    it('should create terminal when client supports it', async () => {
      const client = createMockClient();
      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 5 },
        client,
        createMockLogger()
      );

      const handle = await manager.createTerminal('session-1', {
        command: 'echo',
        args: ['hello'],
      });

      // Handle is now wrapped in ManagedTerminalHandle, but should still have TerminalHandle interface
      expect(handle).toBeDefined();
      expect(handle.id).toBe('term-1');
      // Verify it implements TerminalHandle interface
      expect(typeof handle.currentOutput).toBe('function');
      expect(typeof handle.waitForExit).toBe('function');
      expect(typeof handle.kill).toBe('function');
      expect(typeof handle.release).toBe('function');
      expect(client.createTerminal).toHaveBeenCalledWith({
        sessionId: 'session-1',
        command: 'echo',
        args: ['hello'],
      });
    });

    it('should throw ProtocolError when client does not support terminals', async () => {
      const manager = new TerminalManager(
        { clientSupportsTerminals: false, maxConcurrentTerminals: 5 },
        createMockClient(),
        createMockLogger()
      );

      await expect(
        manager.createTerminal('session-1', {
          command: 'echo',
        })
      ).rejects.toThrow(ProtocolError);

      await expect(
        manager.createTerminal('session-1', {
          command: 'echo',
        })
      ).rejects.toThrow('Client does not support terminal operations');
    });

    it('should validate command is non-empty', async () => {
      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 5 },
        createMockClient(),
        createMockLogger()
      );

      await expect(
        manager.createTerminal('session-1', {
          command: '',
        })
      ).rejects.toThrow(ToolError);

      await expect(
        manager.createTerminal('session-1', {
          command: '   ',
        })
      ).rejects.toThrow('Invalid command: must be a non-empty string');
    });

    it('should reject forbidden commands', async () => {
      const manager = new TerminalManager(
        {
          clientSupportsTerminals: true,
          maxConcurrentTerminals: 5,
          forbiddenCommands: ['rm', 'sudo'],
        },
        createMockClient(),
        createMockLogger()
      );

      await expect(
        manager.createTerminal('session-1', {
          command: 'rm -rf /',
        })
      ).rejects.toThrow(ToolError);

      await expect(
        manager.createTerminal('session-1', {
          command: 'sudo apt update',
        })
      ).rejects.toThrow('Command contains forbidden pattern');
    });

    it('should allow only allowed commands when specified', async () => {
      const manager = new TerminalManager(
        {
          clientSupportsTerminals: true,
          maxConcurrentTerminals: 5,
          allowedCommands: ['echo', 'ls', 'cat'],
        },
        createMockClient(),
        createMockLogger()
      );

      // Should succeed for allowed command
      await expect(
        manager.createTerminal('session-1', {
          command: 'echo hello',
        })
      ).resolves.toBeDefined();

      // Should fail for disallowed command
      await expect(
        manager.createTerminal('session-1', {
          command: 'npm install',
        })
      ).rejects.toThrow(ToolError);

      await expect(
        manager.createTerminal('session-1', {
          command: 'npm install',
        })
      ).rejects.toThrow('Command not in allowed list');
    });

    it('should enforce concurrent terminal limit', async () => {
      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 2 },
        createMockClient(),
        createMockLogger()
      );

      // Create first terminal
      await manager.createTerminal('session-1', {
        command: 'echo 1',
      });

      // Create second terminal
      await manager.createTerminal('session-1', {
        command: 'echo 2',
      });

      // Third should fail
      await expect(
        manager.createTerminal('session-1', {
          command: 'echo 3',
        })
      ).rejects.toThrow(ToolError);

      await expect(
        manager.createTerminal('session-1', {
          command: 'echo 3',
        })
      ).rejects.toThrow('Maximum concurrent terminals reached');
    });

    it('should include optional parameters in request', async () => {
      const client = createMockClient();
      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 5 },
        client,
        createMockLogger()
      );

      await manager.createTerminal('session-1', {
        command: 'npm',
        args: ['test'],
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
        outputByteLimit: 10000,
      });
    });

    it('should not include empty arrays in request', async () => {
      const client = createMockClient();
      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 5 },
        client,
        createMockLogger()
      );

      await manager.createTerminal('session-1', {
        command: 'echo',
        args: [], // Empty array
        env: [], // Empty array
      });

      // Should not include empty args/env
      expect(client.createTerminal).toHaveBeenCalledWith({
        sessionId: 'session-1',
        command: 'echo',
      });
    });

    it('should apply default output byte limit', async () => {
      const client = createMockClient();
      const manager = new TerminalManager(
        {
          clientSupportsTerminals: true,
          maxConcurrentTerminals: 5,
          defaultOutputByteLimit: 5000,
        },
        client,
        createMockLogger()
      );

      await manager.createTerminal('session-1', {
        command: 'echo',
      });

      expect(client.createTerminal).toHaveBeenCalledWith({
        sessionId: 'session-1',
        command: 'echo',
        outputByteLimit: 5000,
      });
    });

    it('should cap output byte limit to maximum', async () => {
      const client = createMockClient();
      const logger = createMockLogger();
      const manager = new TerminalManager(
        {
          clientSupportsTerminals: true,
          maxConcurrentTerminals: 5,
          maxOutputByteLimit: 10000,
        },
        client,
        logger
      );

      await manager.createTerminal('session-1', {
        command: 'echo',
        outputByteLimit: 50000, // Exceeds max
      });

      expect(logger.warn).toHaveBeenCalledWith(
        'Output byte limit capped to maximum',
        expect.objectContaining({
          requested: 50000,
          max: 10000,
        })
      );

      expect(client.createTerminal).toHaveBeenCalledWith({
        sessionId: 'session-1',
        command: 'echo',
        outputByteLimit: 10000, // Capped
      });
    });

    it('should reject negative output byte limit', async () => {
      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 5 },
        createMockClient(),
        createMockLogger()
      );

      await expect(
        manager.createTerminal('session-1', {
          command: 'echo',
          outputByteLimit: -1,
        })
      ).rejects.toThrow('Output byte limit must be a positive number');
    });

    it('should track terminal metadata', async () => {
      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 5 },
        createMockClient(),
        createMockLogger()
      );

      const handle = await manager.createTerminal('session-1', {
        command: 'echo',
        args: ['hello'],
      });

      const metadata = manager.getTerminalMetadata(handle.id);

      expect(metadata).toBeDefined();
      expect(metadata?.id).toBe(handle.id);
      expect(metadata?.sessionId).toBe('session-1');
      expect(metadata?.command).toBe('echo');
      expect(metadata?.args).toEqual(['hello']);
      expect(metadata?.createdAt).toBeInstanceOf(Date);
      expect(metadata?.lastActivity).toBeInstanceOf(Date);
    });
  });

  describe('releaseTerminal', () => {
    it('should remove terminal from tracking', async () => {
      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 5 },
        createMockClient(),
        createMockLogger()
      );

      const handle = await manager.createTerminal('session-1', {
        command: 'echo',
      });

      expect(manager.getTerminalMetadata(handle.id)).toBeDefined();

      manager.releaseTerminal(handle.id);

      expect(manager.getTerminalMetadata(handle.id)).toBeUndefined();
    });

    it('should handle releasing non-existent terminal', () => {
      const logger = createMockLogger();
      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 5 },
        createMockClient(),
        logger
      );

      manager.releaseTerminal('non-existent');

      expect(logger.warn).toHaveBeenCalledWith(
        'Terminal not found for release',
        { terminalId: 'non-existent' }
      );
    });
  });

  describe('getSessionTerminals', () => {
    it('should return all terminals for a session', async () => {
      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 5 },
        createMockClient(),
        createMockLogger()
      );

      await manager.createTerminal('session-1', { command: 'echo 1' });
      await manager.createTerminal('session-1', { command: 'echo 2' });
      await manager.createTerminal('session-2', { command: 'echo 3' });

      const session1Terminals = manager.getSessionTerminals('session-1');
      const session2Terminals = manager.getSessionTerminals('session-2');

      expect(session1Terminals).toHaveLength(2);
      expect(session2Terminals).toHaveLength(1);
    });
  });

  describe('getActiveTerminalCount', () => {
    it('should return count of active terminals', async () => {
      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 5 },
        createMockClient(),
        createMockLogger()
      );

      expect(manager.getActiveTerminalCount()).toBe(0);

      await manager.createTerminal('session-1', { command: 'echo 1' });
      expect(manager.getActiveTerminalCount()).toBe(1);

      await manager.createTerminal('session-1', { command: 'echo 2' });
      expect(manager.getActiveTerminalCount()).toBe(2);
    });
  });

  describe('updateActivity', () => {
    it('should update last activity time', async () => {
      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 5 },
        createMockClient(),
        createMockLogger()
      );

      const handle = await manager.createTerminal('session-1', {
        command: 'echo',
      });

      const metadata1 = manager.getTerminalMetadata(handle.id);
      const lastActivity1 = metadata1?.lastActivity;

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 10));

      manager.updateActivity(handle.id);

      const metadata2 = manager.getTerminalMetadata(handle.id);
      const lastActivity2 = metadata2?.lastActivity;

      expect(lastActivity2).not.toEqual(lastActivity1);
      expect(lastActivity2!.getTime()).toBeGreaterThan(
        lastActivity1!.getTime()
      );
    });
  });

  describe('getMetrics', () => {
    it('should return terminal usage metrics', async () => {
      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 10 },
        createMockClient(),
        createMockLogger()
      );

      await manager.createTerminal('session-1', { command: 'echo 1' });
      await manager.createTerminal('session-1', { command: 'echo 2' });
      await manager.createTerminal('session-2', { command: 'echo 3' });

      const metrics = manager.getMetrics();

      expect(metrics.activeTerminals).toBe(3);
      expect(metrics.maxConcurrentTerminals).toBe(10);
      expect(metrics.terminalsBySession).toEqual({
        'session-1': 2,
        'session-2': 1,
      });
    });
  });

  describe('cleanup', () => {
    it('should clear all tracked terminals', async () => {
      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 5 },
        createMockClient(),
        createMockLogger()
      );

      await manager.createTerminal('session-1', { command: 'echo 1' });
      await manager.createTerminal('session-1', { command: 'echo 2' });

      expect(manager.getActiveTerminalCount()).toBe(2);

      manager.cleanup();

      expect(manager.getActiveTerminalCount()).toBe(0);
    });
  });

  describe('error handling', () => {
    it('should handle client errors gracefully', async () => {
      const client = createMockClient({
        createTerminal: jest.fn().mockRejectedValue(new Error('Network error')),
      });

      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 5 },
        client,
        createMockLogger()
      );

      await expect(
        manager.createTerminal('session-1', {
          command: 'echo',
        })
      ).rejects.toThrow(ToolError);

      await expect(
        manager.createTerminal('session-1', {
          command: 'echo',
        })
      ).rejects.toThrow('Failed to create terminal: Network error');
    });

    it('should preserve ProtocolError when thrown by client', async () => {
      const client = createMockClient({
        createTerminal: jest
          .fn()
          .mockRejectedValue(new ProtocolError('Protocol violation')),
      });

      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 5 },
        client,
        createMockLogger()
      );

      await expect(
        manager.createTerminal('session-1', {
          command: 'echo',
        })
      ).rejects.toThrow(ProtocolError);
    });
  });
});
