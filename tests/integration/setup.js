"use strict";
/**
 * Integration test setup
 *
 * This file runs after the test environment is set up.
 * It provides global test utilities and mocks for integration tests.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const globals_1 = require("@jest/globals");
// Mock console methods to reduce noise during integration tests
const originalConsole = global.console;
global.console = {
    ...originalConsole,
    log: globals_1.jest.fn(),
    info: globals_1.jest.fn(),
    warn: globals_1.jest.fn(),
    error: globals_1.jest.fn(),
    debug: globals_1.jest.fn(),
};
// Mock process.exit to prevent tests from actually exiting
const mockExit = globals_1.jest.fn();
Object.defineProperty(process, 'exit', {
    value: mockExit,
    writable: true,
});
// Global cleanup after each test
afterEach(() => {
    // Clear all mocks
    globals_1.jest.clearAllMocks();
    // Clear console mocks
    global.console.log.mockClear();
    global.console.info.mockClear();
    global.console.warn.mockClear();
    global.console.error.mockClear();
    global.console.debug.mockClear();
    // Reset process.exit mock
    mockExit.mockClear();
});
// Global cleanup after all tests
afterAll(() => {
    // Restore original console
    global.console = originalConsole;
});
//# sourceMappingURL=setup.js.map