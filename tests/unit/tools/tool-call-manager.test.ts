/**
 * Unit tests for ToolCallManager
 *
 * Tests tool call tracking, reporting, and lifecycle management.
 */

import { ToolCallManager } from '../../../src/tools/tool-call-manager';
import type {
  Logger,
  AcpNotification,
  PermissionOutcome,
  RequestPermissionParams,
} from '../../../src/types';

describe('ToolCallManager', () => {
  let manager: ToolCallManager;
  let mockLogger: Logger;
  let sentNotifications: AcpNotification[];
  let mockRequestPermission: jest.Mock<
    Promise<PermissionOutcome>,
    [RequestPermissionParams]
  >;

  beforeEach(() => {
    mockLogger = {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
    };

    sentNotifications = [];

    mockRequestPermission = jest.fn();

    manager = new ToolCallManager({
      logger: mockLogger,
      sendNotification: (notification: AcpNotification) => {
        sentNotifications.push(notification);
      },
      requestPermission: mockRequestPermission,
    });
  });

  afterEach(async () => {
    await manager.cleanup();
  });

  describe('reportToolCall', () => {
    it('should generate unique tool call IDs', async () => {
      const id1 = await manager.reportToolCall('session1', 'read_file', {
        title: 'Reading file',
        kind: 'read',
      });

      const id2 = await manager.reportToolCall('session1', 'read_file', {
        title: 'Reading file',
        kind: 'read',
      });

      expect(id1).not.toBe(id2);
      expect(id1).toMatch(/^tool_read_file_\d+_\d+$/);
      expect(id2).toMatch(/^tool_read_file_\d+_\d+$/);
    });

    it('should send tool_call notification', async () => {
      const toolCallId = await manager.reportToolCall('session1', 'search', {
        title: 'Searching codebase',
        kind: 'search',
        rawInput: { query: 'test' },
      });

      expect(sentNotifications).toHaveLength(1);
      // Now includes _meta fields
      // Defaults to in_progress
      expect(sentNotifications[0]!).toMatchObject({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'session1',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId,
            title: 'Searching codebase',
            kind: 'search',
            status: 'in_progress',
            rawInput: { query: 'test' },
            _meta: {
              toolName: 'search',
              source: 'tool-call-manager',
            },
          },
          _meta: {
            notificationSequence: expect.any(Number),
          },
        },
      });

      // Verify timestamps exist and are ISO strings
      expect(sentNotifications[0]!.params.update._meta.startTime).toMatch(
        /^\d{4}-\d{2}-\d{2}T/
      );
      expect(sentNotifications[0]!.params._meta.timestamp).toMatch(
        /^\d{4}-\d{2}-\d{2}T/
      );
    });

    it('should include locations if provided', async () => {
      const locations = [
        { path: '/path/to/file.ts', line: 42 },
        { path: '/path/to/other.ts' },
      ];

      const toolCallId = await manager.reportToolCall('session1', 'read', {
        title: 'Reading files',
        kind: 'read',
        locations,
      });

      expect(sentNotifications[0]!.params.update).toMatchObject({
        locations,
      });
    });

    it('should default to in_progress status', async () => {
      // Changed default from pending to in_progress
      await manager.reportToolCall('session1', 'test', {
        title: 'Test',
        kind: 'other',
      });

      expect(sentNotifications[0]!.params.update.status).toBe('in_progress');
    });

    it('should allow custom initial status', async () => {
      await manager.reportToolCall('session1', 'test', {
        title: 'Test',
        kind: 'other',
        status: 'in_progress',
      });

      expect(sentNotifications[0]!.params.update.status).toBe('in_progress');
    });
  });

  describe('updateToolCall', () => {
    it('should send tool_call_update notification', async () => {
      const toolCallId = await manager.reportToolCall('session1', 'test', {
        title: 'Test',
        kind: 'other',
      });

      sentNotifications = []; // Clear

      await manager.updateToolCall('session1', toolCallId, {
        status: 'in_progress',
        title: 'Updated title',
      });

      expect(sentNotifications).toHaveLength(1);
      // Now includes _meta fields
      expect(sentNotifications[0]!).toMatchObject({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'session1',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'in_progress',
            title: 'Updated title',
            _meta: {
              source: 'tool-call-manager',
            },
          },
          _meta: {
            notificationSequence: expect.any(Number),
          },
        },
      });

      // Verify timestamps
      expect(sentNotifications[0]!.params.update._meta.updateTime).toMatch(
        /^\d{4}-\d{2}-\d{2}T/
      );
      expect(sentNotifications[0]!.params._meta.timestamp).toMatch(
        /^\d{4}-\d{2}-\d{2}T/
      );
    });

    it('should only include provided fields in update', async () => {
      const toolCallId = await manager.reportToolCall('session1', 'test', {
        title: 'Test',
        kind: 'other',
      });

      sentNotifications = [];

      await manager.updateToolCall('session1', toolCallId, {
        status: 'completed',
      });

      const update = sentNotifications[0]!.params.update;
      expect(update).toHaveProperty('status');
      expect(update).not.toHaveProperty('title');
      expect(update).not.toHaveProperty('content');
    });

    it('should warn if tool call not found', async () => {
      await manager.updateToolCall('session1', 'nonexistent', {
        status: 'completed',
      });

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Tool call not found for update',
        expect.any(Object)
      );
    });

    it('should update content', async () => {
      const toolCallId = await manager.reportToolCall('session1', 'test', {
        title: 'Test',
        kind: 'other',
      });

      sentNotifications = [];

      const content = [
        {
          type: 'content' as const,
          content: {
            type: 'text' as const,
            text: 'Result text',
          },
        },
      ];

      await manager.updateToolCall('session1', toolCallId, {
        content,
      });

      expect(sentNotifications[0]!.params.update.content).toEqual(content);
    });

    it('should mark end time when completed', async () => {
      const toolCallId = await manager.reportToolCall('session1', 'test', {
        title: 'Test',
        kind: 'other',
      });

      const info1 = manager.getToolCallInfo(toolCallId);
      expect(info1?.endTime).toBeUndefined();

      await manager.updateToolCall('session1', toolCallId, {
        status: 'completed',
      });

      const info2 = manager.getToolCallInfo(toolCallId);
      expect(info2?.endTime).toBeInstanceOf(Date);
    });

    it('should mark end time when failed', async () => {
      const toolCallId = await manager.reportToolCall('session1', 'test', {
        title: 'Test',
        kind: 'other',
      });

      await manager.updateToolCall('session1', toolCallId, {
        status: 'failed',
      });

      const info = manager.getToolCallInfo(toolCallId);
      expect(info?.endTime).toBeInstanceOf(Date);
    });
  });

  describe('completeToolCall', () => {
    it('should update status to completed', async () => {
      const toolCallId = await manager.reportToolCall('session1', 'test', {
        title: 'Test',
        kind: 'other',
      });

      sentNotifications = [];

      await manager.completeToolCall('session1', toolCallId, {
        rawOutput: { result: 'success' },
      });

      expect(sentNotifications[0]!.params.update).toMatchObject({
        status: 'completed',
        rawOutput: { result: 'success' },
      });
    });

    it('should include content if provided', async () => {
      const toolCallId = await manager.reportToolCall('session1', 'test', {
        title: 'Test',
        kind: 'other',
      });

      sentNotifications = [];

      const content = [
        {
          type: 'content' as const,
          content: {
            type: 'text' as const,
            text: 'Completed successfully',
          },
        },
      ];

      await manager.completeToolCall('session1', toolCallId, {
        content,
      });

      expect(sentNotifications[0]!.params.update.content).toEqual(content);
    });

    it('should auto-cleanup after delay', async () => {
      jest.useFakeTimers();

      const toolCallId = await manager.reportToolCall('session1', 'test', {
        title: 'Test',
        kind: 'other',
      });

      await manager.completeToolCall('session1', toolCallId, {});

      expect(manager.getToolCallInfo(toolCallId)).toBeDefined();

      jest.advanceTimersByTime(30000);

      expect(manager.getToolCallInfo(toolCallId)).toBeUndefined();

      jest.useRealTimers();
    });
  });

  describe('failToolCall', () => {
    it('should update status to failed', async () => {
      const toolCallId = await manager.reportToolCall('session1', 'test', {
        title: 'Test',
        kind: 'other',
      });

      sentNotifications = [];

      await manager.failToolCall('session1', toolCallId, {
        error: 'Something went wrong',
      });

      expect(sentNotifications[0]!.params.update).toMatchObject({
        status: 'failed',
        title: 'Tool execution failed',
      });
    });

    it('should include error in content', async () => {
      const toolCallId = await manager.reportToolCall('session1', 'test', {
        title: 'Test',
        kind: 'other',
      });

      sentNotifications = [];

      await manager.failToolCall('session1', toolCallId, {
        error: 'File not found',
      });

      const content = sentNotifications[0]!.params.update.content;
      expect(content).toHaveLength(1);
      expect(content![0]).toEqual({
        type: 'content',
        content: {
          type: 'text',
          text: 'Error: File not found',
        },
      });
    });

    it('should use custom title if provided', async () => {
      const toolCallId = await manager.reportToolCall('session1', 'test', {
        title: 'Test',
        kind: 'other',
      });

      sentNotifications = [];

      await manager.failToolCall('session1', toolCallId, {
        title: 'Custom failure message',
        error: 'Error details',
      });

      expect(sentNotifications[0]!.params.update.title).toBe(
        'Custom failure message'
      );
    });

    it('should handle undefined rawOutput correctly', async () => {
      const toolCallId = await manager.reportToolCall('session1', 'test', {
        title: 'Test',
        kind: 'other',
      });

      sentNotifications = [];

      await manager.failToolCall('session1', toolCallId, {
        error: 'Error',
        rawOutput: undefined,
      });

      const update = sentNotifications[0]!.params.update;
      expect(update).not.toHaveProperty('rawOutput');
    });
  });

  describe('requestToolPermission', () => {
    it('should call requestPermission handler', async () => {
      const toolCallId = await manager.reportToolCall('session1', 'edit', {
        title: 'Editing file',
        kind: 'edit',
      });

      mockRequestPermission.mockResolvedValue({
        outcome: 'selected',
        optionId: 'allow-once',
      });

      const options = [
        {
          optionId: 'allow-once',
          name: 'Allow once',
          kind: 'allow_once' as const,
        },
        {
          optionId: 'reject-once',
          name: 'Reject',
          kind: 'reject_once' as const,
        },
      ];

      const outcome = await manager.requestToolPermission(
        'session1',
        toolCallId,
        options
      );

      expect(mockRequestPermission).toHaveBeenCalledWith({
        sessionId: 'session1',
        toolCall: expect.objectContaining({
          toolCallId,
        }),
        options,
      });

      expect(outcome).toEqual({
        outcome: 'selected',
        optionId: 'allow-once',
      });
    });

    it('should default to reject if no handler provided', async () => {
      const managerWithoutPermissions = new ToolCallManager({
        logger: mockLogger,
        sendNotification: () => {},
      });

      const toolCallId = await managerWithoutPermissions.reportToolCall(
        'session1',
        'edit',
        {
          title: 'Editing file',
          kind: 'edit',
        }
      );

      const outcome = await managerWithoutPermissions.requestToolPermission(
        'session1',
        toolCallId,
        [
          {
            optionId: 'allow-once',
            name: 'Allow',
            kind: 'allow_once',
          },
        ]
      );

      expect(outcome).toEqual({
        outcome: 'selected',
        optionId: 'allow-once',
      });

      expect(mockLogger.warn).toHaveBeenCalled();

      await managerWithoutPermissions.cleanup();
    });

    it('should default to reject on error', async () => {
      const toolCallId = await manager.reportToolCall('session1', 'edit', {
        title: 'Editing file',
        kind: 'edit',
      });

      mockRequestPermission.mockRejectedValue(new Error('Permission error'));

      const outcome = await manager.requestToolPermission(
        'session1',
        toolCallId,
        [
          {
            optionId: 'reject-once',
            name: 'Reject',
            kind: 'reject_once',
          },
        ]
      );

      expect(outcome).toEqual({
        outcome: 'selected',
        optionId: 'reject-once',
      });

      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should handle undefined outcome', async () => {
      const toolCallId = await manager.reportToolCall('session1', 'edit', {
        title: 'Editing file',
        kind: 'edit',
      });

      mockRequestPermission.mockResolvedValue(undefined as any);

      const outcome = await manager.requestToolPermission(
        'session1',
        toolCallId,
        [
          {
            optionId: 'reject-once',
            name: 'Reject',
            kind: 'reject_once',
          },
        ]
      );

      expect(outcome).toEqual({
        outcome: 'selected',
        optionId: 'reject-once',
      });

      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  describe('getToolCallInfo', () => {
    it('should return tool call info', async () => {
      const toolCallId = await manager.reportToolCall('session1', 'test', {
        title: 'Test',
        kind: 'other',
      });

      const info = manager.getToolCallInfo(toolCallId);

      expect(info).toMatchObject({
        toolCallId,
        sessionId: 'session1',
        toolName: 'test',
        status: 'in_progress', // Phase 3: Default changed to in_progress
      });
      expect(info?.startTime).toBeInstanceOf(Date);
    });

    it('should return undefined for non-existent tool call', () => {
      const info = manager.getToolCallInfo('nonexistent');
      expect(info).toBeUndefined();
    });
  });

  describe('getSessionToolCalls', () => {
    it('should return all tool calls for a session', async () => {
      await manager.reportToolCall('session1', 'tool1', {
        title: 'Tool 1',
        kind: 'read',
      });
      await manager.reportToolCall('session1', 'tool2', {
        title: 'Tool 2',
        kind: 'edit',
      });
      await manager.reportToolCall('session2', 'tool3', {
        title: 'Tool 3',
        kind: 'search',
      });

      const session1Calls = manager.getSessionToolCalls('session1');
      expect(session1Calls).toHaveLength(2);
      expect(session1Calls.every((c) => c.sessionId === 'session1')).toBe(true);

      const session2Calls = manager.getSessionToolCalls('session2');
      expect(session2Calls).toHaveLength(1);
    });

    it('should return empty array for session with no tool calls', () => {
      const calls = manager.getSessionToolCalls('nonexistent');
      expect(calls).toEqual([]);
    });
  });

  describe('cancelSessionToolCalls', () => {
    it('should cancel all active tool calls for a session', async () => {
      const id1 = await manager.reportToolCall('session1', 'tool1', {
        title: 'Tool 1',
        kind: 'read',
        status: 'in_progress',
      });
      const id2 = await manager.reportToolCall('session1', 'tool2', {
        title: 'Tool 2',
        kind: 'edit',
        status: 'pending',
      });

      sentNotifications = [];

      await manager.cancelSessionToolCalls('session1');

      // Should send updates for each tool call
      expect(sentNotifications.length).toBeGreaterThanOrEqual(2);

      // Tool calls should be removed
      expect(manager.getToolCallInfo(id1)).toBeUndefined();
      expect(manager.getToolCallInfo(id2)).toBeUndefined();
    });

    it('should not cancel completed tool calls', async () => {
      const id1 = await manager.reportToolCall('session1', 'tool1', {
        title: 'Tool 1',
        kind: 'read',
      });

      await manager.completeToolCall('session1', id1, {});

      sentNotifications = [];

      await manager.cancelSessionToolCalls('session1');

      // Should not send additional updates for completed calls
      expect(sentNotifications).toHaveLength(0);
    });
  });

  describe('getMetrics', () => {
    it('should return tool call metrics', async () => {
      await manager.reportToolCall('session1', 'tool1', {
        title: 'Tool 1',
        kind: 'read',
        status: 'in_progress',
      });

      const id2 = await manager.reportToolCall('session1', 'tool2', {
        title: 'Tool 2',
        kind: 'edit',
        status: 'pending',
      });

      await manager.completeToolCall('session1', id2, {});

      const metrics = manager.getMetrics();

      expect(metrics).toEqual({
        activeToolCalls: 2,
        statusCounts: {
          pending: 0,
          in_progress: 1,
          completed: 1,
          failed: 0,
        },
        totalToolCalls: expect.any(Number),
      });
    });
  });

  describe('cleanup', () => {
    it('should clear all tool calls', async () => {
      await manager.reportToolCall('session1', 'tool1', {
        title: 'Tool 1',
        kind: 'read',
      });
      await manager.reportToolCall('session1', 'tool2', {
        title: 'Tool 2',
        kind: 'edit',
      });

      expect(manager.getMetrics().activeToolCalls).toBe(2);

      await manager.cleanup();

      expect(manager.getMetrics().activeToolCalls).toBe(0);
    });
  });
});
