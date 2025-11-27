/**
 * Integration tests for Session Modes
 *
 * These tests verify the complete integration of session modes:
 * - Session creation with modes
 * - Session loading with modes
 * - Mode switching via session/set_mode
 * - Current mode update notifications
 * - End-to-end ACP protocol compliance
 *
 * Per ACP spec: https://agentclientprotocol.com/protocol/session-modes
 */

import { CursorAgentAdapter } from '../../src/adapter/cursor-agent-adapter';
import type { AdapterConfig, Logger } from '../../src/types';
import type {
  NewSessionResponse,
  LoadSessionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  SessionModeState,
  SessionModeId,
  ClientCapabilities,
} from '@agentclientprotocol/sdk';
import { FilesystemToolProvider } from '../../src/tools/filesystem';
import { AcpFileSystemClient } from '../../src/client/filesystem-client';
import { promises as fs } from 'fs';

// Mock the CursorCliBridge module
jest.mock('../../src/cursor/cli-bridge', () => ({
  CursorCliBridge: jest.fn().mockImplementation((config, logger) => {
    return new (require('./mocks/cursor-bridge-mock').MockCursorCliBridge)(
      config,
      logger
    );
  }),
}));

// Mock logger for tests
const mockLogger: Logger = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
};

// Mock client security settings (simulates client-side validation per ACP spec)
const mockClientAllowedPaths = ['/tmp', './'];

// Test configuration
const testConfig: AdapterConfig = {
  logLevel: 'debug',
  sessionDir: '/tmp/cursor-test-sessions',
  maxSessions: 10,
  sessionTimeout: 60000,
  tools: {
    filesystem: {
      enabled: false, // Disabled in config, manually registered in beforeEach
    },
    terminal: {
      enabled: true,
      maxProcesses: 3,
    },
  },
  cursor: {
    timeout: 30000,
    retries: 1,
  },
};

describe('Session Modes Integration', () => {
  let adapter: CursorAgentAdapter;

  beforeEach(async () => {
    jest.clearAllMocks();
    adapter = new CursorAgentAdapter(testConfig, { logger: mockLogger });
    await adapter.initialize();

    // Register filesystem tools with mock client (per ACP architecture)
    const mockClientCapabilities: ClientCapabilities = {
      fs: {
        readTextFile: true,
        writeTextFile: true,
      },
    };

    // Create mock filesystem client for integration tests
    const mockFileSystemClient = new AcpFileSystemClient(
      {
        async readTextFile(params: any) {
          // Validate path is within allowed paths (client-side validation per ACP spec)
          const isAllowed = mockClientAllowedPaths.some((allowed) =>
            params.path.startsWith(allowed)
          );
          if (!isAllowed) {
            throw new Error(`Access to ${params.path} is not allowed`);
          }
          // Use local fs for integration tests
          const content = await fs.readFile(params.path, 'utf-8');
          return { content };
        },
        async writeTextFile(params: any) {
          // Validate path is within allowed paths (client-side validation per ACP spec)
          const isAllowed = mockClientAllowedPaths.some((allowed) =>
            params.path.startsWith(allowed)
          );
          if (!isAllowed) {
            throw new Error(`Access to ${params.path} is not allowed`);
          }
          // Use local fs for integration tests
          await fs.writeFile(params.path, params.content, 'utf-8');
          return {};
        },
      },
      mockLogger
    );

    const filesystemProvider = new FilesystemToolProvider(
      {
        ...testConfig,
        tools: {
          ...testConfig.tools,
          filesystem: {
            ...testConfig.tools.filesystem,
            enabled: true, // Enable for provider (even though disabled in adapter config)
          },
        },
      },
      mockLogger,
      mockClientCapabilities,
      mockFileSystemClient
    );

    // Access the tool registry from the adapter to register filesystem provider
    const toolRegistry = (adapter as any).toolRegistry;
    if (toolRegistry) {
      toolRegistry.registerProvider(filesystemProvider);
    }
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

  describe('session/new with modes', () => {
    it('should return modes in NewSessionResponse', async () => {
      // Arrange
      const request = {
        jsonrpc: '2.0' as const,
        id: 1,
        method: 'session/new',
        params: {
          cwd: '/tmp/test',
          mcpServers: [],
        },
      };

      // Act
      const response = await (adapter as any).processRequest(request);

      // Assert
      expect(response.result).toBeDefined();
      const result = response.result as NewSessionResponse;

      // Per ACP spec: modes should be included in NewSessionResponse
      expect(result).toHaveProperty('modes');
      expect(result.modes).toBeDefined();

      if (result.modes) {
        const modes = result.modes as SessionModeState;
        expect(modes).toHaveProperty('currentModeId');
        expect(modes).toHaveProperty('availableModes');
        expect(Array.isArray(modes.availableModes)).toBe(true);
        expect(modes.availableModes.length).toBeGreaterThan(0);
      }
    });

    it('should include currentModeId in modes', async () => {
      // Arrange
      const request = {
        jsonrpc: '2.0' as const,
        id: 1,
        method: 'session/new',
        params: {
          cwd: '/tmp/test',
          mcpServers: [],
        },
      };

      // Act
      const response = await (adapter as any).processRequest(request);
      const result = response.result as NewSessionResponse;

      // Assert
      expect(result.modes?.currentModeId).toBeDefined();
      expect(typeof result.modes?.currentModeId).toBe('string');
      expect(result.modes?.currentModeId).toBe('ask'); // Default mode
    });

    it('should include standard ACP modes in availableModes', async () => {
      // Arrange
      const request = {
        jsonrpc: '2.0' as const,
        id: 1,
        method: 'session/new',
        params: {
          cwd: '/tmp/test',
          mcpServers: [],
        },
      };

      // Act
      const response = await (adapter as any).processRequest(request);
      const result = response.result as NewSessionResponse;

      // Assert
      const modeIds = result.modes?.availableModes.map((m) => m.id) || [];
      expect(modeIds).toContain('ask');
      expect(modeIds).toContain('architect');
      expect(modeIds).toContain('code');
    });

    it('should validate SessionMode structure per ACP spec', async () => {
      // Arrange
      const request = {
        jsonrpc: '2.0' as const,
        id: 1,
        method: 'session/new',
        params: {
          cwd: '/tmp/test',
          mcpServers: [],
        },
      };

      // Act
      const response = await (adapter as any).processRequest(request);
      const result = response.result as NewSessionResponse;

      // Assert - Per ACP spec: SessionMode has id, name, description
      result.modes?.availableModes.forEach((mode) => {
        expect(mode).toHaveProperty('id');
        expect(mode).toHaveProperty('name');
        expect(typeof mode.id).toBe('string');
        expect(typeof mode.name).toBe('string');
        expect(mode.id.length).toBeGreaterThan(0);
        expect(mode.name.length).toBeGreaterThan(0);

        // description is optional per ACP spec
        if (mode.description !== undefined) {
          expect(typeof mode.description).toBe('string');
        }
      });
    });
  });

  describe('session/load with modes', () => {
    let sessionId: string;

    beforeEach(async () => {
      // Create a session first
      const createRequest = {
        jsonrpc: '2.0' as const,
        id: 1,
        method: 'session/new',
        params: {
          cwd: '/tmp/test',
          mcpServers: [],
        },
      };
      const createResponse = await (adapter as any).processRequest(
        createRequest
      );
      sessionId = createResponse.result.sessionId;
    });

    it('should return modes in LoadSessionResponse', async () => {
      // Arrange
      const request = {
        jsonrpc: '2.0' as const,
        id: 2,
        method: 'session/load',
        params: {
          sessionId,
          cwd: '/tmp/test',
          mcpServers: [],
        },
      };

      // Act
      const response = await (adapter as any).processRequest(request);

      // Assert
      if (response.error) {
        console.error('Load session error:', response.error);
      }
      expect(response.result).toBeDefined();
      expect(response.error).toBeUndefined();
      const result = response.result as LoadSessionResponse;

      // Per ACP spec: modes should be included in LoadSessionResponse
      expect(result).toHaveProperty('modes');
      expect(result.modes).toBeDefined();

      if (result.modes) {
        const modes = result.modes as SessionModeState;
        expect(modes).toHaveProperty('currentModeId');
        expect(modes).toHaveProperty('availableModes');
        expect(Array.isArray(modes.availableModes)).toBe(true);
      }
    });

    it('should reflect current mode in loaded session', async () => {
      // Arrange - Change mode first
      await (adapter as any).processRequest({
        jsonrpc: '2.0' as const,
        id: 2,
        method: 'session/set_mode',
        params: {
          sessionId,
          modeId: 'code',
        },
      });

      // Act - Load session
      const loadRequest = {
        jsonrpc: '2.0' as const,
        id: 3,
        method: 'session/load',
        params: {
          sessionId,
          cwd: '/tmp/test',
          mcpServers: [],
        },
      };
      const response = await (adapter as any).processRequest(loadRequest);
      const result = response.result as LoadSessionResponse;

      // Assert
      expect(result.modes?.currentModeId).toBe('code');
    });
  });

  describe('session/set_mode', () => {
    let sessionId: string;

    beforeEach(async () => {
      // Create a session first
      const createRequest = {
        jsonrpc: '2.0' as const,
        id: 1,
        method: 'session/new',
        params: {
          cwd: '/tmp/test',
          mcpServers: [],
        },
      };
      const createResponse = await (adapter as any).processRequest(
        createRequest
      );
      sessionId = createResponse.result.sessionId;
    });

    it('should successfully change session mode', async () => {
      // Arrange
      const request = {
        jsonrpc: '2.0' as const,
        id: 2,
        method: 'session/set_mode',
        params: {
          sessionId,
          modeId: 'code',
        } as SetSessionModeRequest,
      };

      // Act
      const response = await (adapter as any).processRequest(request);

      // Assert
      expect(response.error).toBeUndefined();
      expect(response.result).toBeDefined();
    });

    it('should return SetSessionModeResponse with metadata', async () => {
      // Arrange
      const request = {
        jsonrpc: '2.0' as const,
        id: 2,
        method: 'session/set_mode',
        params: {
          sessionId,
          modeId: 'architect',
        } as SetSessionModeRequest,
      };

      // Act
      const response = await (adapter as any).processRequest(request);
      const result = response.result as SetSessionModeResponse;

      // Assert
      expect(result).toBeDefined();
      // Response can include _meta with additional information
      if (result._meta) {
        expect(result._meta).toHaveProperty('previousMode');
        expect(result._meta).toHaveProperty('newMode');
        expect(result._meta.previousMode).toBe('ask');
        expect(result._meta.newMode).toBe('architect');
      }
    });

    it('should validate mode exists', async () => {
      // Arrange
      const request = {
        jsonrpc: '2.0' as const,
        id: 2,
        method: 'session/set_mode',
        params: {
          sessionId,
          modeId: 'invalid-mode',
        } as SetSessionModeRequest,
      };

      // Act
      const response = await (adapter as any).processRequest(request);

      // Assert
      expect(response.error).toBeDefined();
      expect(response.error?.message).toContain('Invalid mode');
    });

    it('should persist mode change across session operations', async () => {
      // Arrange - Change mode
      await (adapter as any).processRequest({
        jsonrpc: '2.0' as const,
        id: 2,
        method: 'session/set_mode',
        params: {
          sessionId,
          modeId: 'code',
        },
      });

      // Act - Load session again
      const loadResponse = await (adapter as any).processRequest({
        jsonrpc: '2.0' as const,
        id: 3,
        method: 'session/load',
        params: {
          sessionId,
          cwd: '/tmp/test',
          mcpServers: [],
        },
      });

      // Assert
      const result = loadResponse.result as LoadSessionResponse;
      expect(result.modes?.currentModeId).toBe('code');
    });

    it('should allow switching between all available modes', async () => {
      // Arrange - Get available modes
      const createResponse = await (adapter as any).processRequest({
        jsonrpc: '2.0' as const,
        id: 1,
        method: 'session/new',
        params: {
          cwd: '/tmp/test2',
          mcpServers: [],
        },
      });
      const newSessionId = createResponse.result.sessionId;
      const modes = createResponse.result.modes?.availableModes || [];

      // Act & Assert - Switch to each mode
      for (const mode of modes) {
        const response = await (adapter as any).processRequest({
          jsonrpc: '2.0' as const,
          id: 2,
          method: 'session/set_mode',
          params: {
            sessionId: newSessionId,
            modeId: mode.id,
          },
        });

        expect(response.error).toBeUndefined();
      }
    });
  });

  describe('ACP spec compliance', () => {
    it('should have currentModeId in availableModes', async () => {
      // Arrange
      const request = {
        jsonrpc: '2.0' as const,
        id: 1,
        method: 'session/new',
        params: {
          cwd: '/tmp/test',
          mcpServers: [],
        },
      };

      // Act
      const response = await (adapter as any).processRequest(request);
      const result = response.result as NewSessionResponse;

      // Assert - Per ACP spec: currentModeId must be one of availableModes
      const modeIds = result.modes?.availableModes.map((m) => m.id) || [];
      expect(modeIds).toContain(result.modes?.currentModeId);
    });

    it('should maintain type consistency across all mode operations', async () => {
      // Create session
      const createResponse = await (adapter as any).processRequest({
        jsonrpc: '2.0' as const,
        id: 1,
        method: 'session/new',
        params: {
          cwd: '/tmp/test',
          mcpServers: [],
        },
      });
      const sessionId = createResponse.result.sessionId;
      const createModes = createResponse.result.modes;

      // Change mode
      await (adapter as any).processRequest({
        jsonrpc: '2.0' as const,
        id: 2,
        method: 'session/set_mode',
        params: {
          sessionId,
          modeId: 'architect',
        },
      });

      // Load session
      const loadResponse = await (adapter as any).processRequest({
        jsonrpc: '2.0' as const,
        id: 3,
        method: 'session/load',
        params: {
          sessionId,
          cwd: '/tmp/test',
          mcpServers: [],
        },
      });
      const loadModes = loadResponse.result.modes;

      // Assert - availableModes should be consistent
      expect(createModes?.availableModes).toEqual(loadModes?.availableModes);
      expect(loadModes?.currentModeId).toBe('architect');
    });
  });
});
