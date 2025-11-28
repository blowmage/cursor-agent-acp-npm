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

    it('should include standard ACP modes matching Cursor IDE', () => {
      // Act
      const modes = manager.getAvailableModes();
      const modeIds = modes.map((m) => m.id);

      // Assert - Modes should match Cursor IDE: agent, plan, ask
      expect(modeIds).toContain('ask');
      expect(modeIds).toContain('plan');
      expect(modeIds).toContain('agent');
    });

    it('should return modes with proper descriptions', () => {
      // Act
      const modes = manager.getAvailableModes();

      // Assert
      const askMode = modes.find((m) => m.id === 'ask');
      const planMode = modes.find((m) => m.id === 'plan');
      const agentMode = modes.find((m) => m.id === 'agent');

      expect(askMode?.description).toContain('permission');
      expect(planMode?.description).toContain('plan');
      expect(agentMode?.description).toContain('code');
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
      await manager.setSessionMode(testSession.id, 'agent');

      // Act
      const modeState = manager.getSessionModeState(testSession.id);

      // Assert
      expect(modeState.currentModeId).toBe('agent');
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
      const newMode: SessionModeId = 'agent';

      // Act
      const previousMode = await manager.setSessionMode(
        testSession.id,
        newMode
      );

      // Assert
      expect(previousMode).toBe('ask'); // Original mode
      expect(manager.getSessionMode(testSession.id)).toBe('agent');
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
      await manager.setSessionMode(testSession.id, 'agent');

      // Act
      const previousMode = await manager.setSessionMode(testSession.id, 'plan');

      // Assert
      expect(previousMode).toBe('agent');
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
      const newMode: SessionModeId = 'plan';

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
      await manager.setSessionMode(testSession.id, 'agent');

      // Assert
      const session = await manager.loadSession(testSession.id);
      expect(session.updatedAt.getTime()).toBeGreaterThan(
        originalUpdatedAt.getTime()
      );
    });

    it('should throw error for non-existent session', async () => {
      // Act & Assert
      await expect(
        manager.setSessionMode('non-existent-id', 'agent')
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
      const agentConfig = manager.getModeConfig('agent');
      const planConfig = manager.getModeConfig('plan');

      // Assert
      expect(askConfig).toBeDefined();
      expect(agentConfig).toBeDefined();
      expect(planConfig).toBeDefined();
    });

    it('should return undefined for invalid mode', () => {
      // Act
      const config = manager.getModeConfig('invalid-mode' as SessionModeId);

      // Assert
      expect(config).toBeUndefined();
    });

    it('should return undefined for empty string mode', () => {
      // Act
      const config = manager.getModeConfig('' as SessionModeId);

      // Assert
      expect(config).toBeUndefined();
    });

    it('should return undefined for null-like mode IDs', () => {
      // Act
      const config1 = manager.getModeConfig(null as any);
      const config2 = manager.getModeConfig(undefined as any);

      // Assert
      expect(config1).toBeUndefined();
      expect(config2).toBeUndefined();
    });

    describe('ask mode configuration', () => {
      it('should have strict permission behavior', () => {
        // Act
        const askConfig = manager.getModeConfig('ask');

        // Assert
        expect(askConfig).toBeDefined();
        expect(askConfig?.permissionBehavior).toBe('strict');
      });

      it('should not define available tools', () => {
        // Act
        const askConfig = manager.getModeConfig('ask');

        // Assert - Ask mode doesn't specify tools, relies on default behavior
        expect(askConfig?.availableTools).toBeUndefined();
      });

      it('should not define system prompt', () => {
        // Act
        const askConfig = manager.getModeConfig('ask');

        // Assert
        expect(askConfig?.systemPrompt).toBeUndefined();
      });
    });

    describe('agent mode configuration', () => {
      it('should have strict permission behavior', () => {
        // Act
        const agentConfig = manager.getModeConfig('agent');

        // Assert
        expect(agentConfig).toBeDefined();
        expect(agentConfig?.permissionBehavior).toBe('strict');
      });

      it('should include filesystem and terminal tools', () => {
        // Act
        const agentConfig = manager.getModeConfig('agent');

        // Assert
        expect(agentConfig?.availableTools).toBeDefined();
        expect(Array.isArray(agentConfig?.availableTools)).toBe(true);
        expect(agentConfig?.availableTools).toContain('filesystem');
        expect(agentConfig?.availableTools).toContain('terminal');
        expect(agentConfig?.availableTools?.length).toBe(2);
      });

      it('should have both filesystem and terminal in correct order', () => {
        // Act
        const agentConfig = manager.getModeConfig('agent');

        // Assert
        expect(agentConfig?.availableTools).toEqual(['filesystem', 'terminal']);
      });
    });

    describe('plan mode configuration', () => {
      it('should have strict permission behavior', () => {
        // Act
        const planConfig = manager.getModeConfig('plan');

        // Assert
        expect(planConfig).toBeDefined();
        expect(planConfig?.permissionBehavior).toBe('strict');
      });

      it('should include only filesystem tool', () => {
        // Act
        const planConfig = manager.getModeConfig('plan');

        // Assert
        expect(planConfig?.availableTools).toBeDefined();
        expect(Array.isArray(planConfig?.availableTools)).toBe(true);
        expect(planConfig?.availableTools).toContain('filesystem');
        expect(planConfig?.availableTools).not.toContain('terminal');
        expect(planConfig?.availableTools?.length).toBe(1);
      });

      it('should not include terminal tool', () => {
        // Act
        const planConfig = manager.getModeConfig('plan');

        // Assert - Plan mode is for planning, not executing
        expect(planConfig?.availableTools).toEqual(['filesystem']);
      });
    });

    describe('configuration structure', () => {
      it('should return InternalSessionModeConfig type', () => {
        // Act
        const askConfig = manager.getModeConfig('ask');

        // Assert - Check structure matches InternalSessionModeConfig
        if (askConfig) {
          // All fields are optional per InternalSessionModeConfig
          expect(typeof askConfig).toBe('object');

          if (askConfig.systemPrompt !== undefined) {
            expect(typeof askConfig.systemPrompt).toBe('string');
          }

          if (askConfig.availableTools !== undefined) {
            expect(Array.isArray(askConfig.availableTools)).toBe(true);
            askConfig.availableTools.forEach((tool) => {
              expect(typeof tool).toBe('string');
            });
          }

          if (askConfig.permissionBehavior !== undefined) {
            expect(['strict', 'permissive', 'auto']).toContain(
              askConfig.permissionBehavior
            );
          }
        }
      });

      it('should return consistent config for same mode', () => {
        // Act
        const config1 = manager.getModeConfig('agent');
        const config2 = manager.getModeConfig('agent');

        // Assert - Should return same reference/equivalent config
        expect(config1).toEqual(config2);
      });

      it('should return different configs for different modes', () => {
        // Act
        const askConfig = manager.getModeConfig('ask');
        const agentConfig = manager.getModeConfig('agent');

        // Assert - Configs should be different
        expect(askConfig).not.toEqual(agentConfig);
      });
    });

    describe('all available modes have configs', () => {
      it('should have config for every available mode', () => {
        // Arrange
        const availableModes = manager.getAvailableModes();

        // Act & Assert
        availableModes.forEach((mode) => {
          const config = manager.getModeConfig(mode.id);
          expect(config).toBeDefined();
          expect(config).toHaveProperty('permissionBehavior');
        });
      });

      it('should have exactly 3 mode configs', () => {
        // Arrange
        const availableModes = manager.getAvailableModes();
        const modeIds = availableModes.map((m) => m.id);

        // Act - Count configs that exist
        const configCount = modeIds.filter(
          (id) => manager.getModeConfig(id) !== undefined
        ).length;

        // Assert
        expect(configCount).toBe(3);
        expect(modeIds).toEqual(['agent', 'plan', 'ask']);
      });
    });

    describe('permission behavior consistency', () => {
      it('all modes should use strict permission behavior', () => {
        // Arrange
        const availableModes = manager.getAvailableModes();

        // Act & Assert - All current modes should be strict
        availableModes.forEach((mode) => {
          const config = manager.getModeConfig(mode.id);
          expect(config?.permissionBehavior).toBe('strict');
        });
      });
    });

    describe('tool availability patterns', () => {
      it('should have increasing tool availability: ask < plan < agent', () => {
        // Act
        const askConfig = manager.getModeConfig('ask');
        const planConfig = manager.getModeConfig('plan');
        const agentConfig = manager.getModeConfig('agent');

        // Assert - Tool availability increases
        const askTools = askConfig?.availableTools?.length ?? 0;
        const planTools = planConfig?.availableTools?.length ?? 0;
        const agentTools = agentConfig?.availableTools?.length ?? 0;

        expect(askTools).toBeLessThanOrEqual(planTools);
        expect(planTools).toBeLessThan(agentTools);
      });

      it('agent mode should have superset of plan tools', () => {
        // Act
        const planConfig = manager.getModeConfig('plan');
        const agentConfig = manager.getModeConfig('agent');

        // Assert - Agent should include all plan tools
        const planTools = planConfig?.availableTools ?? [];
        const agentTools = agentConfig?.availableTools ?? [];

        planTools.forEach((tool) => {
          expect(agentTools).toContain(tool);
        });
      });
    });
  });

  describe('Session creation with mode', () => {
    it('should create session with specified mode', async () => {
      // Act
      const session = await manager.createSession({ mode: 'agent' });

      // Assert
      expect(session.state.currentMode).toBe('agent');
      expect(session.metadata.mode).toBe('agent');
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
