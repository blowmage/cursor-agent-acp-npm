/**
 * Unit tests for PermissionsHandler
 *
 * Tests permission request handling and default permission logic.
 */

import { PermissionsHandler } from '../../../src/protocol/permissions';
import type { Logger, AcpRequest } from '../../../src/types';

describe('PermissionsHandler', () => {
  let handler: PermissionsHandler;
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
    };

    handler = new PermissionsHandler({
      logger: mockLogger,
    });
  });

  afterEach(async () => {
    await handler.cleanup();
  });

  describe('handlePermissionRequest', () => {
    it('should handle valid permission request', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'session/request_permission',
        params: {
          sessionId: 'session1',
          toolCall: {
            toolCallId: 'tool_123',
            title: 'Reading file',
            kind: 'read',
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

      const response = await handler.handlePermissionRequest(request);

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

    it('should auto-allow safe operations (read)', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'session/request_permission',
        params: {
          sessionId: 'session1',
          toolCall: {
            toolCallId: 'tool_123',
            kind: 'read',
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

      const response = await handler.handlePermissionRequest(request);

      expect(response.result?.outcome).toEqual({
        outcome: 'selected',
        optionId: 'allow-once',
      });
    });

    it('should auto-allow safe operations (search)', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'session/request_permission',
        params: {
          sessionId: 'session1',
          toolCall: {
            toolCallId: 'tool_123',
            kind: 'search',
          },
          options: [
            {
              optionId: 'allow-once',
              name: 'Allow once',
              kind: 'allow_once',
            },
          ],
        },
      };

      const response = await handler.handlePermissionRequest(request);

      expect(response.result?.outcome).toEqual({
        outcome: 'selected',
        optionId: 'allow-once',
      });
    });

    it('should reject dangerous operations (edit)', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'session/request_permission',
        params: {
          sessionId: 'session1',
          toolCall: {
            toolCallId: 'tool_123',
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

      const response = await handler.handlePermissionRequest(request);

      expect(response.result?.outcome).toEqual({
        outcome: 'selected',
        optionId: 'reject-once',
      });
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('should reject dangerous operations (delete)', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'session/request_permission',
        params: {
          sessionId: 'session1',
          toolCall: {
            toolCallId: 'tool_123',
            kind: 'delete',
          },
          options: [
            {
              optionId: 'reject-once',
              name: 'Reject',
              kind: 'reject_once',
            },
          ],
        },
      };

      const response = await handler.handlePermissionRequest(request);

      expect(response.result?.outcome.optionId).toBe('reject-once');
    });

    it('should reject dangerous operations (execute)', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'session/request_permission',
        params: {
          sessionId: 'session1',
          toolCall: {
            toolCallId: 'tool_123',
            kind: 'execute',
          },
          options: [
            {
              optionId: 'allow-once',
              name: 'Allow',
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

      const response = await handler.handlePermissionRequest(request);

      expect(response.result?.outcome.optionId).toBe('reject-once');
    });

    it('should use first option as fallback', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'session/request_permission',
        params: {
          sessionId: 'session1',
          toolCall: {
            toolCallId: 'tool_123',
            kind: 'other',
          },
          options: [
            {
              optionId: 'custom-option',
              name: 'Custom',
              kind: 'allow_once',
            },
          ],
        },
      };

      const response = await handler.handlePermissionRequest(request);

      expect(response.result?.outcome.optionId).toBe('custom-option');
    });

    it('should throw on missing sessionId', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'session/request_permission',
        params: {
          toolCall: {},
          options: [],
        } as any,
      };

      await expect(handler.handlePermissionRequest(request)).rejects.toThrow(
        'sessionId is required'
      );
    });

    it('should throw on missing toolCall', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'session/request_permission',
        params: {
          sessionId: 'session1',
          options: [],
        } as any,
      };

      await expect(handler.handlePermissionRequest(request)).rejects.toThrow(
        'toolCall is required'
      );
    });

    it('should throw on empty options', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'session/request_permission',
        params: {
          sessionId: 'session1',
          toolCall: {
            toolCallId: 'tool_123',
          },
          options: [],
        },
      };

      await expect(handler.handlePermissionRequest(request)).rejects.toThrow(
        'options is required'
      );
    });

    it('should throw on invalid option', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'session/request_permission',
        params: {
          sessionId: 'session1',
          toolCall: {
            toolCallId: 'tool_123',
          },
          options: [
            {
              optionId: 'test',
              name: 'Test',
              kind: 'invalid_kind' as any,
            },
          ],
        },
      };

      await expect(handler.handlePermissionRequest(request)).rejects.toThrow(
        'Invalid permission option'
      );
    });
  });

  describe('createPermissionRequest', () => {
    it('should create a pending permission request', async () => {
      const promise = handler.createPermissionRequest({
        sessionId: 'session1',
        toolCall: {
          toolCallId: 'tool_123',
        },
        options: [
          {
            optionId: 'allow',
            name: 'Allow',
            kind: 'allow_once',
          },
        ],
      });

      // Should be pending
      expect(handler.getMetrics().pendingRequests).toBe(1);

      // Cleanup (will timeout and resolve)
      await handler.cleanup();
    });

    it('should timeout after default duration', async () => {
      jest.useFakeTimers();

      const promise = handler.createPermissionRequest({
        sessionId: 'session1',
        toolCall: {
          toolCallId: 'tool_123',
        },
        options: [
          {
            optionId: 'reject',
            name: 'Reject',
            kind: 'reject_once',
          },
        ],
      });

      jest.advanceTimersByTime(300000); // 5 minutes

      const outcome = await promise;

      expect(outcome).toEqual({
        outcome: 'selected',
        optionId: 'reject-once',
      });

      expect(mockLogger.warn).toHaveBeenCalled();

      jest.useRealTimers();
    });
  });

  describe('cancelSessionPermissionRequests', () => {
    it('should cancel all pending requests for a session', async () => {
      const promise1 = handler.createPermissionRequest({
        sessionId: 'session1',
        toolCall: {
          toolCallId: 'tool_1',
        },
        options: [
          {
            optionId: 'allow',
            name: 'Allow',
            kind: 'allow_once',
          },
        ],
      });

      const promise2 = handler.createPermissionRequest({
        sessionId: 'session1',
        toolCall: {
          toolCallId: 'tool_2',
        },
        options: [
          {
            optionId: 'allow',
            name: 'Allow',
            kind: 'allow_once',
          },
        ],
      });

      const promise3 = handler.createPermissionRequest({
        sessionId: 'session2',
        toolCall: {
          toolCallId: 'tool_3',
        },
        options: [
          {
            optionId: 'allow',
            name: 'Allow',
            kind: 'allow_once',
          },
        ],
      });

      expect(handler.getMetrics().pendingRequests).toBe(3);

      handler.cancelSessionPermissionRequests('session1');

      // Session 1 requests should be cancelled
      const outcome1 = await promise1;
      const outcome2 = await promise2;

      expect(outcome1).toEqual({ outcome: 'cancelled' });
      expect(outcome2).toEqual({ outcome: 'cancelled' });

      // Session 2 request should still be pending
      expect(handler.getMetrics().pendingRequests).toBe(1);

      await handler.cleanup();
    });
  });

  describe('getMetrics', () => {
    it('should return pending request count', async () => {
      expect(handler.getMetrics().pendingRequests).toBe(0);

      handler.createPermissionRequest({
        sessionId: 'session1',
        toolCall: {
          toolCallId: 'tool_123',
        },
        options: [
          {
            optionId: 'allow',
            name: 'Allow',
            kind: 'allow_once',
          },
        ],
      });

      expect(handler.getMetrics().pendingRequests).toBe(1);

      await handler.cleanup();
    });
  });

  describe('cleanup', () => {
    it('should cancel all pending requests', async () => {
      const promise1 = handler.createPermissionRequest({
        sessionId: 'session1',
        toolCall: {
          toolCallId: 'tool_1',
        },
        options: [
          {
            optionId: 'allow',
            name: 'Allow',
            kind: 'allow_once',
          },
        ],
      });

      const promise2 = handler.createPermissionRequest({
        sessionId: 'session2',
        toolCall: {
          toolCallId: 'tool_2',
        },
        options: [
          {
            optionId: 'allow',
            name: 'Allow',
            kind: 'allow_once',
          },
        ],
      });

      expect(handler.getMetrics().pendingRequests).toBe(2);

      await handler.cleanup();

      expect(handler.getMetrics().pendingRequests).toBe(0);

      const outcome1 = await promise1;
      const outcome2 = await promise2;

      expect(outcome1).toEqual({ outcome: 'cancelled' });
      expect(outcome2).toEqual({ outcome: 'cancelled' });
    });
  });
});
