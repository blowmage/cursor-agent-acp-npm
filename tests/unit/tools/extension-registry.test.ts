/**
 * Unit tests for ExtensionRegistry
 *
 * Tests extension method and notification registration, validation, and handling
 * per ACP spec: https://agentclientprotocol.com/protocol/extensibility
 */

import { ExtensionRegistry } from '../../../src/tools/extension-registry';
import type { Logger } from '../../../src/types';

describe('ExtensionRegistry', () => {
  let registry: ExtensionRegistry;
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    registry = new ExtensionRegistry(mockLogger);
  });

  describe('registerMethod', () => {
    it('should register a valid extension method', () => {
      const handler = jest.fn().mockResolvedValue({ result: 'success' });

      registry.registerMethod('_test/method', handler);

      expect(registry.hasMethod('_test/method')).toBe(true);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Registered extension method',
        {
          name: '_test/method',
        }
      );
    });

    it('should reject method names that do not start with underscore', () => {
      const handler = jest.fn();

      expect(() => {
        registry.registerMethod('test/method', handler);
      }).toThrow(
        'Extension method name must start with underscore: test/method'
      );

      expect(registry.hasMethod('test/method')).toBe(false);
    });

    it('should reject empty method names', () => {
      const handler = jest.fn();

      expect(() => {
        registry.registerMethod('', handler);
      }).toThrow('Extension method name must start with underscore: ');
    });

    it('should reject non-function handlers', () => {
      expect(() => {
        registry.registerMethod('_test/method', 'not a function' as any);
      }).toThrow('Extension method handler must be a function');
    });

    it('should allow overwriting existing methods', () => {
      const handler1 = jest.fn().mockResolvedValue({ result: 'first' });
      const handler2 = jest.fn().mockResolvedValue({ result: 'second' });

      registry.registerMethod('_test/method', handler1);
      registry.registerMethod('_test/method', handler2);

      expect(registry.hasMethod('_test/method')).toBe(true);
    });

    it('should accept method names without namespace separator', () => {
      const handler = jest.fn().mockResolvedValue({ result: 'success' });

      registry.registerMethod('_simplemethod', handler);

      expect(registry.hasMethod('_simplemethod')).toBe(true);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Registered extension method',
        {
          name: '_simplemethod',
        }
      );
    });
  });

  describe('registerNotification', () => {
    it('should register a valid extension notification', () => {
      const handler = jest.fn().mockResolvedValue(undefined);

      registry.registerNotification('_test/notification', handler);

      expect(registry.hasNotification('_test/notification')).toBe(true);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Registered extension notification',
        {
          name: '_test/notification',
        }
      );
    });

    it('should reject notification names that do not start with underscore', () => {
      const handler = jest.fn();

      expect(() => {
        registry.registerNotification('test/notification', handler);
      }).toThrow(
        'Extension notification name must start with underscore: test/notification'
      );
    });

    it('should reject non-function handlers', () => {
      expect(() => {
        registry.registerNotification(
          '_test/notification',
          'not a function' as any
        );
      }).toThrow('Extension notification handler must be a function');
    });

    it('should accept notification names without namespace separator', () => {
      const handler = jest.fn().mockResolvedValue(undefined);

      registry.registerNotification('_simpleevent', handler);

      expect(registry.hasNotification('_simpleevent')).toBe(true);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Registered extension notification',
        {
          name: '_simpleevent',
        }
      );
    });
  });

  describe('callMethod', () => {
    it('should call registered method handler with params', async () => {
      const handler = jest.fn().mockResolvedValue({ result: 'success' });
      registry.registerMethod('_test/method', handler);

      const result = await registry.callMethod('_test/method', {
        param: 'value',
      });

      expect(handler).toHaveBeenCalledWith({ param: 'value' });
      expect(result).toEqual({ result: 'success' });
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Calling extension method',
        {
          name: '_test/method',
          params: { param: 'value' },
        }
      );
    });

    it('should throw error if method not found', async () => {
      await expect(
        registry.callMethod('_test/nonexistent', {})
      ).rejects.toThrow('Extension method not found: _test/nonexistent');
    });

    it('should propagate errors from handler', async () => {
      const handler = jest.fn().mockRejectedValue(new Error('Handler error'));
      registry.registerMethod('_test/method', handler);

      await expect(registry.callMethod('_test/method', {})).rejects.toThrow(
        'Handler error'
      );
      expect(mockLogger.error).toHaveBeenCalledWith('Extension method error', {
        name: '_test/method',
        error: 'Handler error',
      });
    });
  });

  describe('sendNotification', () => {
    it('should call registered notification handler', async () => {
      const handler = jest.fn().mockResolvedValue(undefined);
      registry.registerNotification('_test/notification', handler);

      await registry.sendNotification('_test/notification', { param: 'value' });

      expect(handler).toHaveBeenCalledWith({ param: 'value' });
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Sending extension notification',
        {
          name: '_test/notification',
          params: { param: 'value' },
        }
      );
    });

    it('should ignore unrecognized notifications per ACP spec', async () => {
      await registry.sendNotification('_test/nonexistent', {});

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Unrecognized extension notification ignored',
        {
          name: '_test/nonexistent',
        }
      );
    });

    it('should log but not throw on handler errors', async () => {
      const handler = jest.fn().mockRejectedValue(new Error('Handler error'));
      registry.registerNotification('_test/notification', handler);

      await registry.sendNotification('_test/notification', {});

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Extension notification handler error',
        {
          name: '_test/notification',
          error: 'Handler error',
        }
      );
    });
  });

  describe('getRegisteredMethods', () => {
    it('should return empty array when no methods registered', () => {
      expect(registry.getRegisteredMethods()).toEqual([]);
    });

    it('should return all registered method names', () => {
      registry.registerMethod('_test/method1', jest.fn());
      registry.registerMethod('_test/method2', jest.fn());
      registry.registerMethod('_other/method', jest.fn());

      const methods = registry.getRegisteredMethods();
      expect(methods).toContain('_test/method1');
      expect(methods).toContain('_test/method2');
      expect(methods).toContain('_other/method');
      expect(methods.length).toBe(3);
    });
  });

  describe('getRegisteredNotifications', () => {
    it('should return empty array when no notifications registered', () => {
      expect(registry.getRegisteredNotifications()).toEqual([]);
    });

    it('should return all registered notification names', () => {
      registry.registerNotification('_test/notification1', jest.fn());
      registry.registerNotification('_test/notification2', jest.fn());

      const notifications = registry.getRegisteredNotifications();
      expect(notifications).toContain('_test/notification1');
      expect(notifications).toContain('_test/notification2');
      expect(notifications.length).toBe(2);
    });
  });

  describe('unregisterMethod', () => {
    it('should remove registered method', () => {
      registry.registerMethod('_test/method', jest.fn());
      expect(registry.hasMethod('_test/method')).toBe(true);

      registry.unregisterMethod('_test/method');
      expect(registry.hasMethod('_test/method')).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Unregistered extension method',
        {
          name: '_test/method',
        }
      );
    });

    it('should not error when removing non-existent method', () => {
      expect(() =>
        registry.unregisterMethod('_test/nonexistent')
      ).not.toThrow();
    });
  });

  describe('unregisterNotification', () => {
    it('should remove registered notification', () => {
      registry.registerNotification('_test/notification', jest.fn());
      expect(registry.hasNotification('_test/notification')).toBe(true);

      registry.unregisterNotification('_test/notification');
      expect(registry.hasNotification('_test/notification')).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Unregistered extension notification',
        {
          name: '_test/notification',
        }
      );
    });
  });

  describe('clear', () => {
    it('should remove all registered methods and notifications', () => {
      registry.registerMethod('_test/method', jest.fn());
      registry.registerNotification('_test/notification', jest.fn());

      registry.clear();

      expect(registry.hasMethod('_test/method')).toBe(false);
      expect(registry.hasNotification('_test/notification')).toBe(false);
      expect(registry.getMethodCount()).toBe(0);
      expect(registry.getNotificationCount()).toBe(0);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Cleared all extension methods and notifications'
      );
    });
  });

  describe('getMethodCount', () => {
    it('should return 0 when no methods registered', () => {
      expect(registry.getMethodCount()).toBe(0);
    });

    it('should return correct count of registered methods', () => {
      registry.registerMethod('_test/method1', jest.fn());
      registry.registerMethod('_test/method2', jest.fn());

      expect(registry.getMethodCount()).toBe(2);
    });
  });

  describe('getNotificationCount', () => {
    it('should return 0 when no notifications registered', () => {
      expect(registry.getNotificationCount()).toBe(0);
    });

    it('should return correct count of registered notifications', () => {
      registry.registerNotification('_test/notification1', jest.fn());
      registry.registerNotification('_test/notification2', jest.fn());

      expect(registry.getNotificationCount()).toBe(2);
    });
  });
});
