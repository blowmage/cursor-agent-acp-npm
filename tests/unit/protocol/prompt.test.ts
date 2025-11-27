/**
 * Unit tests for PromptHandler
 */

import { PromptHandler } from '../../../src/protocol/prompt';
import { ContentProcessor } from '../../../src/protocol/content';
import { SlashCommandsRegistry } from '../../../src/tools/slash-commands';
import type {
  AcpRequest,
  SessionPromptParams,
  ContentBlock,
  ConversationMessage,
  StreamChunk,
  StreamProgress,
  Logger,
  AdapterConfig,
} from '../../../src/types';
import { ProtocolError, SessionError } from '../../../src/types';
import type { PlanEntry, SessionNotification } from '@agentclientprotocol/sdk';

// Mock dependencies
const mockSessionManager = {
  loadSession: jest.fn(),
  addMessage: jest.fn(),
  createSession: jest.fn(),
  listSessions: jest.fn(),
  updateSession: jest.fn(),
  deleteSession: jest.fn(),
  cleanup: jest.fn(),
  markSessionProcessing: jest.fn(),
  unmarkSessionProcessing: jest.fn(),
};

const mockCursorBridge = {
  sendPrompt: jest.fn(),
  sendStreamingPrompt: jest.fn(),
  checkAuthentication: jest.fn(),
  getVersion: jest.fn(),
  executeCommand: jest.fn(),
  startInteractiveSession: jest.fn(),
  sendSessionInput: jest.fn(),
  closeSession: jest.fn(),
  getActiveSessions: jest.fn(),
  close: jest.fn(),
};

const mockLogger: Logger = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
};

const mockConfig: AdapterConfig = {
  logLevel: 'debug',
  sessionDir: '~/.cursor-sessions',
  maxSessions: 100,
  sessionTimeout: 3600000,
  tools: {
    filesystem: {
      enabled: true,
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

describe('PromptHandler', () => {
  let promptHandler: PromptHandler;
  let mockSlashCommandsRegistry: SlashCommandsRegistry;
  let mockSendNotification: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    mockSlashCommandsRegistry = new SlashCommandsRegistry(mockLogger);
    mockSlashCommandsRegistry.registerCommand(
      'plan',
      'Create a plan',
      'what to plan'
    );
    mockSlashCommandsRegistry.registerCommand('web', 'Search the web', 'query');

    mockSendNotification = jest.fn();

    promptHandler = new PromptHandler({
      sessionManager: mockSessionManager as any,
      cursorBridge: mockCursorBridge as any,
      config: mockConfig,
      logger: mockLogger,
      sendNotification: mockSendNotification,
      slashCommandsRegistry: mockSlashCommandsRegistry,
    });
  });

  describe('processPrompt', () => {
    // Per ACP schema: https://agentclientprotocol.com/protocol/schema#promptrequest
    // The field name is 'prompt' (ContentBlock[]), not 'content'
    const validRequest: AcpRequest = {
      jsonrpc: '2.0',
      method: 'session/prompt',
      id: 'test-request-1',
      params: {
        sessionId: 'test-session-1',
        prompt: [
          {
            type: 'text',
            text: 'Hello, how can you help me with TypeScript?',
          },
        ],
        stream: false,
        metadata: { source: 'test' },
      },
    };

    // Also test backward compatibility with 'content' field
    const legacyRequest: AcpRequest = {
      jsonrpc: '2.0',
      method: 'session/prompt',
      id: 'test-request-2',
      params: {
        sessionId: 'test-session-1',
        content: [
          {
            type: 'text',
            text: 'Legacy content field',
          },
        ],
        stream: false,
      },
    };

    describe('regular prompts', () => {
      beforeEach(() => {
        mockSessionManager.loadSession.mockResolvedValue({
          id: 'test-session-1',
          metadata: { name: 'Test Session' },
          conversation: [],
          state: { lastActivity: new Date(), messageCount: 0 },
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        mockCursorBridge.sendPrompt.mockResolvedValue({
          success: true,
          stdout:
            'TypeScript is a great language for building scalable applications.',
          stderr: '',
          exitCode: 0,
          metadata: { responseTime: 1500 },
        });
      });

      it('should process regular prompt successfully', async () => {
        const response = await promptHandler.processPrompt(validRequest);

        expect(response.jsonrpc).toBe('2.0');
        expect(response.id).toBe('test-request-1');
        expect(response.error).toBeUndefined();
        expect(response.result).toBeDefined();
        // Per ACP spec, session/prompt returns immediately with empty result
        // Content is sent via session/update notifications asynchronously

        expect(mockSessionManager.loadSession).toHaveBeenCalledWith(
          'test-session-1'
        );

        // Wait a bit for async processing
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(mockSessionManager.addMessage).toHaveBeenCalledTimes(2); // User and assistant messages
        expect(mockCursorBridge.sendPrompt).toHaveBeenCalledTimes(1);
      });

      it('should add user message to session', async () => {
        await promptHandler.processPrompt(validRequest);

        // Wait for async processing
        await new Promise((resolve) => setTimeout(resolve, 50));

        const addMessageCalls = mockSessionManager.addMessage.mock.calls;
        const userMessageCall = addMessageCalls[0];

        expect(userMessageCall[0]).toBe('test-session-1');
        expect(userMessageCall[1].role).toBe('user');
        // Per ACP schema: PromptRequest uses 'prompt' field
        expect(userMessageCall[1].content).toEqual(validRequest.params.prompt);
        expect(userMessageCall[1].metadata).toEqual({ source: 'test' });
      });

      it('should support legacy content field for backward compatibility', async () => {
        mockSessionManager.loadSession.mockResolvedValue({
          id: 'test-session-1',
          metadata: { name: 'Test Session' },
          conversation: [],
          state: { lastActivity: new Date(), messageCount: 0 },
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        const response = await promptHandler.processPrompt(legacyRequest);

        expect(response.jsonrpc).toBe('2.0');
        expect(response.id).toBe('test-request-2');
        expect(response.error).toBeUndefined();

        // Wait for async processing
        await new Promise((resolve) => setTimeout(resolve, 50));

        const addMessageCalls = mockSessionManager.addMessage.mock.calls;
        const userMessageCall = addMessageCalls[0];

        expect(userMessageCall[1].content).toEqual(
          legacyRequest.params.content
        );
      });

      it('should add assistant message to session', async () => {
        await promptHandler.processPrompt(validRequest);

        // Wait for async processing
        await new Promise((resolve) => setTimeout(resolve, 50));

        const addMessageCalls = mockSessionManager.addMessage.mock.calls;
        const assistantMessageCall = addMessageCalls[1];

        expect(assistantMessageCall[0]).toBe('test-session-1');
        expect(assistantMessageCall[1].role).toBe('assistant');
        expect(assistantMessageCall[1].content).toBeInstanceOf(Array);
      });

      it('should process content through ContentProcessor', async () => {
        await promptHandler.processPrompt(validRequest);

        // Wait for async processing
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(mockCursorBridge.sendPrompt).toHaveBeenCalledWith({
          sessionId: 'test-session-1',
          content: expect.objectContaining({
            value: expect.stringContaining(
              'Hello, how can you help me with TypeScript?'
            ),
            metadata: expect.any(Object),
          }),
          metadata: expect.objectContaining({
            source: 'test',
            cwd: expect.any(String),
          }),
        });
      });
    });

    describe('streaming prompts', () => {
      const streamingRequest: AcpRequest = {
        ...validRequest,
        params: {
          ...validRequest.params,
          stream: true,
        },
      };

      beforeEach(() => {
        mockSessionManager.loadSession.mockResolvedValue({
          id: 'test-session-1',
          metadata: { name: 'Test Session' },
          conversation: [],
          state: { lastActivity: new Date(), messageCount: 0 },
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        mockCursorBridge.sendStreamingPrompt.mockImplementation(
          async (options) => {
            // Simulate streaming chunks
            const chunks = ['Hello', ' there!', ' How', ' can', ' I', ' help?'];
            for (const chunk of chunks) {
              if (options.onChunk) {
                await options.onChunk({
                  type: 'content',
                  data: chunk,
                });
              }
              if (options.onProgress) {
                options.onProgress({
                  step: 'processing',
                  progress: chunks.indexOf(chunk) + 1,
                  total: chunks.length,
                  message: `Chunk ${chunks.indexOf(chunk) + 1}/${chunks.length}`,
                });
              }
            }

            return {
              success: true,
              stdout: chunks.join(''),
              stderr: '',
              exitCode: 0,
              metadata: { streaming: true },
            };
          }
        );
      });

      it('should process streaming prompt successfully', async () => {
        const response = await promptHandler.processPrompt(streamingRequest);

        expect(response.jsonrpc).toBe('2.0');
        expect(response.id).toBe('test-request-1');
        expect(response.result).toBeDefined();
        // Per ACP spec, session/prompt returns immediately with empty result

        // Wait for async processing
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(mockCursorBridge.sendStreamingPrompt).toHaveBeenCalledTimes(1);
        expect(mockSessionManager.addMessage).toHaveBeenCalledTimes(2);
      });

      it('should handle streaming chunks correctly', async () => {
        await promptHandler.processPrompt(streamingRequest);

        // Wait for async processing to start
        await new Promise((resolve) => setTimeout(resolve, 50));

        const streamingCall =
          mockCursorBridge.sendStreamingPrompt.mock.calls[0][0];
        expect(streamingCall.onChunk).toBeDefined();
        expect(streamingCall.onProgress).toBeDefined();
        expect(streamingCall.abortSignal).toBeDefined();
      });

      it('should track active streams', async () => {
        expect(promptHandler.getActiveStreamCount()).toBe(0);

        const responsePromise = promptHandler.processPrompt(streamingRequest);

        // Stream count should increase during processing
        // Note: This is a bit tricky to test due to async nature,
        // but the important thing is that it cleans up afterward

        await responsePromise;

        // Wait for async processing to complete
        await new Promise((resolve) => setTimeout(resolve, 100));

        // After completion, stream count should be back to 0
        expect(promptHandler.getActiveStreamCount()).toBe(0);
      });
    });

    describe('validation', () => {
      it('should reject invalid parameters', async () => {
        const invalidRequest: AcpRequest = {
          jsonrpc: '2.0',
          method: 'session/prompt',
          id: 'test-request-1',
          params: null,
        };

        const response = await promptHandler.processPrompt(invalidRequest);

        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(-32603);
        expect(response.error?.message).toContain('Invalid prompt parameters');
      });

      it('should reject missing sessionId', async () => {
        const invalidRequest: AcpRequest = {
          jsonrpc: '2.0',
          method: 'session/prompt',
          id: 'test-request-1',
          params: {
            content: [{ type: 'text', text: 'Hello' }],
          },
        };

        const response = await promptHandler.processPrompt(invalidRequest);

        expect(response.error).toBeDefined();
        expect(response.error?.message).toContain('sessionId is required');
      });

      it('should reject empty content array', async () => {
        const invalidRequest: AcpRequest = {
          jsonrpc: '2.0',
          method: 'session/prompt',
          id: 'test-request-1',
          params: {
            sessionId: 'test-session-1',
            content: [],
          },
        };

        const response = await promptHandler.processPrompt(invalidRequest);

        expect(response.error).toBeDefined();
        expect(response.error?.message).toContain(
          'prompt is required and must be a non-empty array'
        );
      });

      it('should reject invalid content blocks', async () => {
        const invalidRequest: AcpRequest = {
          jsonrpc: '2.0',
          method: 'session/prompt',
          id: 'test-request-1',
          params: {
            sessionId: 'test-session-1',
            content: [{ type: 'invalid', value: 'test' }],
          },
        };

        const response = await promptHandler.processPrompt(invalidRequest);

        expect(response.error).toBeDefined();
        expect(response.error?.message).toContain('Invalid content block');
      });
    });

    describe('content block validation', () => {
      it('should accept valid text content', async () => {
        const request: AcpRequest = {
          ...validRequest,
          params: {
            ...validRequest.params,
            content: [{ type: 'text', text: 'Hello world' }],
          },
        };

        mockSessionManager.loadSession.mockResolvedValue({});
        mockCursorBridge.sendPrompt.mockResolvedValue({
          success: true,
          stdout: 'Response',
        });

        const response = await promptHandler.processPrompt(request);
        expect(response.error).toBeUndefined();
      });

      it('should accept valid code content as embedded resource', async () => {
        const request: AcpRequest = {
          ...validRequest,
          params: {
            ...validRequest.params,
            content: [
              {
                type: 'resource',
                resource: {
                  uri: 'file:///test.js',
                  mimeType: 'text/javascript',
                  text: 'console.log("hello");',
                },
              },
            ],
          },
        };

        mockSessionManager.loadSession.mockResolvedValue({});
        mockCursorBridge.sendPrompt.mockResolvedValue({
          success: true,
          stdout: 'Response',
        });

        const response = await promptHandler.processPrompt(request);
        expect(response.error).toBeUndefined();
      });

      it('should accept valid image content', async () => {
        const request: AcpRequest = {
          ...validRequest,
          params: {
            ...validRequest.params,
            content: [
              {
                type: 'image',
                data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
                mimeType: 'image/png',
                uri: 'test.png',
              },
            ],
          },
        };

        mockSessionManager.loadSession.mockResolvedValue({});
        mockCursorBridge.sendPrompt.mockResolvedValue({
          success: true,
          stdout: 'Response',
        });

        const response = await promptHandler.processPrompt(request);
        expect(response.error).toBeUndefined();
      });
    });

    describe('error handling', () => {
      it('should handle session not found error', async () => {
        mockSessionManager.loadSession.mockRejectedValue(
          new SessionError('Session not found', 'test-session-1')
        );

        const response = await promptHandler.processPrompt(validRequest);

        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(-32001);
        expect(response.error?.message).toContain('Session not found');
      });

      it('should handle cursor bridge errors', async () => {
        const mockSendNotification = jest.fn();
        const handlerWithMock = new PromptHandler({
          sessionManager: mockSessionManager as any,
          cursorBridge: mockCursorBridge as any,
          config: mockConfig,
          logger: mockLogger,
          sendNotification: mockSendNotification,
        });

        mockSessionManager.loadSession.mockResolvedValue({});
        mockCursorBridge.sendPrompt.mockResolvedValue({
          success: false,
          error: 'Cursor CLI is not available',
        });

        const response = await handlerWithMock.processPrompt(validRequest);

        // Per ACP spec: errors during processing should return stopReason: 'refusal'
        expect(response.error).toBeUndefined();
        expect(response.result).toBeDefined();
        expect(response.result?.stopReason).toBe('refusal');
      });

      it('should handle unexpected errors', async () => {
        mockSessionManager.loadSession.mockRejectedValue(
          new Error('Unexpected database error')
        );

        const response = await promptHandler.processPrompt(validRequest);

        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(-32603);
        expect(response.error?.message).toBe('Unexpected database error');
      });
    });
  });

  describe('stream management', () => {
    it('should cancel stream successfully', async () => {
      const success = await promptHandler.cancelStream('test-request-1');
      // Since no stream is active, it should return false
      expect(success).toBe(false);
    });

    it('should track active stream count', () => {
      expect(promptHandler.getActiveStreamCount()).toBe(0);
    });
  });

  describe('cleanup', () => {
    it('should cleanup resources properly', async () => {
      await promptHandler.cleanup();

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'PromptHandler cleanup completed'
      );
    });

    it('should cancel active streams during cleanup', async () => {
      // Start a streaming request (simulate)
      const streamingRequest: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'test-stream-1',
        params: {
          sessionId: 'test-session-1',
          content: [{ type: 'text', value: 'Hello' }],
          stream: true,
        },
      };

      mockSessionManager.loadSession.mockResolvedValue({});
      mockCursorBridge.sendStreamingPrompt.mockImplementation(async () => {
        // Simulate long-running stream
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { success: true, stdout: 'Response' };
      });

      // Start the stream (don't await)
      promptHandler.processPrompt(streamingRequest);

      // Cleanup should cancel streams
      await promptHandler.cleanup();

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'PromptHandler cleanup completed'
      );
    });
  });

  describe('message ID generation', () => {
    it('should generate unique message IDs', async () => {
      const testRequest: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'test-request-1',
        params: {
          sessionId: 'test-session-1',
          content: [
            {
              type: 'text',
              text: 'Hello, how can you help me with TypeScript?',
            },
          ],
          stream: false,
          metadata: { source: 'test' },
        },
      };

      mockSessionManager.loadSession.mockResolvedValue({
        id: 'test-session-1',
        metadata: { name: 'Test Session', cwd: '/test/dir' },
        conversation: [],
        state: { lastActivity: new Date(), messageCount: 0 },
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockCursorBridge.sendPrompt.mockResolvedValue({
        success: true,
        stdout: 'Response 1',
      });

      const request1 = { ...testRequest, id: 'req-1' };
      const request2 = { ...testRequest, id: 'req-2' };

      const response1 = await promptHandler.processPrompt(request1);
      const response2 = await promptHandler.processPrompt(request2);

      // Both should return empty result (per ACP spec)
      expect(response1.result).toBeDefined();
      expect(response2.result).toBeDefined();

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify messages were added with unique IDs
      const addMessageCalls = mockSessionManager.addMessage.mock.calls;
      expect(addMessageCalls.length).toBeGreaterThanOrEqual(2);
      const messageIds = addMessageCalls.map((call) => call[1].id);
      expect(new Set(messageIds).size).toBe(messageIds.length); // All IDs should be unique
    });
  });

  describe('content processing integration', () => {
    it('should process mixed content types', async () => {
      const testRequest: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'test-request-1',
        params: {
          sessionId: 'test-session-1',
          content: [
            {
              type: 'text',
              text: 'Hello, how can you help me with TypeScript?',
            },
          ],
          stream: false,
          metadata: { source: 'test' },
        },
      };

      const mixedContentRequest: AcpRequest = {
        ...testRequest,
        params: {
          ...testRequest.params,
          content: [
            { type: 'text', text: 'Here is some code:' },
            {
              type: 'resource',
              resource: {
                uri: 'file:///example.ts',
                mimeType: 'text/typescript',
                text: 'const x = 42;',
              },
            },
            { type: 'text', text: 'What do you think?' },
          ],
        },
      };

      mockSessionManager.loadSession.mockResolvedValue({
        id: 'test-session-1',
        metadata: { name: 'Test Session', cwd: '/test/dir' },
        conversation: [],
        state: { lastActivity: new Date(), messageCount: 0 },
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockCursorBridge.sendPrompt.mockResolvedValue({
        success: true,
        stdout: 'Great code!',
      });

      const response = await promptHandler.processPrompt(mixedContentRequest);

      expect(response.error).toBeUndefined();
      expect(response.result).toBeDefined();

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify content was processed
      const sendPromptCall = mockCursorBridge.sendPrompt.mock.calls[0][0];
      expect(sendPromptCall.content.value).toContain('Here is some code:');
      // Resources are formatted with headers, not code fences
      expect(sendPromptCall.content.value).toContain(
        '# Resource: file:///example.ts'
      );
      expect(sendPromptCall.content.value).toContain('# Type: text/typescript');
      expect(sendPromptCall.content.value).toContain('const x = 42;');
      expect(sendPromptCall.content.value).toContain('What do you think?');
    });
  });

  describe('sendPlan', () => {
    let sentNotifications: Array<{
      jsonrpc: '2.0';
      method: string;
      params?: any;
    }>;
    let handlerWithNotifications: PromptHandler;

    beforeEach(() => {
      jest.clearAllMocks(); // Clear mocks including logger calls from setup
      sentNotifications = [];
      handlerWithNotifications = new PromptHandler({
        sessionManager: mockSessionManager as any,
        cursorBridge: mockCursorBridge as any,
        config: mockConfig,
        logger: mockLogger,
        sendNotification: (notification) => {
          sentNotifications.push(notification);
        },
        // Don't pass slashCommandsRegistry for these tests
        slashCommandsRegistry: undefined,
      });
    });

    it('should not send notification when sendPlan is disabled', () => {
      const entries: PlanEntry[] = [
        {
          content: 'Analyze the codebase',
          priority: 'high',
          status: 'pending',
        },
      ];

      handlerWithNotifications.sendPlan('session1', entries);

      expect(sentNotifications).toHaveLength(0);
      expect(mockLogger.debug).not.toHaveBeenCalled();
    });

    it('should not send notification when entries array is empty', () => {
      // Enable sendPlan for this test
      (handlerWithNotifications as any).processingConfig.sendPlan = true;

      handlerWithNotifications.sendPlan('session1', []);

      expect(sentNotifications).toHaveLength(0);
      expect(mockLogger.debug).not.toHaveBeenCalled();
    });

    it('should send plan notification with correct structure when enabled', () => {
      // Enable sendPlan for this test
      (handlerWithNotifications as any).processingConfig.sendPlan = true;

      const entries: PlanEntry[] = [
        {
          content: 'Analyze the existing codebase structure',
          priority: 'high',
          status: 'pending',
        },
        {
          content: 'Identify components that need refactoring',
          priority: 'high',
          status: 'pending',
        },
        {
          content: 'Create unit tests for critical functions',
          priority: 'medium',
          status: 'pending',
        },
      ];

      handlerWithNotifications.sendPlan('session1', entries);

      expect(sentNotifications).toHaveLength(1);
      expect(sentNotifications[0]!).toMatchObject({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'session1',
          update: {
            sessionUpdate: 'plan',
            entries: [
              {
                content: 'Analyze the existing codebase structure',
                priority: 'high',
                status: 'pending',
              },
              {
                content: 'Identify components that need refactoring',
                priority: 'high',
                status: 'pending',
              },
              {
                content: 'Create unit tests for critical functions',
                priority: 'medium',
                status: 'pending',
              },
            ],
          },
        },
      });

      // Verify SessionNotification type structure
      const notification = sentNotifications[0]!.params as SessionNotification;
      expect(notification.sessionId).toBe('session1');
      expect(notification.update.sessionUpdate).toBe('plan');
      expect('entries' in notification.update).toBe(true);
      if ('entries' in notification.update) {
        expect(notification.update.entries).toHaveLength(3);
      }

      expect(mockLogger.debug).toHaveBeenCalledWith('Sending plan', {
        sessionId: 'session1',
        stepCount: 3,
      });
    });

    it('should include _meta field when present in entries', () => {
      // Enable sendPlan for this test
      (handlerWithNotifications as any).processingConfig.sendPlan = true;

      const entries: PlanEntry[] = [
        {
          content: 'Task with metadata',
          priority: 'high',
          status: 'pending',
          _meta: {
            source: 'test',
            timestamp: '2024-01-01T00:00:00Z',
          },
        },
        {
          content: 'Task without metadata',
          priority: 'low',
          status: 'completed',
        },
      ];

      handlerWithNotifications.sendPlan('session1', entries);

      expect(sentNotifications).toHaveLength(1);
      const notification = sentNotifications[0]!.params as SessionNotification;
      if ('entries' in notification.update) {
        expect(notification.update.entries[0]!._meta).toEqual({
          source: 'test',
          timestamp: '2024-01-01T00:00:00Z',
        });
        expect(notification.update.entries[1]!._meta).toBeUndefined();
      }
    });

    it('should map all required fields correctly', () => {
      // Enable sendPlan for this test
      (handlerWithNotifications as any).processingConfig.sendPlan = true;

      const entries: PlanEntry[] = [
        {
          content: 'Test content',
          priority: 'high',
          status: 'in_progress',
        },
        {
          content: 'Another task',
          priority: 'medium',
          status: 'completed',
        },
        {
          content: 'Low priority task',
          priority: 'low',
          status: 'pending',
        },
      ];

      handlerWithNotifications.sendPlan('session1', entries);

      expect(sentNotifications).toHaveLength(1);
      const notification = sentNotifications[0]!.params as SessionNotification;
      if ('entries' in notification.update) {
        const mappedEntries = notification.update.entries;
        expect(mappedEntries).toHaveLength(3);

        // Verify all required fields are present
        mappedEntries.forEach((entry) => {
          expect(entry).toHaveProperty('content');
          expect(entry).toHaveProperty('priority');
          expect(entry).toHaveProperty('status');
          expect(typeof entry.content).toBe('string');
          expect(['high', 'medium', 'low']).toContain(entry.priority);
          expect(['pending', 'in_progress', 'completed']).toContain(
            entry.status
          );
        });

        // Verify no invalid fields are present
        mappedEntries.forEach((entry) => {
          expect(entry).not.toHaveProperty('id');
          expect(entry).not.toHaveProperty('title');
          expect(entry).not.toHaveProperty('description');
        });
      }
    });

    it('should handle all valid status values', () => {
      // Enable sendPlan for this test
      (handlerWithNotifications as any).processingConfig.sendPlan = true;

      const entries: PlanEntry[] = [
        { content: 'Pending task', priority: 'high', status: 'pending' },
        {
          content: 'In progress task',
          priority: 'medium',
          status: 'in_progress',
        },
        { content: 'Completed task', priority: 'low', status: 'completed' },
      ];

      handlerWithNotifications.sendPlan('session1', entries);

      expect(sentNotifications).toHaveLength(1);
      const notification = sentNotifications[0]!.params as SessionNotification;
      if ('entries' in notification.update) {
        expect(notification.update.entries[0]!.status).toBe('pending');
        expect(notification.update.entries[1]!.status).toBe('in_progress');
        expect(notification.update.entries[2]!.status).toBe('completed');
      }
    });

    it('should handle all valid priority values', () => {
      // Enable sendPlan for this test
      (handlerWithNotifications as any).processingConfig.sendPlan = true;

      const entries: PlanEntry[] = [
        { content: 'High priority', priority: 'high', status: 'pending' },
        { content: 'Medium priority', priority: 'medium', status: 'pending' },
        { content: 'Low priority', priority: 'low', status: 'pending' },
      ];

      handlerWithNotifications.sendPlan('session1', entries);

      expect(sentNotifications).toHaveLength(1);
      const notification = sentNotifications[0]!.params as SessionNotification;
      if ('entries' in notification.update) {
        expect(notification.update.entries[0]!.priority).toBe('high');
        expect(notification.update.entries[1]!.priority).toBe('medium');
        expect(notification.update.entries[2]!.priority).toBe('low');
      }
    });
  });

  describe('updatePlan', () => {
    let sentNotifications: Array<{
      jsonrpc: '2.0';
      method: string;
      params?: any;
    }>;
    let handlerWithNotifications: PromptHandler;

    beforeEach(() => {
      jest.clearAllMocks(); // Clear mocks including logger calls from setup
      sentNotifications = [];
      handlerWithNotifications = new PromptHandler({
        sessionManager: mockSessionManager as any,
        cursorBridge: mockCursorBridge as any,
        config: mockConfig,
        logger: mockLogger,
        sendNotification: (notification) => {
          sentNotifications.push(notification);
        },
        // Don't pass slashCommandsRegistry for these tests
        slashCommandsRegistry: undefined,
      });
    });

    it('should not send notification when sendPlan is disabled', () => {
      const entries: PlanEntry[] = [
        {
          content: 'Updated task',
          priority: 'high',
          status: 'in_progress',
        },
      ];

      handlerWithNotifications.updatePlan('session1', entries);

      expect(sentNotifications).toHaveLength(0);
      expect(mockLogger.debug).not.toHaveBeenCalled();
    });

    it('should send complete plan update with correct structure', () => {
      // Enable sendPlan for this test
      (handlerWithNotifications as any).processingConfig.sendPlan = true;

      const entries: PlanEntry[] = [
        {
          content: 'Task 1',
          priority: 'high',
          status: 'completed',
        },
        {
          content: 'Task 2',
          priority: 'medium',
          status: 'in_progress',
        },
        {
          content: 'Task 3',
          priority: 'low',
          status: 'pending',
        },
      ];

      handlerWithNotifications.updatePlan('session1', entries);

      expect(sentNotifications).toHaveLength(1);
      expect(sentNotifications[0]!).toMatchObject({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'session1',
          update: {
            sessionUpdate: 'plan',
            entries: [
              {
                content: 'Task 1',
                priority: 'high',
                status: 'completed',
              },
              {
                content: 'Task 2',
                priority: 'medium',
                status: 'in_progress',
              },
              {
                content: 'Task 3',
                priority: 'low',
                status: 'pending',
              },
            ],
          },
        },
      });

      // Verify SessionNotification type structure
      const notification = sentNotifications[0]!.params as SessionNotification;
      expect(notification.sessionId).toBe('session1');
      expect(notification.update.sessionUpdate).toBe('plan');
      expect('entries' in notification.update).toBe(true);
      if ('entries' in notification.update) {
        expect(notification.update.entries).toHaveLength(3);
      }

      expect(mockLogger.debug).toHaveBeenCalledWith('Updating plan', {
        sessionId: 'session1',
        entryCount: 3,
      });
    });

    it('should send complete plan even when updating single entry', () => {
      // Enable sendPlan for this test
      (handlerWithNotifications as any).processingConfig.sendPlan = true;

      // Initial plan
      const initialEntries: PlanEntry[] = [
        {
          content: 'Task 1',
          priority: 'high',
          status: 'pending',
        },
        {
          content: 'Task 2',
          priority: 'medium',
          status: 'pending',
        },
      ];

      handlerWithNotifications.sendPlan('session1', initialEntries);
      sentNotifications = []; // Clear

      // Update: Task 1 is now completed, but must send complete plan
      const updatedEntries: PlanEntry[] = [
        {
          content: 'Task 1',
          priority: 'high',
          status: 'completed',
        },
        {
          content: 'Task 2',
          priority: 'medium',
          status: 'pending',
        },
      ];

      handlerWithNotifications.updatePlan('session1', updatedEntries);

      expect(sentNotifications).toHaveLength(1);
      const notification = sentNotifications[0]!.params as SessionNotification;
      if ('entries' in notification.update) {
        // Must send complete plan, not just the updated entry
        expect(notification.update.entries).toHaveLength(2);
        expect(notification.update.entries[0]!.status).toBe('completed');
        expect(notification.update.entries[1]!.status).toBe('pending');
      }
    });

    it('should include _meta field when present in entries', () => {
      // Enable sendPlan for this test
      (handlerWithNotifications as any).processingConfig.sendPlan = true;

      const entries: PlanEntry[] = [
        {
          content: 'Task with metadata',
          priority: 'high',
          status: 'in_progress',
          _meta: {
            updatedAt: '2024-01-01T00:00:00Z',
            source: 'test',
          },
        },
      ];

      handlerWithNotifications.updatePlan('session1', entries);

      expect(sentNotifications).toHaveLength(1);
      const notification = sentNotifications[0]!.params as SessionNotification;
      if ('entries' in notification.update) {
        expect(notification.update.entries[0]!._meta).toEqual({
          updatedAt: '2024-01-01T00:00:00Z',
          source: 'test',
        });
      }
    });

    it('should map all required fields correctly', () => {
      // Enable sendPlan for this test
      (handlerWithNotifications as any).processingConfig.sendPlan = true;

      const entries: PlanEntry[] = [
        {
          content: 'Updated content',
          priority: 'high',
          status: 'completed',
        },
      ];

      handlerWithNotifications.updatePlan('session1', entries);

      expect(sentNotifications).toHaveLength(1);
      const notification = sentNotifications[0]!.params as SessionNotification;
      if ('entries' in notification.update) {
        const mappedEntries = notification.update.entries;
        expect(mappedEntries).toHaveLength(1);

        // Verify all required fields are present
        const entry = mappedEntries[0]!;
        expect(entry).toHaveProperty('content');
        expect(entry).toHaveProperty('priority');
        expect(entry).toHaveProperty('status');
        expect(entry.content).toBe('Updated content');
        expect(entry.priority).toBe('high');
        expect(entry.status).toBe('completed');

        // Verify no invalid fields are present
        expect(entry).not.toHaveProperty('id');
        expect(entry).not.toHaveProperty('title');
        expect(entry).not.toHaveProperty('description');
      }
    });

    it('should handle empty entries array', () => {
      // Enable sendPlan for this test
      (handlerWithNotifications as any).processingConfig.sendPlan = true;

      handlerWithNotifications.updatePlan('session1', []);

      expect(sentNotifications).toHaveLength(1);
      const notification = sentNotifications[0]!.params as SessionNotification;
      if ('entries' in notification.update) {
        expect(notification.update.entries).toHaveLength(0);
      }

      expect(mockLogger.debug).toHaveBeenCalledWith('Updating plan', {
        sessionId: 'session1',
        entryCount: 0,
      });
    });
  });

  describe('slash command detection and processing', () => {
    beforeEach(() => {
      mockSessionManager.loadSession.mockResolvedValue({
        id: 'test-session-1',
        metadata: { name: 'Test Session', cwd: '/tmp' },
        conversation: [],
        state: { lastActivity: new Date(), messageCount: 0 },
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      mockCursorBridge.sendPrompt.mockResolvedValue({
        success: true,
        stdout: 'Command processed',
        stderr: '',
        exitCode: 0,
        metadata: {},
      });
    });

    it('should detect slash command at start of text content', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'test-request-1',
        params: {
          sessionId: 'test-session-1',
          content: [
            {
              type: 'text',
              text: '/plan create a new feature',
            },
          ],
          stream: false,
        },
      };

      await promptHandler.processPrompt(request);

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockLogger.debug).toHaveBeenCalledWith('Detected slash command', {
        command: 'plan',
        input: 'create a new feature',
      });

      expect(mockLogger.info).toHaveBeenCalledWith('Processing slash command', {
        sessionId: 'test-session-1',
        command: 'plan',
        input: 'create a new feature',
        description: 'Create a plan',
      });

      // Command should still be processed as regular prompt
      expect(mockCursorBridge.sendPrompt).toHaveBeenCalled();
    });

    it('should detect slash command without input', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'test-request-1',
        params: {
          sessionId: 'test-session-1',
          content: [
            {
              type: 'text',
              text: '/web',
            },
          ],
          stream: false,
        },
      };

      await promptHandler.processPrompt(request);

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockLogger.debug).toHaveBeenCalledWith('Detected slash command', {
        command: 'web',
        input: '',
      });
    });

    it('should not detect command when text does not start with slash', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'test-request-1',
        params: {
          sessionId: 'test-session-1',
          content: [
            {
              type: 'text',
              text: 'This is a regular message /plan',
            },
          ],
          stream: false,
        },
      };

      await promptHandler.processPrompt(request);

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockLogger.debug).not.toHaveBeenCalledWith(
        'Detected slash command',
        expect.anything()
      );
    });

    it('should handle unknown slash command gracefully', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'test-request-1',
        params: {
          sessionId: 'test-session-1',
          content: [
            {
              type: 'text',
              text: '/unknown command with input',
            },
          ],
          stream: false,
        },
      };

      await promptHandler.processPrompt(request);

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockLogger.debug).toHaveBeenCalledWith('Unknown slash command', {
        command: 'unknown',
      });

      // Should still process as regular prompt
      expect(mockCursorBridge.sendPrompt).toHaveBeenCalled();
    });

    it('should handle command detection with multiple content blocks', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'test-request-1',
        params: {
          sessionId: 'test-session-1',
          content: [
            {
              type: 'text',
              text: 'Some regular text',
            },
            {
              type: 'text',
              text: '/plan create feature',
            },
          ],
          stream: false,
        },
      };

      await promptHandler.processPrompt(request);

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should detect command in second block
      expect(mockLogger.debug).toHaveBeenCalledWith('Detected slash command', {
        command: 'plan',
        input: 'create feature',
      });
    });

    it('should work without slash commands registry', async () => {
      const handlerWithoutRegistry = new PromptHandler({
        sessionManager: mockSessionManager as any,
        cursorBridge: mockCursorBridge as any,
        config: mockConfig,
        logger: mockLogger,
        sendNotification: mockSendNotification,
        // No slashCommandsRegistry provided
      });

      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'test-request-1',
        params: {
          sessionId: 'test-session-1',
          content: [
            {
              type: 'text',
              text: '/plan test',
            },
          ],
          stream: false,
        },
      };

      await handlerWithoutRegistry.processPrompt(request);

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should not crash, just log that registry is not available
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Slash commands registry not available'
      );
    });

    it('should extract command name correctly with whitespace', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'test-request-1',
        params: {
          sessionId: 'test-session-1',
          content: [
            {
              type: 'text',
              text: '/web   multiple   spaces   in   input',
            },
          ],
          stream: false,
        },
      };

      await promptHandler.processPrompt(request);

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockLogger.debug).toHaveBeenCalledWith('Detected slash command', {
        command: 'web',
        input: 'multiple   spaces   in   input',
      });
    });
  });
});
