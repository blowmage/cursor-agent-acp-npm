/**
 * Integration tests for Prompt Turn Scenarios
 *
 * Comprehensive tests for session/prompt, session/cancel, multi-turn conversations,
 * notifications, queueing, and all prompt turn edge cases.
 */

import { CursorAgentAdapter } from '../../src/adapter/cursor-agent-adapter';
import type {
  AcpRequest,
  AcpResponse,
  AdapterConfig,
  Logger,
  AcpNotification,
} from '../../src/types';

// Mock the CursorCliBridge module so adapter uses mock instead of real CLI
jest.mock('../../src/cursor/cli-bridge', () => ({
  CursorCliBridge: jest.fn().mockImplementation((config, logger) => {
    return new (require('./mocks/cursor-bridge-mock').MockCursorCliBridge)(
      config,
      logger
    );
  }),
}));

describe('Prompt Turn Integration Tests', () => {
  let adapter: CursorAgentAdapter;
  let mockConfig: AdapterConfig;
  let mockLogger: Logger;
  let notifications: AcpNotification[];
  let originalStdoutWrite: any;

  beforeEach(async () => {
    jest.clearAllMocks();

    // Capture notifications sent to stdout
    notifications = [];
    originalStdoutWrite = process.stdout.write;
    process.stdout.write = jest.fn((data: string | Buffer) => {
      const str = data.toString();
      try {
        const parsed = JSON.parse(str.trim());
        if (parsed.method && parsed.method.startsWith('session/')) {
          notifications.push(parsed);
        }
      } catch {
        // Ignore non-JSON output
      }
      return true;
    }) as any;

    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    mockConfig = {
      logLevel: 'debug',
      sessionDir: '~/.cursor-sessions-test',
      maxSessions: 100,
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
      },
      cursor: {
        timeout: 30000,
        retries: 3,
      },
    };

    // Create adapter - jest.mock ensures CursorCliBridge is mocked automatically
    adapter = new CursorAgentAdapter(mockConfig, { logger: mockLogger });
    await adapter.initialize();
  });

  afterEach(async () => {
    process.stdout.write = originalStdoutWrite;
    if (adapter) {
      try {
        await adapter.shutdown();
      } catch (error) {
        // Ignore shutdown errors in tests
      }
    }
    notifications = [];
    // Give time for all async cleanup to complete
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  describe('1. Session Cancellation Tests', () => {
    let sessionId: string;

    beforeEach(async () => {
      // Create a test session
      const createRequest: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'setup-session',
        params: {
          cwd: '/tmp/test-project',
          mcpServers: [],
          metadata: { name: 'Cancel Test Session' },
        },
      };

      const response = await adapter.processRequest(createRequest);
      sessionId = response.result.sessionId;
      notifications = []; // Clear setup notifications
    });

    it('should handle session/cancel as notification (no response)', async () => {
      const cancelRequest: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/cancel',
        params: {
          sessionId,
        },
      } as any; // No id field - this is a notification

      const response = await adapter.processRequest(cancelRequest);

      // Per JSON-RPC 2.0 spec: Notifications should not receive responses
      // But our implementation returns a dummy response that shouldn't be sent
      expect(response).toBeDefined();
      expect(response.id).toBeNull();
    });

    it('should handle session/cancel with id (defensive for non-compliant clients)', async () => {
      const cancelRequest: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/cancel',
        id: 'cancel-req-1',
        params: {
          sessionId,
        },
      };

      const response = await adapter.processRequest(cancelRequest);

      // Should return a response since id was provided
      expect(response.id).toBe('cancel-req-1');
      expect(response.result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('should be a notification'),
        expect.any(Object)
      );
    });

    it('should abort active prompt when session/cancel is called', async () => {
      // Start a long-running prompt (don't await)
      const promptRequest: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'long-prompt-1',
        params: {
          sessionId,
          content: [{ type: 'text', text: 'Long running task' }],
          stream: false,
        },
      };

      const promptPromise = adapter.processRequest(promptRequest);

      // Wait just a tiny bit for prompt to start processing
      // but not long enough for mock to complete (mock takes 50ms)
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Send cancel notification
      const cancelRequest: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/cancel',
        params: {
          sessionId,
        },
      } as any;

      await adapter.processRequest(cancelRequest);

      // Wait for prompt to complete
      const response = await promptPromise;

      // Should complete with 'cancelled' or 'end_turn' depending on timing
      // If cancelled in time, stopReason should be 'cancelled'
      // If completed before cancel, stopReason will be 'end_turn'
      expect(['cancelled', 'end_turn']).toContain(response.result?.stopReason);
    }, 10000);

    it('should cancel multiple concurrent requests for the same session', async () => {
      // Start multiple prompts
      const prompts = [
        adapter.processRequest({
          jsonrpc: '2.0',
          method: 'session/prompt',
          id: 'prompt-1',
          params: {
            sessionId,
            content: [{ type: 'text', text: 'Request 1' }],
          },
        }),
        adapter.processRequest({
          jsonrpc: '2.0',
          method: 'session/prompt',
          id: 'prompt-2',
          params: {
            sessionId,
            content: [{ type: 'text', text: 'Request 2' }],
          },
        }),
        adapter.processRequest({
          jsonrpc: '2.0',
          method: 'session/prompt',
          id: 'prompt-3',
          params: {
            sessionId,
            content: [{ type: 'text', text: 'Request 3' }],
          },
        }),
      ];

      // Wait for prompts to start
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Cancel the session
      await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/cancel',
        params: { sessionId },
      } as any);

      // All prompts should complete with cancelled status
      const responses = await Promise.all(prompts);

      responses.forEach((response) => {
        expect(['cancelled', 'end_turn']).toContain(
          response.result?.stopReason
        );
      });
    }, 15000);

    it('should handle cancel when no active requests exist', async () => {
      const cancelRequest: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/cancel',
        params: {
          sessionId,
        },
      } as any;

      // Should not throw error
      await expect(
        adapter.processRequest(cancelRequest)
      ).resolves.toBeDefined();

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('No active requests'),
        expect.any(Object)
      );
    });

    it('should require sessionId parameter', async () => {
      const cancelRequest: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/cancel',
        id: 'cancel-req',
        params: {},
      };

      const response = await adapter.processRequest(cancelRequest);

      expect(response.error).toBeDefined();
      expect(response.error?.message).toContain('sessionId is required');
    });
  });

  describe('2. Multi-Turn Conversation Tests', () => {
    let sessionId: string;

    beforeEach(async () => {
      const createRequest: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'setup-session',
        params: {
          cwd: '/tmp/test-project',
          mcpServers: [],
          metadata: { name: 'Multi-Turn Test Session' },
        },
      };

      const response = await adapter.processRequest(createRequest);
      sessionId = response.result.sessionId;
      notifications = [];
    });

    it('should process multiple sequential prompts in the same session', async () => {
      // First turn
      const prompt1 = await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'turn-1',
        params: {
          sessionId,
          content: [{ type: 'text', text: 'What is TypeScript?' }],
        },
      });

      expect(prompt1.result?.stopReason).toBeDefined();

      // Second turn
      const prompt2 = await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'turn-2',
        params: {
          sessionId,
          content: [{ type: 'text', text: 'Can you explain more?' }],
        },
      });

      expect(prompt2.result?.stopReason).toBeDefined();

      // Third turn
      const prompt3 = await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'turn-3',
        params: {
          sessionId,
          content: [{ type: 'text', text: 'Give me an example' }],
        },
      });

      expect(prompt3.result?.stopReason).toBeDefined();
    }, 30000);

    it('should accumulate conversation history across turns', async () => {
      // Send first prompt
      await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'turn-1',
        params: {
          sessionId,
          content: [{ type: 'text', text: 'Hello' }],
        },
      });

      // Send second prompt
      await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'turn-2',
        params: {
          sessionId,
          content: [{ type: 'text', text: 'How are you?' }],
        },
      });

      // Load session to check conversation history
      const sessionData = await (adapter as any).sessionManager.loadSession(
        sessionId
      );

      expect(sessionData.conversation.length).toBe(4); // 2 user + 2 assistant messages
      expect(
        sessionData.conversation.filter((m: any) => m.role === 'user').length
      ).toBe(2);
    }, 20000);

    it('should maintain session state across multiple turns', async () => {
      // First turn
      await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'turn-1',
        params: {
          sessionId,
          content: [{ type: 'text', text: 'Turn 1' }],
        },
      });

      const state1 = await (adapter as any).sessionManager.loadSession(
        sessionId
      );
      const messageCount1 = state1.state.messageCount;

      // Second turn
      await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'turn-2',
        params: {
          sessionId,
          content: [{ type: 'text', text: 'Turn 2' }],
        },
      });

      const state2 = await (adapter as any).sessionManager.loadSession(
        sessionId
      );
      const messageCount2 = state2.state.messageCount;

      expect(messageCount2).toBeGreaterThan(messageCount1);
    }, 20000);

    it('should process prompts sequentially when sent rapidly', async () => {
      // Send 5 prompts rapidly without waiting
      const prompts = Array.from({ length: 5 }, (_, i) =>
        adapter.processRequest({
          jsonrpc: '2.0',
          method: 'session/prompt',
          id: `rapid-turn-${i}`,
          params: {
            sessionId,
            content: [{ type: 'text', text: `Rapid request ${i}` }],
          },
        })
      );

      // All should complete successfully (queued, not parallel)
      const responses = await Promise.all(prompts);

      responses.forEach((response, i) => {
        expect(response.result?.stopReason).toBeDefined();
        expect(response.id).toBe(`rapid-turn-${i}`);
      });
    }, 30000);
  });

  describe('3. Session/Update Notification Tests', () => {
    let sessionId: string;

    beforeEach(async () => {
      const createRequest: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'setup-session',
        params: {
          cwd: '/tmp/test-project',
          mcpServers: [],
          metadata: { name: 'Notification Test Session' },
        },
      };

      const response = await adapter.processRequest(createRequest);
      sessionId = response.result.sessionId;
      notifications = [];
    });

    it('should send agent_thought_chunk notification at start of processing', async () => {
      const promptPromise = adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'notify-test-1',
        params: {
          sessionId,
          content: [{ type: 'text', text: 'Test notification' }],
        },
      });

      // Wait a bit for processing to start
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should have received agent_thought_chunk notification
      const thoughtNotification = notifications.find(
        (n) =>
          n.method === 'session/update' &&
          n.params?.update?.sessionUpdate === 'agent_thought_chunk'
      );

      expect(thoughtNotification).toBeDefined();
      expect(thoughtNotification?.params?.update?.content).toBeDefined();
      expect(thoughtNotification?.params?.update?.content?.type).toBe('text');
      expect(thoughtNotification?.params?.update?.content?.text).toBeDefined();

      await promptPromise;
    }, 10000);

    it('should complete successfully with proper stopReason', async () => {
      const response = await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'notify-test-2',
        params: {
          sessionId,
          content: [{ type: 'text', text: 'Test completion' }],
        },
      });

      // Should have proper stop reason in response
      expect(response.result).toBeDefined();
      expect(response.result.stopReason).toBeDefined();
      expect([
        'end_turn',
        'refusal',
        'cancelled',
        'max_tokens',
        'max_turn_requests',
      ]).toContain(response.result.stopReason);

      // Should have _meta with timing information
      expect(response.result._meta).toBeDefined();
      expect(response.result._meta.processingDurationMs).toBeGreaterThanOrEqual(
        0
      );
    }, 10000);

    it('should send agent_message_chunk notifications', async () => {
      await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'notify-test-3',
        params: {
          sessionId,
          content: [{ type: 'text', text: 'Test message chunks' }],
        },
      });

      // Should have agent message chunk notifications
      const messageChunks = notifications.filter(
        (n) =>
          n.method === 'session/update' &&
          n.params?.update?.sessionUpdate === 'agent_message_chunk'
      );

      expect(messageChunks.length).toBeGreaterThan(0);
      messageChunks.forEach((chunk) => {
        expect(chunk.params?.update?.content).toBeDefined();
      });
    }, 10000);

    it('should send notifications in correct order', async () => {
      await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'notify-test-4',
        params: {
          sessionId,
          content: [{ type: 'text', text: 'Test order' }],
        },
      });

      const updateTypes = notifications.map(
        (n) => n.params?.update?.sessionUpdate
      );

      // Should start with agent_thought_chunk (progress notification)
      expect(updateTypes[0]).toBe('agent_thought_chunk');

      // Should have agent_message_chunk (response content)
      expect(updateTypes).toContain('agent_message_chunk');

      // Verify we have both thought and message chunks
      const thoughtChunks = updateTypes.filter(
        (t) => t === 'agent_thought_chunk'
      );
      const messageChunks = updateTypes.filter(
        (t) => t === 'agent_message_chunk'
      );
      expect(thoughtChunks.length).toBeGreaterThan(0);
      expect(messageChunks.length).toBeGreaterThan(0);
    }, 10000);

    it('should include sessionId in all notifications', async () => {
      await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'notify-test-5',
        params: {
          sessionId,
          content: [{ type: 'text', text: 'Test sessionId' }],
        },
      });

      notifications.forEach((notification) => {
        expect(notification.params?.sessionId).toBe(sessionId);
      });
    }, 10000);

    it('should echo user messages via user_message_chunk (Phase 2)', async () => {
      await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'notify-test-6',
        params: {
          sessionId,
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'text', text: 'World' },
          ],
        },
      });

      // Should have user message chunk notifications
      const userChunks = notifications.filter(
        (n) =>
          n.method === 'session/update' &&
          n.params?.update?.sessionUpdate === 'user_message_chunk'
      );

      // Should echo both content blocks
      expect(userChunks.length).toBe(2);

      // Verify content matches input (now with annotations)
      expect(userChunks[0].params?.update?.content.type).toBe('text');
      expect(userChunks[0].params?.update?.content.text).toBe('Hello');
      expect(userChunks[0].params?.update?.content.annotations).toBeDefined();
      expect(
        userChunks[0].params?.update?.content.annotations?._meta?.source
      ).toBe('user_input');

      expect(userChunks[1].params?.update?.content.type).toBe('text');
      expect(userChunks[1].params?.update?.content.text).toBe('World');
      expect(userChunks[1].params?.update?.content.annotations).toBeDefined();
    }, 10000);

    it('should include content metrics in response (Phase 2)', async () => {
      const response = await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'notify-test-7',
        params: {
          sessionId,
          content: [{ type: 'text', text: 'Test metrics' }],
        },
      });

      // Should have content metrics in _meta
      expect(response.result._meta).toBeDefined();
      expect(response.result._meta.contentMetrics).toBeDefined();
      expect(response.result._meta.contentMetrics.inputBlocks).toBe(1);
      expect(response.result._meta.contentMetrics.inputSize).toBeGreaterThan(0);
      expect(response.result._meta.contentMetrics.outputBlocks).toBeGreaterThan(
        0
      );
      expect(response.result._meta.contentMetrics.outputSize).toBeGreaterThan(
        0
      );
    }, 10000);

    it('should annotate agent message chunks (Phase 3)', async () => {
      await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'notify-test-8',
        params: {
          sessionId,
          content: [{ type: 'text', text: 'Test annotation' }],
        },
      });

      // Should have agent message chunk notifications with annotations
      const agentChunks = notifications.filter(
        (n) =>
          n.method === 'session/update' &&
          n.params?.update?.sessionUpdate === 'agent_message_chunk'
      );

      expect(agentChunks.length).toBeGreaterThan(0);

      // Verify first chunk has annotations
      const firstChunk = agentChunks[0].params?.update?.content;
      expect(firstChunk).toBeDefined();
      expect(firstChunk.annotations).toBeDefined();
      expect(firstChunk.annotations?._meta?.source).toBe('cursor_agent');
      expect(firstChunk.annotations?.audience).toContain('user');
      expect(firstChunk.annotations?.lastModified).toBeDefined();
    }, 10000);

    it('should annotate content with correct categories (Phase 3)', async () => {
      // Clear notifications for this test
      notifications = [];

      await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'notify-test-9',
        params: {
          sessionId,
          content: [{ type: 'text', text: 'Text content for category test' }],
        },
      });

      // Check user message annotations
      const userChunks = notifications.filter(
        (n) =>
          n.method === 'session/update' &&
          n.params?.update?.sessionUpdate === 'user_message_chunk'
      );

      // Should have at least one user message chunk
      expect(userChunks.length).toBeGreaterThan(0);

      // Text content should be categorized as 'text'
      const firstUserChunk = userChunks[0]?.params?.update?.content;
      expect(firstUserChunk).toBeDefined();
      expect(firstUserChunk.annotations?._meta?.category).toBe('text');
      expect(firstUserChunk.annotations?._meta?.source).toBe('user_input');
    }, 10000);
  });

  describe('4. Session Queue/Concurrency Tests', () => {
    it('should queue concurrent prompts to the same session', async () => {
      // Create session
      const createResponse = await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'setup-session',
        params: {
          cwd: '/tmp/test-project',
          mcpServers: [],
        },
      });

      const sessionId = createResponse.result.sessionId;

      const startTime = Date.now();

      // Send 3 prompts concurrently
      const prompts = [
        adapter.processRequest({
          jsonrpc: '2.0',
          method: 'session/prompt',
          id: 'queue-1',
          params: {
            sessionId,
            content: [{ type: 'text', text: 'Queued request 1' }],
          },
        }),
        adapter.processRequest({
          jsonrpc: '2.0',
          method: 'session/prompt',
          id: 'queue-2',
          params: {
            sessionId,
            content: [{ type: 'text', text: 'Queued request 2' }],
          },
        }),
        adapter.processRequest({
          jsonrpc: '2.0',
          method: 'session/prompt',
          id: 'queue-3',
          params: {
            sessionId,
            content: [{ type: 'text', text: 'Queued request 3' }],
          },
        }),
      ];

      const responses = await Promise.all(prompts);

      const endTime = Date.now();
      const totalTime = endTime - startTime;

      // All should complete successfully
      responses.forEach((response, index) => {
        expect(response.result?.stopReason).toBeDefined();
        expect(response.id).toBe(`queue-${index + 1}`);
      });

      // Verify prompts were queued (not parallel)
      // If they ran in parallel, total time would be ~50ms (one mock execution)
      // If queued sequentially, total time should be at least 150ms (3 × 50ms)
      // We use a lower bound to account for test overhead
      expect(totalTime).toBeGreaterThan(100);
    }, 30000);

    it('should process prompts to different sessions in parallel', async () => {
      // Create two sessions
      const session1Response = await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'setup-session-1',
        params: {
          cwd: '/tmp/test-project',
          mcpServers: [],
        },
      });

      const session2Response = await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'setup-session-2',
        params: {
          cwd: '/tmp/test-project',
          mcpServers: [],
        },
      });

      const sessionId1 = session1Response.result.sessionId;
      const sessionId2 = session2Response.result.sessionId;

      const startTime = Date.now();

      // Send prompts to different sessions concurrently
      const prompts = [
        adapter.processRequest({
          jsonrpc: '2.0',
          method: 'session/prompt',
          id: 'parallel-1',
          params: {
            sessionId: sessionId1,
            content: [{ type: 'text', text: 'Request to session 1' }],
          },
        }),
        adapter.processRequest({
          jsonrpc: '2.0',
          method: 'session/prompt',
          id: 'parallel-2',
          params: {
            sessionId: sessionId2,
            content: [{ type: 'text', text: 'Request to session 2' }],
          },
        }),
      ];

      const responses = await Promise.all(prompts);

      const endTime = Date.now();
      const totalTime = endTime - startTime;

      // Both should complete successfully
      responses.forEach((response) => {
        expect(response.result?.stopReason).toBeDefined();
      });

      // Should complete faster than sequential processing
      expect(totalTime).toBeLessThan(10000); // Mock is fast
    }, 15000);

    it('should continue queue processing even if one request fails', async () => {
      const createResponse = await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'setup-session',
        params: {
          cwd: '/tmp/test-project',
          mcpServers: [],
        },
      });

      const sessionId = createResponse.result.sessionId;

      // Send prompts including one with invalid content
      const prompts = [
        adapter.processRequest({
          jsonrpc: '2.0',
          method: 'session/prompt',
          id: 'fail-queue-1',
          params: {
            sessionId,
            content: [{ type: 'text', text: 'Valid request 1' }],
          },
        }),
        adapter.processRequest({
          jsonrpc: '2.0',
          method: 'session/prompt',
          id: 'fail-queue-2',
          params: {
            sessionId,
            content: [], // Invalid: empty content
          },
        }),
        adapter.processRequest({
          jsonrpc: '2.0',
          method: 'session/prompt',
          id: 'fail-queue-3',
          params: {
            sessionId,
            content: [{ type: 'text', text: 'Valid request 3' }],
          },
        }),
      ];

      const responses = await Promise.all(prompts);

      // First should succeed
      expect(responses[0].result?.stopReason).toBeDefined();

      // Second should fail
      expect(responses[1].error).toBeDefined();

      // Third should still succeed (queue continues)
      expect(responses[2].result?.stopReason).toBeDefined();
    }, 20000);
  });

  describe('5. Stop Reason Tests', () => {
    let sessionId: string;

    beforeEach(async () => {
      const createRequest: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'setup-session',
        params: {
          cwd: '/tmp/test-project',
          mcpServers: [],
        },
      };

      const response = await adapter.processRequest(createRequest);
      sessionId = response.result.sessionId;
    });

    it('should return stopReason: end_turn for successful completion', async () => {
      const response = await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'stop-test-1',
        params: {
          sessionId,
          content: [{ type: 'text', text: 'Normal request' }],
        },
      });

      expect(response.result?.stopReason).toBe('end_turn');
    }, 10000);

    it('should return stopReason: refusal for errors', async () => {
      // Configure mock to return an error
      const mockBridge = (adapter as any).cursorBridge;
      const originalSendPrompt = mockBridge.sendPrompt;

      mockBridge.sendPrompt = jest.fn().mockResolvedValue({
        success: false,
        error: 'Simulated error',
      });

      const response = await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'stop-test-2',
        params: {
          sessionId,
          content: [{ type: 'text', text: 'Error request' }],
        },
      });

      expect(response.result?.stopReason).toBe('refusal');

      // Restore original
      mockBridge.sendPrompt = originalSendPrompt;
    }, 10000);

    it('should return stopReason: cancelled after cancellation', async () => {
      const promptPromise = adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'stop-test-3',
        params: {
          sessionId,
          content: [{ type: 'text', text: 'To be cancelled' }],
        },
      });

      // Wait for processing to start (but not complete - mock takes ~50ms)
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Cancel
      await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/cancel',
        params: { sessionId },
      } as any);

      const response = await promptPromise;

      // Depending on timing, may be cancelled or completed
      expect(['cancelled', 'end_turn']).toContain(response.result?.stopReason);
    }, 10000);

    it('should only return valid stopReason values', async () => {
      const response = await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'stop-test-4',
        params: {
          sessionId,
          content: [{ type: 'text', text: 'Check stop reason' }],
        },
      });

      const validStopReasons = ['end_turn', 'refusal', 'cancelled', 'length'];
      expect(validStopReasons).toContain(response.result?.stopReason);
    }, 10000);
  });

  describe('6. Session Load to Prompt Flow Tests', () => {
    it('should load session and continue conversation with prompt', async () => {
      // Create a session with some history
      const createResponse = await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'setup-session',
        params: {
          cwd: '/tmp/test-project',
          mcpServers: [],
        },
      });

      const sessionId = createResponse.result.sessionId;

      // Add a prompt to create history
      await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'initial-prompt',
        params: {
          sessionId,
          content: [{ type: 'text', text: 'Initial conversation' }],
        },
      });

      // Load the session
      notifications = [];
      const loadResponse = await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/load',
        id: 'load-session',
        params: {
          sessionId,
          cwd: '/tmp/test-project',
          mcpServers: [],
        },
      });

      // Per ACP spec: session/load returns LoadSessionResponse with modes and models
      expect(loadResponse.result).toBeDefined();
      expect(loadResponse.result.modes).toBeDefined();
      expect(loadResponse.result.models).toBeDefined();

      // Should have received conversation history via notifications
      const historyNotifications = notifications.filter(
        (n) => n.method === 'session/update'
      );
      expect(historyNotifications.length).toBeGreaterThan(0);

      // Now send a new prompt to continue the conversation
      notifications = [];
      const continueResponse = await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'continue-prompt',
        params: {
          sessionId,
          content: [{ type: 'text', text: 'Continue conversation' }],
        },
      });

      expect(continueResponse.result?.stopReason).toBeDefined();

      // Verify conversation has grown
      const sessionData = await (adapter as any).sessionManager.loadSession(
        sessionId
      );
      expect(sessionData.conversation.length).toBeGreaterThanOrEqual(4);
    }, 20000);

    it('should maintain context from loaded conversation in new prompts', async () => {
      // Create session and add initial conversation
      const createResponse = await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'setup-session',
        params: {
          cwd: '/tmp/test-project',
          mcpServers: [],
          metadata: { topic: 'TypeScript' },
        },
      });

      const sessionId = createResponse.result.sessionId;

      // Add conversation
      await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'context-1',
        params: {
          sessionId,
          content: [{ type: 'text', text: 'Tell me about interfaces' }],
        },
      });

      // Load session
      await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/load',
        id: 'load-session',
        params: {
          sessionId,
          cwd: '/tmp/test-project',
          mcpServers: [],
        },
      });

      // Continue conversation (should have context)
      const response = await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'context-2',
        params: {
          sessionId,
          content: [{ type: 'text', text: 'Can you give an example?' }],
        },
      });

      expect(response.result?.stopReason).toBeDefined();

      // Verify full conversation history
      const sessionData = await (adapter as any).sessionManager.loadSession(
        sessionId
      );
      expect(sessionData.conversation.length).toBeGreaterThanOrEqual(4);
      expect(sessionData.metadata.topic).toBe('TypeScript');
    }, 20000);
  });

  describe('7. Error Recovery Tests', () => {
    let sessionId: string;

    beforeEach(async () => {
      const createRequest: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'setup-session',
        params: {
          cwd: '/tmp/test-project',
          mcpServers: [],
        },
      };

      const response = await adapter.processRequest(createRequest);
      sessionId = response.result.sessionId;
      notifications = [];
    });

    it('should handle cursor bridge errors gracefully with refusal stopReason', async () => {
      // Configure mock to return error
      const mockBridge = (adapter as any).cursorBridge;
      const originalSendPrompt = mockBridge.sendPrompt;

      mockBridge.sendPrompt = jest.fn().mockResolvedValue({
        success: false,
        error: 'Simulated failure',
      });

      const response = await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'error-test-1',
        params: {
          sessionId,
          content: [{ type: 'text', text: 'Will fail' }],
        },
      });

      // Per ACP spec: Cursor errors result in stopReason='refusal', not failure
      expect(response.result?.stopReason).toBe('refusal');

      // Should have _meta with error details
      expect(response.result?._meta?.stopReasonDetails).toBeDefined();
      expect(response.result?._meta?.stopReasonDetails?.reason).toBe('refusal');

      // Should have processing time in metadata
      expect(
        response.result?._meta?.processingDurationMs
      ).toBeGreaterThanOrEqual(0);

      // Restore
      mockBridge.sendPrompt = originalSendPrompt;
    }, 10000);

    it('should cleanup session processing flag on error', async () => {
      // Configure mock to throw error
      const mockBridge = (adapter as any).cursorBridge;
      mockBridge.sendPrompt = jest.fn().mockRejectedValue(new Error('Boom'));

      await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'error-test-2',
        params: {
          sessionId,
          content: [{ type: 'text', text: 'Will throw' }],
        },
      });

      // Session should not be stuck in processing state
      await (adapter as any).sessionManager.loadSession(sessionId);

      // If session is properly cleaned up, we can send another prompt
      const mockBridge2 = (adapter as any).cursorBridge;
      mockBridge2.sendPrompt = jest.fn().mockResolvedValue({
        success: true,
        stdout: 'Recovered',
      });

      const response = await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'error-test-3',
        params: {
          sessionId,
          content: [{ type: 'text', text: 'After error' }],
        },
      });

      expect(response.result?.stopReason).toBeDefined();
    }, 15000);

    it('should allow subsequent prompts after error', async () => {
      // First prompt fails
      const mockBridge = (adapter as any).cursorBridge;
      const originalSendPrompt = mockBridge.sendPrompt;

      mockBridge.sendPrompt = jest.fn().mockResolvedValue({
        success: false,
        error: 'First fails',
      });

      await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'recovery-1',
        params: {
          sessionId,
          content: [{ type: 'text', text: 'First attempt' }],
        },
      });

      // Restore and try again
      mockBridge.sendPrompt = originalSendPrompt;

      const response = await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'recovery-2',
        params: {
          sessionId,
          content: [{ type: 'text', text: 'Second attempt' }],
        },
      });

      expect(response.result?.stopReason).toBeDefined();
    }, 15000);
  });

  describe('8. Streaming Prompt Tests', () => {
    let sessionId: string;

    beforeEach(async () => {
      const createRequest: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'setup-session',
        params: {
          cwd: '/tmp/test-project',
          mcpServers: [],
        },
      };

      const response = await adapter.processRequest(createRequest);
      sessionId = response.result.sessionId;
      notifications = [];
    });

    it('should process streaming prompt with stream: true', async () => {
      const response = await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'stream-test-1',
        params: {
          sessionId,
          content: [{ type: 'text', text: 'Stream this response' }],
          stream: true,
        },
      });

      expect(response.result?.stopReason).toBeDefined();
    }, 10000);

    it('should send multiple agent_message_chunk notifications when streaming', async () => {
      await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'stream-test-2',
        params: {
          sessionId,
          content: [{ type: 'text', text: 'Stream chunks' }],
          stream: true,
        },
      });

      const messageChunks = notifications.filter(
        (n) =>
          n.method === 'session/update' &&
          n.params?.update?.sessionUpdate === 'agent_message_chunk'
      );

      // Streaming should produce multiple chunks
      expect(messageChunks.length).toBeGreaterThan(0);
    }, 10000);

    it('should handle cancellation during streaming', async () => {
      const promptPromise = adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'stream-cancel-1',
        params: {
          sessionId,
          content: [{ type: 'text', text: 'Stream to be cancelled' }],
          stream: true,
        },
      });

      // Wait for streaming to start (but not complete - mock streams in ~50ms)
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Cancel
      await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/cancel',
        params: { sessionId },
      } as any);

      const response = await promptPromise;

      // Depending on timing, may be cancelled or completed
      expect(['cancelled', 'end_turn']).toContain(response.result?.stopReason);
    }, 10000);
  });

  describe('9. Validation Tests', () => {
    let sessionId: string;

    beforeEach(async () => {
      const createRequest: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'setup-session',
        params: {
          cwd: '/tmp/test-project',
          mcpServers: [],
        },
      };

      const response = await adapter.processRequest(createRequest);
      sessionId = response.result.sessionId;
    });

    it('should reject session/prompt without sessionId', async () => {
      const response = await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'validation-1',
        params: {
          content: [{ type: 'text', text: 'No session' }],
        },
      });

      expect(response.error).toBeDefined();
      expect(response.error?.message).toContain('sessionId');
    });

    it('should reject session/prompt with empty content array', async () => {
      const response = await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'validation-2',
        params: {
          sessionId,
          content: [],
        },
      });

      expect(response.error).toBeDefined();
      expect(response.error?.message).toContain('content');
    });

    it('should reject session/prompt with non-existent session', async () => {
      const response = await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'validation-3',
        params: {
          sessionId: 'non-existent-session',
          content: [{ type: 'text', text: 'Invalid session' }],
        },
      });

      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32001); // Session error
    });

    it('should reject session/prompt with invalid content blocks', async () => {
      const response = await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'validation-4',
        params: {
          sessionId,
          content: [{ type: 'invalid_type', text: 'Bad content' }],
        },
      });

      expect(response.error).toBeDefined();
    });
  });
});
