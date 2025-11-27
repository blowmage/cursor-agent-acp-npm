/**
 * Unit tests for session/load method validation
 * Tests absolute path validation for cwd parameter
 */

import { CursorAgentAdapter } from '../../../src/adapter/cursor-agent-adapter';
import type { AdapterConfig, AcpRequest, Logger } from '../../../src/types';

// Mock the CursorCliBridge module
jest.mock('../../../src/cursor/cli-bridge', () => ({
  CursorCliBridge: jest.fn().mockImplementation((config, logger) => {
    return {
      getVersion: jest.fn().mockResolvedValue('1.0.0'),
      checkAuthentication: jest
        .fn()
        .mockResolvedValue({ authenticated: true, user: 'test' }),
      close: jest.fn().mockResolvedValue(undefined),
    };
  }),
}));

// Mock logger for tests
const mockLogger: Logger = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
};

// Test configuration
const testConfig: AdapterConfig = {
  logLevel: 'debug',
  sessionDir: '/tmp/cursor-test-sessions',
  maxSessions: 10,
  sessionTimeout: 60000,
  tools: {
    filesystem: {
      enabled: false, // Disabled for adapter tests - not testing filesystem
    },
    terminal: {
      enabled: true,
      maxProcesses: 3,
    },
  },
  cursor: {
    timeout: 30000,
    retries: 1,
  },
};

describe('CursorAgentAdapter - session/load', () => {
  let adapter: CursorAgentAdapter;
  let sentNotifications: any[];

  beforeEach(async () => {
    jest.clearAllMocks();
    sentNotifications = [];

    // Spy on process.stdout.write to capture notifications
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      const str = typeof chunk === 'string' ? chunk : chunk.toString();
      try {
        const notification = JSON.parse(str.trim());
        if (notification.method === 'session/update') {
          sentNotifications.push(notification);
        }
      } catch {
        // Not JSON, ignore
      }
      return true;
    });

    adapter = new CursorAgentAdapter(testConfig, { logger: mockLogger });
    await adapter.initialize();

    // Create a session first for loading
    const createRequest: AcpRequest = {
      jsonrpc: '2.0',
      method: 'session/new',
      id: 'test-create',
      params: {
        cwd: '/tmp/test',
        mcpServers: [],
      },
    };
    await adapter.processRequest(createRequest);

    // Clear notifications from creation
    sentNotifications = [];
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (adapter) {
      try {
        await adapter.shutdown();
      } catch (error) {
        // Ignore shutdown errors in tests
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  describe('cwd validation', () => {
    it('should reject session/load with relative path', async () => {
      const createResponse = await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-create-1',
        params: {
          cwd: '/tmp/test',
          mcpServers: [],
        },
      });

      const sessionId = createResponse.result.sessionId;

      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/load',
        id: 'test-load-1',
        params: {
          sessionId,
          cwd: 'relative/path',
          mcpServers: [],
        },
      };

      const response = await adapter.processRequest(request);

      expect(response.error).toBeDefined();
      expect(response.error?.message).toContain('cwd must be an absolute path');
    });

    it('should reject session/load with relative path starting with ./', async () => {
      const createResponse = await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-create-2',
        params: {
          cwd: '/tmp/test',
          mcpServers: [],
        },
      });

      const sessionId = createResponse.result.sessionId;

      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/load',
        id: 'test-load-2',
        params: {
          sessionId,
          cwd: './current/path',
          mcpServers: [],
        },
      };

      const response = await adapter.processRequest(request);

      expect(response.error).toBeDefined();
      expect(response.error?.message).toContain('cwd must be an absolute path');
    });

    it('should reject session/load with relative path starting with ../', async () => {
      const createResponse = await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-create-3',
        params: {
          cwd: '/tmp/test',
          mcpServers: [],
        },
      });

      const sessionId = createResponse.result.sessionId;

      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/load',
        id: 'test-load-3',
        params: {
          sessionId,
          cwd: '../parent/path',
          mcpServers: [],
        },
      };

      const response = await adapter.processRequest(request);

      expect(response.error).toBeDefined();
      expect(response.error?.message).toContain('cwd must be an absolute path');
    });

    it('should accept session/load with Unix absolute path', async () => {
      const createResponse = await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-create-4',
        params: {
          cwd: '/tmp/test',
          mcpServers: [],
        },
      });

      const sessionId = createResponse.result.sessionId;

      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/load',
        id: 'test-load-4',
        params: {
          sessionId,
          cwd: '/absolute/unix/path',
          mcpServers: [],
        },
      };

      const response = await adapter.processRequest(request);

      expect(response.result).toBeDefined();
      expect(response.error).toBeUndefined();
    });

    it('should accept session/load with Windows absolute path', async () => {
      const createResponse = await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-create-5',
        params: {
          cwd: '/tmp/test',
          mcpServers: [],
        },
      });

      const sessionId = createResponse.result.sessionId;

      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/load',
        id: 'test-load-5',
        params: {
          sessionId,
          cwd: 'C:\\absolute\\windows\\path',
          mcpServers: [],
        },
      };

      const response = await adapter.processRequest(request);

      expect(response.result).toBeDefined();
      expect(response.error).toBeUndefined();
    });

    it('should accept session/load with Windows absolute path (forward slashes)', async () => {
      const createResponse = await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-create-6',
        params: {
          cwd: '/tmp/test',
          mcpServers: [],
        },
      });

      const sessionId = createResponse.result.sessionId;

      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/load',
        id: 'test-load-6',
        params: {
          sessionId,
          cwd: 'D:/absolute/windows/path',
          mcpServers: [],
        },
      };

      const response = await adapter.processRequest(request);

      expect(response.result).toBeDefined();
      expect(response.error).toBeUndefined();
    });

    it('should reject session/load with non-string cwd', async () => {
      const createResponse = await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-create-7',
        params: {
          cwd: '/tmp/test',
          mcpServers: [],
        },
      });

      const sessionId = createResponse.result.sessionId;

      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/load',
        id: 'test-load-7',
        params: {
          sessionId,
          cwd: 123 as any,
          mcpServers: [],
        },
      };

      const response = await adapter.processRequest(request);

      expect(response.error).toBeDefined();
      expect(response.error?.message).toContain('cwd must be a string');
    });
  });

  describe('available_commands_update notification', () => {
    it('should send available_commands_update notification after session load', async () => {
      const createResponse = await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-create-load',
        params: {
          cwd: '/tmp/test',
          mcpServers: [],
        },
      });

      const sessionId = createResponse.result.sessionId;

      // Clear notifications from creation
      sentNotifications = [];

      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/load',
        id: 'test-load-1',
        params: {
          sessionId,
          cwd: '/tmp/test',
          mcpServers: [],
        },
      };

      const response = await adapter.processRequest(request);

      expect(response.result).toBeDefined();

      // Wait a bit for notification to be sent
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should have sent available_commands_update notification
      const commandNotifications = sentNotifications.filter(
        (n) => n.params?.update?.sessionUpdate === 'available_commands_update'
      );

      expect(commandNotifications.length).toBeGreaterThan(0);

      const notification = commandNotifications[0]!;
      expect(notification.jsonrpc).toBe('2.0');
      expect(notification.method).toBe('session/update');
      expect(notification.params.sessionId).toBe(sessionId);
      expect(notification.params.update.sessionUpdate).toBe(
        'available_commands_update'
      );
      expect(notification.params.update.availableCommands).toBeInstanceOf(
        Array
      );
      expect(
        notification.params.update.availableCommands.length
      ).toBeGreaterThan(0);
    });

    it('should include commands in load notification', async () => {
      const createResponse = await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-create-load-2',
        params: {
          cwd: '/tmp/test',
          mcpServers: [],
        },
      });

      const sessionId = createResponse.result.sessionId;

      // Clear notifications from creation
      sentNotifications = [];

      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/load',
        id: 'test-load-2',
        params: {
          sessionId,
          cwd: '/tmp/test',
          mcpServers: [],
        },
      };

      await adapter.processRequest(request);

      // Wait for notification
      await new Promise((resolve) => setTimeout(resolve, 50));

      const commandNotifications = sentNotifications.filter(
        (n) => n.params?.update?.sessionUpdate === 'available_commands_update'
      );

      expect(commandNotifications.length).toBeGreaterThan(0);

      const commands = commandNotifications[0]!.params.update.availableCommands;

      // Should have at least the default "plan" command
      const planCommand = commands.find((c: any) => c.name === 'plan');
      expect(planCommand).toBeDefined();
      expect(planCommand.description).toBe(
        'Create a detailed implementation plan'
      );
    });
  });
});
