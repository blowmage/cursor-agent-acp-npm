// Global test setup for unit tests

import { jest } from '@jest/globals';

// Increase max listeners to prevent warnings during parallel test execution
// Jest adds listeners for each test suite for exit handling
// Set to 30 to accommodate 6 test suites running in parallel
process.setMaxListeners(30);

// Extend Jest timeout for all tests
jest.setTimeout(10000);

// Mock console methods to reduce noise during tests unless explicitly needed
const originalConsole = global.console;
global.console = {
  ...originalConsole,
  log: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

// Mock process.exit to prevent tests from actually exiting
const mockExit = jest.fn();
Object.defineProperty(process, 'exit', {
  value: mockExit,
  writable: true,
});

// Mock environment variables for consistent testing
process.env.NODE_ENV = 'test';
process.env.CURSOR_AGENT_ACP_LOG_LEVEL = 'error';
process.env.CURSOR_AGENT_ACP_SESSION_DIR = '/tmp/test-sessions';

// Global test helpers
declare global {
  // eslint-disable-next-line no-unused-vars
  namespace jest {
    // eslint-disable-next-line no-unused-vars
    interface Matchers<R> {
      toBeValidSessionId(): R;
      toBeValidAcpResponse(): R;
      toBeValidInitializeResult(): R;
    }
  }
}

// Custom Jest matchers
expect.extend({
  toBeValidSessionId(received: string) {
    const isValid =
      typeof received === 'string' &&
      received.length > 0 &&
      /^[a-zA-Z0-9-_]+$/.test(received);

    if (isValid) {
      return {
        message: () => `expected ${received} not to be a valid session ID`,
        pass: true,
      };
    }
    return {
      message: () => `expected ${received} to be a valid session ID`,
      pass: false,
    };
  },

  toBeValidAcpResponse(received: any) {
    // For initialization responses and other direct results (not JSON-RPC wrapped)
    const isDirectResult =
      received &&
      typeof received === 'object' &&
      (received.protocolVersion !== undefined ||
        received.capabilities !== undefined ||
        received.sessionId !== undefined);

    // For JSON-RPC wrapped responses
    const isJsonRpcResponse =
      received &&
      typeof received === 'object' &&
      typeof received.jsonrpc === 'string' &&
      received.jsonrpc === '2.0' &&
      (received.result !== undefined || received.error !== undefined) &&
      (typeof received.id === 'string' ||
        typeof received.id === 'number' ||
        received.id === null);

    const isValid = isDirectResult || isJsonRpcResponse;

    if (isValid) {
      return {
        message: () => `expected response not to be valid ACP response`,
        pass: true,
      };
    }
    return {
      message: () =>
        `expected response to be valid ACP response, got: ${JSON.stringify(received)}`,
      pass: false,
    };
  },

  toBeValidInitializeResult(received: any) {
    const isValid =
      received &&
      typeof received === 'object' &&
      typeof received.protocolVersion === 'string' &&
      received.serverInfo &&
      typeof received.serverInfo.name === 'string' &&
      typeof received.serverInfo.version === 'string' &&
      received.capabilities &&
      typeof received.capabilities === 'object';

    if (isValid) {
      return {
        message: () => `expected response not to be valid initialize result`,
        pass: true,
      };
    }
    return {
      message: () =>
        `expected response to be valid initialize result, got: ${JSON.stringify(received)}`,
      pass: false,
    };
  },
});

// Clean up after each test
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

// Global cleanup
afterAll(() => {
  // Restore original console
  global.console = originalConsole;
});

// Helper functions for tests
export const testHelpers = {
  // Create a mock ACP request
  createMockAcpRequest: (
    method: string,
    params: any = {},
    id: string | number = 1
  ) => ({
    jsonrpc: '2.0' as const,
    method,
    params,
    id,
  }),

  // Create a mock ACP response
  createMockAcpResponse: (result: any, id: string | number = 1) => ({
    jsonrpc: '2.0' as const,
    result,
    id,
  }),

  // Create a mock ACP error response
  createMockAcpError: (
    code: number,
    message: string,
    id: string | number = 1
  ) => ({
    jsonrpc: '2.0' as const,
    error: { code, message },
    id,
  }),

  // Generate a test session ID
  generateTestSessionId: (): string => {
    return `test-session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  },

  // Wait for a specified amount of time
  wait: (ms: number): Promise<void> => {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },

  // Create a temporary directory for testing
  createTempDir: async (): Promise<string> => {
    const fs = await import('fs/promises');
    const path = await import('path');
    const os = await import('os');

    const tempDir = path.join(os.tmpdir(), `cursor-acp-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
    return tempDir;
  },

  // Clean up temporary directory
  cleanupTempDir: async (dirPath: string): Promise<void> => {
    const fs = await import('fs/promises');
    try {
      await fs.rm(dirPath, { recursive: true, force: true });
    } catch (error) {
      // Ignore errors during cleanup
    }
  },
};

// Export commonly used test constants
export const TEST_CONSTANTS = {
  DEFAULT_TIMEOUT: 5000,
  LONG_TIMEOUT: 10000,
  SHORT_TIMEOUT: 1000,

  MOCK_SESSION_ID: 'mock-session-12345',
  MOCK_USER_ID: 'test-user',

  SAMPLE_TEXT_CONTENT: 'This is sample text content for testing',
  SAMPLE_CODE_CONTENT: 'console.log("Hello, world!");',

  ACP_PROTOCOL_VERSION: 1, // Per ACP spec: protocol versions are integers
} as const;
