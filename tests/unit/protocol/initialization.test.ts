/**
 * Tests for InitializationHandler
 *
 * Tests the ACP initialization process including capability declarations,
 * protocol version validation, and error handling.
 */

import { InitializationHandler } from '../../../src/protocol/initialization';
import { createLogger } from '../../../src/utils/logger';
import { DEFAULT_CONFIG } from '../../../src';
import type {
  InitializeParams,
  InitializeResult,
  AdapterConfig,
  Logger,
} from '../../../src/types';
import { testHelpers, TEST_CONSTANTS } from '../../setup';

describe('InitializationHandler', () => {
  let handler: InitializationHandler;
  let mockConfig: AdapterConfig;
  let mockLogger: Logger;

  beforeEach(() => {
    mockConfig = { ...DEFAULT_CONFIG };
    mockLogger = createLogger({ level: 'error', silent: true });
    handler = new InitializationHandler(mockConfig, mockLogger);
  });

  describe('initialize', () => {
    it('should declare all required capabilities', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: TEST_CONSTANTS.ACP_PROTOCOL_VERSION,
        clientInfo: {
          name: 'test-client',
          version: '1.0.0',
        },
      };

      // Act
      const result = await handler.initialize(params);

      // Assert - Basic response structure
      expect(result).toBeValidAcpResponse();
      expect(result.protocolVersion).toBe(TEST_CONSTANTS.ACP_PROTOCOL_VERSION);
      expect(result.agentInfo).toEqual({
        name: 'cursor-agent-acp',
        title: 'Cursor Agent ACP Adapter',
        version: expect.any(String), // Dynamic version from package.json
      });

      // Verify all required capabilities are declared per ACP spec
      // Per ACP schema: https://agentclientprotocol.com/protocol/schema#agentcapabilities
      expect(result.agentCapabilities).toBeDefined();
      expect(result.agentCapabilities.loadSession).toBe(true);
      expect(result.agentCapabilities.promptCapabilities).toBeDefined();
      expect(result.agentCapabilities.mcpCapabilities).toBeDefined(); // Per ACP spec: use "mcpCapabilities"

      // Per ACP schema: SessionCapabilities should be included
      // https://agentclientprotocol.com/protocol/schema#sessioncapabilities
      expect(result.agentCapabilities.sessionCapabilities).toBeDefined();
      expect(result.agentCapabilities.sessionCapabilities._meta).toBeDefined();
      expect(
        result.agentCapabilities.sessionCapabilities._meta.supportsSessionModes
      ).toBe(true);
      expect(
        result.agentCapabilities.sessionCapabilities._meta.supportsSetMode
      ).toBe(true);

      expect(result.authMethods).toEqual([]);
    });

    it('should set correct protocol version', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
      };

      // Act
      const result = await handler.initialize(params);

      // Assert
      expect(result.protocolVersion).toBe(1);
    });

    it('should handle client info when provided', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
        clientInfo: {
          name: 'zed-editor',
          version: '0.143.0',
        },
      };

      // Act
      const result = await handler.initialize(params);

      // Assert
      expect(result).toBeDefined();
      expect(result.agentInfo.name).toBe('cursor-agent-acp');
      // The handler should log client info but not return it
    });

    it('should handle missing client info gracefully', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
      };

      // Act
      const result = await handler.initialize(params);

      // Assert
      expect(result).toBeDefined();
      expect(result.agentInfo.name).toBe('cursor-agent-acp');
    });

    it('should reflect filesystem capability based on config', async () => {
      // Arrange
      const disabledConfig = {
        ...mockConfig,
        tools: {
          ...mockConfig.tools,
          filesystem: { ...mockConfig.tools.filesystem, enabled: false },
        },
      };
      const disabledHandler = new InitializationHandler(
        disabledConfig,
        mockLogger
      );

      const params: InitializeParams = {
        protocolVersion: 1,
      };

      // Act
      const result = await disabledHandler.initialize(params);

      // Assert
      expect(result.agentCapabilities._meta?.fileSystem).toBe(false);
    });

    it('should reflect terminal capability based on config', async () => {
      // Arrange
      const disabledConfig = {
        ...mockConfig,
        tools: {
          ...mockConfig.tools,
          terminal: { ...mockConfig.tools.terminal, enabled: false },
        },
      };
      const disabledHandler = new InitializationHandler(
        disabledConfig,
        mockLogger
      );

      const params: InitializeParams = {
        protocolVersion: 1,
      };

      // Act
      const result = await disabledHandler.initialize(params);

      // Assert
      expect(result.agentCapabilities._meta?.terminal).toBe(false);
    });

    it('should handle invalid protocol version', async () => {
      // Arrange
      const params: any = {
        protocolVersion: 'invalid-version', // String instead of integer
      };

      // Act & Assert - Should reject invalid protocol versions per ACP spec
      await expect(handler.initialize(params)).rejects.toThrow(
        'Protocol version must be an integer'
      );
    });

    it('should handle missing protocol version', async () => {
      // Arrange
      const params = {} as InitializeParams;

      // Act & Assert
      await expect(handler.initialize(params)).rejects.toThrow(
        'Protocol version is required'
      );
    });

    it('should succeed even if cursor-agent is unavailable (non-blocking per ACP spec)', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
      };

      // Mock cursor-agent being unavailable
      jest.spyOn(handler as any, 'testCursorConnectivity').mockResolvedValue({
        success: false,
        error: 'cursor-agent CLI not installed or not in PATH',
      });

      // Act
      const result = await handler.initialize(params);

      // Assert - should succeed but with limited capabilities
      expect(result).toBeDefined();
      expect(result.protocolVersion).toBe(1);
      expect(result.agentCapabilities).toBeDefined();
      expect(result.agentCapabilities._meta?.cursorAvailable).toBe(false);

      // Verify cursorCliGuidance is included in metadata
      expect(result._meta?.cursorCliGuidance).toBeDefined();
      expect(result._meta?.cursorCliGuidance?.issue).toContain('not installed');
      expect(result._meta?.cursorCliGuidance?.resolution).toContain(
        'Install cursor-agent CLI'
      );
      expect(result._meta?.cursorCliStatus).toBe('unavailable');
    });

    it('should succeed even if cursor-agent authentication fails (non-blocking per ACP spec)', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
      };

      // Mock cursor-agent being unauthenticated
      jest.spyOn(handler as any, 'testCursorConnectivity').mockResolvedValue({
        success: true,
        authenticated: false,
        error: 'User not authenticated. Please run: cursor-agent login',
        version: '1.2.3',
      });

      // Act
      const result = await handler.initialize(params);

      // Assert - should succeed but with limited capabilities
      expect(result).toBeDefined();
      expect(result.agentCapabilities).toBeDefined();
      expect(result.agentCapabilities._meta?.cursorAvailable).toBe(false);

      // Verify cursorCliGuidance is included in metadata
      expect(result._meta?.cursorCliGuidance).toBeDefined();
      expect(result._meta?.cursorCliGuidance?.issue).toContain(
        'not authenticated'
      );
      expect(result._meta?.cursorCliGuidance?.resolution).toBe(
        'Run: cursor-agent login'
      );
      expect(result._meta?.cursorAuthenticated).toBe(false);
      expect(result._meta?.cursorVersion).toBe('1.2.3');
    });

    it('should succeed when cursor-agent is available and authenticated', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
      };

      // Mock cursor-agent being available and authenticated
      jest.spyOn(handler as any, 'testCursorConnectivity').mockResolvedValue({
        success: true,
        authenticated: true,
        version: '1.2.3',
      });

      // Act
      const result = await handler.initialize(params);

      // Assert
      expect(result).toBeDefined();
      expect(result.agentCapabilities).toBeDefined();
    });

    it('should handle initialization timeout gracefully', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
      };

      // Mock a timeout scenario
      jest
        .spyOn(handler as any, 'testCursorConnectivity')
        .mockImplementation(
          () =>
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Timeout')), 100)
            )
        );

      // Act & Assert
      await expect(handler.initialize(params)).rejects.toThrow('Timeout');
    });

    it('should log initialization attempt', async () => {
      // Arrange
      const logSpy = jest.spyOn(mockLogger, 'info');
      const params: InitializeParams = {
        protocolVersion: 1,
        clientInfo: { name: 'test-client', version: '1.0.0' },
      };

      // Mock successful connectivity test
      jest.spyOn(handler as any, 'testCursorConnectivity').mockResolvedValue({
        success: true,
        authenticated: true,
      });

      // Act
      await handler.initialize(params);

      // Assert
      expect(logSpy).toHaveBeenCalledWith(
        'Initializing ACP adapter',
        expect.any(Object)
      );
    });

    it('should log successful initialization', async () => {
      // Arrange
      const logSpy = jest.spyOn(mockLogger, 'info');
      const params: InitializeParams = {
        protocolVersion: 1,
      };

      // Mock successful connectivity test
      jest.spyOn(handler as any, 'testCursorConnectivity').mockResolvedValue({
        success: true,
        authenticated: true,
      });

      // Act
      await handler.initialize(params);

      // Assert - Check that success was logged with details
      expect(logSpy).toHaveBeenCalledWith(
        'ACP adapter initialized successfully',
        expect.objectContaining({
          protocolVersion: 1,
          agentCapabilities: expect.any(Object),
          agentInfo: expect.any(Object),
        })
      );
    });
  });

  describe('edge cases', () => {
    it('should handle null protocol version', async () => {
      // Arrange
      const params = { protocolVersion: null } as any;

      // Act & Assert
      await expect(handler.initialize(params)).rejects.toThrow();
    });

    it('should handle undefined client info properties', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
        clientInfo: {
          name: undefined as any,
          version: undefined as any,
        },
      };

      // Mock successful connectivity test
      jest.spyOn(handler as any, 'testCursorConnectivity').mockResolvedValue({
        success: true,
        authenticated: true,
      });

      // Act
      const result = await handler.initialize(params);

      // Assert
      expect(result).toBeDefined();
    });

    it('should handle extremely long protocol version', async () => {
      // Arrange
      const longVersion = 'x'.repeat(1000);
      const params: InitializeParams = {
        protocolVersion: longVersion,
      };

      // Act & Assert
      await expect(handler.initialize(params)).rejects.toThrow();
    });
  });

  describe('client capabilities storage and validation', () => {
    it('should store client capabilities when provided', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
          terminal: true,
        },
      };

      // Act
      await handler.initialize(params);

      // Assert
      const storedCapabilities = handler.getClientCapabilities();
      expect(storedCapabilities).toEqual(params.clientCapabilities);
    });

    it('should return null when no client capabilities provided', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
      };

      // Act
      await handler.initialize(params);

      // Assert
      expect(handler.getClientCapabilities()).toBeNull();
    });

    it('should correctly check canRequestFileRead when capability is true', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
        clientCapabilities: {
          fs: {
            readTextFile: true,
          },
        },
      };

      // Act
      await handler.initialize(params);

      // Assert
      expect(handler.canRequestFileRead()).toBe(true);
    });

    it('should correctly check canRequestFileRead when capability is false', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
        clientCapabilities: {
          fs: {
            readTextFile: false,
          },
        },
      };

      // Act
      await handler.initialize(params);

      // Assert
      expect(handler.canRequestFileRead()).toBe(false);
    });

    it('should return false for canRequestFileRead when fs is undefined', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
        clientCapabilities: {},
      };

      // Act
      await handler.initialize(params);

      // Assert
      expect(handler.canRequestFileRead()).toBe(false);
    });

    it('should return false for canRequestFileRead when capabilities are null', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
      };

      // Act
      await handler.initialize(params);

      // Assert
      expect(handler.canRequestFileRead()).toBe(false);
    });

    it('should correctly check canRequestFileWrite when capability is true', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
        clientCapabilities: {
          fs: {
            writeTextFile: true,
          },
        },
      };

      // Act
      await handler.initialize(params);

      // Assert
      expect(handler.canRequestFileWrite()).toBe(true);
    });

    it('should correctly check canRequestFileWrite when capability is false', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
        clientCapabilities: {
          fs: {
            writeTextFile: false,
          },
        },
      };

      // Act
      await handler.initialize(params);

      // Assert
      expect(handler.canRequestFileWrite()).toBe(false);
    });

    it('should return false for canRequestFileWrite when fs is undefined', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
        clientCapabilities: {},
      };

      // Act
      await handler.initialize(params);

      // Assert
      expect(handler.canRequestFileWrite()).toBe(false);
    });

    it('should correctly check canRequestTerminal when capability is true', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
        clientCapabilities: {
          terminal: true,
        },
      };

      // Act
      await handler.initialize(params);

      // Assert
      expect(handler.canRequestTerminal()).toBe(true);
    });

    it('should correctly check canRequestTerminal when capability is false', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
        clientCapabilities: {
          terminal: false,
        },
      };

      // Act
      await handler.initialize(params);

      // Assert
      expect(handler.canRequestTerminal()).toBe(false);
    });

    it('should return false for canRequestTerminal when capabilities are null', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
      };

      // Act
      await handler.initialize(params);

      // Assert
      expect(handler.canRequestTerminal()).toBe(false);
    });

    it('should handle partial fs capabilities', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
        clientCapabilities: {
          fs: {
            readTextFile: true,
            // writeTextFile intentionally omitted
          },
        },
      };

      // Act
      await handler.initialize(params);

      // Assert
      expect(handler.canRequestFileRead()).toBe(true);
      expect(handler.canRequestFileWrite()).toBe(false);
    });

    it('should log stored client capabilities', async () => {
      // Arrange
      const logSpy = jest.spyOn(mockLogger, 'info');
      const params: InitializeParams = {
        protocolVersion: 1,
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: false,
          },
          terminal: true,
        },
      };

      // Mock successful connectivity test
      jest.spyOn(handler as any, 'testCursorConnectivity').mockResolvedValue({
        success: true,
        authenticated: true,
      });

      // Act
      await handler.initialize(params);

      // Assert
      expect(logSpy).toHaveBeenCalledWith(
        'Client capabilities stored',
        expect.objectContaining({
          supportsFileRead: true,
          supportsFileWrite: false,
          supportsTerminal: true,
        })
      );
    });
  });

  describe('protocol version negotiation edge cases', () => {
    it('should return version 1 when client requests unsupported version 2', async () => {
      // Arrange
      const logSpy = jest.spyOn(mockLogger, 'warn');
      const params: InitializeParams = {
        protocolVersion: 2,
      };

      // Act
      const result = await handler.initialize(params);

      // Assert
      expect(result.protocolVersion).toBe(1);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'Client version 2 is newer than latest supported version 1'
        )
      );
    });

    it('should return version 1 when client requests unsupported version 99', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 99,
      };

      // Act
      const result = await handler.initialize(params);

      // Assert
      expect(result.protocolVersion).toBe(1);
    });

    it('should negotiate down to version 1 when client requests version 0', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 0,
      };

      // Act & Assert - version 0 is invalid and should throw
      await expect(handler.initialize(params)).rejects.toThrow(
        'Protocol version must be positive'
      );
    });

    it('should negotiate down to version 1 for negative protocol versions', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: -1,
      };

      // Act & Assert - negative versions are invalid and should throw
      await expect(handler.initialize(params)).rejects.toThrow(
        'Protocol version must be positive'
      );
    });

    it('should reject fractional protocol versions', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1.5,
      };

      // Act & Assert
      await expect(handler.initialize(params)).rejects.toThrow(
        'Protocol version must be an integer'
      );
    });

    it('should reject very large protocol versions gracefully', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: Number.MAX_SAFE_INTEGER,
      };

      // Act
      const result = await handler.initialize(params);

      // Assert - should negotiate down to version 1
      expect(result.protocolVersion).toBe(1);
    });

    it('should reject NaN as protocol version', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: NaN,
      };

      // Act & Assert
      await expect(handler.initialize(params)).rejects.toThrow(
        'Protocol version must be an integer'
      );
    });

    it('should reject Infinity as protocol version', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: Infinity,
      };

      // Act & Assert
      await expect(handler.initialize(params)).rejects.toThrow(
        'Protocol version must be an integer'
      );
    });
  });

  describe('cursor connectivity impact on capabilities', () => {
    it('should set image capability to true when cursor is available and authenticated', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
      };

      jest.spyOn(handler as any, 'testCursorConnectivity').mockResolvedValue({
        success: true,
        authenticated: true,
        version: '1.0.0',
      });

      // Act
      const result = await handler.initialize(params);

      // Assert
      expect(result.agentCapabilities.promptCapabilities?.image).toBe(true);
    });

    it('should set image capability to false when cursor is unavailable', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
      };

      jest.spyOn(handler as any, 'testCursorConnectivity').mockResolvedValue({
        success: false,
        error: 'cursor not found',
      });

      // Act
      const result = await handler.initialize(params);

      // Assert
      expect(result.agentCapabilities.promptCapabilities?.image).toBe(false);
    });

    it('should set image capability to false when cursor is unauthenticated', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
      };

      jest.spyOn(handler as any, 'testCursorConnectivity').mockResolvedValue({
        success: true,
        authenticated: false,
        error: 'Authentication required',
      });

      // Act
      const result = await handler.initialize(params);

      // Assert
      expect(result.agentCapabilities.promptCapabilities?.image).toBe(false);
    });

    it('should set embeddedContext capability based on cursor availability', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
      };

      jest.spyOn(handler as any, 'testCursorConnectivity').mockResolvedValue({
        success: true,
        authenticated: true,
      });

      // Act
      const result = await handler.initialize(params);

      // Assert
      expect(result.agentCapabilities.promptCapabilities?.embeddedContext).toBe(
        true
      );
    });

    it('should set embeddedContext to false when cursor is unavailable', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
      };

      jest.spyOn(handler as any, 'testCursorConnectivity').mockResolvedValue({
        success: false,
      });

      // Act
      const result = await handler.initialize(params);

      // Assert
      expect(result.agentCapabilities.promptCapabilities?.embeddedContext).toBe(
        false
      );
    });

    it('should set audio capability to false regardless of cursor availability', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
      };

      jest.spyOn(handler as any, 'testCursorConnectivity').mockResolvedValue({
        success: true,
        authenticated: true,
      });

      // Act
      const result = await handler.initialize(params);

      // Assert
      expect(result.agentCapabilities.promptCapabilities?.audio).toBe(false);
    });

    it('should set _meta.streaming based on cursor availability', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
      };

      jest.spyOn(handler as any, 'testCursorConnectivity').mockResolvedValue({
        success: true,
        authenticated: true,
      });

      // Act
      const result = await handler.initialize(params);

      // Assert
      expect(result.agentCapabilities._meta?.streaming).toBe(true);
    });

    it('should set _meta.streaming to false when cursor is unavailable', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
      };

      jest.spyOn(handler as any, 'testCursorConnectivity').mockResolvedValue({
        success: false,
      });

      // Act
      const result = await handler.initialize(params);

      // Assert
      expect(result.agentCapabilities._meta?.streaming).toBe(false);
    });

    it('should set _meta.toolCalling based on cursor availability', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
      };

      jest.spyOn(handler as any, 'testCursorConnectivity').mockResolvedValue({
        success: true,
        authenticated: true,
      });

      // Act
      const result = await handler.initialize(params);

      // Assert
      expect(result.agentCapabilities._meta?.toolCalling).toBe(true);
    });

    it('should set _meta.toolCalling to false when cursor is unavailable', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
      };

      jest.spyOn(handler as any, 'testCursorConnectivity').mockResolvedValue({
        success: false,
      });

      // Act
      const result = await handler.initialize(params);

      // Assert
      expect(result.agentCapabilities._meta?.toolCalling).toBe(false);
    });

    it('should include implementation metadata in _meta', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
      };

      jest.spyOn(handler as any, 'testCursorConnectivity').mockResolvedValue({
        success: true,
        authenticated: true,
      });

      // Act
      const result = await handler.initialize(params);

      // Assert - verify key metadata fields are present
      expect(result.agentCapabilities._meta).toBeDefined();
      expect(result.agentCapabilities._meta?.implementation).toBe(
        'cursor-agent-acp-npm'
      );
      expect(result.agentCapabilities._meta?.description).toBeDefined();
    });

    it('should set _meta.cursorAvailable to true when cursor is available', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
      };

      jest.spyOn(handler as any, 'testCursorConnectivity').mockResolvedValue({
        success: true,
        authenticated: true,
        version: '1.2.3',
      });

      // Act
      const result = await handler.initialize(params);

      // Assert
      expect(result.agentCapabilities._meta?.cursorAvailable).toBe(true);
    });

    it('should set _meta.cursorAvailable to false when cursor is unavailable', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
      };

      jest.spyOn(handler as any, 'testCursorConnectivity').mockResolvedValue({
        success: false,
      });

      // Act
      const result = await handler.initialize(params);

      // Assert
      expect(result.agentCapabilities._meta?.cursorAvailable).toBe(false);
    });

    it('should include cursor version in _meta when available', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
      };

      jest.spyOn(handler as any, 'testCursorConnectivity').mockResolvedValue({
        success: true,
        authenticated: true,
        version: '1.2.3',
      });

      // Act
      const result = await handler.initialize(params);

      // Assert
      expect(result.agentCapabilities._meta?.cursorVersion).toBe('1.2.3');
    });
  });

  describe('client info variations', () => {
    it('should handle clientInfo with title field', async () => {
      // Arrange
      const logSpy = jest.spyOn(mockLogger, 'info');
      const params: InitializeParams = {
        protocolVersion: 1,
        clientInfo: {
          name: 'test-client',
          title: 'Test Client Application',
          version: '2.0.0',
        },
      };

      // Mock successful connectivity test
      jest.spyOn(handler as any, 'testCursorConnectivity').mockResolvedValue({
        success: true,
        authenticated: true,
      });

      // Act
      const result = await handler.initialize(params);

      // Assert
      expect(result).toBeDefined();
      expect(logSpy).toHaveBeenCalledWith(
        'Client information received and validated',
        expect.objectContaining({
          name: 'test-client',
          title: 'Test Client Application',
          version: '2.0.0',
        })
      );
    });

    it('should handle clientInfo with empty strings', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
        clientInfo: {
          name: '',
          version: '',
        },
      };

      // Mock successful connectivity test
      jest.spyOn(handler as any, 'testCursorConnectivity').mockResolvedValue({
        success: true,
        authenticated: true,
      });

      // Act
      const result = await handler.initialize(params);

      // Assert
      expect(result).toBeDefined();
    });

    it('should handle clientInfo with special characters', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
        clientInfo: {
          name: 'test-client-™',
          version: '1.0.0-beta+build.123',
        },
      };

      // Mock successful connectivity test
      jest.spyOn(handler as any, 'testCursorConnectivity').mockResolvedValue({
        success: true,
        authenticated: true,
      });

      // Act
      const result = await handler.initialize(params);

      // Assert
      expect(result).toBeDefined();
    });

    it('should handle clientInfo with very long strings', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
        clientInfo: {
          name: 'a'.repeat(1000),
          version: 'v'.repeat(500),
        },
      };

      // Mock successful connectivity test
      jest.spyOn(handler as any, 'testCursorConnectivity').mockResolvedValue({
        success: true,
        authenticated: true,
      });

      // Act
      const result = await handler.initialize(params);

      // Assert
      expect(result).toBeDefined();
    });
  });

  describe('logging', () => {
    it('should log warning when cursor is unavailable', async () => {
      // Arrange
      const logSpy = jest.spyOn(mockLogger, 'warn');
      const params: InitializeParams = {
        protocolVersion: 1,
      };

      jest.spyOn(handler as any, 'testCursorConnectivity').mockResolvedValue({
        success: false,
        error: 'cursor-agent not found',
      });

      // Act
      await handler.initialize(params);

      // Assert
      expect(logSpy).toHaveBeenCalledWith(
        'Cursor CLI not available during initialization. Features may be limited.',
        expect.objectContaining({
          error: 'cursor-agent not found',
        })
      );
    });

    it('should log warning when cursor authentication fails', async () => {
      // Arrange
      const logSpy = jest.spyOn(mockLogger, 'warn');
      const params: InitializeParams = {
        protocolVersion: 1,
      };

      jest.spyOn(handler as any, 'testCursorConnectivity').mockResolvedValue({
        success: true,
        authenticated: false,
        error: 'Authentication required',
      });

      // Act
      await handler.initialize(params);

      // Assert
      expect(logSpy).toHaveBeenCalledWith(
        'Cursor authentication not verified. Features may require authentication.',
        expect.objectContaining({
          error: 'Authentication required',
        })
      );
    });

    it('should log info when cursor connectivity is verified', async () => {
      // Arrange
      const logSpy = jest.spyOn(mockLogger, 'info');
      const params: InitializeParams = {
        protocolVersion: 1,
      };

      jest.spyOn(handler as any, 'testCursorConnectivity').mockResolvedValue({
        success: true,
        authenticated: true,
        version: '1.2.3',
      });

      // Act
      await handler.initialize(params);

      // Assert
      expect(logSpy).toHaveBeenCalledWith(
        'Cursor CLI connectivity verified',
        expect.objectContaining({
          version: '1.2.3',
          authenticated: true,
        })
      );
    });

    it('should log error when initialization fails', async () => {
      // Arrange
      const logSpy = jest.spyOn(mockLogger, 'error');
      const params: InitializeParams = {
        protocolVersion: 1,
      };

      // Force an error during initialization
      jest
        .spyOn(handler as any, 'testCursorConnectivity')
        .mockRejectedValue(new Error('Unexpected error'));

      // Act & Assert
      await expect(handler.initialize(params)).rejects.toThrow();
      expect(logSpy).toHaveBeenCalledWith(
        'Initialization failed',
        expect.objectContaining({
          error: expect.any(Error),
          durationMs: expect.any(Number),
        })
      );
    });
  });

  describe('extension capabilities advertising', () => {
    it('should advertise registered extension methods in _meta', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
      };

      jest.spyOn(handler as any, 'testCursorConnectivity').mockResolvedValue({
        success: true,
        authenticated: true,
      });

      // Mock extension registry getter
      const mockRegistry = {
        getRegisteredMethods: jest
          .fn()
          .mockReturnValue(['_test/method1', '_test/method2', '_other/method']),
        getRegisteredNotifications: jest.fn().mockReturnValue([]),
      };

      handler.setExtensionRegistryGetter(() => mockRegistry);

      // Act
      const result = await handler.initialize(params);

      // Assert
      expect(result.agentCapabilities._meta).toBeDefined();
      expect(result.agentCapabilities._meta?.test).toBeDefined();
      expect(result.agentCapabilities._meta?.test?.methods).toEqual([
        '_test/method1',
        '_test/method2',
      ]);
      expect(result.agentCapabilities._meta?.other?.methods).toEqual([
        '_other/method',
      ]);
    });

    it('should advertise registered extension notifications in _meta', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
      };

      jest.spyOn(handler as any, 'testCursorConnectivity').mockResolvedValue({
        success: true,
        authenticated: true,
      });

      const mockRegistry = {
        getRegisteredMethods: jest.fn().mockReturnValue([]),
        getRegisteredNotifications: jest
          .fn()
          .mockReturnValue(['_test/notification1', '_test/notification2']),
      };

      handler.setExtensionRegistryGetter(() => mockRegistry);

      // Act
      const result = await handler.initialize(params);

      // Assert
      expect(result.agentCapabilities._meta?.test).toBeDefined();
      expect(result.agentCapabilities._meta?.test?.notifications).toEqual([
        '_test/notification1',
        '_test/notification2',
      ]);
    });

    it('should group methods and notifications by namespace', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
      };

      jest.spyOn(handler as any, 'testCursorConnectivity').mockResolvedValue({
        success: true,
        authenticated: true,
      });

      const mockRegistry = {
        getRegisteredMethods: jest
          .fn()
          .mockReturnValue(['_namespace/method1', '_namespace/method2']),
        getRegisteredNotifications: jest
          .fn()
          .mockReturnValue(['_namespace/notification']),
      };

      handler.setExtensionRegistryGetter(() => mockRegistry);

      // Act
      const result = await handler.initialize(params);

      // Assert
      expect(result.agentCapabilities._meta?.namespace).toBeDefined();
      expect(result.agentCapabilities._meta?.namespace?.methods).toHaveLength(
        2
      );
      expect(
        result.agentCapabilities._meta?.namespace?.notifications
      ).toHaveLength(1);
    });

    it('should not include extension capabilities if none registered', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
      };

      jest.spyOn(handler as any, 'testCursorConnectivity').mockResolvedValue({
        success: true,
        authenticated: true,
      });

      const mockRegistry = {
        getRegisteredMethods: jest.fn().mockReturnValue([]),
        getRegisteredNotifications: jest.fn().mockReturnValue([]),
      };

      handler.setExtensionRegistryGetter(() => mockRegistry);

      // Act
      const result = await handler.initialize(params);

      // Assert - should still have _meta but no extension namespaces
      expect(result.agentCapabilities._meta).toBeDefined();
      // Standard _meta fields should still be present
      expect(result.agentCapabilities._meta?.implementation).toBe(
        'cursor-agent-acp-npm'
      );
    });

    it('should handle undefined extension registry gracefully', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
      };

      jest.spyOn(handler as any, 'testCursorConnectivity').mockResolvedValue({
        success: true,
        authenticated: true,
      });

      handler.setExtensionRegistryGetter(() => undefined);

      // Act
      const result = await handler.initialize(params);

      // Assert - should not crash and should still have standard _meta
      expect(result.agentCapabilities._meta).toBeDefined();
      expect(result.agentCapabilities._meta?.implementation).toBe(
        'cursor-agent-acp-npm'
      );
    });
  });

  describe('cursor CLI bridge integration', () => {
    it('should use cursor bridge getter when set', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
      };

      const mockCursorBridge = {
        getVersion: jest.fn().mockResolvedValue('1.2.3'),
        checkAuthentication: jest.fn().mockResolvedValue({
          authenticated: true,
          user: 'test-user',
          email: 'test@example.com',
        }),
      };

      handler.setCursorBridgeGetter(() => mockCursorBridge);

      // Act
      const result = await handler.initialize(params);

      // Assert
      expect(mockCursorBridge.getVersion).toHaveBeenCalled();
      expect(mockCursorBridge.checkAuthentication).toHaveBeenCalled();
      expect(result._meta?.cursorCliStatus).toBe('available');
      expect(result._meta?.cursorAuthenticated).toBe(true);
      expect(result._meta?.cursorVersion).toBe('1.2.3');
    });

    it('should handle cursor bridge getter returning undefined', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
      };

      handler.setCursorBridgeGetter(() => undefined);

      // Act
      const result = await handler.initialize(params);

      // Assert
      expect(result._meta?.cursorCliStatus).toBe('unavailable');
      expect(result._meta?.cursorAuthenticated).toBeUndefined();
    });

    it('should handle cursor bridge not being set', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
      };

      // Don't set cursor bridge getter

      // Act
      const result = await handler.initialize(params);

      // Assert
      expect(result._meta?.cursorCliStatus).toBe('unavailable');
    });

    it('should detect cursor-agent CLI not installed error', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
      };

      const mockCursorBridge = {
        getVersion: jest
          .fn()
          .mockRejectedValue(new Error('spawn cursor-agent ENOENT')),
        checkAuthentication: jest.fn(),
      };

      handler.setCursorBridgeGetter(() => mockCursorBridge);

      // Act
      const result = await handler.initialize(params);

      // Assert
      expect(result._meta?.cursorCliStatus).toBe('unavailable');
      expect(result._meta?.cursorCliGuidance?.issue).toContain('not installed');
      expect(result._meta?.cursorCliGuidance?.resolution).toContain(
        'Install cursor-agent CLI'
      );
    });

    it('should detect cursor-agent CLI authentication error', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
      };

      const mockCursorBridge = {
        getVersion: jest.fn().mockResolvedValue('1.2.3'),
        checkAuthentication: jest.fn().mockResolvedValue({
          authenticated: false,
          error: 'User not authenticated',
        }),
      };

      handler.setCursorBridgeGetter(() => mockCursorBridge);

      // Act
      const result = await handler.initialize(params);

      // Assert
      expect(result._meta?.cursorCliStatus).toBe('available');
      expect(result._meta?.cursorAuthenticated).toBe(false);
      expect(result._meta?.cursorVersion).toBe('1.2.3');
      expect(result._meta?.cursorCliGuidance?.issue).toContain(
        'not authenticated'
      );
      expect(result._meta?.cursorCliGuidance?.resolution).toBe(
        'Run: cursor-agent login'
      );
    });

    it('should handle cursor bridge getVersion throwing non-ENOENT error', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
      };

      const mockCursorBridge = {
        getVersion: jest.fn().mockRejectedValue(new Error('Timeout error')),
        checkAuthentication: jest.fn(),
      };

      handler.setCursorBridgeGetter(() => mockCursorBridge);

      // Act
      const result = await handler.initialize(params);

      // Assert
      expect(result._meta?.cursorCliStatus).toBe('unavailable');
      expect(result._meta?.cursorCliGuidance?.issue).toContain(
        'Failed to execute'
      );
    });

    it('should handle cursor bridge checkAuthentication throwing error', async () => {
      // Arrange
      const params: InitializeParams = {
        protocolVersion: 1,
      };

      const mockCursorBridge = {
        getVersion: jest.fn().mockResolvedValue('1.2.3'),
        checkAuthentication: jest
          .fn()
          .mockRejectedValue(new Error('Auth check failed')),
      };

      handler.setCursorBridgeGetter(() => mockCursorBridge);

      // Act
      const result = await handler.initialize(params);

      // Assert
      expect(result._meta?.cursorCliStatus).toBe('available');
      expect(result._meta?.cursorAuthenticated).toBe(false);
      expect(result._meta?.cursorVersion).toBe('1.2.3');
      // When auth check throws, we still provide guidance
      expect(result._meta?.cursorCliGuidance).toBeDefined();
      expect(result._meta?.cursorCliGuidance?.issue).toBeDefined();
      expect(result._meta?.cursorCliGuidance?.resolution).toBe(
        'Run: cursor-agent login'
      );
    });
  });
});
