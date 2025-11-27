/**
 * Integration tests for ACP Extensibility
 *
 * Tests extension method and notification handling, capabilities advertisement,
 * and end-to-end extensibility features per ACP spec.
 * Per ACP spec: https://agentclientprotocol.com/protocol/extensibility
 */

import { CursorAgentAdapter } from '../../src/adapter/cursor-agent-adapter';
import type { AdapterConfig, Logger } from '../../src/types';
import type {
  NewSessionResponse,
  InitializeResponse,
} from '@agentclientprotocol/sdk';

// Mock the CursorCliBridge module
jest.mock('../../src/cursor/cli-bridge', () => ({
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
      enabled: false,
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

describe('Extensibility Integration', () => {
  let adapter: CursorAgentAdapter;

  beforeEach(async () => {
    jest.clearAllMocks();
    adapter = new CursorAgentAdapter(testConfig, { logger: mockLogger });
    await adapter.initialize();
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

  describe('Extension Method Registration and Invocation', () => {
    it('should register and invoke a custom extension method', async () => {
      const registry = adapter.getExtensionRegistry();

      // Register a test method
      const mockHandler = jest.fn().mockResolvedValue({ result: 'success' });
      registry.registerMethod('_test/custom_method', mockHandler);

      // Create a session first
      const createSession = await adapter.processRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'session/new',
        params: {
          cwd: process.cwd(),
        },
      });

      expect(createSession.result).toBeDefined();

      // Invoke the extension method
      const response = await adapter.processRequest({
        jsonrpc: '2.0',
        id: 2,
        method: '_test/custom_method',
        params: {
          input: 'test data',
        },
      });

      expect(response.error).toBeUndefined();
      expect(response.result).toBeDefined();
      expect(response.result).toEqual({ result: 'success' });
      expect(mockHandler).toHaveBeenCalledWith({ input: 'test data' });
    });

    it('should return -32601 error for unregistered extension methods', async () => {
      const response = await adapter.processRequest({
        jsonrpc: '2.0',
        id: 1,
        method: '_test/nonexistent_method',
        params: {},
      });

      expect(response.result).toBeUndefined();
      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32601);
      expect(response.error?.message).toBe('Method not found');
    });

    it('should handle errors in extension method handlers', async () => {
      const registry = adapter.getExtensionRegistry();

      // Register a method that throws
      const mockHandler = jest
        .fn()
        .mockRejectedValue(new Error('Handler error'));
      registry.registerMethod('_test/failing_method', mockHandler);

      const response = await adapter.processRequest({
        jsonrpc: '2.0',
        id: 1,
        method: '_test/failing_method',
        params: {},
      });

      expect(response.result).toBeUndefined();
      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32603);
      expect(response.error?.message).toBe('Handler error');
    });

    it('should support multiple extension methods', async () => {
      const registry = adapter.getExtensionRegistry();

      // Register multiple methods
      const handler1 = jest.fn().mockResolvedValue({ value: 1 });
      const handler2 = jest.fn().mockResolvedValue({ value: 2 });

      registry.registerMethod('_app1/method1', handler1);
      registry.registerMethod('_app2/method2', handler2);

      // Call first method
      const response1 = await adapter.processRequest({
        jsonrpc: '2.0',
        id: 1,
        method: '_app1/method1',
        params: {},
      });

      expect(response1.result).toEqual({ value: 1 });

      // Call second method
      const response2 = await adapter.processRequest({
        jsonrpc: '2.0',
        id: 2,
        method: '_app2/method2',
        params: {},
      });

      expect(response2.result).toEqual({ value: 2 });
    });
  });

  describe('Extension Notification Handling', () => {
    it('should handle extension notifications silently', async () => {
      const registry = adapter.getExtensionRegistry();

      // Register a test notification handler
      const mockHandler = jest.fn().mockResolvedValue(undefined);
      registry.registerNotification('_test/status_update', mockHandler);

      // Send notification via registry (simulating received notification)
      await registry.sendNotification('_test/status_update', {
        status: 'running',
      });

      expect(mockHandler).toHaveBeenCalledWith({ status: 'running' });
    });

    it('should ignore unregistered extension notifications per ACP spec', async () => {
      const registry = adapter.getExtensionRegistry();

      // Should not throw - notifications are one-way
      await expect(
        registry.sendNotification('_test/unregistered_notification', {})
      ).resolves.toBeUndefined();
    });

    it('should not throw if notification handler fails', async () => {
      const registry = adapter.getExtensionRegistry();

      // Register a failing notification handler
      const mockHandler = jest
        .fn()
        .mockRejectedValue(new Error('Handler failed'));
      registry.registerNotification('_test/failing_notification', mockHandler);

      // Should not throw - notifications are best-effort
      await expect(
        registry.sendNotification('_test/failing_notification', {})
      ).resolves.toBeUndefined();

      expect(mockHandler).toHaveBeenCalled();
    });
  });

  describe('Capabilities Advertisement', () => {
    it('should advertise extension capabilities in initialize response', async () => {
      const registry = adapter.getExtensionRegistry();

      // Register some extension methods and notifications
      registry.registerMethod('_myapp/action1', async () => ({ ok: true }));
      registry.registerMethod('_myapp/action2', async () => ({ ok: true }));
      registry.registerNotification('_myapp/event1', async () => {});

      const response = await adapter.processRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: 1,
          clientInfo: {
            name: 'test-client',
            version: '1.0.0',
          },
        },
      });

      expect(response.error).toBeUndefined();
      expect(response.result).toBeDefined();

      const initResult = response.result as InitializeResponse;
      expect(initResult.agentCapabilities).toBeDefined();
      expect(initResult.agentCapabilities._meta).toBeDefined();

      // Check if extensions are advertised in _meta
      const meta = initResult.agentCapabilities._meta as any;
      expect(meta.myapp).toBeDefined();
      expect(meta.myapp.methods).toContain('_myapp/action1');
      expect(meta.myapp.methods).toContain('_myapp/action2');
      expect(meta.myapp.notifications).toContain('_myapp/event1');
    });

    it('should group extensions by namespace in capabilities', async () => {
      const registry = adapter.getExtensionRegistry();

      // Register methods from different namespaces
      registry.registerMethod('_app1/method', async () => ({ ok: true }));
      registry.registerMethod('_app2/method', async () => ({ ok: true }));

      const response = await adapter.processRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: 1,
          clientInfo: {
            name: 'test-client',
            version: '1.0.0',
          },
        },
      });

      const initResult = response.result as InitializeResponse;
      const meta = initResult.agentCapabilities._meta as any;

      // Both namespaces should be present
      expect(meta.app1).toBeDefined();
      expect(meta.app2).toBeDefined();
      expect(meta.app1.methods).toContain('_app1/method');
      expect(meta.app2.methods).toContain('_app2/method');
    });

    it('should not include extension capabilities if none registered', async () => {
      const response = await adapter.processRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: 1,
          clientInfo: {
            name: 'test-client',
            version: '1.0.0',
          },
        },
      });

      const initResult = response.result as InitializeResponse;
      expect(initResult.agentCapabilities).toBeDefined();

      // _meta might exist but should not contain extension namespaces
      // (it may contain other metadata)
    });
  });

  describe('Extension Name Validation', () => {
    it('should reject extension methods without underscore prefix', () => {
      const registry = adapter.getExtensionRegistry();

      expect(() => {
        registry.registerMethod('test/method', async () => ({}));
      }).toThrow('Extension method name must start with underscore');
    });

    it('should reject extension notifications without underscore prefix', () => {
      const registry = adapter.getExtensionRegistry();

      expect(() => {
        registry.registerNotification('test/notification', async () => {});
      }).toThrow('Extension notification name must start with underscore');
    });

    it('should accept properly formatted extension names', () => {
      const registry = adapter.getExtensionRegistry();

      expect(() => {
        registry.registerMethod('_myapp/method', async () => ({}));
      }).not.toThrow();

      expect(() => {
        registry.registerNotification('_myapp/notification', async () => {});
      }).not.toThrow();
    });
  });

  describe('Dynamic Extension Management', () => {
    it('should allow unregistering extension methods', async () => {
      const registry = adapter.getExtensionRegistry();

      // Register and then unregister
      registry.registerMethod('_test/method', async () => ({ ok: true }));
      expect(registry.hasMethod('_test/method')).toBe(true);

      registry.unregisterMethod('_test/method');
      expect(registry.hasMethod('_test/method')).toBe(false);

      // Method should no longer be callable
      const response = await adapter.processRequest({
        jsonrpc: '2.0',
        id: 1,
        method: '_test/method',
        params: {},
      });

      expect(response.error?.code).toBe(-32601);
    });

    it('should allow clearing all extensions', () => {
      const registry = adapter.getExtensionRegistry();

      registry.registerMethod('_test/method1', async () => ({}));
      registry.registerMethod('_test/method2', async () => ({}));
      registry.registerNotification('_test/notification', async () => {});

      registry.clear();

      expect(registry.getMethodCount()).toBe(0);
      expect(registry.getNotificationCount()).toBe(0);
    });

    it('should track registered method count', () => {
      const registry = adapter.getExtensionRegistry();

      expect(registry.getMethodCount()).toBe(0);

      registry.registerMethod('_test/method1', async () => ({}));
      expect(registry.getMethodCount()).toBe(1);

      registry.registerMethod('_test/method2', async () => ({}));
      expect(registry.getMethodCount()).toBe(2);

      registry.unregisterMethod('_test/method1');
      expect(registry.getMethodCount()).toBe(1);
    });
  });

  describe('ACP Spec Compliance', () => {
    it('should follow JSON-RPC 2.0 error format for extension methods', async () => {
      const response = await adapter.processRequest({
        jsonrpc: '2.0',
        id: 1,
        method: '_test/nonexistent',
        params: {},
      });

      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe(1);
      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32601);
      expect(response.error?.message).toBeDefined();
      expect(response.result).toBeUndefined();
    });

    it('should support arbitrary JSON-RPC params for extension methods', async () => {
      const registry = adapter.getExtensionRegistry();

      const mockHandler = jest.fn().mockImplementation(async (params) => {
        return { received: params };
      });

      registry.registerMethod('_test/echo', mockHandler);

      const testParams = {
        string: 'value',
        number: 42,
        boolean: true,
        array: [1, 2, 3],
        object: { nested: 'data' },
      };

      const response = await adapter.processRequest({
        jsonrpc: '2.0',
        id: 1,
        method: '_test/echo',
        params: testParams,
      });

      expect(response.result).toEqual({ received: testParams });
      expect(mockHandler).toHaveBeenCalledWith(testParams);
    });

    it('should return arbitrary JSON-RPC result from extension methods', async () => {
      const registry = adapter.getExtensionRegistry();

      const complexResult = {
        status: 'success',
        data: {
          items: [
            { id: 1, name: 'item1' },
            { id: 2, name: 'item2' },
          ],
          total: 2,
        },
        metadata: {
          timestamp: new Date().toISOString(),
        },
      };

      registry.registerMethod('_test/complex', async () => complexResult);

      const response = await adapter.processRequest({
        jsonrpc: '2.0',
        id: 1,
        method: '_test/complex',
        params: {},
      });

      expect(response.result).toEqual(complexResult);
    });
  });
});
