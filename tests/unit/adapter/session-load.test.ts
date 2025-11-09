/**
 * Unit tests for session/load method validation
 * Tests absolute path validation for cwd parameter
 */

import { CursorAgentAdapter } from '../../../src/adapter/cursor-agent-adapter';
import type { AdapterConfig, AcpRequest, Logger } from '../../../src/types';

// Mock the CursorCliBridge module
jest.mock('../../../src/cursor/cli-bridge', () => ({
  CursorCliBridge: jest.fn().mockImplementation((config, logger) => {
    return {
      getVersion: jest.fn().mockResolvedValue('1.0.0'),
      checkAuthentication: jest
        .fn()
        .mockResolvedValue({ authenticated: true, user: 'test' }),
      close: jest.fn().mockResolvedValue(undefined),
    };
  }),
}));

// Mock logger for tests
const mockLogger: Logger = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
};

// Test configuration
const testConfig: AdapterConfig = {
  logLevel: 'debug',
  sessionDir: '/tmp/cursor-test-sessions',
  maxSessions: 10,
  sessionTimeout: 60000,
  tools: {
    filesystem: {
      enabled: false, // Disabled for adapter tests - not testing filesystem
      allowedPaths: ['/tmp', './'],
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

describe('CursorAgentAdapter - session/load', () => {
  let adapter: CursorAgentAdapter;

  beforeEach(async () => {
    adapter = new CursorAgentAdapter(testConfig, { logger: mockLogger });
    await adapter.initialize();

    // Create a session first for loading
    const createRequest: AcpRequest = {
      jsonrpc: '2.0',
      method: 'session/new',
      id: 'test-create',
      params: {
        cwd: '/tmp/test',
        mcpServers: [],
      },
    };
    await adapter.processRequest(createRequest);
  });

  afterEach(async () => {
    if (adapter) {
      try {
        await adapter.shutdown();
      } catch (error) {
        // Ignore shutdown errors in tests
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  describe('cwd validation', () => {
    it('should reject session/load with relative path', async () => {
      const createResponse = await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-create-1',
        params: {
          cwd: '/tmp/test',
          mcpServers: [],
        },
      });

      const sessionId = createResponse.result.sessionId;

      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/load',
        id: 'test-load-1',
        params: {
          sessionId,
          cwd: 'relative/path',
          mcpServers: [],
        },
      };

      const response = await adapter.processRequest(request);

      expect(response.error).toBeDefined();
      expect(response.error?.message).toContain('cwd must be an absolute path');
    });

    it('should reject session/load with relative path starting with ./', async () => {
      const createResponse = await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-create-2',
        params: {
          cwd: '/tmp/test',
          mcpServers: [],
        },
      });

      const sessionId = createResponse.result.sessionId;

      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/load',
        id: 'test-load-2',
        params: {
          sessionId,
          cwd: './current/path',
          mcpServers: [],
        },
      };

      const response = await adapter.processRequest(request);

      expect(response.error).toBeDefined();
      expect(response.error?.message).toContain('cwd must be an absolute path');
    });

    it('should reject session/load with relative path starting with ../', async () => {
      const createResponse = await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-create-3',
        params: {
          cwd: '/tmp/test',
          mcpServers: [],
        },
      });

      const sessionId = createResponse.result.sessionId;

      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/load',
        id: 'test-load-3',
        params: {
          sessionId,
          cwd: '../parent/path',
          mcpServers: [],
        },
      };

      const response = await adapter.processRequest(request);

      expect(response.error).toBeDefined();
      expect(response.error?.message).toContain('cwd must be an absolute path');
    });

    it('should accept session/load with Unix absolute path', async () => {
      const createResponse = await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-create-4',
        params: {
          cwd: '/tmp/test',
          mcpServers: [],
        },
      });

      const sessionId = createResponse.result.sessionId;

      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/load',
        id: 'test-load-4',
        params: {
          sessionId,
          cwd: '/absolute/unix/path',
          mcpServers: [],
        },
      };

      const response = await adapter.processRequest(request);

      expect(response.result).toBeDefined();
      expect(response.error).toBeUndefined();
    });

    it('should accept session/load with Windows absolute path', async () => {
      const createResponse = await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-create-5',
        params: {
          cwd: '/tmp/test',
          mcpServers: [],
        },
      });

      const sessionId = createResponse.result.sessionId;

      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/load',
        id: 'test-load-5',
        params: {
          sessionId,
          cwd: 'C:\\absolute\\windows\\path',
          mcpServers: [],
        },
      };

      const response = await adapter.processRequest(request);

      expect(response.result).toBeDefined();
      expect(response.error).toBeUndefined();
    });

    it('should accept session/load with Windows absolute path (forward slashes)', async () => {
      const createResponse = await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-create-6',
        params: {
          cwd: '/tmp/test',
          mcpServers: [],
        },
      });

      const sessionId = createResponse.result.sessionId;

      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/load',
        id: 'test-load-6',
        params: {
          sessionId,
          cwd: 'D:/absolute/windows/path',
          mcpServers: [],
        },
      };

      const response = await adapter.processRequest(request);

      expect(response.result).toBeDefined();
      expect(response.error).toBeUndefined();
    });

    it('should reject session/load with non-string cwd', async () => {
      const createResponse = await adapter.processRequest({
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'test-create-7',
        params: {
          cwd: '/tmp/test',
          mcpServers: [],
        },
      });

      const sessionId = createResponse.result.sessionId;

      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/load',
        id: 'test-load-7',
        params: {
          sessionId,
          cwd: 123 as any,
          mcpServers: [],
        },
      };

      const response = await adapter.processRequest(request);

      expect(response.error).toBeDefined();
      expect(response.error?.message).toContain('cwd must be a string');
    });
  });
});
