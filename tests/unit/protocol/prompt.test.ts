/**
 * Unit tests for PromptHandler
 */

/* eslint-disable @typescript-eslint/no-unused-vars, no-unused-vars, no-duplicate-imports */

import { PromptHandler } from '../../../src/protocol/prompt';
import { ContentProcessor } from '../../../src/protocol/content';
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
      allowedPaths: ['./'],
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

  beforeEach(() => {
    jest.clearAllMocks();

    promptHandler = new PromptHandler({
      sessionManager: mockSessionManager as any,
      cursorBridge: mockCursorBridge as any,
      config: mockConfig,
      logger: mockLogger,
      sendNotification: jest.fn(),
    });
  });

  describe('processPrompt', () => {
    const validRequest: AcpRequest = {
      jsonrpc: '2.0',
      method: 'session/prompt',
      id: 'test-request-1',
      params: {
        sessionId: 'test-session-1',
        content: [
          {
            type: 'text',
            value: 'Hello, how can you help me with TypeScript?',
          },
        ],
        stream: false,
        metadata: { source: 'test' },
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
        expect(userMessageCall[1].content).toEqual(validRequest.params.content);
        expect(userMessageCall[1].metadata).toEqual({ source: 'test' });
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
            content: [{ type: 'text', value: 'Hello' }],
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
          'content/prompt is required and must be a non-empty array'
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
            content: [{ type: 'text', value: 'Hello world' }],
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

      it('should accept valid code content', async () => {
        const request: AcpRequest = {
          ...validRequest,
          params: {
            ...validRequest.params,
            content: [
              {
                type: 'code',
                value: 'console.log("hello");',
                language: 'javascript',
                filename: 'test.js',
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
                value:
                  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
                mimeType: 'image/png',
                filename: 'test.png',
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
              value: 'Hello, how can you help me with TypeScript?',
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
              value: 'Hello, how can you help me with TypeScript?',
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
              type: 'code',
              value: 'const x = 42;',
              language: 'typescript',
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
      expect(sendPromptCall.content.value).toContain('```typescript');
      expect(sendPromptCall.content.value).toContain('const x = 42;');
      expect(sendPromptCall.content.value).toContain('What do you think?');
    });
  });
});
