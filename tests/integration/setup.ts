/**
 * Integration test setup
 *
 * This file runs after the test environment is set up.
 * It provides global test utilities and mocks for integration tests.
 */

import { jest } from '@jest/globals';

// Mock the @agentclientprotocol/sdk ES module before any imports
jest.mock('@agentclientprotocol/sdk', () => ({
  AgentSideConnection: jest.fn(),
  ndJsonStream: jest.fn(),
  // Add other exports as needed
}));

// Mock console methods to reduce noise during integration tests
const originalConsole = global.console;
global.console = {
  ...originalConsole,
  log: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

// Mock process.stdout.write to suppress JSON-RPC messages during tests
// JSON-RPC messages are written to stdout per ACP protocol spec
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = jest.fn((chunk: any, encoding?: any, cb?: any) => {
  // Silently suppress stdout writes during tests (JSON-RPC messages)
  if (typeof cb === 'function') {
    cb();
  }
  return true;
}) as typeof process.stdout.write;

// Mock process.exit to prevent tests from actually exiting
const mockExit = jest.fn();
Object.defineProperty(process, 'exit', {
  value: mockExit,
  writable: true,
});

// Global cleanup after each test
afterEach(() => {
  // Clear all mocks
  jest.clearAllMocks();

  // Clear console mocks
  (global.console.log as jest.Mock).mockClear();
  (global.console.info as jest.Mock).mockClear();
  (global.console.warn as jest.Mock).mockClear();
  (global.console.error as jest.Mock).mockClear();
  (global.console.debug as jest.Mock).mockClear();

  // Reset process.exit mock
  mockExit.mockClear();
});

// Global cleanup after all tests
afterAll(() => {
  // Restore original console
  global.console = originalConsole;
  // Restore original stdout.write
  process.stdout.write = originalStdoutWrite;
});
