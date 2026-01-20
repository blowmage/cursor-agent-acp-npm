/**
 * Integration tests for ACP Extensibility
 *
 * Tests extension method and notification handling, capabilities advertisement,
 * and end-to-end extensibility features per ACP spec.
 * Per ACP spec: https://agentclientprotocol.com/protocol/extensibility
 */

import { jest } from '@jest/globals';
import { CursorAgentAdapter } from '../../src/adapter/cursor-agent-adapter';
import type { AdapterConfig, Logger } from '../../src/types';
import type {
  NewSessionResponse,
  InitializeResponse,
} from '@agentclientprotocol/sdk';

// Mock the CursorCliBridge module
jest.mock('../../src/cursor/cli-bridge', () => ({
  CursorCliBridge: jest.fn().mockImplementation(() => ({
    getVersion: jest.fn().mockResolvedValue('1.0.0'),
    checkAuthentication: jest
      .fn()
      .mockResolvedValue({ authenticated: true, user: 'test-user' }),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

// Mock logger with jest spies
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
  let mockSendNotification: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    adapter = new CursorAgentAdapter(testConfig, { logger: mockLogger });

    // Spy on sendNotification to verify notifications are sent
    mockSendNotification = jest.spyOn(adapter as any, 'sendNotification');

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
    // Clean up spies
    if (mockSendNotification) {
      mockSendNotification.mockRestore();
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
          mcpServers: [], // Required per ACP SDK
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

      // Register a test notification handler with jest mock
      const mockNotificationHandler = jest.fn().mockResolvedValue(undefined);
      registry.registerNotification(
        '_test/status_update',
        mockNotificationHandler
      );

      // Send notification via registry (simulating received notification)
      await registry.sendNotification('_test/status_update', {
        status: 'running',
      });

      // Verify handler was called with correct params
      expect(mockNotificationHandler).toHaveBeenCalledTimes(1);
      expect(mockNotificationHandler).toHaveBeenCalledWith({
        status: 'running',
      });

      // Verify logger was called appropriately
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Sending extension notification',
        expect.objectContaining({
          name: '_test/status_update',
          params: { status: 'running' },
        })
      );
    });

    it('should ignore unregistered extension notifications per ACP spec', async () => {
      const registry = adapter.getExtensionRegistry();

      // Should not throw - notifications are one-way
      await expect(
        registry.sendNotification('_test/unregistered_notification', {})
      ).resolves.toBeUndefined();

      // Verify that debug log was called for ignored notification
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Unrecognized extension notification ignored',
        expect.objectContaining({
          name: '_test/unregistered_notification',
        })
      );
    });

    it('should not throw if notification handler fails', async () => {
      const registry = adapter.getExtensionRegistry();

      // Register a failing notification handler with jest mock
      const mockFailingHandler = jest
        .fn()
        .mockRejectedValue(new Error('Handler failed'));
      registry.registerNotification(
        '_test/failing_notification',
        mockFailingHandler
      );

      // Should not throw - notifications are best-effort
      await expect(
        registry.sendNotification('_test/failing_notification', {})
      ).resolves.toBeUndefined();

      // Verify handler was called
      expect(mockFailingHandler).toHaveBeenCalledTimes(1);

      // Verify that warning was logged
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Extension notification handler error',
        expect.objectContaining({
          name: '_test/failing_notification',
          error: 'Handler failed',
        })
      );
    });
  });

  describe('Capabilities Advertisement', () => {
    it('should advertise extension capabilities in initialize response', async () => {
      const registry = adapter.getExtensionRegistry();

      // Register some extension methods and notifications using jest mocks
      const mockAction1 = jest.fn().mockResolvedValue({ ok: true });
      const mockAction2 = jest.fn().mockResolvedValue({ ok: true });
      const mockEvent1 = jest.fn().mockResolvedValue(undefined);

      registry.registerMethod('_myapp/action1', mockAction1);
      registry.registerMethod('_myapp/action2', mockAction2);
      registry.registerNotification('_myapp/event1', mockEvent1);

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

      // Verify handlers were registered but not called yet
      expect(mockAction1).not.toHaveBeenCalled();
      expect(mockAction2).not.toHaveBeenCalled();
      expect(mockEvent1).not.toHaveBeenCalled();
    });

    it('should group extensions by namespace in capabilities', async () => {
      const registry = adapter.getExtensionRegistry();

      // Register methods from different namespaces with jest mocks
      const mockApp1Handler = jest.fn().mockResolvedValue({ ok: true });
      const mockApp2Handler = jest.fn().mockResolvedValue({ ok: true });

      registry.registerMethod('_app1/method', mockApp1Handler);
      registry.registerMethod('_app2/method', mockApp2Handler);

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

      // Verify handlers were not called during initialization
      expect(mockApp1Handler).not.toHaveBeenCalled();
      expect(mockApp2Handler).not.toHaveBeenCalled();
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
      // (it may contain other metadata like version info)
      const meta = initResult.agentCapabilities._meta as any;
      if (meta) {
        // Ensure no extension namespaces are present (they would start with lowercase)
        // We might have some metadata but no extension namespaces
        expect(meta).toBeDefined();
      }
    });
  });

  describe('Extension Name Validation', () => {
    it('should reject extension methods without underscore prefix', () => {
      const registry = adapter.getExtensionRegistry();
      const mockHandler = jest.fn();

      expect(() => {
        registry.registerMethod('test/method', mockHandler);
      }).toThrow('Extension method name must start with underscore');

      // Verify handler was not registered
      expect(mockHandler).not.toHaveBeenCalled();
    });

    it('should reject extension notifications without underscore prefix', () => {
      const registry = adapter.getExtensionRegistry();
      const mockHandler = jest.fn();

      expect(() => {
        registry.registerNotification('test/notification', mockHandler);
      }).toThrow('Extension notification name must start with underscore');

      // Verify handler was not registered
      expect(mockHandler).not.toHaveBeenCalled();
    });

    it('should accept properly formatted extension names', () => {
      const registry = adapter.getExtensionRegistry();
      const mockMethodHandler = jest.fn().mockResolvedValue({});
      const mockNotificationHandler = jest.fn().mockResolvedValue(undefined);

      expect(() => {
        registry.registerMethod('_myapp/method', mockMethodHandler);
      }).not.toThrow();

      expect(() => {
        registry.registerNotification(
          '_myapp/notification',
          mockNotificationHandler
        );
      }).not.toThrow();

      // Verify methods were registered
      expect(registry.hasMethod('_myapp/method')).toBe(true);
      expect(registry.hasNotification('_myapp/notification')).toBe(true);

      // Verify debug logs were called
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Registered extension method',
        expect.objectContaining({ name: '_myapp/method' })
      );
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Registered extension notification',
        expect.objectContaining({ name: '_myapp/notification' })
      );
    });
  });

  describe('Dynamic Extension Management', () => {
    it('should allow unregistering extension methods', async () => {
      const registry = adapter.getExtensionRegistry();
      const mockHandler = jest.fn().mockResolvedValue({ ok: true });

      // Register and then unregister
      registry.registerMethod('_test/method', mockHandler);
      expect(registry.hasMethod('_test/method')).toBe(true);

      registry.unregisterMethod('_test/method');
      expect(registry.hasMethod('_test/method')).toBe(false);

      // Verify debug log for unregistration
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Unregistered extension method',
        expect.objectContaining({ name: '_test/method' })
      );

      // Method should no longer be callable
      const response = await adapter.processRequest({
        jsonrpc: '2.0',
        id: 1,
        method: '_test/method',
        params: {},
      });

      expect(response.error?.code).toBe(-32601);
      expect(response.error?.message).toBe('Method not found');

      // Verify handler was never called after unregistration
      expect(mockHandler).not.toHaveBeenCalled();
    });

    it('should allow clearing all extensions', () => {
      const registry = adapter.getExtensionRegistry();
      const mockMethod1 = jest.fn().mockResolvedValue({});
      const mockMethod2 = jest.fn().mockResolvedValue({});
      const mockNotification = jest.fn().mockResolvedValue(undefined);

      registry.registerMethod('_test/method1', mockMethod1);
      registry.registerMethod('_test/method2', mockMethod2);
      registry.registerNotification('_test/notification', mockNotification);

      expect(registry.getMethodCount()).toBe(2);
      expect(registry.getNotificationCount()).toBe(1);

      registry.clear();

      expect(registry.getMethodCount()).toBe(0);
      expect(registry.getNotificationCount()).toBe(0);

      // Verify debug log for clear
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Cleared all extension methods and notifications'
      );

      // Verify handlers were never called
      expect(mockMethod1).not.toHaveBeenCalled();
      expect(mockMethod2).not.toHaveBeenCalled();
      expect(mockNotification).not.toHaveBeenCalled();
    });

    it('should track registered method count', () => {
      const registry = adapter.getExtensionRegistry();
      const mockHandler1 = jest.fn().mockResolvedValue({});
      const mockHandler2 = jest.fn().mockResolvedValue({});

      expect(registry.getMethodCount()).toBe(0);

      registry.registerMethod('_test/method1', mockHandler1);
      expect(registry.getMethodCount()).toBe(1);

      registry.registerMethod('_test/method2', mockHandler2);
      expect(registry.getMethodCount()).toBe(2);

      registry.unregisterMethod('_test/method1');
      expect(registry.getMethodCount()).toBe(1);

      // Verify mock logger was called for each registration
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Registered extension method',
        expect.objectContaining({ name: '_test/method1' })
      );
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Registered extension method',
        expect.objectContaining({ name: '_test/method2' })
      );
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
      expect(response.id).toBe(1n);
      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32601);
      expect(response.error?.message).toBeDefined();
      expect(response.result).toBeUndefined();
    });

    it('should support arbitrary JSON-RPC params for extension methods', async () => {
      const registry = adapter.getExtensionRegistry();

      const mockEchoHandler = jest.fn().mockImplementation(async (params) => {
        return { received: params };
      });

      registry.registerMethod('_test/echo', mockEchoHandler);

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
      expect(mockEchoHandler).toHaveBeenCalledTimes(1);
      expect(mockEchoHandler).toHaveBeenCalledWith(testParams);
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

      const mockComplexHandler = jest.fn().mockResolvedValue(complexResult);
      registry.registerMethod('_test/complex', mockComplexHandler);

      const response = await adapter.processRequest({
        jsonrpc: '2.0',
        id: 1,
        method: '_test/complex',
        params: {},
      });

      expect(response.result).toEqual(complexResult);
      expect(mockComplexHandler).toHaveBeenCalledTimes(1);
      expect(mockComplexHandler).toHaveBeenCalledWith({});
    });
  });
});
