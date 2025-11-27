/**
 * Unit tests for Session Mode operations in CursorAgentAdapter
 *
 * Tests the agent-initiated mode change logic including:
 * - current_mode_update notification sending
 * - Graceful handling of notification failures
 * - Behavior when agentConnection is not available
 *
 * Per ACP spec: https://agentclientprotocol.com/protocol/session-modes#from-the-agent
 */

import { CursorAgentAdapter } from '../../../src/adapter/cursor-agent-adapter';
import type { AdapterConfig, Logger, SessionData } from '../../../src/types';
import type {
  SetSessionModeRequest,
  SetSessionModeResponse,
  SessionNotification,
  AgentSideConnection,
} from '@agentclientprotocol/sdk';
import { DEFAULT_CONFIG } from '../../../src';
import { createLogger } from '../../../src/utils/logger';
import { testHelpers } from '../../setup';

// Mock CursorCliBridge
jest.mock('../../../src/cursor/cli-bridge', () => ({
  CursorCliBridge: jest.fn().mockImplementation(() => ({
    checkAuthentication: jest.fn().mockResolvedValue({
      authenticated: true,
      user: 'test-user',
    }),
    getVersion: jest.fn().mockResolvedValue('1.0.0-mock'),
    executeCommand: jest.fn().mockResolvedValue({
      success: true,
      stdout: '',
      stderr: '',
    }),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

describe('CursorAgentAdapter - Session Mode Notifications', () => {
  let adapter: CursorAgentAdapter;
  let mockConfig: AdapterConfig;
  let mockLogger: Logger;
  let tempDir: string;
  let sessionId: string;
  let mockAgentConnection: jest.Mocked<AgentSideConnection>;

  beforeEach(async () => {
    jest.clearAllMocks();

    mockConfig = {
      ...DEFAULT_CONFIG,
      maxSessions: 5,
      sessionTimeout: 60000,
      tools: {
        filesystem: { enabled: false },
        terminal: { enabled: false, maxProcesses: 3 },
      },
    };

    mockLogger = createLogger({ level: 'error', silent: true });
    tempDir = await testHelpers.createTempDir();
    mockConfig.sessionDir = tempDir;

    adapter = new CursorAgentAdapter(mockConfig, { logger: mockLogger });
    await adapter.initialize();

    // Create a test session
    const sessionManager = (adapter as any).sessionManager;
    const session: SessionData = await sessionManager.createSession({
      name: 'Test Session',
    });
    sessionId = session.id;

    // Create mock agent connection
    mockAgentConnection = {
      sessionUpdate: jest.fn().mockResolvedValue(undefined),
      requestPermission: jest.fn(),
      readTextFile: jest.fn(),
      writeTextFile: jest.fn(),
      createTerminal: jest.fn(),
      extMethod: jest.fn(),
      extNotification: jest.fn(),
      signal: new AbortController().signal,
      closed: Promise.resolve(),
    } as any;
  });

  afterEach(async () => {
    await adapter.shutdown();
    await testHelpers.cleanupTempDir(tempDir);
  });

  describe('current_mode_update notification', () => {
    it('should send notification when agent changes mode', async () => {
      // Arrange
      (adapter as any).agentConnection = mockAgentConnection;
      const params: SetSessionModeRequest = {
        sessionId,
        modeId: 'code',
      };

      // Act
      await (adapter as any).handleSetSessionModeFromAgent(params);

      // Assert
      expect(mockAgentConnection.sessionUpdate).toHaveBeenCalledTimes(1);
      expect(mockAgentConnection.sessionUpdate).toHaveBeenCalledWith({
        sessionId,
        update: {
          sessionUpdate: 'current_mode_update',
          currentModeId: 'code',
        },
      });
    });

    it('should include correct currentModeId in notification', async () => {
      // Arrange
      (adapter as any).agentConnection = mockAgentConnection;
      const params: SetSessionModeRequest = {
        sessionId,
        modeId: 'architect',
      };

      // Act
      await (adapter as any).handleSetSessionModeFromAgent(params);

      // Assert
      const notificationCall =
        mockAgentConnection.sessionUpdate.mock.calls[0][0];
      expect(notificationCall.update.currentModeId).toBe('architect');
    });

    it('should send notification with correct structure per ACP spec', async () => {
      // Arrange
      (adapter as any).agentConnection = mockAgentConnection;
      const params: SetSessionModeRequest = {
        sessionId,
        modeId: 'code',
      };

      // Act
      await (adapter as any).handleSetSessionModeFromAgent(params);

      // Assert
      const notification = mockAgentConnection.sessionUpdate.mock
        .calls[0][0] as SessionNotification;
      expect(notification).toHaveProperty('sessionId');
      expect(notification).toHaveProperty('update');
      expect(notification.update).toHaveProperty('sessionUpdate');
      expect(notification.update).toHaveProperty('currentModeId');
      expect(notification.update.sessionUpdate).toBe('current_mode_update');
    });

    it('should send notification for each mode change', async () => {
      // Arrange
      (adapter as any).agentConnection = mockAgentConnection;

      // Act - Change mode multiple times
      await (adapter as any).handleSetSessionModeFromAgent({
        sessionId,
        modeId: 'code',
      });
      await (adapter as any).handleSetSessionModeFromAgent({
        sessionId,
        modeId: 'architect',
      });
      await (adapter as any).handleSetSessionModeFromAgent({
        sessionId,
        modeId: 'ask',
      });

      // Assert
      expect(mockAgentConnection.sessionUpdate).toHaveBeenCalledTimes(3);
    });

    it('should send notification even when switching to same mode', async () => {
      // Arrange
      (adapter as any).agentConnection = mockAgentConnection;

      // Act - Switch to current mode
      await (adapter as any).handleSetSessionModeFromAgent({
        sessionId,
        modeId: 'ask', // Default mode
      });

      // Assert - Notification should still be sent
      expect(mockAgentConnection.sessionUpdate).toHaveBeenCalledTimes(1);
    });
  });

  describe('notification failure handling', () => {
    it('should succeed mode change even if notification fails', async () => {
      // Arrange
      mockAgentConnection.sessionUpdate.mockRejectedValueOnce(
        new Error('Network error')
      );
      (adapter as any).agentConnection = mockAgentConnection;
      const params: SetSessionModeRequest = {
        sessionId,
        modeId: 'code',
      };

      // Act
      const result = await (adapter as any).handleSetSessionModeFromAgent(
        params
      );

      // Assert - Mode change should succeed
      expect(result).toBeDefined();
      expect(result._meta?.newMode).toBe('code');

      // Verify mode was actually changed
      const sessionManager = (adapter as any).sessionManager;
      const currentMode = sessionManager.getSessionMode(sessionId);
      expect(currentMode).toBe('code');
    });

    it('should log warning when notification fails', async () => {
      // Arrange
      const warnSpy = jest.spyOn(mockLogger, 'warn');
      mockAgentConnection.sessionUpdate.mockRejectedValueOnce(
        new Error('Connection timeout')
      );
      (adapter as any).agentConnection = mockAgentConnection;
      const params: SetSessionModeRequest = {
        sessionId,
        modeId: 'architect',
      };

      // Act
      await (adapter as any).handleSetSessionModeFromAgent(params);

      // Assert
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'Failed to send current_mode_update notification'
        ),
        expect.objectContaining({
          sessionId,
          modeId: 'architect',
        })
      );
    });

    it('should not throw error when notification fails', async () => {
      // Arrange
      mockAgentConnection.sessionUpdate.mockRejectedValueOnce(
        new Error('Network error')
      );
      (adapter as any).agentConnection = mockAgentConnection;
      const params: SetSessionModeRequest = {
        sessionId,
        modeId: 'code',
      };

      // Act & Assert - Should not throw
      await expect(
        (adapter as any).handleSetSessionModeFromAgent(params)
      ).resolves.not.toThrow();
    });

    it('should return proper response even when notification fails', async () => {
      // Arrange
      mockAgentConnection.sessionUpdate.mockRejectedValueOnce(
        new Error('Network error')
      );
      (adapter as any).agentConnection = mockAgentConnection;
      const params: SetSessionModeRequest = {
        sessionId,
        modeId: 'code',
      };

      // Act
      const result = await (adapter as any).handleSetSessionModeFromAgent(
        params
      );

      // Assert - Response should be valid
      expect(result).toBeDefined();
      expect(result._meta).toBeDefined();
      expect(result._meta?.previousMode).toBe('ask');
      expect(result._meta?.newMode).toBe('code');
      expect(result._meta?.changedAt).toBeDefined();
    });

    it('should handle multiple notification failures gracefully', async () => {
      // Arrange
      mockAgentConnection.sessionUpdate.mockRejectedValue(
        new Error('Persistent network error')
      );
      (adapter as any).agentConnection = mockAgentConnection;

      // Act - Try multiple mode changes
      const result1 = await (adapter as any).handleSetSessionModeFromAgent({
        sessionId,
        modeId: 'code',
      });
      const result2 = await (adapter as any).handleSetSessionModeFromAgent({
        sessionId,
        modeId: 'architect',
      });

      // Assert - Both should succeed
      expect(result1._meta?.newMode).toBe('code');
      expect(result2._meta?.newMode).toBe('architect');
    });

    it('should include error details in warning log', async () => {
      // Arrange
      const warnSpy = jest.spyOn(mockLogger, 'warn');
      const testError = new Error('Connection timeout');
      mockAgentConnection.sessionUpdate.mockRejectedValueOnce(testError);
      (adapter as any).agentConnection = mockAgentConnection;

      // Act
      await (adapter as any).handleSetSessionModeFromAgent({
        sessionId,
        modeId: 'code',
      });

      // Assert
      expect(warnSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          error: testError,
        })
      );
    });
  });

  describe('agentConnection availability', () => {
    it('should skip notification when agentConnection is not available', async () => {
      // Arrange - No agent connection
      (adapter as any).agentConnection = null;
      const params: SetSessionModeRequest = {
        sessionId,
        modeId: 'code',
      };

      // Act
      await (adapter as any).handleSetSessionModeFromAgent(params);

      // Assert - No notification should be sent
      expect(mockAgentConnection.sessionUpdate).not.toHaveBeenCalled();
    });

    it('should succeed mode change when agentConnection is not available', async () => {
      // Arrange
      (adapter as any).agentConnection = null;
      const params: SetSessionModeRequest = {
        sessionId,
        modeId: 'architect',
      };

      // Act
      const result = await (adapter as any).handleSetSessionModeFromAgent(
        params
      );

      // Assert
      expect(result).toBeDefined();
      expect(result._meta?.newMode).toBe('architect');

      // Verify mode was actually changed
      const sessionManager = (adapter as any).sessionManager;
      const currentMode = sessionManager.getSessionMode(sessionId);
      expect(currentMode).toBe('architect');
    });

    it('should not log debug message when agentConnection is not available', async () => {
      // Arrange
      const debugSpy = jest.spyOn(mockLogger, 'debug');
      (adapter as any).agentConnection = null;

      // Act
      await (adapter as any).handleSetSessionModeFromAgent({
        sessionId,
        modeId: 'code',
      });

      // Assert - Debug log should not mention notification
      const debugCalls = debugSpy.mock.calls.filter((call) =>
        call[0].includes('current_mode_update notification')
      );
      expect(debugCalls.length).toBe(0);
    });

    it('should not log warning when agentConnection is not available', async () => {
      // Arrange
      const warnSpy = jest.spyOn(mockLogger, 'warn');
      (adapter as any).agentConnection = null;

      // Act
      await (adapter as any).handleSetSessionModeFromAgent({
        sessionId,
        modeId: 'code',
      });

      // Assert - No warnings about notification failures
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('should handle transition from no connection to connection', async () => {
      // Arrange - Start with no connection
      (adapter as any).agentConnection = null;

      // Act - Change mode without connection
      await (adapter as any).handleSetSessionModeFromAgent({
        sessionId,
        modeId: 'code',
      });

      // Assert - No notification sent
      expect(mockAgentConnection.sessionUpdate).not.toHaveBeenCalled();

      // Now add connection
      (adapter as any).agentConnection = mockAgentConnection;

      // Act - Change mode with connection
      await (adapter as any).handleSetSessionModeFromAgent({
        sessionId,
        modeId: 'architect',
      });

      // Assert - Notification should be sent now
      expect(mockAgentConnection.sessionUpdate).toHaveBeenCalledTimes(1);
    });

    it('should handle undefined agentConnection', async () => {
      // Arrange
      (adapter as any).agentConnection = undefined;

      // Act & Assert - Should not throw
      await expect(
        (adapter as any).handleSetSessionModeFromAgent({
          sessionId,
          modeId: 'code',
        })
      ).resolves.not.toThrow();
    });
  });

  describe('notification content verification', () => {
    it('should use sessionUpdate field with value current_mode_update', async () => {
      // Arrange
      (adapter as any).agentConnection = mockAgentConnection;

      // Act
      await (adapter as any).handleSetSessionModeFromAgent({
        sessionId,
        modeId: 'code',
      });

      // Assert
      const notification = mockAgentConnection.sessionUpdate.mock.calls[0][0];
      expect(notification.update.sessionUpdate).toBe('current_mode_update');
    });

    it('should include sessionId in notification', async () => {
      // Arrange
      (adapter as any).agentConnection = mockAgentConnection;

      // Act
      await (adapter as any).handleSetSessionModeFromAgent({
        sessionId,
        modeId: 'code',
      });

      // Assert
      const notification = mockAgentConnection.sessionUpdate.mock.calls[0][0];
      expect(notification.sessionId).toBe(sessionId);
    });

    it('should not include previousMode in notification', async () => {
      // Arrange
      (adapter as any).agentConnection = mockAgentConnection;

      // Act
      await (adapter as any).handleSetSessionModeFromAgent({
        sessionId,
        modeId: 'code',
      });

      // Assert - Per ACP spec, only currentModeId is in notification
      const notification = mockAgentConnection.sessionUpdate.mock.calls[0][0];
      expect(notification.update).not.toHaveProperty('previousMode');
      expect(notification.update).not.toHaveProperty('previousModeId');
    });

    it('should use currentModeId not modeId in notification', async () => {
      // Arrange
      (adapter as any).agentConnection = mockAgentConnection;

      // Act
      await (adapter as any).handleSetSessionModeFromAgent({
        sessionId,
        modeId: 'architect',
      });

      // Assert - Per ACP spec, field is currentModeId
      const notification = mockAgentConnection.sessionUpdate.mock.calls[0][0];
      expect(notification.update).toHaveProperty('currentModeId');
      expect(notification.update).not.toHaveProperty('modeId');
      expect(notification.update.currentModeId).toBe('architect');
    });
  });

  describe('integration with mode change', () => {
    it('should send notification after mode is successfully changed', async () => {
      // Arrange
      const sessionManager = (adapter as any).sessionManager;
      const initialMode = sessionManager.getSessionMode(sessionId);
      (adapter as any).agentConnection = mockAgentConnection;

      // Act
      await (adapter as any).handleSetSessionModeFromAgent({
        sessionId,
        modeId: 'code',
      });

      // Assert - Mode should be changed before notification
      const finalMode = sessionManager.getSessionMode(sessionId);
      expect(initialMode).toBe('ask');
      expect(finalMode).toBe('code');
      expect(mockAgentConnection.sessionUpdate).toHaveBeenCalled();
    });

    it('should not send notification if mode change fails', async () => {
      // Arrange
      (adapter as any).agentConnection = mockAgentConnection;

      // Act & Assert - Try to set invalid mode
      await expect(
        (adapter as any).handleSetSessionModeFromAgent({
          sessionId,
          modeId: 'invalid-mode',
        })
      ).rejects.toThrow();

      // Notification should not be sent for failed mode change
      expect(mockAgentConnection.sessionUpdate).not.toHaveBeenCalled();
    });

    it('should return response with metadata after notification', async () => {
      // Arrange
      (adapter as any).agentConnection = mockAgentConnection;

      // Act
      const result = (await (adapter as any).handleSetSessionModeFromAgent({
        sessionId,
        modeId: 'code',
      })) as SetSessionModeResponse;

      // Assert - Response should include metadata
      expect(result._meta).toBeDefined();
      expect(result._meta?.previousMode).toBe('ask');
      expect(result._meta?.newMode).toBe('code');
      expect(result._meta?.changedAt).toBeDefined();
      expect(new Date(result._meta!.changedAt!).getTime()).toBeLessThanOrEqual(
        Date.now()
      );
    });
  });
});
