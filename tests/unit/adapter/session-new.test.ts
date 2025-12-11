/**
 * Tests for session/new method - ACP spec compliance
 *
 * Tests parameter validation, path handling, and MCP server configuration
 * for the session/new method per ACP specification.
 */

import { CursorAgentAdapter } from '../../../src/adapter/cursor-agent-adapter';
import type {
  AdapterConfig,
  AcpRequest,
  AcpResponse,
  Logger,
} from '../../../src/types';

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
      // Note: allowedPaths removed - security now enforced by ACP client
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

describe('session/new - Parameter Validation', () => {
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

  describe('cwd parameter validation', () => {
    it('should reject session/new without cwd parameter', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-cwd-1',
        params: {
          mcpServers: [],
          metadata: { name: 'Test Session' },
        },
      };

      const response = await adapter.processRequest(request);

      expect(response.error).toBeDefined();
      expect(response.error?.message).toContain(
        'cwd (working directory) is required'
      );
    });

    it('should reject session/new with null cwd', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-cwd-2',
        params: {
          cwd: null,
          mcpServers: [],
        },
      };

      const response = await adapter.processRequest(request);

      expect(response.error).toBeDefined();
      expect(response.error?.message).toContain(
        'cwd (working directory) is required'
      );
    });

    it('should reject session/new with empty string cwd', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-cwd-3',
        params: {
          cwd: '',
          mcpServers: [],
        },
      };

      const response = await adapter.processRequest(request);

      expect(response.error).toBeDefined();
      expect(response.error?.message).toContain(
        'cwd (working directory) is required'
      );
    });

    it('should reject session/new with relative path cwd', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-cwd-4',
        params: {
          cwd: './relative/path',
          mcpServers: [],
        },
      };

      const response = await adapter.processRequest(request);

      expect(response.error).toBeDefined();
      expect(response.error?.message).toContain('cwd must be an absolute path');
    });

    it('should reject session/new with relative path starting with ../', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-cwd-5',
        params: {
          cwd: '../parent/path',
          mcpServers: [],
        },
      };

      const response = await adapter.processRequest(request);

      expect(response.error).toBeDefined();
      expect(response.error?.message).toContain('cwd must be an absolute path');
    });

    it('should accept session/new with Unix absolute path', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-cwd-6',
        params: {
          cwd: '/absolute/unix/path',
          mcpServers: [],
        },
      };

      const response = await adapter.processRequest(request);

      expect(response.result).toBeDefined();
      expect(response.result.sessionId).toBeDefined();
      expect(response.error).toBeUndefined();
    });

    it('should accept session/new with Windows absolute path', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-cwd-7',
        params: {
          cwd: 'C:\\absolute\\windows\\path',
          mcpServers: [],
        },
      };

      const response = await adapter.processRequest(request);

      expect(response.result).toBeDefined();
      expect(response.result.sessionId).toBeDefined();
      expect(response.error).toBeUndefined();
    });

    it('should accept Windows paths with forward slashes', async () => {
      // Windows accepts both forward slashes (D:/) and backslashes (D:\)
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-cwd-8',
        params: {
          cwd: 'D:/absolute/windows/path',
          mcpServers: [],
        },
      };

      const response = await adapter.processRequest(request);

      // Should accept both forward and backward slashes
      expect(response.result).toBeDefined();
      expect(response.result.sessionId).toBeDefined();
      expect(response.error).toBeUndefined();
    });

    it('should handle cwd with special characters', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-cwd-9',
        params: {
          cwd: '/path/with spaces/and-special_chars!@#',
          mcpServers: [],
        },
      };

      const response = await adapter.processRequest(request);

      expect(response.result).toBeDefined();
      expect(response.result.sessionId).toBeDefined();
    });

    it('should handle very long cwd paths', async () => {
      const longPath = '/very/long/' + 'path/'.repeat(50) + 'directory';
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-cwd-10',
        params: {
          cwd: longPath,
          mcpServers: [],
        },
      };

      const response = await adapter.processRequest(request);

      expect(response.result).toBeDefined();
      expect(response.result.sessionId).toBeDefined();
    });

    it('should log session creation with cwd', async () => {
      const logSpy = jest.spyOn(mockLogger, 'info');
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-cwd-11',
        params: {
          cwd: '/test/project',
          mcpServers: [],
        },
      };

      await adapter.processRequest(request);

      expect(logSpy).toHaveBeenCalledWith(
        'Session created with working directory and MCP servers',
        expect.objectContaining({
          sessionId: expect.any(String),
          cwd: '/test/project',
        })
      );
    });
  });

  describe('mcpServers parameter validation', () => {
    it('should accept session/new with empty mcpServers array', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-mcp-1',
        params: {
          cwd: '/test/project',
          mcpServers: [],
        },
      };

      const response = await adapter.processRequest(request);

      expect(response.result).toBeDefined();
      expect(response.result.sessionId).toBeDefined();
      expect(response.error).toBeUndefined();
    });

    it('should default mcpServers to empty array when missing', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-mcp-2',
        params: {
          cwd: '/test/project',
          // mcpServers intentionally omitted
        },
      };

      const response = await adapter.processRequest(request);

      expect(response.result).toBeDefined();
      expect(response.result.sessionId).toBeDefined();
    });

    it('should accept session/new with single MCP server', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-mcp-3',
        params: {
          cwd: '/test/project',
          mcpServers: [
            {
              name: 'test-mcp-server',
              url: 'http://localhost:3000',
            },
          ],
        },
      };

      const response = await adapter.processRequest(request);

      expect(response.result).toBeDefined();
      expect(response.result.sessionId).toBeDefined();
    });

    it('should accept session/new with multiple MCP servers', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-mcp-4',
        params: {
          cwd: '/test/project',
          mcpServers: [
            {
              name: 'mcp-server-1',
              url: 'http://localhost:3000',
            },
            {
              name: 'mcp-server-2',
              url: 'http://localhost:3001',
            },
            {
              name: 'mcp-server-3',
              url: 'http://localhost:3002',
            },
          ],
        },
      };

      const response = await adapter.processRequest(request);

      expect(response.result).toBeDefined();
      expect(response.result.sessionId).toBeDefined();
    });

    it('should handle MCP servers without name', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-mcp-5',
        params: {
          cwd: '/test/project',
          mcpServers: [
            {
              url: 'http://localhost:3000',
            },
          ],
        },
      };

      const response = await adapter.processRequest(request);

      expect(response.result).toBeDefined();
      expect(response.result.sessionId).toBeDefined();
    });

    it('should log MCP server count', async () => {
      const logSpy = jest.spyOn(mockLogger, 'info');
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-mcp-6',
        params: {
          cwd: '/test/project',
          mcpServers: [
            { name: 'server-1', url: 'http://localhost:3000' },
            { name: 'server-2', url: 'http://localhost:3001' },
          ],
        },
      };

      await adapter.processRequest(request);

      expect(logSpy).toHaveBeenCalledWith(
        'Session created with working directory and MCP servers',
        expect.objectContaining({
          sessionId: expect.any(String),
          cwd: '/test/project',
          mcpServerCount: 2,
          mcpServerNames: ['server-1', 'server-2'],
        })
      );
    });

    it('should log unnamed MCP servers as "unnamed"', async () => {
      const logSpy = jest.spyOn(mockLogger, 'info');
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-mcp-7',
        params: {
          cwd: '/test/project',
          mcpServers: [
            { url: 'http://localhost:3000' },
            { name: 'named-server', url: 'http://localhost:3001' },
          ],
        },
      };

      await adapter.processRequest(request);

      expect(logSpy).toHaveBeenCalledWith(
        'Session created with working directory and MCP servers',
        expect.objectContaining({
          mcpServerNames: ['unnamed', 'named-server'],
        })
      );
    });

    it('should handle MCP servers with complex configuration', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-mcp-8',
        params: {
          cwd: '/test/project',
          mcpServers: [
            {
              name: 'advanced-mcp-server',
              url: 'http://localhost:3000',
              auth: {
                type: 'bearer',
                token: 'test-token',
              },
              capabilities: {
                streaming: true,
                tools: ['search', 'analyze'],
              },
            },
          ],
        },
      };

      const response = await adapter.processRequest(request);

      expect(response.result).toBeDefined();
      expect(response.result.sessionId).toBeDefined();
    });
  });

  describe('metadata handling with cwd and mcpServers', () => {
    it('should store cwd in metadata', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-meta-1',
        params: {
          cwd: '/test/project',
          mcpServers: [],
          metadata: {
            name: 'Test Session',
          },
        },
      };

      const createResponse = await adapter.processRequest(request);
      const sessionId = createResponse.result.sessionId;

      // List sessions to verify metadata
      const listRequest: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/list',
        id: 'test-meta-list',
        params: {},
      };

      const listResponse = await adapter.processRequest(listRequest);
      const session = listResponse.result.sessions.find(
        (s: any) => s.id === sessionId
      );

      expect(session.metadata.cwd).toBe('/test/project');
      expect(session.metadata.name).toBe('Test Session');
    });

    it('should store mcpServers in metadata', async () => {
      const mcpServers = [
        { name: 'test-server', url: 'http://localhost:3000' },
      ];

      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-meta-2',
        params: {
          cwd: '/test/project',
          mcpServers,
        },
      };

      const createResponse = await adapter.processRequest(request);
      const sessionId = createResponse.result.sessionId;

      // List sessions to verify metadata
      const listRequest: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/list',
        id: 'test-meta-list-2',
        params: {},
      };

      const listResponse = await adapter.processRequest(listRequest);
      const session = listResponse.result.sessions.find(
        (s: any) => s.id === sessionId
      );

      expect(session.metadata.mcpServers).toEqual(mcpServers);
    });

    it('should merge cwd and mcpServers with existing metadata', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-meta-3',
        params: {
          cwd: '/test/project',
          mcpServers: [{ name: 'server-1' }],
          metadata: {
            name: 'My Session',
            tags: ['test', 'development'],
            customField: 'custom-value',
          },
        },
      };

      const createResponse = await adapter.processRequest(request);
      const sessionId = createResponse.result.sessionId;

      // List sessions to verify metadata
      const listRequest: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/list',
        id: 'test-meta-list-3',
        params: {},
      };

      const listResponse = await adapter.processRequest(listRequest);
      const session = listResponse.result.sessions.find(
        (s: any) => s.id === sessionId
      );

      expect(session.metadata).toMatchObject({
        name: 'My Session',
        tags: ['test', 'development'],
        customField: 'custom-value',
        cwd: '/test/project',
        mcpServers: [{ name: 'server-1' }],
      });
    });

    it('should not allow metadata to override cwd', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-meta-4',
        params: {
          cwd: '/correct/path',
          mcpServers: [],
          metadata: {
            cwd: '/wrong/path', // Should be overridden
          },
        },
      };

      const createResponse = await adapter.processRequest(request);
      const sessionId = createResponse.result.sessionId;

      // List sessions to verify correct cwd
      const listRequest: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/list',
        id: 'test-meta-list-4',
        params: {},
      };

      const listResponse = await adapter.processRequest(listRequest);
      const session = listResponse.result.sessions.find(
        (s: any) => s.id === sessionId
      );

      expect(session.metadata.cwd).toBe('/correct/path');
    });

    it('should not allow metadata to override mcpServers', async () => {
      const correctServers = [{ name: 'correct-server' }];
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-meta-5',
        params: {
          cwd: '/test/project',
          mcpServers: correctServers,
          metadata: {
            mcpServers: [{ name: 'wrong-server' }], // Should be overridden
          },
        },
      };

      const createResponse = await adapter.processRequest(request);
      const sessionId = createResponse.result.sessionId;

      // List sessions to verify correct mcpServers
      const listRequest: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/list',
        id: 'test-meta-list-5',
        params: {},
      };

      const listResponse = await adapter.processRequest(listRequest);
      const session = listResponse.result.sessions.find(
        (s: any) => s.id === sessionId
      );

      expect(session.metadata.mcpServers).toEqual(correctServers);
    });
  });

  describe('response format per ACP spec', () => {
    it('should return sessionId in response', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-response-1',
        params: {
          cwd: '/test/project',
          mcpServers: [],
        },
      };

      const response = await adapter.processRequest(request);

      expect(response.result).toBeDefined();
      expect(response.result.sessionId).toBeDefined();
      expect(typeof response.result.sessionId).toBe('string');
      expect(response.result.sessionId.length).toBeGreaterThan(0);
    });

    it('should include modes and models in response', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-response-2',
        params: {
          cwd: '/test/project',
          mcpServers: [],
        },
      };

      const response = await adapter.processRequest(request);

      // Modes should be defined with available modes and current mode
      expect(response.result.modes).toBeDefined();
      expect(response.result.modes.availableModes).toBeDefined();
      expect(Array.isArray(response.result.modes.availableModes)).toBe(true);
      expect(response.result.modes.currentModeId).toBeDefined();
      expect(response.result.modes.currentModeId).toBe('ask'); // Default mode

      // Models should be defined with available models and current model
      expect(response.result.models).toBeDefined();
      expect(response.result.models.availableModels).toBeDefined();
      expect(Array.isArray(response.result.models.availableModels)).toBe(true);
      expect(response.result.models.currentModelId).toBeDefined();
      expect(response.result.models.currentModelId).toBe('auto'); // Default model
    });

    it('should return proper JSON-RPC 2.0 response structure', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-response-3',
        params: {
          cwd: '/test/project',
          mcpServers: [],
        },
      };

      const response = await adapter.processRequest(request);

      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe('test-response-3');
      expect(response.result).toBeDefined();
      expect(response.error).toBeUndefined();
    });

    it('should return error response for validation failures', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-response-4',
        params: {
          // cwd missing
          mcpServers: [],
        },
      };

      const response = await adapter.processRequest(request);

      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe('test-response-4');
      expect(response.error).toBeDefined();
      expect(response.error?.code).toBeDefined();
      expect(response.error?.message).toBeDefined();
      expect(response.result).toBeUndefined();
    });
  });

  describe('edge cases and error handling', () => {
    it('should handle missing params object', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-edge-1',
        // params intentionally omitted
      };

      const response = await adapter.processRequest(request);

      expect(response.error).toBeDefined();
      expect(response.error?.message).toContain('cwd');
    });

    it('should handle null params object', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-edge-2',
        params: null as any,
      };

      const response = await adapter.processRequest(request);

      expect(response.error).toBeDefined();
    });

    it('should handle params with wrong type', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-edge-3',
        params: 'invalid' as any,
      };

      const response = await adapter.processRequest(request);

      expect(response.error).toBeDefined();
    });

    it('should handle concurrent session creation with same cwd', async () => {
      const requests = Array.from({ length: 5 }, (_, i) => ({
        jsonrpc: '2.0' as const,
        method: 'session/new',
        id: `concurrent-${i}`,
        params: {
          cwd: '/same/project/path',
          mcpServers: [],
          metadata: { name: `Session ${i}` },
        },
      }));

      const responses = await Promise.all(
        requests.map((req) => adapter.processRequest(req))
      );

      // All should succeed
      responses.forEach((response) => {
        expect(response.result).toBeDefined();
        expect(response.result.sessionId).toBeDefined();
      });

      // All session IDs should be unique
      const sessionIds = responses.map((r) => r.result.sessionId);
      const uniqueIds = new Set(sessionIds);
      expect(uniqueIds.size).toBe(sessionIds.length);
    });
  });

  describe('available_commands_update notification', () => {
    it('should send available_commands_update notification after session creation', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-1',
        params: {
          cwd: '/tmp',
          mcpServers: [],
        },
      };

      const response = await adapter.processRequest(request);

      expect(response.result).toBeDefined();
      expect(response.result.sessionId).toBeDefined();

      // Wait for notification to be sent (uses setImmediate)
      await new Promise((resolve) => setImmediate(resolve));

      // Should have sent available_commands_update notification
      const commandNotifications = sentNotifications.filter(
        (n) => n.params?.update?.sessionUpdate === 'available_commands_update'
      );

      expect(commandNotifications.length).toBeGreaterThan(0);

      const notification = commandNotifications[0]!;
      expect(notification.jsonrpc).toBe('2.0');
      expect(notification.method).toBe('session/update');
      expect(notification.params.sessionId).toBe(response.result.sessionId);
      expect(notification.params.update.sessionUpdate).toBe(
        'available_commands_update'
      );
      expect(notification.params.update.availableCommands).toBeInstanceOf(
        Array
      );
      expect(
        notification.params.update.availableCommands.length
      ).toBeGreaterThan(0);

      // Verify command structure matches SDK types
      const command = notification.params.update.availableCommands[0];
      expect(command).toHaveProperty('name');
      expect(command).toHaveProperty('description');
      expect(typeof command.name).toBe('string');
      expect(typeof command.description).toBe('string');
    });

    it('should include default commands in notification', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-1',
        params: {
          cwd: '/tmp',
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
      expect(planCommand.input).toBeDefined();
      expect(planCommand.input.hint).toBe('description of what to plan');
    });

    it('should not send notification when no commands are registered', async () => {
      // Create adapter and clear commands
      const adapterWithNoCommands = new CursorAgentAdapter(testConfig, {
        logger: mockLogger,
      });
      await adapterWithNoCommands.initialize();

      // Access private registry and clear it
      const registry = (adapterWithNoCommands as any).slashCommandsRegistry;
      if (registry) {
        registry.clear();
      }

      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-1',
        params: {
          cwd: '/tmp',
          mcpServers: [],
        },
      };

      sentNotifications = [];
      await adapterWithNoCommands.processRequest(request);

      // Wait for notification
      await new Promise((resolve) => setTimeout(resolve, 50));

      const commandNotifications = sentNotifications.filter(
        (n) => n.params?.update?.sessionUpdate === 'available_commands_update'
      );

      // Should not send notification when no commands
      expect(commandNotifications.length).toBe(0);

      await adapterWithNoCommands.shutdown();
    });
  });

  describe('model state in response', () => {
    it('should include models in session/new response', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-1',
        params: {
          cwd: '/tmp',
          mcpServers: [],
        },
      };

      const response = await adapter.processRequest(request);

      expect(response.result).toHaveProperty('models');
      expect(response.result.models).toHaveProperty('availableModels');
      expect(response.result.models).toHaveProperty('currentModelId');
    });

    it('should return list of available models', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-1',
        params: {
          cwd: '/tmp',
          mcpServers: [],
        },
      };

      const response = await adapter.processRequest(request);

      const models = response.result.models.availableModels;
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);

      // Check model structure
      models.forEach((model: any) => {
        expect(model).toHaveProperty('modelId');
        expect(model).toHaveProperty('name');
        expect(typeof model.modelId).toBe('string');
        expect(typeof model.name).toBe('string');
      });
    });

    it('should include expected models', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-1',
        params: {
          cwd: '/tmp',
          mcpServers: [],
        },
      };

      const response = await adapter.processRequest(request);

      const modelIds = response.result.models.availableModels.map(
        (m: any) => m.modelId
      );

      // Check for some key models
      expect(modelIds).toContain('auto');
      expect(modelIds).toContain('composer-1');
      expect(modelIds).toContain('sonnet-4.5');
      expect(modelIds).toContain('gpt-5');
      expect(modelIds).toContain('grok');
    });

    it('should set default model as current', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-1',
        params: {
          cwd: '/tmp',
          mcpServers: [],
        },
      };

      const response = await adapter.processRequest(request);

      expect(response.result.models.currentModelId).toBe('auto');
    });

    it('should use custom model when specified in metadata', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-1',
        params: {
          cwd: '/tmp',
          mcpServers: [],
          metadata: {
            model: 'sonnet-4.5',
          },
        },
      };

      const response = await adapter.processRequest(request);

      expect(response.result.models.currentModelId).toBe('sonnet-4.5');
    });
  });
});
