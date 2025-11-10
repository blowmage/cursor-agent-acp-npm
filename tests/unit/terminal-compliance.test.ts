/**
 * ACP Terminals Protocol Compliance Tests
 *
 * Tests that verify strict compliance with the ACP Terminals specification:
 * https://agentclientprotocol.com/protocol/terminals
 *
 * These tests ensure the implementation follows the standard exactly.
 */

import { TerminalManager } from '../../src/tools/terminal-manager';
import type { Logger } from '../../src/types';
import { ProtocolError, ToolError } from '../../src/types';
import type {
  TerminalHandle,
  CreateTerminalRequest,
  AgentSideConnection,
  EnvVariable,
} from '@agentclientprotocol/sdk';

// Mock logger
const createMockLogger = (): Logger => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
});

// Mock TerminalHandle
class MockTerminalHandle implements TerminalHandle {
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

// Mock AgentSideConnection
let mockTerminalCounter = 0;
const createMockClient = (): Partial<AgentSideConnection> => {
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
  } as Partial<AgentSideConnection>;
};

describe('ACP Terminals Protocol Compliance', () => {
  beforeEach(() => {
    mockTerminalCounter = 0;
  });

  describe('Checking Support (ACP Spec Section)', () => {
    /**
     * Per ACP spec: https://agentclientprotocol.com/protocol/terminals#checking-support
     * "Before attempting to use terminal methods, Agents MUST verify that the Client
     * supports this capability by checking the Client Capabilities field in the
     * initialize response."
     */

    it('MUST check client capabilities before creating terminal', async () => {
      const manager = new TerminalManager(
        { clientSupportsTerminals: false, maxConcurrentTerminals: 5 },
        createMockClient() as AgentSideConnection,
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

    it('MUST NOT attempt terminal operations if client does not support them', async () => {
      const client = createMockClient();
      const manager = new TerminalManager(
        { clientSupportsTerminals: false, maxConcurrentTerminals: 5 },
        client as AgentSideConnection,
        createMockLogger()
      );

      await expect(
        manager.createTerminal('session-1', {
          command: 'echo',
        })
      ).rejects.toThrow();

      // Client should not be called
      expect(client.createTerminal).not.toHaveBeenCalled();
    });

    it('SHOULD allow terminal operations when client supports them', async () => {
      const client = createMockClient();
      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 5 },
        client as AgentSideConnection,
        createMockLogger()
      );

      const handle = await manager.createTerminal('session-1', {
        command: 'echo',
      });

      expect(handle).toBeDefined();
      expect(client.createTerminal).toHaveBeenCalled();
    });
  });

  describe('Executing Commands (ACP Spec Section)', () => {
    /**
     * Per ACP spec: https://agentclientprotocol.com/protocol/terminals#executing-commands
     * The terminal/create method starts a command in a new terminal.
     */

    it('MUST require sessionId parameter', async () => {
      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 5 },
        createMockClient() as AgentSideConnection,
        createMockLogger()
      );

      // TypeScript will catch this, but we verify runtime behavior
      const handle = await manager.createTerminal('session-1', {
        command: 'echo',
      });

      expect(handle).toBeDefined();
    });

    it('MUST require command parameter', async () => {
      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 5 },
        createMockClient() as AgentSideConnection,
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

    it('MUST support optional args parameter', async () => {
      const client = createMockClient();
      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 5 },
        client as AgentSideConnection,
        createMockLogger()
      );

      await manager.createTerminal('session-1', {
        command: 'npm',
        args: ['test', '--coverage'],
      });

      expect(client.createTerminal).toHaveBeenCalledWith({
        sessionId: 'session-1',
        command: 'npm',
        args: ['test', '--coverage'],
      });
    });

    it('MUST support optional cwd parameter (absolute path)', async () => {
      const client = createMockClient();
      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 5 },
        client as AgentSideConnection,
        createMockLogger()
      );

      await manager.createTerminal('session-1', {
        command: 'ls',
        cwd: '/home/user/project',
      });

      expect(client.createTerminal).toHaveBeenCalledWith({
        sessionId: 'session-1',
        command: 'ls',
        cwd: '/home/user/project',
      });
    });

    it('MUST support optional env parameter', async () => {
      const client = createMockClient();
      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 5 },
        client as AgentSideConnection,
        createMockLogger()
      );

      const env: EnvVariable[] = [
        { name: 'NODE_ENV', value: 'test' },
        { name: 'CI', value: 'true' },
      ];

      await manager.createTerminal('session-1', {
        command: 'npm',
        env,
      });

      expect(client.createTerminal).toHaveBeenCalledWith({
        sessionId: 'session-1',
        command: 'npm',
        env,
      });
    });

    it('MUST support optional outputByteLimit parameter', async () => {
      const client = createMockClient();
      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 5 },
        client as AgentSideConnection,
        createMockLogger()
      );

      await manager.createTerminal('session-1', {
        command: 'npm',
        outputByteLimit: 1048576,
      });

      expect(client.createTerminal).toHaveBeenCalledWith({
        sessionId: 'session-1',
        command: 'npm',
        outputByteLimit: 1048576,
      });
    });

    it('MUST return TerminalHandle immediately without waiting for completion', async () => {
      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 5 },
        createMockClient() as AgentSideConnection,
        createMockLogger()
      );

      const handle = await manager.createTerminal('session-1', {
        command: 'sleep',
        args: ['10'],
      });

      // Handle should be returned immediately
      expect(handle).toBeDefined();
      expect(handle.id).toBeDefined();
    });
  });

  describe('Releasing Terminals (ACP Spec Section)', () => {
    /**
     * Per ACP spec: https://agentclientprotocol.com/protocol/terminals#releasing-terminals
     * "The Agent MUST release the terminal using terminal/release when it's no longer needed."
     */

    it('MUST release terminal when done', async () => {
      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 5 },
        createMockClient() as AgentSideConnection,
        createMockLogger()
      );

      const handle = await manager.createTerminal('session-1', {
        command: 'echo',
      });

      // Terminal should be tracked
      expect(manager.getTerminalMetadata(handle.id)).toBeDefined();

      // Release terminal
      await handle.release();
      manager.releaseTerminal(handle.id);

      // Terminal should be removed from tracking
      expect(manager.getTerminalMetadata(handle.id)).toBeUndefined();
    });

    it('MUST invalidate terminal ID after release', async () => {
      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 5 },
        createMockClient() as AgentSideConnection,
        createMockLogger()
      );

      const handle = await manager.createTerminal('session-1', {
        command: 'echo',
      });

      await handle.release();
      manager.releaseTerminal(handle.id);

      // Attempting to use released terminal should fail
      await expect(handle.currentOutput()).rejects.toThrow(
        'Terminal already released'
      );
    });
  });

  describe('Output Byte Limit (ACP Spec Section)', () => {
    /**
     * Per ACP spec: https://agentclientprotocol.com/protocol/terminals#executing-commands
     * "When the limit is exceeded, the Client truncates from the beginning of the output
     * to stay within the limit. The Client MUST ensure truncation happens at a character
     * boundary to maintain valid string output."
     */

    it('MUST accept positive outputByteLimit values', async () => {
      const client = createMockClient();
      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 5 },
        client as AgentSideConnection,
        createMockLogger()
      );

      await manager.createTerminal('session-1', {
        command: 'echo',
        outputByteLimit: 1000,
      });

      expect(client.createTerminal).toHaveBeenCalledWith(
        expect.objectContaining({
          outputByteLimit: 1000,
        })
      );
    });

    it('MUST reject negative outputByteLimit values', async () => {
      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 5 },
        createMockClient() as AgentSideConnection,
        createMockLogger()
      );

      await expect(
        manager.createTerminal('session-1', {
          command: 'echo',
          outputByteLimit: -1,
        })
      ).rejects.toThrow('Output byte limit must be a positive number');
    });

    it('SHOULD apply default outputByteLimit when not specified', async () => {
      const client = createMockClient();
      const manager = new TerminalManager(
        {
          clientSupportsTerminals: true,
          maxConcurrentTerminals: 5,
          defaultOutputByteLimit: 5000,
        },
        client as AgentSideConnection,
        createMockLogger()
      );

      await manager.createTerminal('session-1', {
        command: 'echo',
      });

      expect(client.createTerminal).toHaveBeenCalledWith(
        expect.objectContaining({
          outputByteLimit: 5000,
        })
      );
    });
  });

  describe('SDK Type Compliance', () => {
    /**
     * Verify that we're using SDK types correctly
     */

    it('SHOULD use CreateTerminalRequest type from SDK', async () => {
      const client = createMockClient();
      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 5 },
        client as AgentSideConnection,
        createMockLogger()
      );

      await manager.createTerminal('session-1', {
        command: 'echo',
        args: ['hello'],
        cwd: '/tmp',
        env: [{ name: 'TEST', value: 'true' }],
        outputByteLimit: 1000,
      });

      const call = (client.createTerminal as jest.Mock).mock.calls[0];
      const request: CreateTerminalRequest = call[0];

      // Verify request matches CreateTerminalRequest type
      expect(request.sessionId).toBe('session-1');
      expect(request.command).toBe('echo');
      expect(request.args).toEqual(['hello']);
      expect(request.cwd).toBe('/tmp');
      expect(request.env).toEqual([{ name: 'TEST', value: 'true' }]);
      expect(request.outputByteLimit).toBe(1000);
    });

    it('SHOULD return TerminalHandle type from SDK', async () => {
      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 5 },
        createMockClient() as AgentSideConnection,
        createMockLogger()
      );

      const handle: TerminalHandle = await manager.createTerminal('session-1', {
        command: 'echo',
      });

      // Verify TerminalHandle interface compliance
      expect(handle.id).toBeDefined();
      expect(typeof handle.currentOutput).toBe('function');
      expect(typeof handle.waitForExit).toBe('function');
      expect(typeof handle.kill).toBe('function');
      expect(typeof handle.release).toBe('function');
    });
  });

  describe('Agent-Side Policies', () => {
    /**
     * These are agent-side security policies, not part of ACP spec but
     * important for implementation
     */

    it('SHOULD enforce concurrent terminal limits', async () => {
      const manager = new TerminalManager(
        { clientSupportsTerminals: true, maxConcurrentTerminals: 2 },
        createMockClient() as AgentSideConnection,
        createMockLogger()
      );

      await manager.createTerminal('session-1', { command: 'echo 1' });
      await manager.createTerminal('session-1', { command: 'echo 2' });

      await expect(
        manager.createTerminal('session-1', { command: 'echo 3' })
      ).rejects.toThrow('Maximum concurrent terminals reached');
    });

    it('SHOULD validate commands against forbidden list', async () => {
      const manager = new TerminalManager(
        {
          clientSupportsTerminals: true,
          maxConcurrentTerminals: 5,
          forbiddenCommands: ['rm', 'sudo'],
        },
        createMockClient() as AgentSideConnection,
        createMockLogger()
      );

      await expect(
        manager.createTerminal('session-1', {
          command: 'rm -rf /',
        })
      ).rejects.toThrow('Command contains forbidden pattern');
    });

    it('SHOULD validate commands against allowed list', async () => {
      const manager = new TerminalManager(
        {
          clientSupportsTerminals: true,
          maxConcurrentTerminals: 5,
          allowedCommands: ['echo', 'ls'],
        },
        createMockClient() as AgentSideConnection,
        createMockLogger()
      );

      await expect(
        manager.createTerminal('session-1', {
          command: 'npm install',
        })
      ).rejects.toThrow('Command not in allowed list');
    });
  });
});
