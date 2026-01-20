/**
 * Unit tests for CLI auth commands
 *
 * Tests the auth login, logout, and status commands from the CLI.
 */

import { jest } from '@jest/globals';
import { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

// Mock child_process before importing the CLI module
const mockSpawn = jest.fn();
jest.mock('child_process', () => ({
  spawn: mockSpawn,
}));

// Mock the CursorCliBridge
const mockCheckAuthentication = jest.fn();
const mockClose = jest.fn();
jest.mock('../../../src/cursor/cli-bridge', () => ({
  CursorCliBridge: jest.fn().mockImplementation(() => ({
    checkAuthentication: mockCheckAuthentication,
    close: mockClose,
  })),
}));

// Mock logger
const mockCreateLogger = jest.fn();
jest.mock('../../../src/utils/logger', () => ({
  createLogger: mockCreateLogger,
}));

// Mock commander to capture command definitions
// Use a global object to store handlers and mocks so they're accessible from the hoisted mock factory
// This needs to be on a global object because Jest hoists jest.mock() calls
(global as any).__authCommandHandlers = {
  authLogin: undefined as ((options: any) => Promise<void>) | undefined,
  authLogout: undefined as (() => Promise<void>) | undefined,
  authStatus: undefined as (() => Promise<void>) | undefined,
};

// Create local references for use in tests
const handlers = (global as any).__authCommandHandlers;

jest.mock('commander', () => {
  // Access handlers from global scope
  // This factory runs when Jest sets up mocks, before the module imports
  let handlerCallCount = 0;

  const createMockCommandChain = () => {
    const chain = {
      description: jest.fn().mockReturnThis(),
      option: jest.fn().mockReturnThis(),
      action: jest.fn().mockImplementation((handler: any) => {
        // Capture handlers based on call order
        // The CLI module calls: login, logout, status in that order
        handlerCallCount++;
        const handlers = (global as any).__authCommandHandlers;
        if (handlerCallCount === 1) {
          handlers.authLogin = handler;
        } else if (handlerCallCount === 2) {
          handlers.authLogout = handler;
        } else if (handlerCallCount === 3) {
          handlers.authStatus = handler;
        }
        return chain;
      }),
      command: jest.fn().mockImplementation(() => {
        return createMockCommandChain();
      }),
    };
    return chain;
  };

  const mockAuthCommand = createMockCommandChain();
  const mockCommandFn = jest.fn().mockImplementation((name: string) => {
    if (name === 'auth') {
      return mockAuthCommand;
    }
    return createMockCommandChain();
  });

  return {
    program: {
      name: jest.fn().mockReturnThis(),
      description: jest.fn().mockReturnThis(),
      version: jest.fn().mockReturnThis(),
      command: mockCommandFn,
      option: jest.fn().mockReturnThis(),
      action: jest.fn().mockReturnThis(),
      parse: jest.fn(),
      opts: jest.fn().mockReturnValue({}),
    },
  };
});

// Import the CLI module - mocks are hoisted by Jest so they'll be in place
// Note: With ESM, we can't use jest.isolateModules() with async imports
// The module will be loaded once and reused across tests
import '../../../src/bin/cursor-agent-acp';
import { program } from 'commander';

describe('CLI Auth Commands', () => {
  let mockLogger: any;
  let mockChildProcess: EventEmitter;
  let exitSpy: jest.SpyInstance;

  beforeAll(() => {
    // Verify handlers were captured when the module loaded
    // The module should have registered the commands, which should have captured the handlers
    if (!handlers.authLogin || !handlers.authLogout || !handlers.authStatus) {
      console.warn(
        'Handlers not captured. This may indicate a mock setup issue.'
      );
    }
  });

  beforeEach(() => {
    // Note: Don't reset handlers - they're captured when the module loads
    // The module only loads once with ESM, so handlers persist across tests
    // We just need to reset the mock functions, not the handler references

    // Setup mock logger
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
    mockCreateLogger.mockReturnValue(mockLogger);

    // Setup mock child process
    mockChildProcess = new EventEmitter() as EventEmitter & { pid?: number };
    (mockChildProcess as any).pid = 12345;
    mockSpawn.mockReturnValue(mockChildProcess);

    // Mock process.exit to prevent tests from exiting
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(((
      code?: number
    ) => {
      // Don't actually exit during tests
    }) as any);

    // Clear all mocks but preserve handler references
    // The handlers are captured when the module loads, so we don't want to clear them
    jest.clearAllMocks();
  });

  afterEach(() => {
    exitSpy.mockRestore();
    mockCheckAuthentication.mockReset();
    mockClose.mockReset();
  });

  describe('auth login', () => {
    test('should spawn cursor-agent login with inherited stdio', async () => {
      expect(handlers.authLogin).toBeDefined();

      // Start the login handler
      const loginPromise = handlers.authLogin!({ check: false });

      // Simulate successful login
      setImmediate(() => {
        mockChildProcess.emit('close', 0);
      });

      await loginPromise;

      expect(mockSpawn).toHaveBeenCalledWith(
        'cursor-agent',
        ['login'],
        expect.objectContaining({
          stdio: 'inherit',
          env: expect.any(Object),
        })
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Starting Cursor CLI login...'
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Login completed successfully!'
      );
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    test('should check authentication after login when --check flag is provided', async () => {
      expect(handlers.authLogin).toBeDefined();

      // Mock successful authentication check
      mockCheckAuthentication.mockResolvedValue({
        authenticated: true,
        user: 'test-user',
        email: 'test@example.com',
        plan: 'pro',
      });

      // Start the login handler with check option
      const loginPromise = handlers.authLogin!({ check: true });

      // Simulate successful login
      setImmediate(() => {
        mockChildProcess.emit('close', 0);
      });

      await loginPromise;

      expect(mockSpawn).toHaveBeenCalledWith(
        'cursor-agent',
        ['login'],
        expect.any(Object)
      );
      expect(mockCheckAuthentication).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        '✅ Authentication verified'
      );
      expect(mockLogger.info).toHaveBeenCalledWith('   User: test-user');
      expect(mockLogger.info).toHaveBeenCalledWith(
        '   Email: test@example.com'
      );
      expect(mockLogger.info).toHaveBeenCalledWith('   Plan: pro');
      expect(mockClose).toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    test('should handle authentication check failure gracefully', async () => {
      expect(handlers.authLogin).toBeDefined();

      // Mock failed authentication check
      mockCheckAuthentication.mockResolvedValue({
        authenticated: false,
        error: 'Not authenticated',
      });

      // Start the login handler with check option
      const loginPromise = handlers.authLogin!({ check: true });

      // Simulate successful login
      setImmediate(() => {
        mockChildProcess.emit('close', 0);
      });

      await loginPromise;

      expect(mockCheckAuthentication).toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        '⚠️  Authentication check failed'
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        '   Error: Not authenticated'
      );
      expect(mockClose).toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    test('should handle login failure with non-zero exit code', async () => {
      expect(handlers.authLogin).toBeDefined();

      // Start the login handler
      const loginPromise = handlers.authLogin!({ check: false });

      // Simulate failed login
      setImmediate(() => {
        mockChildProcess.emit('close', 1);
      });

      // Should reject with error
      await expect(loginPromise).rejects.toThrow(
        'Login failed with exit code 1'
      );

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Login failed with exit code 1'
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    test('should handle spawn error', async () => {
      expect(handlers.authLogin).toBeDefined();

      // Start the login handler
      const loginPromise = handlers.authLogin!({ check: false });

      // Simulate spawn error
      setImmediate(() => {
        mockChildProcess.emit('error', new Error('Command not found'));
      });

      // Should reject with error
      await expect(loginPromise).rejects.toThrow('Command not found');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to start login process: Command not found'
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('auth logout', () => {
    test('should spawn cursor-agent logout with inherited stdio', async () => {
      expect(handlers.authLogout).toBeDefined();

      // Start the logout handler
      const logoutPromise = handlers.authLogout!();

      // Simulate successful logout
      setImmediate(() => {
        mockChildProcess.emit('close', 0);
      });

      await logoutPromise;

      expect(mockSpawn).toHaveBeenCalledWith(
        'cursor-agent',
        ['logout'],
        expect.objectContaining({
          stdio: 'inherit',
          env: expect.any(Object),
        })
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Logging out from Cursor CLI...'
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        '✅ Logout completed successfully!'
      );
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    test('should handle logout failure with non-zero exit code', async () => {
      expect(handlers.authLogout).toBeDefined();

      // Start the logout handler
      const logoutPromise = handlers.authLogout!();

      // Simulate failed logout
      setImmediate(() => {
        mockChildProcess.emit('close', 1);
      });

      // Should reject with error
      await expect(logoutPromise).rejects.toThrow(
        'Logout failed with exit code 1'
      );

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Logout failed with exit code 1'
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    test('should handle spawn error', async () => {
      expect(handlers.authLogout).toBeDefined();

      // Start the logout handler
      const logoutPromise = handlers.authLogout!();

      // Simulate spawn error
      setImmediate(() => {
        mockChildProcess.emit('error', new Error('Command not found'));
      });

      // Should reject with error
      await expect(logoutPromise).rejects.toThrow('Command not found');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to start logout process: Command not found'
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('auth status', () => {
    test('should check authentication and show status when authenticated', async () => {
      expect(handlers.authStatus).toBeDefined();

      // Mock successful authentication check
      mockCheckAuthentication.mockResolvedValue({
        authenticated: true,
        user: 'test-user',
        email: 'test@example.com',
        plan: 'free',
      });

      await handlers.authStatus!();

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Checking authentication status...'
      );
      expect(mockCheckAuthentication).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith('✅ Authenticated');
      expect(mockLogger.info).toHaveBeenCalledWith('   User: test-user');
      expect(mockLogger.info).toHaveBeenCalledWith(
        '   Email: test@example.com'
      );
      expect(mockLogger.info).toHaveBeenCalledWith('   Plan: free');
      expect(mockClose).toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    test('should show partial information when some fields are missing', async () => {
      expect(handlers.authStatus).toBeDefined();

      // Mock authentication check with only email
      mockCheckAuthentication.mockResolvedValue({
        authenticated: true,
        email: 'user@example.com',
      });

      await handlers.authStatus!();

      expect(mockLogger.info).toHaveBeenCalledWith('✅ Authenticated');
      expect(mockLogger.info).toHaveBeenCalledWith(
        '   Email: user@example.com'
      );
      // Should not log undefined fields
      expect(mockLogger.info).not.toHaveBeenCalledWith(
        expect.stringContaining('User: undefined')
      );
      expect(mockLogger.info).not.toHaveBeenCalledWith(
        expect.stringContaining('Plan: undefined')
      );
      expect(mockClose).toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    test('should show not authenticated status and exit with code 1', async () => {
      expect(handlers.authStatus).toBeDefined();

      // Mock failed authentication check
      mockCheckAuthentication.mockResolvedValue({
        authenticated: false,
        error: 'Not logged in',
      });

      await handlers.authStatus!();

      expect(mockLogger.warn).toHaveBeenCalledWith('❌ Not authenticated');
      expect(mockLogger.warn).toHaveBeenCalledWith('   Error: Not logged in');
      expect(mockClose).toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    test('should handle authentication check errors', async () => {
      expect(handlers.authStatus).toBeDefined();

      // Mock authentication check throwing an error
      mockCheckAuthentication.mockRejectedValue(new Error('Connection failed'));

      await handlers.authStatus!();

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to check authentication status: Connection failed'
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    test('should handle authentication check with no error message', async () => {
      expect(handlers.authStatus).toBeDefined();

      // Mock failed authentication check without error message
      mockCheckAuthentication.mockResolvedValue({
        authenticated: false,
      });

      await handlers.authStatus!();

      expect(mockLogger.warn).toHaveBeenCalledWith('❌ Not authenticated');
      // Should not log error if not present
      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('Error:')
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});
