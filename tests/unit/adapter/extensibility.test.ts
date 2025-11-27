/**
 * Unit tests for ACP Extensibility support
 *
 * Tests extension method and notification handling in CursorAgentAdapter
 * per ACP spec: https://agentclientprotocol.com/protocol/extensibility
 */

import { CursorAgentAdapter } from '../../../src/adapter/cursor-agent-adapter';
import type { AdapterConfig } from '../../../src/types';
import type { Request } from '@agentclientprotocol/sdk';

// Mock the CursorCliBridge module to prevent actual CLI calls
jest.mock('../../../src/cursor/cli-bridge', () => ({
  CursorCliBridge: jest.fn().mockImplementation(() => ({
    getVersion: jest.fn().mockResolvedValue('1.0.0-mock'),
    checkAuthentication: jest
      .fn()
      .mockResolvedValue({ authenticated: true, user: 'test-user' }),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

describe('CursorAgentAdapter - Extensibility', () => {
  let adapter: CursorAgentAdapter;
  let mockConfig: AdapterConfig;

  beforeEach(() => {
    mockConfig = {
      logLevel: 'debug',
      sessionDir: '/tmp/cursor-test-sessions',
      maxSessions: 10,
      sessionTimeout: 60000,
      tools: {
        filesystem: { enabled: false },
        terminal: {
          enabled: false,
          maxProcesses: 3,
        },
      },
      cursor: {
        timeout: 30000,
        retries: 1,
      },
    };
    adapter = new CursorAgentAdapter(mockConfig);
  });

  afterEach(async () => {
    if (adapter) {
      await adapter.shutdown().catch(() => {
        // Ignore shutdown errors
      });
    }
  });

  describe('Extension Registry', () => {
    it('should initialize extension registry', async () => {
      await adapter.initialize();

      const registry = adapter.getExtensionRegistry();
      expect(registry).toBeDefined();
    });

    it('should throw error if registry accessed before initialization', () => {
      expect(() => adapter.getExtensionRegistry()).toThrow(
        'Extension registry not initialized'
      );
    });
  });

  describe('Extension Method Handling', () => {
    beforeEach(async () => {
      await adapter.initialize();
    });

    it('should handle registered extension method', async () => {
      const registry = adapter.getExtensionRegistry();
      const handler = jest.fn().mockResolvedValue({ result: 'success' });

      registry.registerMethod('_test/method', handler);

      const request = {
        jsonrpc: '2.0',
        id: 1,
        method: '_test/method',
        params: { param: 'value' },
      } as Request;

      const response = await adapter.processRequest(request);

      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe(1);
      expect(response.result).toEqual({ result: 'success' });
      expect(handler).toHaveBeenCalledWith({ param: 'value' });
    });

    it('should return JSON-RPC error for unregistered extension method', async () => {
      const request = {
        jsonrpc: '2.0',
        id: 1,
        method: '_test/nonexistent',
        params: {},
      } as Request;

      const response = await adapter.processRequest(request);

      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe(1);
      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32601);
      expect(response.error?.message).toBe('Method not found');
    });

    it('should return JSON-RPC error for array params', async () => {
      const registry = adapter.getExtensionRegistry();
      registry.registerMethod('_test/method', jest.fn());

      const request = {
        jsonrpc: '2.0',
        id: 1,
        method: '_test/method',
        params: ['array', 'params'],
      } as Request;

      const response = await adapter.processRequest(request);

      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32602);
      expect(response.error?.message).toContain('Invalid params');
    });

    it('should return JSON-RPC error for non-object params', async () => {
      const registry = adapter.getExtensionRegistry();
      registry.registerMethod('_test/method', jest.fn());

      const request = {
        jsonrpc: '2.0',
        id: 1,
        method: '_test/method',
        params: 'string-params',
      } as Request;

      const response = await adapter.processRequest(request);

      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32602);
      expect(response.error?.message).toContain('Invalid params');
    });

    it('should accept undefined params', async () => {
      const registry = adapter.getExtensionRegistry();
      const handler = jest.fn().mockResolvedValue({ ok: true });
      registry.registerMethod('_test/method', handler);

      const request = {
        jsonrpc: '2.0',
        id: 1,
        method: '_test/method',
        // params intentionally omitted
      } as Request;

      const response = await adapter.processRequest(request);

      expect(response.error).toBeUndefined();
      expect(response.result).toEqual({ ok: true });
      expect(handler).toHaveBeenCalledWith({});
    });

    it('should return JSON-RPC error for handler exceptions', async () => {
      const registry = adapter.getExtensionRegistry();
      const handler = jest
        .fn()
        .mockRejectedValue(new Error('Handler execution failed'));

      registry.registerMethod('_test/method', handler);

      const request = {
        jsonrpc: '2.0',
        id: 1,
        method: '_test/method',
        params: {},
      } as Request;

      const response = await adapter.processRequest(request);

      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe(1);
      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32603);
      expect(response.error?.message).toBe('Handler execution failed');
    });

    it('should route extension methods (starting with _) to extension handler', async () => {
      const registry = adapter.getExtensionRegistry();
      const handler = jest.fn().mockResolvedValue({ handled: true });

      registry.registerMethod('_custom/extension', handler);

      const request: Request = {
        jsonrpc: '2.0',
        id: 1,
        method: '_custom/extension',
        params: { test: 'data' },
      };

      const response = await adapter.processRequest(request);

      expect(response.result).toEqual({ handled: true });
      expect(handler).toHaveBeenCalledWith({ test: 'data' });
    });

    it('should not route standard methods to extension handler', async () => {
      const request: Request = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: 1,
        },
      };

      // Should handle as standard method, not extension
      const response = await adapter.processRequest(request);
      expect(response.result).toBeDefined();
      expect(response.error).toBeUndefined();
    });
  });

  describe('Agent Implementation Extension Methods', () => {
    beforeEach(async () => {
      await adapter.initialize();
    });

    it('should delegate extMethod to extension registry', async () => {
      const registry = adapter.getExtensionRegistry();
      const handler = jest.fn().mockResolvedValue({ result: 'delegated' });

      registry.registerMethod('_agent/method', handler);

      // Note: This tests the integration through the adapter
      // The actual extMethod is called by AgentSideConnection
      const request: Request = {
        jsonrpc: '2.0',
        id: 1,
        method: '_agent/method',
        params: { test: true },
      };

      const response = await adapter.processRequest(request);

      expect(response.result).toEqual({ result: 'delegated' });
      expect(handler).toHaveBeenCalledWith({ test: true });
    });
  });

  describe('Custom Capabilities Advertising', () => {
    beforeEach(async () => {
      await adapter.initialize();
    });

    it('should advertise registered extension methods in initialization', async () => {
      const registry = adapter.getExtensionRegistry();
      registry.registerMethod('_test/method1', jest.fn());
      registry.registerMethod('_test/method2', jest.fn());
      registry.registerMethod('_other/method', jest.fn());

      const request: Request = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: 1,
        },
      };

      const response = await adapter.processRequest(request);
      const capabilities = (response.result as any)?.agentCapabilities;

      expect(capabilities?._meta).toBeDefined();
      expect(capabilities?._meta?.test).toBeDefined();
      expect(capabilities?._meta?.test?.methods).toContain('_test/method1');
      expect(capabilities?._meta?.test?.methods).toContain('_test/method2');
      expect(capabilities?._meta?.other?.methods).toContain('_other/method');
    });

    it('should advertise registered extension notifications in initialization', async () => {
      const registry = adapter.getExtensionRegistry();
      registry.registerNotification('_test/notification1', jest.fn());
      registry.registerNotification('_test/notification2', jest.fn());

      const request: Request = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: 1,
        },
      };

      const response = await adapter.processRequest(request);
      const capabilities = (response.result as any)?.agentCapabilities;

      expect(capabilities?._meta?.test).toBeDefined();
      expect(capabilities?._meta?.test?.notifications).toContain(
        '_test/notification1'
      );
      expect(capabilities?._meta?.test?.notifications).toContain(
        '_test/notification2'
      );
    });

    it('should group methods and notifications by namespace', async () => {
      const registry = adapter.getExtensionRegistry();
      registry.registerMethod('_namespace/method1', jest.fn());
      registry.registerMethod('_namespace/method2', jest.fn());
      registry.registerNotification('_namespace/notification', jest.fn());

      const request: Request = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: 1,
        },
      };

      const response = await adapter.processRequest(request);
      const capabilities = (response.result as any)?.agentCapabilities;

      expect(capabilities?._meta?.namespace).toBeDefined();
      expect(capabilities?._meta?.namespace?.methods).toHaveLength(2);
      expect(capabilities?._meta?.namespace?.notifications).toHaveLength(1);
    });

    it('should handle extension methods without slash separator', async () => {
      const registry = adapter.getExtensionRegistry();

      // Register methods without namespace separator (just underscore prefix)
      registry.registerMethod('_simplemethod', jest.fn());
      registry.registerNotification('_simpleevent', jest.fn());

      const request = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: 1,
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      } as Request;

      const response = await adapter.processRequest(request);
      const capabilities = (response.result as any)?.agentCapabilities;

      // Extension names without slashes use the name itself as the namespace
      expect(capabilities?._meta?.simplemethod).toBeDefined();
      expect(capabilities?._meta?.simplemethod?.methods).toContain(
        '_simplemethod'
      );
      expect(capabilities?._meta?.simpleevent).toBeDefined();
      expect(capabilities?._meta?.simpleevent?.notifications).toContain(
        '_simpleevent'
      );
    });

    it('should not include extension capabilities if none registered', async () => {
      const request: Request = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: 1,
        },
      };

      const response = await adapter.processRequest(request);
      const capabilities = (response.result as any)?.agentCapabilities;

      // Should still have _meta but no extension namespaces
      expect(capabilities?._meta).toBeDefined();
      // Check that no extension namespace keys exist (only standard keys)
      const extensionKeys = Object.keys(capabilities?._meta || {}).filter(
        (key) =>
          ![
            'streaming',
            'toolCalling',
            'fileSystem',
            'terminal',
            'cursorAvailable',
            'cursorVersion',
            'description',
            'implementation',
            'repositoryUrl',
          ].includes(key)
      );
      expect(extensionKeys.length).toBe(0);
    });
  });
});
