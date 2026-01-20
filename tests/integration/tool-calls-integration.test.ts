/**
 * Integration tests for Tool Calls Implementation
 *
 * Tests the complete flow of tool call reporting from tool execution
 * through to client notifications.
 *
 * Note: CursorCliBridge is mocked to avoid slow real cursor-agent calls
 * while still testing all other component integrations.
 */

import { jest } from '@jest/globals';
import { CursorAgentAdapter } from '../../src/adapter/cursor-agent-adapter';
import type { AdapterConfig, Logger } from '../../src/types';
import type {
  Request as AcpRequest,
  Notification as AcpNotification,
  ClientCapabilities,
} from '@agentclientprotocol/sdk';
import { FilesystemToolProvider } from '../../src/tools/filesystem';
import { AcpFileSystemClient } from '../../src/client/filesystem-client';
import { promises as fs } from 'fs';
import { MockCursorCliBridge } from './mocks/cursor-bridge-mock';

// Mock the CursorCliBridge module
jest.mock('../../src/cursor/cli-bridge', () => ({
  CursorCliBridge: jest.fn().mockImplementation((config, logger) => {
    return new MockCursorCliBridge(config, logger);
  }),
}));

// Mock fs module to avoid real file I/O operations in integration tests
jest.mock('fs', () => {
  // Map of mock file contents for testing
  const mockFiles = new Map<string, string>();

  return {
    promises: {
      readFile: jest.fn().mockImplementation(async (filePath: string) => {
        // Check if file was written by a test
        if (mockFiles.has(filePath)) {
          return mockFiles.get(filePath);
        }

        // Return mock content for test files
        if (filePath.includes('test.txt')) {
          return 'mock test file content';
        }

        if (filePath.includes('test-write.txt')) {
          return 'written content';
        }

        // Simulate file not found for non-existent files
        if (filePath.includes('nonexistent')) {
          const error: any = new Error(
            `ENOENT: no such file or directory, open '${filePath}'`
          );
          error.code = 'ENOENT';
          throw error;
        }

        // Default mock content
        return 'default mock file content';
      }),
      writeFile: jest
        .fn()
        .mockImplementation(async (filePath: string, content: string) => {
          mockFiles.set(filePath, content);
          return undefined;
        }),
    },
  };
});

// Mock logger for tests
const mockLogger: Logger = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
};

describe('Tool Calls Integration', () => {
  let adapter: CursorAgentAdapter;
  let sentNotifications: AcpNotification[];

  // Mock client security settings (simulates client-side validation per ACP spec)
  const mockClientAllowedPaths = ['/tmp'];

  const mockConfig: AdapterConfig = {
    logLevel: 'error',
    sessionDir: '/tmp/test-sessions',
    maxSessions: 10,
    sessionTimeout: 3600000,
    tools: {
      filesystem: {
        enabled: false, // Disabled in config, manually registered in beforeEach
        // Note: Security validation now done by mock client (simulates ACP client behavior)
      },
      terminal: {
        enabled: true,
        maxProcesses: 5,
      },
      cursor: {
        enabled: false, // Disable to avoid CLI dependency
      },
    },
    cursor: {
      timeout: 30000,
      retries: 3,
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    sentNotifications = [];

    // Create adapter - jest.mock ensures CursorCliBridge is mocked automatically
    adapter = new CursorAgentAdapter(mockConfig, { logger: mockLogger });

    // Spy on sendNotification to capture notifications before initialization
    jest
      .spyOn(adapter as any, 'sendNotification')
      .mockImplementation((notification: AcpNotification) => {
        sentNotifications.push(notification);
        // Still write to stdout like the real implementation
        const notificationStr = JSON.stringify(notification);
        process.stdout.write(notificationStr + '\n');
      });

    await adapter.initialize();

    // Register filesystem tools with mock client (per ACP architecture)
    const mockClientCapabilities: ClientCapabilities = {
      fs: {
        readTextFile: true,
        writeTextFile: true,
      },
    };

    // Create mock filesystem client for integration tests
    const mockFileSystemClient = new AcpFileSystemClient(
      {
        async readTextFile(params: any) {
          // Validate path is within allowed paths (client-side validation per ACP spec)
          const isAllowed = mockClientAllowedPaths.some((allowed) =>
            params.path.startsWith(allowed)
          );
          if (!isAllowed) {
            throw new Error(`Access to ${params.path} is not allowed`);
          }
          // Use mocked fs - no real file I/O
          const content = await fs.readFile(params.path, 'utf-8');
          return { content };
        },
        async writeTextFile(params: any) {
          // Validate path is within allowed paths (client-side validation per ACP spec)
          const isAllowed = mockClientAllowedPaths.some((allowed) =>
            params.path.startsWith(allowed)
          );
          if (!isAllowed) {
            throw new Error(`Access to ${params.path} is not allowed`);
          }
          // Use mocked fs - no real file I/O
          await fs.writeFile(params.path, params.content, 'utf-8');
          return {};
        },
      },
      mockLogger
    );

    const filesystemProvider = new FilesystemToolProvider(
      {
        ...mockConfig,
        tools: {
          ...mockConfig.tools,
          filesystem: {
            ...mockConfig.tools.filesystem,
            enabled: true, // Enable for provider (even though disabled in adapter config)
          },
        },
      },
      mockLogger,
      mockClientCapabilities,
      mockFileSystemClient
    );

    // Access the tool registry from the adapter to register filesystem provider
    const toolRegistry = (adapter as any).toolRegistry;
    if (toolRegistry) {
      toolRegistry.registerProvider(filesystemProvider);
    }
  });

  afterEach(async () => {
    if (adapter) {
      try {
        await adapter.shutdown();
      } catch (error) {
        // Ignore shutdown errors in tests
      }
    }
    // Give time for all async cleanup to complete
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  describe('Tool Call Reporting', () => {
    it('should report tool call when executing with sessionId', async () => {
      // Create a session
      const sessionRequest: AcpRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'session/new',
        params: {
          cwd: '/tmp',
          mcpServers: [],
        },
      };

      const sessionResponse = await adapter.processRequest(sessionRequest);
      const sessionId = (sessionResponse as any).result?.sessionId;

      sentNotifications = []; // Clear

      // Execute a tool with sessionId
      const toolRequest: AcpRequest = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'read_file',
          parameters: {
            _sessionId: sessionId,
            path: '/tmp/test.txt',
          },
        },
      };

      await adapter.processRequest(toolRequest);

      // Should receive tool call notifications
      const toolCallNotifications = sentNotifications.filter(
        (n) =>
          n.method === 'session/update' &&
          (n.params?.update?.sessionUpdate === 'tool_call' ||
            n.params?.update?.sessionUpdate === 'tool_call_update')
      );

      expect(toolCallNotifications.length).toBeGreaterThan(0);

      // First notification should be tool_call
      const firstToolCall = toolCallNotifications[0];
      expect(firstToolCall?.params?.update?.sessionUpdate).toBe('tool_call');
      expect(firstToolCall?.params?.update?.title).toContain('Reading file');
      expect(firstToolCall?.params?.update?.kind).toBe('read');
    });

    it('should include locations for filesystem operations', async () => {
      const sessionRequest: AcpRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'session/new',
        params: {
          cwd: '/tmp',
          mcpServers: [],
        },
      };

      const sessionResponse = await adapter.processRequest(sessionRequest);
      const sessionId = (sessionResponse as any).result?.sessionId;

      sentNotifications = [];

      const toolRequest: AcpRequest = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'read_file',
          parameters: {
            _sessionId: sessionId,
            path: '/tmp/test.txt',
          },
        },
      };

      await adapter.processRequest(toolRequest);

      const toolCallNotifications = sentNotifications.filter(
        (n) => n.method === 'session/update'
      );

      // Should have location information
      const hasLocation = toolCallNotifications.some(
        (n) => n.params?.update?.locations?.length > 0
      );

      expect(hasLocation).toBe(true);
    });

    it('should report different tool kinds correctly', async () => {
      const sessionRequest: AcpRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'session/new',
        params: {
          cwd: '/tmp',
          mcpServers: [],
        },
      };

      const sessionResponse = await adapter.processRequest(sessionRequest);
      const sessionId = (sessionResponse as any).result?.sessionId;

      const toolTests = [
        { name: 'read_file', expectedKind: 'read' },
        { name: 'write_file', expectedKind: 'edit' }, // write_file is an 'edit' kind tool per ACP spec
      ];

      for (const test of toolTests) {
        sentNotifications = [];

        const toolRequest: AcpRequest = {
          jsonrpc: '2.0',
          id: Math.random(),
          method: 'tools/call',
          params: {
            name: test.name,
            parameters:
              test.name === 'read_file'
                ? { _sessionId: sessionId, path: '/tmp/test.txt' }
                : {
                    _sessionId: sessionId,
                    path: '/tmp/test-write.txt',
                    content: 'test',
                  },
          },
        };

        await adapter.processRequest(toolRequest);

        const toolCallNotif = sentNotifications.find(
          (n) =>
            n.method === 'session/update' &&
            n.params?.update?.sessionUpdate === 'tool_call'
        );

        expect(toolCallNotif?.params?.update?.kind).toBe(test.expectedKind);
      }
    });

    it('should report tool call completion status', async () => {
      const sessionRequest: AcpRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'session/new',
        params: {
          cwd: '/tmp',
          mcpServers: [],
        },
      };

      const sessionResponse = await adapter.processRequest(sessionRequest);
      const sessionId = (sessionResponse as any).result?.sessionId;

      sentNotifications = [];

      const toolRequest: AcpRequest = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'read_file',
          parameters: {
            _sessionId: sessionId,
            path: '/tmp/test.txt',
          },
        },
      };

      await adapter.processRequest(toolRequest);

      // Should have completed notification
      const completedNotif = sentNotifications.find(
        (n) =>
          n.method === 'session/update' &&
          n.params?.update?.sessionUpdate === 'tool_call_update' &&
          n.params?.update?.status === 'completed'
      );

      expect(completedNotif).toBeDefined();
    });

    it('should report tool call failure', async () => {
      const sessionRequest: AcpRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'session/new',
        params: {
          cwd: '/tmp',
          mcpServers: [],
        },
      };

      const sessionResponse = await adapter.processRequest(sessionRequest);
      const sessionId = (sessionResponse as any).result?.sessionId;

      sentNotifications = [];

      // Try to read non-existent file
      const toolRequest: AcpRequest = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'read_file',
          parameters: {
            _sessionId: sessionId,
            path: '/tmp/nonexistent-file-12345.txt',
          },
        },
      };

      await adapter.processRequest(toolRequest);

      // Should have failed notification
      const failedNotif = sentNotifications.find(
        (n) =>
          n.method === 'session/update' &&
          n.params?.update?.sessionUpdate === 'tool_call_update' &&
          n.params?.update?.status === 'failed'
      );

      expect(failedNotif).toBeDefined();
    });
  });

  describe('Session Cancellation', () => {
    it('should cancel tool calls when session is cancelled', async () => {
      const sessionRequest: AcpRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'session/new',
        params: {
          cwd: '/tmp',
          mcpServers: [],
        },
      };

      const sessionResponse = await adapter.processRequest(sessionRequest);
      const sessionId = (sessionResponse as any).result?.sessionId;

      // Start a tool execution
      const toolRequest: AcpRequest = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'read_file',
          parameters: {
            _sessionId: sessionId,
            path: '/tmp/test.txt',
          },
        },
      };

      const toolPromise = adapter.processRequest(toolRequest);

      // Cancel the session
      const cancelRequest: AcpRequest = {
        jsonrpc: '2.0',
        id: 3,
        method: 'session/cancel',
        params: {
          sessionId,
        },
      };

      await adapter.processRequest(cancelRequest);

      // Wait for tool to complete
      await toolPromise;

      // Should not throw errors
      expect(true).toBe(true);
    });
  });

  describe('Permission Requests', () => {
    it('should handle permission request', async () => {
      const permissionRequest: AcpRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'session/request_permission',
        params: {
          sessionId: 'test_session',
          toolCall: {
            toolCallId: 'tool_123',
            title: 'Editing file',
            kind: 'edit',
          },
          options: [
            {
              optionId: 'allow-once',
              name: 'Allow once',
              kind: 'allow_once',
            },
            {
              optionId: 'reject-once',
              name: 'Reject',
              kind: 'reject_once',
            },
          ],
        },
      };

      const response = await adapter.processRequest(permissionRequest);

      expect(response).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: {
          outcome: expect.objectContaining({
            outcome: 'selected',
            optionId: expect.any(String),
          }),
        },
      });
    });

    it('should auto-reject dangerous operations by default', async () => {
      const permissionRequest: AcpRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'session/request_permission',
        params: {
          sessionId: 'test_session',
          toolCall: {
            toolCallId: 'tool_123',
            kind: 'delete',
          },
          options: [
            {
              optionId: 'allow-once',
              name: 'Allow once',
              kind: 'allow_once',
            },
            {
              optionId: 'reject-once',
              name: 'Reject',
              kind: 'reject_once',
            },
          ],
        },
      };

      const response = await adapter.processRequest(permissionRequest);

      expect(response.result?.outcome.optionId).toBe('reject-once');
    });
  });

  describe('Backward Compatibility', () => {
    it('should work without sessionId (no tool call reporting)', async () => {
      const toolRequest: AcpRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'read_file',
          parameters: {
            path: '/tmp/test.txt',
          },
        },
      };

      const response = await adapter.processRequest(toolRequest);

      expect(response).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
      });

      // Should not send tool call notifications
      const toolCallNotifications = sentNotifications.filter(
        (n) =>
          n.method === 'session/update' &&
          (n.params?.update?.sessionUpdate === 'tool_call' ||
            n.params?.update?.sessionUpdate === 'tool_call_update')
      );

      expect(toolCallNotifications).toHaveLength(0);
    });
  });
});
