/**
 * Tests for Session Modes
 *
 * Tests ACP-compliant session mode functionality including:
 * - Getting available modes
 * - Getting session mode state
 * - Setting session modes
 * - Mode validation
 *
 * Per ACP spec: https://agentclientprotocol.com/protocol/session-modes
 */

import { SessionManager } from '../../../src/session/manager';
import { createLogger } from '../../../src/utils/logger';
import { DEFAULT_CONFIG } from '../../../src';
import type { AdapterConfig, Logger, SessionData } from '../../../src/types';
import { SessionError } from '../../../src/types';
import type { SessionModeState, SessionModeId } from '@agentclientprotocol/sdk';
import { testHelpers } from '../../setup';

describe('SessionManager - Session Modes', () => {
  let manager: SessionManager;
  let mockConfig: AdapterConfig;
  let mockLogger: Logger;
  let tempDir: string;
  let testSession: SessionData;

  beforeEach(async () => {
    mockConfig = {
      ...DEFAULT_CONFIG,
      maxSessions: 5,
      sessionTimeout: 60000,
    };
    mockLogger = createLogger({ level: 'error', silent: true });
    tempDir = await testHelpers.createTempDir();
    mockConfig.sessionDir = tempDir;

    manager = new SessionManager(mockConfig, mockLogger);

    // Create a test session for mode operations
    testSession = await manager.createSession({ name: 'Test Session' });
  });

  afterEach(async () => {
    await manager.cleanup();
    await testHelpers.cleanupTempDir(tempDir);
  });

  describe('getAvailableModes', () => {
    it('should return array of available modes', () => {
      // Act
      const modes = manager.getAvailableModes();

      // Assert
      expect(Array.isArray(modes)).toBe(true);
      expect(modes.length).toBeGreaterThan(0);

      // Per ACP spec: Each mode must have id, name, and optional description
      modes.forEach((mode) => {
        expect(mode).toHaveProperty('id');
        expect(mode).toHaveProperty('name');
        expect(typeof mode.id).toBe('string');
        expect(typeof mode.name).toBe('string');
        expect(mode.id.length).toBeGreaterThan(0);
        expect(mode.name.length).toBeGreaterThan(0);
      });
    });

    it('should include standard ACP modes', () => {
      // Act
      const modes = manager.getAvailableModes();
      const modeIds = modes.map((m) => m.id);

      // Assert - Per ACP spec examples: ask, architect, code
      expect(modeIds).toContain('ask');
      expect(modeIds).toContain('architect');
      expect(modeIds).toContain('code');
    });

    it('should return modes with proper descriptions', () => {
      // Act
      const modes = manager.getAvailableModes();

      // Assert
      const askMode = modes.find((m) => m.id === 'ask');
      const architectMode = modes.find((m) => m.id === 'architect');
      const codeMode = modes.find((m) => m.id === 'code');

      expect(askMode?.description).toContain('permission');
      expect(architectMode?.description).toContain('plan');
      expect(codeMode?.description).toContain('code');
    });
  });

  describe('getSessionModeState', () => {
    it('should return SessionModeState with currentModeId and availableModes', () => {
      // Act
      const modeState = manager.getSessionModeState(testSession.id);

      // Assert - Per ACP spec: SessionModeState structure
      expect(modeState).toHaveProperty('currentModeId');
      expect(modeState).toHaveProperty('availableModes');
      expect(typeof modeState.currentModeId).toBe('string');
      expect(Array.isArray(modeState.availableModes)).toBe(true);
    });

    it('should return correct current mode for session', () => {
      // Act
      const modeState = manager.getSessionModeState(testSession.id);

      // Assert - Default mode should be 'ask'
      expect(modeState.currentModeId).toBe('ask');
    });

    it('should include all available modes in state', () => {
      // Act
      const modeState = manager.getSessionModeState(testSession.id);
      const availableModes = manager.getAvailableModes();

      // Assert
      expect(modeState.availableModes).toEqual(availableModes);
      expect(modeState.availableModes.length).toBeGreaterThan(0);
    });

    it('should work without sessionId (default mode)', () => {
      // Act
      const modeState = manager.getSessionModeState();

      // Assert - Should return state with default mode
      expect(modeState).toHaveProperty('currentModeId');
      expect(modeState).toHaveProperty('availableModes');
      expect(modeState.currentModeId).toBe('ask');
    });

    it('should reflect updated mode after setSessionMode', async () => {
      // Arrange
      await manager.setSessionMode(testSession.id, 'code');

      // Act
      const modeState = manager.getSessionModeState(testSession.id);

      // Assert
      expect(modeState.currentModeId).toBe('code');
    });
  });

  describe('getSessionMode', () => {
    it('should return current mode ID for session', () => {
      // Act
      const modeId = manager.getSessionMode(testSession.id);

      // Assert
      expect(typeof modeId).toBe('string');
      expect(modeId.length).toBeGreaterThan(0);
    });

    it('should return default mode for new session', () => {
      // Act
      const modeId = manager.getSessionMode(testSession.id);

      // Assert - Per ACP spec: ask is a common default mode
      expect(modeId).toBe('ask');
    });

    it('should return ask for non-existent session', () => {
      // Act
      const modeId = manager.getSessionMode('non-existent-session-id');

      // Assert - Should fallback to default
      expect(modeId).toBe('ask');
    });
  });

  describe('setSessionMode', () => {
    it('should change session mode successfully', async () => {
      // Arrange
      const newMode: SessionModeId = 'code';

      // Act
      const previousMode = await manager.setSessionMode(
        testSession.id,
        newMode
      );

      // Assert
      expect(previousMode).toBe('ask'); // Original mode
      expect(manager.getSessionMode(testSession.id)).toBe('code');
    });

    it('should validate mode exists in availableModes', async () => {
      // Arrange
      const invalidMode = 'invalid-mode' as SessionModeId;

      // Act & Assert
      await expect(
        manager.setSessionMode(testSession.id, invalidMode)
      ).rejects.toThrow(SessionError);
    });

    it('should provide helpful error for invalid mode', async () => {
      // Arrange
      const invalidMode = 'invalid-mode' as SessionModeId;

      // Act & Assert
      try {
        await manager.setSessionMode(testSession.id, invalidMode);
        fail('Should have thrown error');
      } catch (error) {
        expect(error).toBeInstanceOf(SessionError);
        const sessionError = error as SessionError;
        expect(sessionError.message).toContain('Invalid mode');
        expect(sessionError.message).toContain(invalidMode);
        expect(sessionError.message).toContain('Available modes');
      }
    });

    it('should return previous mode ID', async () => {
      // Arrange
      await manager.setSessionMode(testSession.id, 'code');

      // Act
      const previousMode = await manager.setSessionMode(
        testSession.id,
        'architect'
      );

      // Assert
      expect(previousMode).toBe('code');
    });

    it('should allow switching to same mode', async () => {
      // Arrange
      const currentMode = manager.getSessionMode(testSession.id);

      // Act
      const previousMode = await manager.setSessionMode(
        testSession.id,
        currentMode
      );

      // Assert
      expect(previousMode).toBe(currentMode);
      expect(manager.getSessionMode(testSession.id)).toBe(currentMode);
    });

    it('should update session metadata with new mode', async () => {
      // Arrange
      const newMode: SessionModeId = 'architect';

      // Act
      await manager.setSessionMode(testSession.id, newMode);

      // Assert
      const session = await manager.loadSession(testSession.id);
      expect(session.metadata.mode).toBe(newMode);
      expect(session.state.currentMode).toBe(newMode);
    });

    it('should update session timestamps', async () => {
      // Arrange
      const originalUpdatedAt = testSession.updatedAt;
      await new Promise((resolve) => setTimeout(resolve, 10)); // Small delay

      // Act
      await manager.setSessionMode(testSession.id, 'code');

      // Assert
      const session = await manager.loadSession(testSession.id);
      expect(session.updatedAt.getTime()).toBeGreaterThan(
        originalUpdatedAt.getTime()
      );
    });

    it('should throw error for non-existent session', async () => {
      // Act & Assert
      await expect(
        manager.setSessionMode('non-existent-id', 'code')
      ).rejects.toThrow(SessionError);
    });

    it('should allow switching between all available modes', async () => {
      // Arrange
      const modes = manager.getAvailableModes();

      // Act & Assert - Switch to each mode
      for (const mode of modes) {
        await expect(
          manager.setSessionMode(testSession.id, mode.id)
        ).resolves.not.toThrow();
        expect(manager.getSessionMode(testSession.id)).toBe(mode.id);
      }
    });
  });

  describe('getModeConfig', () => {
    it('should return internal config for valid mode', () => {
      // Act
      const askConfig = manager.getModeConfig('ask');
      const codeConfig = manager.getModeConfig('code');
      const architectConfig = manager.getModeConfig('architect');

      // Assert
      expect(askConfig).toBeDefined();
      expect(codeConfig).toBeDefined();
      expect(architectConfig).toBeDefined();
    });

    it('should return undefined for invalid mode', () => {
      // Act
      const config = manager.getModeConfig('invalid-mode' as SessionModeId);

      // Assert
      expect(config).toBeUndefined();
    });

    it('should include permission behavior in config', () => {
      // Act
      const askConfig = manager.getModeConfig('ask');

      // Assert
      expect(askConfig).toHaveProperty('permissionBehavior');
      expect(askConfig?.permissionBehavior).toBe('strict');
    });
  });

  describe('Session creation with mode', () => {
    it('should create session with specified mode', async () => {
      // Act
      const session = await manager.createSession({ mode: 'code' });

      // Assert
      expect(session.state.currentMode).toBe('code');
      expect(session.metadata.mode).toBe('code');
    });

    it('should create session with default mode if not specified', async () => {
      // Act
      const session = await manager.createSession({});

      // Assert
      expect(session.state.currentMode).toBe('ask');
      expect(session.metadata.mode).toBe('ask');
    });
  });

  describe('ACP spec compliance', () => {
    it('should have SessionMode structure matching ACP spec', () => {
      // Per ACP spec: SessionMode has id, name, and optional description
      const modes = manager.getAvailableModes();

      modes.forEach((mode) => {
        expect(mode).toHaveProperty('id');
        expect(mode).toHaveProperty('name');
        // description is optional per ACP spec
        if (mode.description !== undefined) {
          expect(typeof mode.description).toBe('string');
        }
      });
    });

    it('should have SessionModeState structure matching ACP spec', () => {
      // Per ACP spec: SessionModeState has currentModeId and availableModes
      const modeState = manager.getSessionModeState(testSession.id);

      expect(modeState).toHaveProperty('currentModeId');
      expect(modeState).toHaveProperty('availableModes');
      expect(typeof modeState.currentModeId).toBe('string');
      expect(Array.isArray(modeState.availableModes)).toBe(true);
    });

    it('should have currentModeId in availableModes', () => {
      // Per ACP spec: currentModeId must be one of availableModes
      const modeState = manager.getSessionModeState(testSession.id);
      const modeIds = modeState.availableModes.map((m) => m.id);

      expect(modeIds).toContain(modeState.currentModeId);
    });
  });
});
