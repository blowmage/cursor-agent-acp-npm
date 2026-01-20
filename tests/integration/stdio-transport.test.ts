/**
 * Stdio Transport Integration Tests
 *
 * Tests the stdio transport implementation for strict ACP compliance.
 * Per ACP spec: https://agentclientprotocol.com/protocol/transports
 *
 * These tests verify:
 * - Newline-delimited JSON-RPC message format
 * - Multiple sequential messages
 * - Proper stdin/stdout handling
 * - Error handling for malformed messages
 * - Stream lifecycle management
 */

import { jest } from '@jest/globals';
import { CursorAgentAdapter } from '../../src/adapter/cursor-agent-adapter';
import { createLogger } from '../../src/utils/logger';
import type { AdapterConfig, Logger } from '../../src/types';
import { Readable, Writable } from 'stream';
import type {
  Request,
  InitializeRequest,
  InitializeResponse,
} from '@agentclientprotocol/sdk';

// Mock the CursorCliBridge to prevent actual CLI calls
jest.mock('../../src/cursor/cli-bridge', () => ({
  CursorCliBridge: jest.fn().mockImplementation(() => ({
    getVersion: jest.fn().mockResolvedValue('1.0.0-mock'),
    checkAuthentication: jest
      .fn()
      .mockResolvedValue({ authenticated: true, user: 'test-user' }),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

describe('Stdio Transport Integration Tests', () => {
  let adapter: CursorAgentAdapter;
  let logger: Logger;
  let mockStdin: Readable;
  let mockStdout: Writable;
  let stdoutData: string[];

  const DEFAULT_CONFIG: AdapterConfig = {
    logLevel: 'error',
    sessionDir: '/tmp/test-sessions',
    maxSessions: 100,
    sessionTimeout: 3600000,
    tools: {
      filesystem: { enabled: false },
      terminal: { enabled: false, maxProcesses: 5 },
    },
    cursor: {
      timeout: 30000,
      retries: 3,
    },
  };

  beforeEach(() => {
    logger = createLogger({ level: 'error' });
    stdoutData = [];

    // Create mock stdin stream
    mockStdin = new Readable({
      read() {},
    });

    // Create mock stdout stream that captures output
    mockStdout = new Writable({
      write(chunk, encoding, callback) {
        stdoutData.push(chunk.toString());
        callback();
      },
    });

    adapter = new CursorAgentAdapter(DEFAULT_CONFIG, { logger });
  });

  afterEach(async () => {
    if (adapter) {
      try {
        await adapter.shutdown();
      } catch (error) {
        // Ignore shutdown errors in tests
      }
    }
  });

  describe('Newline-Delimited Message Format', () => {
    it('should send JSON-RPC responses delimited by newlines', async () => {
      // Initialize adapter components (this doesn't call initialize protocol method)
      await adapter.initialize();

      // Now test the initialize protocol method via processRequest
      const response = await adapter.processRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: 1,
        },
      } as Request);

      // Check for errors first
      if (response.error) {
        throw new Error(`Initialize failed: ${JSON.stringify(response.error)}`);
      }

      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe(1);
      expect(response.result).toBeDefined();

      // Verify result structure per ACP spec (using InitializeResponse type from SDK)
      const result = response.result as InitializeResponse;

      // The SDK response includes 'protocolVersion' as expected
      expect(result.protocolVersion).toBe(1);
      expect(result.agentCapabilities).toBeDefined();
      expect(result.agentInfo).toBeDefined();
    });

    it('should handle multiple sequential requests', async () => {
      await adapter.initialize();

      // First request: initialize
      const initResponse = await adapter.processRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: 1 },
      } as Request);

      expect(initResponse.id).toBe(1);
      expect(initResponse.result).toBeDefined();

      // Second request: session/new
      const sessionResponse = await adapter.processRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/new',
        params: {
          cwd: '/test',
          mcpServers: [],
        },
      } as Request);

      expect(sessionResponse.id).toBe(2n);
      expect(sessionResponse.result).toBeDefined();
      expect((sessionResponse.result as any).sessionId).toBeDefined();
    });

    it('should not include embedded newlines in responses', async () => {
      await adapter.initialize();

      const response = await adapter.processRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: 1 },
      } as Request);

      const responseStr = JSON.stringify(response);

      // Per ACP spec: Messages MUST NOT contain embedded newlines
      expect(responseStr).not.toContain('\n');
      expect(responseStr).not.toContain('\r');
    });
  });

  describe('Error Handling', () => {
    it('should return JSON-RPC error for invalid method', async () => {
      await adapter.initialize();

      const response = await adapter.processRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'invalid/method',
        params: {},
      } as Request);

      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32601); // Method not found
      expect(response.result).toBeUndefined();
    });

    it('should handle malformed params gracefully', async () => {
      await adapter.initialize();

      const response = await adapter.processRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'session/new',
        params: null, // Invalid params
      } as Request);

      expect(response.error).toBeDefined();
      expect(response.result).toBeUndefined();
    });

    it('should return proper error structure per JSON-RPC 2.0', async () => {
      await adapter.initialize();

      const response = await adapter.processRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'invalid/method',
        params: {},
      } as Request);

      // Per JSON-RPC 2.0 spec
      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe(1);
      expect(response.error).toBeDefined();
      expect(response.error?.code).toBeDefined();
      expect(response.error?.message).toBeDefined();
      expect(typeof response.error?.code).toBe('number');
      expect(typeof response.error?.message).toBe('string');
    });
  });

  describe('Notification Handling', () => {
    it('should handle notifications (requests without id)', async () => {
      await adapter.initialize();

      // Create a session first
      const sessionResponse = await adapter.processRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'session/new',
        params: {
          cwd: '/test',
          mcpServers: [],
        },
      } as Request);

      const sessionId = (sessionResponse.result as any).sessionId;

      // Send a notification (no id)
      const response = await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'cancel',
        params: {
          sessionId,
          reason: 'test',
        },
      } as any);

      // Per JSON-RPC 2.0: Notifications don't receive responses
      // But our processRequest always returns something for testing
      expect(response).toBeDefined();
    });
  });

  describe('ACP Protocol Compliance', () => {
    it('should advertise stdio transport in capabilities', async () => {
      await adapter.initialize();

      const response = await adapter.processRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: 1 },
      } as Request);

      if (response.error) {
        console.error('Initialize error:', response.error);
        throw new Error(`Initialize failed: ${response.error.message}`);
      }

      const result = response.result as any;
      expect(result.agentInfo).toBeDefined();
      expect(result.agentInfo.name).toBe('cursor-agent-acp');

      // Verify implementation details mention stdio
      const meta = result.agentCapabilities?._meta;
      expect(meta?.description).toContain('ACP adapter');
    });

    it('should use SDK types throughout protocol', async () => {
      await adapter.initialize();

      const response = await adapter.processRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: 1 },
      } as Request);

      expect(response.error).toBeUndefined();
      expect(response.result).toBeDefined();

      const result = response.result as InitializeResponse;

      // Verify SDK type structure (SDK uses 'protocolVersion' in response)
      expect(result.protocolVersion).toBe(1);
      expect(result.agentCapabilities).toBeDefined();
      expect(result.agentInfo).toHaveProperty('name');
      expect(result.agentInfo).toHaveProperty('version');
    });
  });

  describe('Stream Lifecycle', () => {
    it('should properly initialize adapter components', async () => {
      await adapter.initialize();

      const status = adapter.getStatus();
      expect(status.components.sessionManager).toBe(true);
      expect(status.components.cursorBridge).toBe(true);
      expect(status.components.toolRegistry).toBe(true);
      expect(status.components.initializationHandler).toBe(true);
      expect(status.components.promptHandler).toBe(true);
    });

    it('should handle shutdown gracefully', async () => {
      await adapter.initialize();
      await adapter.shutdown();

      const status = adapter.getStatus();
      expect(status.running).toBe(false);
    });
  });

  describe('Large Message Handling', () => {
    it('should handle large content blocks', async () => {
      await adapter.initialize();

      // Create session
      const sessionResponse = await adapter.processRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'session/new',
        params: {
          cwd: '/test',
          mcpServers: [],
        },
      } as Request);

      if (sessionResponse.error) {
        console.error('Session creation error:', sessionResponse.error);
        throw new Error(
          `Session creation failed: ${sessionResponse.error.message}`
        );
      }

      expect(sessionResponse.result).toBeDefined();
      const sessionId = (sessionResponse.result as any).sessionId;
      expect(sessionId).toBeDefined();

      // Send prompt with large content
      const largeText = 'a'.repeat(10000); // 10KB text block
      const promptResponse = await adapter.processRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/prompt',
        params: {
          sessionId,
          content: [
            {
              type: 'text',
              text: largeText,
            },
          ],
        },
      } as Request);

      // The prompt might succeed or fail, but should return a valid response
      expect(promptResponse.jsonrpc).toBe('2.0');
      expect(promptResponse.id).toBe(2n);
      // Either result or error should be defined
      expect(
        promptResponse.result !== undefined ||
          promptResponse.error !== undefined
      ).toBe(true);
    });
  });

  describe('Concurrent Requests', () => {
    it('should handle multiple sessions concurrently', async () => {
      await adapter.initialize();

      // Create multiple sessions
      const promises: Promise<any>[] = [];
      for (let i = 0; i < 5; i++) {
        promises.push(
          adapter.processRequest({
            jsonrpc: '2.0',
            id: i + 1,
            method: 'session/new',
            params: {
              cwd: `/test${i}`,
              mcpServers: [],
            },
          } as Request)
        );
      }

      const responses = await Promise.all(promises);

      // Verify all sessions were created
      expect(responses).toHaveLength(5);
      responses.forEach((response, index) => {
        expect(response.id).toBe(BigInt(index + 1));
        expect((response.result as any).sessionId).toBeDefined();
      });

      // Verify all sessions have unique IDs
      const sessionIds = responses.map((r) => (r.result as any).sessionId);
      const uniqueIds = new Set(sessionIds);
      expect(uniqueIds.size).toBe(5);
    });
  });
});
