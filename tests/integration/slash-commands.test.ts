/**
 * Integration tests for Slash Commands
 *
 * These tests verify the complete integration of slash commands per ACP spec:
 * - Advertising commands via available_commands_update notifications
 * - Sending notifications after session creation
 * - Dynamic command updates during a session
 * - Command registration and validation
 * - ACP protocol compliance
 *
 * Per ACP spec: https://agentclientprotocol.com/protocol/slash-commands
 */

import { jest } from '@jest/globals';
import { CursorAgentAdapter } from '../../src/adapter/cursor-agent-adapter';
import { SlashCommandsRegistry } from '../../src/tools/slash-commands';
import type { AdapterConfig, Logger } from '../../src/types';
import type {
  NewSessionResponse,
  AvailableCommand,
} from '@agentclientprotocol/sdk';
import { MockCursorCliBridge } from './mocks/cursor-bridge-mock';

// Mock the CursorCliBridge module
jest.mock('../../src/cursor/cli-bridge', () => ({
  CursorCliBridge: jest.fn().mockImplementation((config, logger) => {
    return new MockCursorCliBridge(config, logger);
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

describe('Slash Commands Integration', () => {
  let adapter: CursorAgentAdapter;
  let capturedNotifications: any[] = [];

  beforeEach(async () => {
    jest.clearAllMocks();
    capturedNotifications = [];

    adapter = new CursorAgentAdapter(testConfig, { logger: mockLogger });

    // Capture notifications sent by adapter
    const originalSendNotification = (adapter as any).sendNotification;
    (adapter as any).sendNotification = jest.fn((notification: any) => {
      capturedNotifications.push(notification);
      if (originalSendNotification) {
        return originalSendNotification.call(adapter, notification);
      }
    });

    await adapter.initialize();
  });

  afterEach(async () => {
    if (adapter) {
      await adapter.shutdown();
    }
  });

  describe('Advertising Commands on Session Creation', () => {
    it('should send available_commands_update notification after creating a session', async () => {
      // Per ACP spec: Agent MAY send available_commands_update after creating a session
      const request = {
        jsonrpc: '2.0' as const,
        id: 1,
        method: 'session/new' as const,
        params: {
          cwd: process.cwd(),
          mcpServers: [],
        },
      };

      const response = await adapter.processRequest(request);

      // Verify session was created
      expect(response.error).toBeUndefined();
      expect(response.result).toBeDefined();
      const sessionResponse = response.result as NewSessionResponse;
      expect(sessionResponse.sessionId).toBeDefined();

      // Wait for async notification to be sent
      await new Promise((resolve) => setImmediate(resolve));

      // Find available_commands_update notification
      const commandsNotification = capturedNotifications.find(
        (n) =>
          n.method === 'session/update' &&
          n.params?.update?.sessionUpdate === 'available_commands_update'
      );

      expect(commandsNotification).toBeDefined();
      expect(commandsNotification.params.sessionId).toBe(
        sessionResponse.sessionId
      );

      // Verify notification structure per ACP spec
      const update = commandsNotification.params.update;
      expect(update.sessionUpdate).toBe('available_commands_update');
      expect(update.availableCommands).toBeDefined();
      expect(Array.isArray(update.availableCommands)).toBe(true);
    });

    it('should include default registered commands in notification', async () => {
      const request = {
        jsonrpc: '2.0' as const,
        id: 1,
        method: 'session/new' as const,
        params: {
          cwd: process.cwd(),
          mcpServers: [],
        },
      };

      await adapter.processRequest(request);

      // Wait for async notification to be sent
      await new Promise((resolve) => setImmediate(resolve));

      const commandsNotification = capturedNotifications.find(
        (n) =>
          n.method === 'session/update' &&
          n.params?.update?.sessionUpdate === 'available_commands_update'
      );

      const commands = commandsNotification.params.update.availableCommands;

      // Should include default 'plan' command
      const planCommand = commands.find(
        (c: AvailableCommand) => c.name === 'plan'
      );
      expect(planCommand).toBeDefined();
      expect(planCommand.description).toBe(
        'Create a detailed implementation plan'
      );
      expect(planCommand.input?.hint).toBe('description of what to plan');
    });

    it('should send available_commands_update notification after loading a session', async () => {
      // Create session first
      const createRequest = {
        jsonrpc: '2.0' as const,
        id: 1,
        method: 'session/new' as const,
        params: {
          cwd: process.cwd(),
          mcpServers: [],
        },
      };

      const createResponse = await adapter.processRequest(createRequest);
      expect(createResponse.result).toBeDefined();
      const sessionId = (createResponse.result as NewSessionResponse).sessionId;

      // Wait for session/new notification
      await new Promise((resolve) => setImmediate(resolve));

      // Clear captured notifications after session creation
      capturedNotifications.length = 0;

      // Load the session
      const loadRequest = {
        jsonrpc: '2.0' as const,
        id: 2,
        method: 'session/load' as const,
        params: {
          sessionId,
          cwd: process.cwd(),
          mcpServers: [],
        },
      };

      const loadResponse = await adapter.processRequest(loadRequest);

      expect(loadResponse.error).toBeUndefined();
      expect(loadResponse.result).toBeDefined();

      // Wait for async notification to be sent
      await new Promise((resolve) => setImmediate(resolve));

      // Per ACP spec: Agent MAY send available_commands_update after loading a session
      // Note: This is optional per the spec, so if no commands are registered, no notification will be sent
      const hasCommands =
        adapter.getSlashCommandsRegistry().getCommandCount() > 0;

      if (hasCommands) {
        const commandsNotification = capturedNotifications.find(
          (n) =>
            n.method === 'session/update' &&
            n.params?.update?.sessionUpdate === 'available_commands_update'
        );

        expect(commandsNotification).toBeDefined();
        if (commandsNotification) {
          expect(commandsNotification.params.sessionId).toBe(sessionId);
        }
      } else {
        // If no commands registered, notification won't be sent (which is correct behavior)
        expect(true).toBe(true);
      }
    });
  });

  describe('Dynamic Command Updates', () => {
    it('should allow registering new commands dynamically', async () => {
      const registry = adapter.getSlashCommandsRegistry();

      // Register a new command
      registry.registerCommand(
        'web',
        'Search the web for information',
        'query to search for'
      );

      // Verify command was registered
      const commands = registry.getCommands();
      const webCommand = commands.find((c) => c.name === 'web');

      expect(webCommand).toBeDefined();
      expect(webCommand!.description).toBe('Search the web for information');
      expect(webCommand!.input?.hint).toBe('query to search for');
    });

    it('should send notification when updateAvailableCommands is called', async () => {
      // Create a session
      const createRequest = {
        jsonrpc: '2.0' as const,
        id: 1,
        method: 'session/new' as const,
        params: {
          cwd: process.cwd(),
          mcpServers: [], // Required per ACP SDK
        },
      };

      const createResponse = await adapter.processRequest(createRequest);
      const sessionId = (createResponse.result as NewSessionResponse).sessionId;

      // Clear captured notifications
      capturedNotifications = [];

      // Register a new command
      const registry = adapter.getSlashCommandsRegistry();
      registry.registerCommand('test', 'Run tests for the current project');

      // Manually trigger update for the session
      adapter.updateAvailableCommands(sessionId);

      // Verify notification was sent
      const commandsNotification = capturedNotifications.find(
        (n) =>
          n.method === 'session/update' &&
          n.params?.update?.sessionUpdate === 'available_commands_update'
      );

      expect(commandsNotification).toBeDefined();

      const commands = commandsNotification.params.update.availableCommands;
      const testCommand = commands.find(
        (c: AvailableCommand) => c.name === 'test'
      );
      expect(testCommand).toBeDefined();
    });

    it('should update commands list when commands are modified', async () => {
      const registry = adapter.getSlashCommandsRegistry();

      // Register initial commands
      registry.registerCommand('cmd1', 'First command');
      registry.registerCommand('cmd2', 'Second command');

      let commandCount = registry.getCommandCount();
      expect(commandCount).toBeGreaterThanOrEqual(2); // At least 2 + default commands

      // Update commands to replace all
      registry.updateCommands([
        { name: 'new1', description: 'New command 1' },
        { name: 'new2', description: 'New command 2' },
      ]);

      commandCount = registry.getCommandCount();
      expect(commandCount).toBe(2);

      const commands = registry.getCommands();
      expect(commands.find((c) => c.name === 'new1')).toBeDefined();
      expect(commands.find((c) => c.name === 'new2')).toBeDefined();
    });

    it('should remove commands when removeCommand is called', async () => {
      const registry = adapter.getSlashCommandsRegistry();

      registry.registerCommand('temp', 'Temporary command');
      expect(registry.hasCommand('temp')).toBe(true);

      registry.removeCommand('temp');
      expect(registry.hasCommand('temp')).toBe(false);
    });

    it('should clear all commands when clear is called', async () => {
      const registry = adapter.getSlashCommandsRegistry();

      registry.registerCommand('cmd1', 'Command 1');
      registry.registerCommand('cmd2', 'Command 2');

      let count = registry.getCommandCount();
      expect(count).toBeGreaterThan(0);

      registry.clear();
      count = registry.getCommandCount();
      expect(count).toBe(0);
    });
  });

  describe('Command Validation', () => {
    it('should validate commands have required fields', () => {
      const validCommand: AvailableCommand = {
        name: 'test',
        description: 'Test command',
      };

      expect(() =>
        SlashCommandsRegistry.validateCommand(validCommand)
      ).not.toThrow();
    });

    it('should reject commands without name', () => {
      const invalidCommand = {
        description: 'Test command',
      };

      expect(() =>
        SlashCommandsRegistry.validateCommand(invalidCommand)
      ).toThrow('Command name must be a non-empty string');
    });

    it('should reject commands without description', () => {
      const invalidCommand = {
        name: 'test',
      };

      expect(() =>
        SlashCommandsRegistry.validateCommand(invalidCommand)
      ).toThrow('Command description must be a non-empty string');
    });

    it('should reject commands with empty name', () => {
      const invalidCommand = {
        name: '',
        description: 'Test command',
      };

      expect(() =>
        SlashCommandsRegistry.validateCommand(invalidCommand)
      ).toThrow('Command name must be a non-empty string');
    });

    it('should reject commands with empty description', () => {
      const invalidCommand = {
        name: 'test',
        description: '',
      };

      expect(() =>
        SlashCommandsRegistry.validateCommand(invalidCommand)
      ).toThrow('Command description must be a non-empty string');
    });

    it('should validate commands with optional input field', () => {
      const validCommand: AvailableCommand = {
        name: 'test',
        description: 'Test command',
        input: {
          hint: 'test hint',
        },
      };

      expect(() =>
        SlashCommandsRegistry.validateCommand(validCommand)
      ).not.toThrow();
    });

    it('should reject commands with invalid input.hint', () => {
      const invalidCommand = {
        name: 'test',
        description: 'Test command',
        input: {
          hint: '',
        },
      };

      expect(() =>
        SlashCommandsRegistry.validateCommand(invalidCommand)
      ).toThrow('Command input.hint must be a non-empty string');
    });

    it('should use isValidCommand type guard', () => {
      const validCommand: AvailableCommand = {
        name: 'test',
        description: 'Test command',
      };

      const invalidCommand = {
        name: '',
        description: 'Test',
      };

      expect(SlashCommandsRegistry.isValidCommand(validCommand)).toBe(true);
      expect(SlashCommandsRegistry.isValidCommand(invalidCommand)).toBe(false);
    });
  });

  describe('ACP Protocol Compliance', () => {
    it('should use correct notification structure per ACP spec', async () => {
      const request = {
        jsonrpc: '2.0' as const,
        id: 1,
        method: 'session/new' as const,
        params: {
          cwd: process.cwd(),
          mcpServers: [],
        },
      };

      await adapter.processRequest(request);

      // Wait for async notification to be sent
      await new Promise((resolve) => setImmediate(resolve));

      const commandsNotification = capturedNotifications.find(
        (n) =>
          n.method === 'session/update' &&
          n.params?.update?.sessionUpdate === 'available_commands_update'
      );

      // Per ACP spec: Verify notification structure
      expect(commandsNotification.jsonrpc).toBe('2.0');
      expect(commandsNotification.method).toBe('session/update');
      expect(commandsNotification.params).toBeDefined();
      expect(commandsNotification.params.sessionId).toBeDefined();
      expect(commandsNotification.params.update).toBeDefined();
      expect(commandsNotification.params.update.sessionUpdate).toBe(
        'available_commands_update'
      );
      expect(
        commandsNotification.params.update.availableCommands
      ).toBeDefined();
    });

    it('should send AvailableCommand objects with required fields', async () => {
      const request = {
        jsonrpc: '2.0' as const,
        id: 1,
        method: 'session/new' as const,
        params: {
          cwd: process.cwd(),
          mcpServers: [],
        },
      };

      await adapter.processRequest(request);

      // Wait for async notification to be sent
      await new Promise((resolve) => setImmediate(resolve));

      const commandsNotification = capturedNotifications.find(
        (n) =>
          n.method === 'session/update' &&
          n.params?.update?.sessionUpdate === 'available_commands_update'
      );

      const commands = commandsNotification.params.update.availableCommands;

      // Per ACP spec: All commands must have name and description
      for (const command of commands) {
        expect(command.name).toBeDefined();
        expect(typeof command.name).toBe('string');
        expect(command.name.trim().length).toBeGreaterThan(0);

        expect(command.description).toBeDefined();
        expect(typeof command.description).toBe('string');
        expect(command.description.trim().length).toBeGreaterThan(0);

        // If input is present, it must have hint
        if (command.input) {
          expect(command.input.hint).toBeDefined();
          expect(typeof command.input.hint).toBe('string');
          expect(command.input.hint.trim().length).toBeGreaterThan(0);
        }
      }
    });

    it('should allow commands without input field', async () => {
      const registry = adapter.getSlashCommandsRegistry();

      // Register command without input hint
      registry.registerCommand('simple', 'A simple command without input');

      const command = registry.getCommand('simple');
      expect(command).toBeDefined();
      expect(command!.name).toBe('simple');
      expect(command!.description).toBe('A simple command without input');
      expect(command!.input).toBeUndefined();
    });
  });

  describe('onChange Callback', () => {
    it('should trigger onChange callback when commands are modified', () => {
      const registry = new SlashCommandsRegistry(mockLogger);
      const mockCallback = jest.fn();

      registry.onChange(mockCallback);

      // Register a command
      registry.registerCommand('test', 'Test command');

      // Verify callback was called
      expect(mockCallback).toHaveBeenCalled();

      const commands = mockCallback.mock.calls[0][0];
      expect(Array.isArray(commands)).toBe(true);
      expect(
        commands.find((c: AvailableCommand) => c.name === 'test')
      ).toBeDefined();
    });

    it('should trigger onChange when commands are updated', () => {
      const registry = new SlashCommandsRegistry(mockLogger);
      const mockCallback = jest.fn();

      registry.onChange(mockCallback);

      // Update commands
      registry.updateCommands([{ name: 'new', description: 'New command' }]);

      expect(mockCallback).toHaveBeenCalled();
    });

    it('should trigger onChange when commands are removed', () => {
      const registry = new SlashCommandsRegistry(mockLogger);

      registry.registerCommand('temp', 'Temporary command');

      const mockCallback = jest.fn();
      registry.onChange(mockCallback);

      registry.removeCommand('temp');

      expect(mockCallback).toHaveBeenCalled();
    });

    it('should trigger onChange when commands are cleared', () => {
      const registry = new SlashCommandsRegistry(mockLogger);
      const mockCallback = jest.fn();

      registry.onChange(mockCallback);

      registry.clear();

      expect(mockCallback).toHaveBeenCalled();
    });

    it('should allow manual trigger via triggerUpdate', () => {
      const registry = new SlashCommandsRegistry(mockLogger);
      const mockCallback = jest.fn();

      registry.onChange(mockCallback);

      // Clear previous calls
      mockCallback.mockClear();

      // Manually trigger update
      registry.triggerUpdate();

      expect(mockCallback).toHaveBeenCalled();
    });
  });

  describe('/model Command', () => {
    it('should include /model command in available commands', async () => {
      const request = {
        jsonrpc: '2.0' as const,
        id: 1,
        method: 'session/new' as const,
        params: {
          cwd: process.cwd(),
          mcpServers: [],
        },
      };

      await adapter.processRequest(request);

      // Wait for async notification to be sent
      await new Promise((resolve) => setImmediate(resolve));

      const commandsNotification = capturedNotifications.find(
        (n) =>
          n.method === 'session/update' &&
          n.params?.update?.sessionUpdate === 'available_commands_update'
      );

      const commands = commandsNotification.params.update.availableCommands;
      const modelCommand = commands.find(
        (c: AvailableCommand) => c.name === 'model'
      );

      expect(modelCommand).toBeDefined();
      expect(modelCommand.description).toContain('Switch to a different model');
      expect(modelCommand.input).toBeDefined();
      expect(modelCommand.input.hint).toBe('model-id');
    });

    it('should list available models in /model command description', async () => {
      const request = {
        jsonrpc: '2.0' as const,
        id: 1,
        method: 'session/new' as const,
        params: {
          cwd: process.cwd(),
          mcpServers: [],
        },
      };

      await adapter.processRequest(request);

      // Wait for async notification to be sent
      await new Promise((resolve) => setImmediate(resolve));

      const commandsNotification = capturedNotifications.find(
        (n) =>
          n.method === 'session/update' &&
          n.params?.update?.sessionUpdate === 'available_commands_update'
      );

      const commands = commandsNotification.params.update.availableCommands;
      const modelCommand = commands.find(
        (c: AvailableCommand) => c.name === 'model'
      );

      // Description should mention some models
      expect(modelCommand.description).toContain('auto');
      expect(modelCommand.description).toContain('sonnet-4.5');
      expect(modelCommand.description).toContain('gpt-5');
    });
  });
});
