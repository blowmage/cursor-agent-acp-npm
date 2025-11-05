"use strict";
/**
 * Integration test environment setup
 *
 * This file runs before all tests to set up the test environment.
 * It configures environment variables and global test settings.
 */
// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.CURSOR_AGENT_ACP_LOG_LEVEL = 'error';
process.env.CURSOR_AGENT_ACP_SESSION_DIR = '/tmp/cursor-test-sessions';
// Increase max listeners to prevent warnings during test execution
process.setMaxListeners(50);
// Set longer timeout for integration tests
jest.setTimeout(70000);
//# sourceMappingURL=env.js.map