/**
 * Tests for SessionManager
 *
 * Tests session lifecycle management including creation, persistence,
 * loading, updating, and cleanup of conversation sessions.
 */

import { SessionManager } from '../../../src/session/manager';
import { createLogger } from '../../../src/utils/logger';
import { DEFAULT_CONFIG } from '../../../src';
import type {
  AdapterConfig,
  Logger,
  SessionMetadata,
  SessionData,
  ConversationMessage,
} from '../../../src/types';
import { SessionError } from '../../../src/types';
import { testHelpers, TEST_CONSTANTS } from '../../setup';

describe('SessionManager', () => {
  let manager: SessionManager;
  let mockConfig: AdapterConfig;
  let mockLogger: Logger;
  let tempDir: string;

  beforeEach(async () => {
    mockConfig = {
      ...DEFAULT_CONFIG,
      maxSessions: 5, // Lower limit for testing
      sessionTimeout: 60000, // 1 minute for testing
    };
    mockLogger = createLogger({ level: 'error', silent: true });
    tempDir = await testHelpers.createTempDir();
    mockConfig.sessionDir = tempDir;

    manager = new SessionManager(mockConfig, mockLogger);
  });

  afterEach(async () => {
    await manager.cleanup();
    await testHelpers.cleanupTempDir(tempDir);
  });

  describe('createSession', () => {
    it('should create session with unique ID', async () => {
      // Act
      const session = await manager.createSession();

      // Assert
      expect(session.id).toBeValidSessionId();
      expect(session.metadata.name).toMatch(/^Session [a-f0-9]{8}$/);
      expect(session.conversation).toEqual([]);
      expect(session.state.messageCount).toBe(0);
      expect(session.createdAt).toBeInstanceOf(Date);
      expect(session.updatedAt).toBeInstanceOf(Date);
    });

    it('should persist session metadata', async () => {
      // Arrange
      const metadata: SessionMetadata = {
        name: 'Test Session',
        description: 'A test session',
        tags: ['test', 'example'],
        projectPath: '/test/project',
      };

      // Act
      const session = await manager.createSession(metadata);

      // Assert
      expect(session.metadata.name).toBe('Test Session');
      expect(session.metadata.description).toBe('A test session');
      expect(session.metadata.tags).toEqual(['test', 'example']);
      expect(session.metadata.projectPath).toBe('/test/project');
    });

    it('should handle empty metadata gracefully', async () => {
      // Act
      const session = await manager.createSession({});

      // Assert
      expect(session.id).toBeValidSessionId();
      expect(session.metadata.name).toBeDefined();
      expect(session.conversation).toEqual([]);
    });

    it('should enforce session limits', async () => {
      // Arrange - Create sessions up to the limit
      for (let i = 0; i < mockConfig.maxSessions; i++) {
        await manager.createSession({ name: `Session ${i}` });
      }

      // Mock one session as expired to allow cleanup
      const sessions = Array.from((manager as any).sessions.values());
      if (sessions.length > 0) {
        sessions[0].state.lastActivity = new Date(
          Date.now() - mockConfig.sessionTimeout - 1000
        );
      }

      // Act & Assert - Creating one more should trigger cleanup and succeed
      const session = await manager.createSession({ name: 'Limit Test' });
      expect(session).toBeDefined();
      expect(session.metadata.name).toBe('Limit Test');
    });

    it('should throw error when cleanup fails and still at limit', async () => {
      // Arrange - Create sessions up to the limit with recent timestamps
      const sessions = [];
      for (let i = 0; i < mockConfig.maxSessions; i++) {
        const session = await manager.createSession({ name: `Session ${i}` });
        sessions.push(session);
      }

      // Mock all sessions as recently active to prevent cleanup
      jest.spyOn(Date, 'now').mockReturnValue(Date.now());

      // Act & Assert
      await expect(manager.createSession()).rejects.toThrow(SessionError);
      await expect(manager.createSession()).rejects.toThrow(
        'Maximum number of sessions reached'
      );
    });

    it('should generate unique IDs for concurrent sessions', async () => {
      // Arrange - Use a higher limit for concurrent testing
      const highLimitConfig = { ...mockConfig, maxSessions: 15 };
      const concurrentManager = new SessionManager(highLimitConfig, mockLogger);

      // Act
      const promises = Array.from({ length: 10 }, () =>
        concurrentManager.createSession()
      );
      const sessions = await Promise.all(promises);

      // Assert
      const ids = sessions.map((s) => s.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(10);

      // Cleanup
      await concurrentManager.cleanup();
    });
  });

  describe('loadSession', () => {
    it('should load existing session from memory', async () => {
      // Arrange
      const created = await manager.createSession({ name: 'Memory Test' });

      // Act
      const loaded = await manager.loadSession(created.id);

      // Assert
      expect(loaded.id).toBe(created.id);
      expect(loaded.metadata.name).toBe('Memory Test');
    });

    it('should update last activity when loading session', async () => {
      // Arrange
      const created = await manager.createSession();
      const originalActivity = created.state.lastActivity;

      // Wait a bit
      await testHelpers.wait(10);

      // Act
      const loaded = await manager.loadSession(created.id);

      // Assert
      expect(loaded.state.lastActivity.getTime()).toBeGreaterThan(
        originalActivity.getTime()
      );
    });

    it('should throw error for non-existent session', async () => {
      // Arrange
      const nonExistentId = 'non-existent-session-id';

      // Act & Assert
      await expect(manager.loadSession(nonExistentId)).rejects.toThrow(
        SessionError
      );
      await expect(manager.loadSession(nonExistentId)).rejects.toThrow(
        `Session not found: ${nonExistentId}`
      );
    });

    it('should load session from disk when not in memory', async () => {
      // Arrange
      const sessionId = testHelpers.generateTestSessionId();

      // Mock loadSessionFromDisk to return a session
      const mockSession: SessionData = {
        id: sessionId,
        metadata: { name: 'Disk Test' },
        conversation: [],
        state: {
          lastActivity: new Date(),
          messageCount: 0,
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest
        .spyOn(manager as any, 'loadSessionFromDisk')
        .mockResolvedValue(mockSession);

      // Act
      const loaded = await manager.loadSession(sessionId);

      // Assert
      expect(loaded.id).toBe(sessionId);
      expect(loaded.metadata.name).toBe('Disk Test');
    });

    it('should handle corrupted session data gracefully', async () => {
      // Arrange
      const sessionId = testHelpers.generateTestSessionId();

      // Mock loadSessionFromDisk to throw an error
      jest
        .spyOn(manager as any, 'loadSessionFromDisk')
        .mockRejectedValue(new Error('Corrupted data'));

      // Act & Assert
      await expect(manager.loadSession(sessionId)).rejects.toThrow(
        SessionError
      );
    });
  });

  describe('listSessions', () => {
    beforeEach(async () => {
      // Create test sessions with different timestamps
      await manager.createSession({ name: 'Session 1', tags: ['tag1'] });
      await testHelpers.wait(10);
      await manager.createSession({ name: 'Session 2', tags: ['tag2'] });
      await testHelpers.wait(10);
      await manager.createSession({
        name: 'Session 3',
        tags: ['tag1', 'tag3'],
      });
    });

    it('should list all sessions by default', async () => {
      // Act
      const result = await manager.listSessions();

      // Assert
      expect(result.items).toHaveLength(3);
      expect(result.total).toBe(3);
      expect(result.hasMore).toBe(false);
    });

    it('should sort sessions by last activity (most recent first)', async () => {
      // Act
      const result = await manager.listSessions();

      // Assert
      expect(result.items[0].metadata.name).toBe('Session 3');
      expect(result.items[1].metadata.name).toBe('Session 2');
      expect(result.items[2].metadata.name).toBe('Session 1');
    });

    it('should handle pagination correctly', async () => {
      // Act
      const page1 = await manager.listSessions(2, 0);
      const page2 = await manager.listSessions(2, 2);

      // Assert
      expect(page1.items).toHaveLength(2);
      expect(page1.hasMore).toBe(true);
      expect(page1.total).toBe(3);

      expect(page2.items).toHaveLength(1);
      expect(page2.hasMore).toBe(false);
      expect(page2.total).toBe(3);
    });

    it('should filter sessions by name', async () => {
      // Act
      const result = await manager.listSessions(50, 0, { name: 'Session 2' });

      // Assert
      expect(result.items).toHaveLength(1);
      expect(result.items[0].metadata.name).toBe('Session 2');
    });

    it('should filter sessions by tags', async () => {
      // Act
      const result = await manager.listSessions(50, 0, { tags: 'tag1' });

      // Assert
      expect(result.items).toHaveLength(2);
      expect(result.items.some((s) => s.metadata.name === 'Session 1')).toBe(
        true
      );
      expect(result.items.some((s) => s.metadata.name === 'Session 3')).toBe(
        true
      );
    });

    it('should handle empty results', async () => {
      // Act
      const result = await manager.listSessions(50, 0, {
        name: 'Non-existent',
      });

      // Assert
      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(0);
      expect(result.hasMore).toBe(false);
    });

    it('should include correct session status', async () => {
      // Act
      const result = await manager.listSessions();

      // Assert
      result.items.forEach((session) => {
        expect(['active', 'inactive', 'expired', 'error']).toContain(
          session.status
        );
      });
    });
  });

  describe('updateSession', () => {
    let testSession: SessionData;

    beforeEach(async () => {
      testSession = await manager.createSession({ name: 'Original Name' });
    });

    it('should update session metadata', async () => {
      // Arrange
      const updates: Partial<SessionMetadata> = {
        name: 'Updated Name',
        description: 'Updated description',
      };

      const originalTimestamp = testSession.updatedAt.getTime();

      // Wait a bit to ensure timestamp difference
      await testHelpers.wait(10);

      // Act
      const updated = await manager.updateSession(testSession.id, updates);

      // Assert
      expect(updated.metadata.name).toBe('Updated Name');
      expect(updated.metadata.description).toBe('Updated description');
      expect(updated.updatedAt.getTime()).toBeGreaterThan(originalTimestamp);
    });

    it('should preserve existing metadata when partially updating', async () => {
      // Arrange
      const session = await manager.createSession({
        name: 'Original Name',
        description: 'Original description',
        tags: ['original'],
      });

      // Act
      const updated = await manager.updateSession(session.id, {
        name: 'New Name',
      });

      // Assert
      expect(updated.metadata.name).toBe('New Name');
      expect(updated.metadata.description).toBe('Original description');
      expect(updated.metadata.tags).toEqual(['original']);
    });

    it('should throw error for non-existent session', async () => {
      // Arrange
      const nonExistentId = 'non-existent-session-id';

      // Act & Assert
      await expect(
        manager.updateSession(nonExistentId, { name: 'New Name' })
      ).rejects.toThrow(SessionError);
    });

    it('should update last activity timestamp', async () => {
      // Arrange
      const originalActivity = testSession.state.lastActivity;
      await testHelpers.wait(10);

      // Act
      const updated = await manager.updateSession(testSession.id, {
        name: 'New Name',
      });

      // Assert
      expect(updated.state.lastActivity.getTime()).toBeGreaterThan(
        originalActivity.getTime()
      );
    });
  });

  describe('deleteSession', () => {
    let testSession: SessionData;

    beforeEach(async () => {
      testSession = await manager.createSession({ name: 'To Be Deleted' });
    });

    it('should delete existing session', async () => {
      // Act
      await manager.deleteSession(testSession.id);

      // Assert
      await expect(manager.loadSession(testSession.id)).rejects.toThrow(
        SessionError
      );
    });

    it('should handle deletion of non-existent session gracefully', async () => {
      // Arrange
      const nonExistentId = 'non-existent-session-id';

      // Act & Assert - Should not throw
      await expect(manager.deleteSession(nonExistentId)).resolves.not.toThrow();
    });

    it('should remove session from memory and disk', async () => {
      // Arrange
      const deleteFromDiskSpy = jest.spyOn(
        manager as any,
        'deleteSessionFromDisk'
      );

      // Act
      await manager.deleteSession(testSession.id);

      // Assert
      expect(deleteFromDiskSpy).toHaveBeenCalledWith(testSession.id);
    });
  });

  describe('addMessage', () => {
    let testSession: SessionData;

    beforeEach(async () => {
      testSession = await manager.createSession({ name: 'Message Test' });
    });

    it('should add message to session conversation', async () => {
      // Arrange
      const message: ConversationMessage = {
        id: 'msg-1',
        role: 'user',
        content: [{ type: 'text', text: 'Hello, world!' }],
        timestamp: new Date(),
      };

      // Act
      await manager.addMessage(testSession.id, message);

      // Assert
      const updated = await manager.loadSession(testSession.id);
      expect(updated.conversation).toHaveLength(1);
      expect(updated.conversation[0]).toEqual(message);
      expect(updated.state.messageCount).toBe(1);
    });

    it('should update session state when adding message', async () => {
      // Arrange
      const message: ConversationMessage = {
        id: 'msg-1',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello back!' }],
        timestamp: new Date(),
      };

      const originalActivity = testSession.state.lastActivity;
      await testHelpers.wait(10);

      // Act
      await manager.addMessage(testSession.id, message);

      // Assert
      const updated = await manager.loadSession(testSession.id);
      expect(updated.state.lastActivity.getTime()).toBeGreaterThan(
        originalActivity.getTime()
      );
      expect(updated.state.messageCount).toBe(1);
    });

    it('should handle multiple messages in sequence', async () => {
      // Arrange
      const messages: ConversationMessage[] = [
        {
          id: 'msg-1',
          role: 'user',
          content: [{ type: 'text', text: 'First message' }],
          timestamp: new Date(),
        },
        {
          id: 'msg-2',
          role: 'assistant',
          content: [{ type: 'text', text: 'Second message' }],
          timestamp: new Date(),
        },
      ];

      // Act
      for (const message of messages) {
        await manager.addMessage(testSession.id, message);
      }

      // Assert
      const updated = await manager.loadSession(testSession.id);
      expect(updated.conversation).toHaveLength(2);
      expect(updated.state.messageCount).toBe(2);
    });

    it('should throw error for non-existent session', async () => {
      // Arrange
      const message: ConversationMessage = {
        id: 'msg-1',
        role: 'user',
        content: [{ type: 'text', text: 'Hello' }],
        timestamp: new Date(),
      };

      // Act & Assert
      await expect(manager.addMessage('non-existent', message)).rejects.toThrow(
        SessionError
      );
    });
  });

  describe('cleanupExpiredSessions', () => {
    it('should remove expired sessions', async () => {
      // Arrange
      const expiredSession = await manager.createSession({ name: 'Expired' });

      // Mock the session as expired
      const expiredTime = new Date(
        Date.now() - mockConfig.sessionTimeout - 1000
      );
      expiredSession.state.lastActivity = expiredTime;

      const activeSession = await manager.createSession({ name: 'Active' });

      // Act
      const cleanedCount = await manager.cleanupExpiredSessions();

      // Assert
      expect(cleanedCount).toBe(1);
      await expect(manager.loadSession(expiredSession.id)).rejects.toThrow();
      await expect(
        manager.loadSession(activeSession.id)
      ).resolves.toBeDefined();
    });

    it('should not remove active sessions', async () => {
      // Arrange
      const activeSession = await manager.createSession({ name: 'Active' });

      // Act
      const cleanedCount = await manager.cleanupExpiredSessions();

      // Assert
      expect(cleanedCount).toBe(0);
      await expect(
        manager.loadSession(activeSession.id)
      ).resolves.toBeDefined();
    });

    it('should handle cleanup errors gracefully', async () => {
      // Arrange
      const session = await manager.createSession({ name: 'Error Test' });

      // Mock the session as expired
      const expiredTime = new Date(
        Date.now() - mockConfig.sessionTimeout - 1000
      );
      session.state.lastActivity = expiredTime;

      // Mock delete to fail
      jest
        .spyOn(manager, 'deleteSession')
        .mockRejectedValue(new Error('Delete failed'));

      // Act
      const cleanedCount = await manager.cleanupExpiredSessions();

      // Assert - Should continue despite errors
      expect(cleanedCount).toBe(0); // No sessions successfully cleaned
    });
  });

  describe('cleanup', () => {
    it('should persist all active sessions', async () => {
      // Arrange
      await manager.createSession({ name: 'Session 1' });
      await manager.createSession({ name: 'Session 2' });

      const persistSpy = jest.spyOn(manager as any, 'persistSession');

      // Act
      await manager.cleanup();

      // Assert
      expect(persistSpy).toHaveBeenCalledTimes(2);
    });

    it('should clear memory after cleanup', async () => {
      // Arrange
      const session = await manager.createSession({ name: 'Test Session' });

      // Act
      await manager.cleanup();

      // Assert
      const metrics = manager.getMetrics();
      expect(metrics.totalSessions).toBe(0);
    });

    it('should stop cleanup interval', async () => {
      // Arrange
      const clearIntervalSpy = jest.spyOn(global, 'clearInterval');

      // Act
      await manager.cleanup();

      // Assert
      expect(clearIntervalSpy).toHaveBeenCalled();
    });
  });

  describe('getMetrics', () => {
    it('should return correct session metrics', async () => {
      // Arrange
      await manager.createSession({ name: 'Session 1' });
      await manager.createSession({ name: 'Session 2' });

      // Act
      const metrics = manager.getMetrics();

      // Assert
      expect(metrics.totalSessions).toBe(2);
      expect(metrics.maxSessions).toBe(mockConfig.maxSessions);
      expect(metrics.sessionTimeout).toBe(mockConfig.sessionTimeout);
    });
  });

  describe('edge cases', () => {
    it('should handle concurrent session creation', async () => {
      // Arrange - Use a higher limit for concurrent testing
      const highLimitConfig = { ...mockConfig, maxSessions: 25 };
      const concurrentManager = new SessionManager(highLimitConfig, mockLogger);

      // Act
      const promises = Array.from({ length: 20 }, (_, i) =>
        concurrentManager.createSession({ name: `Concurrent ${i}` })
      );

      // Assert - Should not throw
      await expect(Promise.all(promises)).resolves.toBeDefined();

      // Cleanup
      await concurrentManager.cleanup();
    });

    it('should handle session operations during cleanup', async () => {
      // Arrange
      const session = await manager.createSession({ name: 'Cleanup Test' });

      // Act - Start cleanup but don't wait
      const cleanupPromise = manager.cleanup();

      // Try to access session during cleanup
      const loadPromise = manager.loadSession(session.id);

      // Assert - Operations should complete without errors
      await expect(
        Promise.all([cleanupPromise, loadPromise])
      ).resolves.toBeDefined();
    });

    it('should handle invalid session IDs gracefully', async () => {
      // Act & Assert
      await expect(manager.loadSession('')).rejects.toThrow();
      await expect(manager.loadSession(null as any)).rejects.toThrow();
      await expect(manager.loadSession(undefined as any)).rejects.toThrow();
    });
  });

  describe('getAvailableModels', () => {
    beforeEach(() => {
      // Set up available models for testing
      manager.setAvailableModels([
        { id: 'auto', name: 'Auto', provider: 'cursor' },
        { id: 'composer-1', name: 'Composer 1', provider: 'cursor' },
        { id: 'gpt-5', name: 'GPT-5', provider: 'openai' },
        { id: 'sonnet-4.5', name: 'Claude 4.5 Sonnet', provider: 'anthropic' },
        { id: 'grok', name: 'Grok', provider: 'xai' },
      ]);
    });

    it('should return list of available models', () => {
      // Act
      const models = manager.getAvailableModels();

      // Assert
      expect(models).toBeInstanceOf(Array);
      expect(models.length).toBeGreaterThan(0);
      expect(models[0]).toHaveProperty('id');
      expect(models[0]).toHaveProperty('name');
      expect(models[0]).toHaveProperty('provider');
    });

    it('should include all expected models', () => {
      // Act
      const models = manager.getAvailableModels();
      const modelIds = models.map((m) => m.id);

      // Assert - Check for some key models
      expect(modelIds).toContain('auto');
      expect(modelIds).toContain('composer-1');
      expect(modelIds).toContain('sonnet-4.5');
      expect(modelIds).toContain('gpt-5');
      expect(modelIds).toContain('grok');
    });
  });

  describe('getSessionModel', () => {
    it('should return default model for new session', async () => {
      // Arrange
      const session = await manager.createSession();

      // Act
      const model = manager.getSessionModel(session.id);

      // Assert
      expect(model).toBe('auto'); // Default model
    });

    it('should return custom model when specified', async () => {
      // Arrange
      const session = await manager.createSession({ model: 'sonnet-4.5' });

      // Act
      const model = manager.getSessionModel(session.id);

      // Assert
      expect(model).toBe('sonnet-4.5');
    });

    it('should return default for non-existent session', () => {
      // Act
      const model = manager.getSessionModel('non-existent');

      // Assert
      expect(model).toBe('auto');
    });
  });

  describe('setSessionModel', () => {
    let testSession: SessionData;

    beforeEach(async () => {
      // Set up available models for testing
      manager.setAvailableModels([
        { id: 'auto', name: 'Auto', provider: 'cursor' },
        { id: 'gpt-5', name: 'GPT-5', provider: 'openai' },
        { id: 'gpt-5.2', name: 'GPT-5.2', provider: 'openai' },
        { id: 'sonnet-4.5', name: 'Claude 4.5 Sonnet', provider: 'anthropic' },
        { id: 'opus-4.5', name: 'Claude 4.5 Opus', provider: 'anthropic' },
        { id: 'gemini-3-pro', name: 'Gemini 3 Pro', provider: 'google' },
      ]);

      testSession = await manager.createSession({ name: 'Model Test' });
    });

    it('should change session model', async () => {
      // Act
      await manager.setSessionModel(testSession.id, 'gpt-5');

      // Assert
      const model = manager.getSessionModel(testSession.id);
      expect(model).toBe('gpt-5');
    });

    it('should throw error for invalid model', async () => {
      // Act & Assert
      await expect(
        manager.setSessionModel(testSession.id, 'invalid-model')
      ).rejects.toThrow(SessionError);
      await expect(
        manager.setSessionModel(testSession.id, 'invalid-model')
      ).rejects.toThrow(/Invalid model/);
    });

    it('should throw error for non-existent session', async () => {
      // Act & Assert
      await expect(
        manager.setSessionModel('non-existent', 'gpt-5')
      ).rejects.toThrow(SessionError);
    });

    it('should update session metadata', async () => {
      // Act
      await manager.setSessionModel(testSession.id, 'sonnet-4.5');

      // Assert
      const session = await manager.loadSession(testSession.id);
      expect(session.metadata.model).toBe('sonnet-4.5');
      expect(session.state.currentModel).toBe('sonnet-4.5');
    });

    it('should update last activity timestamp', async () => {
      // Arrange
      const originalActivity = testSession.state.lastActivity;
      await testHelpers.wait(10);

      // Act
      await manager.setSessionModel(testSession.id, 'opus-4.5');

      // Assert
      const session = await manager.loadSession(testSession.id);
      expect(session.state.lastActivity.getTime()).toBeGreaterThan(
        originalActivity.getTime()
      );
    });

    it('should support all available models', async () => {
      // Arrange
      const models = manager.getAvailableModels();

      // Act & Assert - All models should be settable
      for (const model of models) {
        await expect(
          manager.setSessionModel(testSession.id, model.id)
        ).resolves.not.toThrow();

        const currentModel = manager.getSessionModel(testSession.id);
        expect(currentModel).toBe(model.id);
      }
    });
  });
});
