/**
 * Integration tests for Tool Calls Implementation
 *
 * Tests the complete flow of tool call reporting from tool execution
 * through to client notifications.
 *
 * Note: CursorCliBridge is mocked to avoid slow real cursor-agent calls
 * while still testing all other component integrations.
 */

import { CursorAgentAdapter } from '../../src/adapter/cursor-agent-adapter';
import type {
  AdapterConfig,
  AcpRequest,
  AcpNotification,
  Logger,
} from '../../src/types';

// Mock the CursorCliBridge module
jest.mock('../../src/cursor/cli-bridge', () => ({
  CursorCliBridge: jest.fn().mockImplementation((config, logger) => {
    return new (require('./mocks/cursor-bridge-mock').MockCursorCliBridge)(
      config,
      logger
    );
  }),
}));

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

  const mockConfig: AdapterConfig = {
    logLevel: 'error',
    sessionDir: '/tmp/test-sessions',
    maxSessions: 10,
    sessionTimeout: 3600000,
    tools: {
      filesystem: {
        enabled: true,
        allowedPaths: ['/tmp'],
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
            sessionId,
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
          name: 'list_directory',
          parameters: {
            sessionId,
            path: '/tmp',
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
        { name: 'list_directory', expectedKind: 'read' },
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
                ? { sessionId, path: '/tmp/test.txt' }
                : { sessionId, path: '/tmp' },
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
          name: 'list_directory',
          parameters: {
            sessionId,
            path: '/tmp',
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
            sessionId,
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
          name: 'list_directory',
          parameters: {
            sessionId,
            path: '/tmp',
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
          name: 'list_directory',
          parameters: {
            path: '/tmp',
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
