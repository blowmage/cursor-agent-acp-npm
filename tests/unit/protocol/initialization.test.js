"use strict";
/**
 * Tests for InitializationHandler
 *
 * Tests the ACP initialization process including capability declarations,
 * protocol version validation, and error handling.
 */
Object.defineProperty(exports, "__esModule", { value: true });
/* eslint-disable @typescript-eslint/no-unused-vars, no-unused-vars */
const initialization_1 = require("../../../src/protocol/initialization");
const logger_1 = require("../../../src/utils/logger");
const src_1 = require("../../../src");
const setup_1 = require("../../setup");
describe('InitializationHandler', () => {
    let handler;
    let mockConfig;
    let mockLogger;
    beforeEach(() => {
        mockConfig = { ...src_1.DEFAULT_CONFIG };
        mockLogger = (0, logger_1.createLogger)({ level: 'error', silent: true });
        handler = new initialization_1.InitializationHandler(mockConfig, mockLogger);
    });
    describe('initialize', () => {
        it('should declare all required capabilities', async () => {
            // Arrange
            const params = {
                protocolVersion: setup_1.TEST_CONSTANTS.ACP_PROTOCOL_VERSION,
                clientInfo: {
                    name: 'test-client',
                    version: '1.0.0',
                },
            };
            // Act
            const result = await handler.initialize(params);
            // Assert
            expect(result).toBeValidAcpResponse();
            expect(result.protocolVersion).toBe(setup_1.TEST_CONSTANTS.ACP_PROTOCOL_VERSION);
            expect(result.agentInfo).toEqual({
                name: 'cursor-agent-acp',
                title: 'Cursor Agent ACP Adapter',
                version: expect.any(String), // Dynamic version from package.json
            });
            // Verify all required capabilities are declared per ACP spec
            expect(result.agentCapabilities).toBeDefined();
            expect(result.agentCapabilities.loadSession).toBe(true);
            expect(result.agentCapabilities.promptCapabilities).toBeDefined();
            expect(result.agentCapabilities.mcp).toBeDefined();
            expect(result.authMethods).toEqual([]);
        });
        it('should set correct protocol version', async () => {
            // Arrange
            const params = {
                protocolVersion: 1,
            };
            // Act
            const result = await handler.initialize(params);
            // Assert
            expect(result.protocolVersion).toBe(1);
        });
        it('should handle client info when provided', async () => {
            // Arrange
            const params = {
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
            const params = {
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
            const disabledHandler = new initialization_1.InitializationHandler(disabledConfig, mockLogger);
            const params = {
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
            const disabledHandler = new initialization_1.InitializationHandler(disabledConfig, mockLogger);
            const params = {
                protocolVersion: 1,
            };
            // Act
            const result = await disabledHandler.initialize(params);
            // Assert
            expect(result.agentCapabilities._meta?.terminal).toBe(false);
        });
        it('should handle invalid protocol version', async () => {
            // Arrange
            const params = {
                protocolVersion: 'invalid-version', // String instead of integer
            };
            // Act & Assert - Should reject invalid protocol versions per ACP spec
            await expect(handler.initialize(params)).rejects.toThrow('Protocol version must be an integer');
        });
        it('should handle missing protocol version', async () => {
            // Arrange
            const params = {};
            // Act & Assert
            await expect(handler.initialize(params)).rejects.toThrow('Protocol version is required');
        });
        it('should succeed even if cursor-agent is unavailable (non-blocking per ACP spec)', async () => {
            // Arrange
            const params = {
                protocolVersion: 1,
            };
            // Mock cursor-agent being unavailable
            jest
                .spyOn(handler, 'testCursorConnectivity')
                .mockResolvedValue({
                success: false,
                error: 'cursor-agent not found',
            });
            // Act
            const result = await handler.initialize(params);
            // Assert - should succeed but with limited capabilities
            expect(result).toBeDefined();
            expect(result.protocolVersion).toBe(1);
            expect(result.agentCapabilities).toBeDefined();
            expect(result.agentCapabilities._meta?.cursorAvailable).toBe(false);
        });
        it('should succeed even if cursor-agent authentication fails (non-blocking per ACP spec)', async () => {
            // Arrange
            const params = {
                protocolVersion: 1,
            };
            // Mock cursor-agent being unauthenticated
            jest.spyOn(handler, 'testCursorConnectivity').mockResolvedValue({
                success: true,
                authenticated: false,
                error: 'Authentication required',
            });
            // Act
            const result = await handler.initialize(params);
            // Assert - should succeed but with limited capabilities
            expect(result).toBeDefined();
            expect(result.agentCapabilities).toBeDefined();
            expect(result.agentCapabilities._meta?.cursorAvailable).toBe(false);
        });
        it('should succeed when cursor-agent is available and authenticated', async () => {
            // Arrange
            const params = {
                protocolVersion: 1,
            };
            // Mock cursor-agent being available and authenticated
            jest.spyOn(handler, 'testCursorConnectivity').mockResolvedValue({
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
            const params = {
                protocolVersion: 1,
            };
            // Mock a timeout scenario
            jest
                .spyOn(handler, 'testCursorConnectivity')
                .mockImplementation(() => new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 100)));
            // Act & Assert
            await expect(handler.initialize(params)).rejects.toThrow('Timeout');
        });
        it('should log initialization attempt', async () => {
            // Arrange
            const logSpy = jest.spyOn(mockLogger, 'info');
            const params = {
                protocolVersion: 1,
                clientInfo: { name: 'test-client', version: '1.0.0' },
            };
            // Mock successful connectivity test
            jest.spyOn(handler, 'testCursorConnectivity').mockResolvedValue({
                success: true,
                authenticated: true,
            });
            // Act
            await handler.initialize(params);
            // Assert
            expect(logSpy).toHaveBeenCalledWith('Initializing ACP adapter', expect.any(Object));
        });
        it('should log successful initialization', async () => {
            // Arrange
            const logSpy = jest.spyOn(mockLogger, 'info');
            const params = {
                protocolVersion: 1,
            };
            // Mock successful connectivity test
            jest.spyOn(handler, 'testCursorConnectivity').mockResolvedValue({
                success: true,
                authenticated: true,
            });
            // Act
            await handler.initialize(params);
            // Assert
            expect(logSpy).toHaveBeenCalledWith('ACP adapter initialized successfully');
        });
    });
    describe('edge cases', () => {
        it('should handle null protocol version', async () => {
            // Arrange
            const params = { protocolVersion: null };
            // Act & Assert
            await expect(handler.initialize(params)).rejects.toThrow();
        });
        it('should handle undefined client info properties', async () => {
            // Arrange
            const params = {
                protocolVersion: 1,
                clientInfo: {
                    name: undefined,
                    version: undefined,
                },
            };
            // Mock successful connectivity test
            jest.spyOn(handler, 'testCursorConnectivity').mockResolvedValue({
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
            const params = {
                protocolVersion: longVersion,
            };
            // Act & Assert
            await expect(handler.initialize(params)).rejects.toThrow();
        });
    });
});
//# sourceMappingURL=initialization.test.js.map