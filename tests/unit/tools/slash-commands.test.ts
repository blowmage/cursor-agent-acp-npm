/**
 * Unit tests for SlashCommandsRegistry
 *
 * Tests command registration, retrieval, and management functionality.
 */

import { SlashCommandsRegistry } from '../../../src/tools/slash-commands';
import type { Logger } from '../../../src/types';
import type { AvailableCommand } from '@agentclientprotocol/sdk';

describe('SlashCommandsRegistry', () => {
  let registry: SlashCommandsRegistry;
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
    };

    registry = new SlashCommandsRegistry(mockLogger);
  });

  describe('registerCommand', () => {
    it('should register a command without input hint', () => {
      registry.registerCommand('test', 'Run tests');

      const commands = registry.getCommands();
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        name: 'test',
        description: 'Run tests',
      });
      expect(commands[0]!.input).toBeUndefined();
    });

    it('should register a command with input hint', () => {
      registry.registerCommand('web', 'Search the web', 'query to search for');

      const commands = registry.getCommands();
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        name: 'web',
        description: 'Search the web',
        input: {
          hint: 'query to search for',
        },
      });
    });

    it('should overwrite existing command with same name', () => {
      registry.registerCommand('test', 'Original description');
      registry.registerCommand('test', 'Updated description', 'new hint');

      const commands = registry.getCommands();
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        name: 'test',
        description: 'Updated description',
        input: {
          hint: 'new hint',
        },
      });
    });

    it('should log debug message when registering command', () => {
      registry.registerCommand('test', 'Run tests');

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Registered slash command',
        {
          name: 'test',
          description: 'Run tests',
        }
      );
    });
  });

  describe('getCommands', () => {
    it('should return empty array when no commands registered', () => {
      const commands = registry.getCommands();
      expect(commands).toEqual([]);
    });

    it('should return all registered commands', () => {
      registry.registerCommand('test', 'Run tests');
      registry.registerCommand('web', 'Search web', 'query');
      registry.registerCommand('plan', 'Create plan');

      const commands = registry.getCommands();
      expect(commands).toHaveLength(3);
      expect(commands.map((c) => c.name)).toEqual(['test', 'web', 'plan']);
    });

    it('should return commands in registration order', () => {
      registry.registerCommand('first', 'First command');
      registry.registerCommand('second', 'Second command');
      registry.registerCommand('third', 'Third command');

      const commands = registry.getCommands();
      expect(commands[0]!.name).toBe('first');
      expect(commands[1]!.name).toBe('second');
      expect(commands[2]!.name).toBe('third');
    });
  });

  describe('updateCommands', () => {
    it('should replace all existing commands', () => {
      registry.registerCommand('old1', 'Old command 1');
      registry.registerCommand('old2', 'Old command 2');

      const newCommands: AvailableCommand[] = [
        {
          name: 'new1',
          description: 'New command 1',
        },
        {
          name: 'new2',
          description: 'New command 2',
          input: {
            hint: 'hint',
          },
        },
      ];

      registry.updateCommands(newCommands);

      const commands = registry.getCommands();
      expect(commands).toHaveLength(2);
      expect(commands.map((c) => c.name)).toEqual(['new1', 'new2']);
    });

    it('should clear all commands when empty array provided', () => {
      registry.registerCommand('test', 'Run tests');
      registry.updateCommands([]);

      expect(registry.getCommands()).toEqual([]);
    });

    it('should log debug message when updating commands', () => {
      const newCommands: AvailableCommand[] = [
        {
          name: 'test',
          description: 'Test command',
        },
      ];

      registry.updateCommands(newCommands);

      expect(mockLogger.debug).toHaveBeenCalledWith('Updated slash commands', {
        count: 1,
        names: ['test'],
      });
    });
  });

  describe('removeCommand', () => {
    it('should remove existing command', () => {
      registry.registerCommand('test', 'Run tests');
      registry.registerCommand('web', 'Search web');

      registry.removeCommand('test');

      const commands = registry.getCommands();
      expect(commands).toHaveLength(1);
      expect(commands[0]!.name).toBe('web');
    });

    it('should do nothing when removing non-existent command', () => {
      registry.registerCommand('test', 'Run tests');

      registry.removeCommand('nonexistent');

      const commands = registry.getCommands();
      expect(commands).toHaveLength(1);
    });

    it('should log debug message when removing command', () => {
      registry.registerCommand('test', 'Run tests');
      registry.removeCommand('test');

      expect(mockLogger.debug).toHaveBeenCalledWith('Removed slash command', {
        name: 'test',
      });
    });

    it('should not log when removing non-existent command', () => {
      registry.removeCommand('nonexistent');

      expect(mockLogger.debug).not.toHaveBeenCalledWith(
        'Removed slash command',
        expect.anything()
      );
    });
  });

  describe('hasCommand', () => {
    it('should return true for existing command', () => {
      registry.registerCommand('test', 'Run tests');

      expect(registry.hasCommand('test')).toBe(true);
    });

    it('should return false for non-existent command', () => {
      expect(registry.hasCommand('nonexistent')).toBe(false);
    });
  });

  describe('getCommand', () => {
    it('should return command when it exists', () => {
      registry.registerCommand('test', 'Run tests', 'test hint');

      const command = registry.getCommand('test');
      expect(command).toMatchObject({
        name: 'test',
        description: 'Run tests',
        input: {
          hint: 'test hint',
        },
      });
    });

    it('should return undefined when command does not exist', () => {
      const command = registry.getCommand('nonexistent');
      expect(command).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('should remove all commands', () => {
      registry.registerCommand('test1', 'Test 1');
      registry.registerCommand('test2', 'Test 2');
      registry.registerCommand('test3', 'Test 3');

      registry.clear();

      expect(registry.getCommands()).toEqual([]);
      expect(registry.getCommandCount()).toBe(0);
    });

    it('should log debug message when clearing', () => {
      registry.registerCommand('test', 'Run tests');
      registry.clear();

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Cleared all slash commands'
      );
    });
  });

  describe('getCommandCount', () => {
    it('should return 0 when no commands registered', () => {
      expect(registry.getCommandCount()).toBe(0);
    });

    it('should return correct count of registered commands', () => {
      registry.registerCommand('test1', 'Test 1');
      expect(registry.getCommandCount()).toBe(1);

      registry.registerCommand('test2', 'Test 2');
      expect(registry.getCommandCount()).toBe(2);

      registry.removeCommand('test1');
      expect(registry.getCommandCount()).toBe(1);
    });
  });

  describe('SDK type compliance', () => {
    it('should return commands that match AvailableCommand type', () => {
      registry.registerCommand('test', 'Run tests', 'test hint');

      const commands = registry.getCommands();
      expect(commands[0]).toHaveProperty('name');
      expect(commands[0]).toHaveProperty('description');
      expect(typeof commands[0]!.name).toBe('string');
      expect(typeof commands[0]!.description).toBe('string');
    });

    it('should handle AvailableCommandInput correctly', () => {
      registry.registerCommand('web', 'Search web', 'query');

      const command = registry.getCommand('web');
      expect(command!.input).toHaveProperty('hint');
      expect(typeof command!.input!.hint).toBe('string');
    });
  });

  describe('validateCommand', () => {
    it('should validate valid commands', () => {
      const validCommand: AvailableCommand = {
        name: 'test',
        description: 'Test command',
      };

      expect(() =>
        SlashCommandsRegistry.validateCommand(validCommand)
      ).not.toThrow();
    });

    it('should validate commands with input', () => {
      const validCommand: AvailableCommand = {
        name: 'test',
        description: 'Test command',
        input: { hint: 'test hint' },
      };

      expect(() =>
        SlashCommandsRegistry.validateCommand(validCommand)
      ).not.toThrow();
    });

    it('should reject non-object commands', () => {
      expect(() => SlashCommandsRegistry.validateCommand(null)).toThrow(
        'Command must be an object'
      );

      expect(() => SlashCommandsRegistry.validateCommand('string')).toThrow(
        'Command must be an object'
      );
    });

    it('should reject commands without name', () => {
      const invalidCommand = { description: 'Test' };
      expect(() =>
        SlashCommandsRegistry.validateCommand(invalidCommand)
      ).toThrow('Command name must be a non-empty string');
    });

    it('should reject commands with empty name', () => {
      const invalidCommand = { name: '', description: 'Test' };
      expect(() =>
        SlashCommandsRegistry.validateCommand(invalidCommand)
      ).toThrow('Command name must be a non-empty string');
    });

    it('should reject commands without description', () => {
      const invalidCommand = { name: 'test' };
      expect(() =>
        SlashCommandsRegistry.validateCommand(invalidCommand)
      ).toThrow('Command description must be a non-empty string');
    });

    it('should reject commands with empty description', () => {
      const invalidCommand = { name: 'test', description: '' };
      expect(() =>
        SlashCommandsRegistry.validateCommand(invalidCommand)
      ).toThrow('Command description must be a non-empty string');
    });

    it('should reject commands with invalid input', () => {
      const invalidCommand = {
        name: 'test',
        description: 'Test',
        input: { hint: '' },
      };
      expect(() =>
        SlashCommandsRegistry.validateCommand(invalidCommand)
      ).toThrow('Command input.hint must be a non-empty string');
    });
  });

  describe('isValidCommand', () => {
    it('should return true for valid commands', () => {
      const validCommand: AvailableCommand = {
        name: 'test',
        description: 'Test command',
      };

      expect(SlashCommandsRegistry.isValidCommand(validCommand)).toBe(true);
    });

    it('should return false for invalid commands', () => {
      const invalidCommand = { name: '', description: 'Test' };
      expect(SlashCommandsRegistry.isValidCommand(invalidCommand)).toBe(false);
    });

    it('should return false for non-objects', () => {
      expect(SlashCommandsRegistry.isValidCommand(null)).toBe(false);
      expect(SlashCommandsRegistry.isValidCommand('string')).toBe(false);
      expect(SlashCommandsRegistry.isValidCommand(123)).toBe(false);
    });
  });

  describe('onChange callback', () => {
    it('should trigger onChange when registering a command', () => {
      const mockCallback = jest.fn();
      registry.onChange(mockCallback);

      registry.registerCommand('test', 'Test command');

      expect(mockCallback).toHaveBeenCalledWith(registry.getCommands());
    });

    it('should trigger onChange when updating commands', () => {
      const mockCallback = jest.fn();
      registry.onChange(mockCallback);

      const newCommands: AvailableCommand[] = [
        { name: 'new', description: 'New command' },
      ];
      registry.updateCommands(newCommands);

      expect(mockCallback).toHaveBeenCalledWith(registry.getCommands());
    });

    it('should trigger onChange when removing a command', () => {
      registry.registerCommand('test', 'Test command');

      const mockCallback = jest.fn();
      registry.onChange(mockCallback);

      registry.removeCommand('test');

      expect(mockCallback).toHaveBeenCalledWith(registry.getCommands());
    });

    it('should trigger onChange when clearing commands', () => {
      const mockCallback = jest.fn();
      registry.onChange(mockCallback);

      registry.clear();

      expect(mockCallback).toHaveBeenCalledWith(registry.getCommands());
    });

    it('should not trigger onChange when removing non-existent command', () => {
      const mockCallback = jest.fn();
      registry.onChange(mockCallback);

      mockCallback.mockClear();

      registry.removeCommand('nonexistent');

      expect(mockCallback).not.toHaveBeenCalled();
    });
  });

  describe('triggerUpdate', () => {
    it('should manually trigger onChange callback', () => {
      const mockCallback = jest.fn();
      registry.onChange(mockCallback);

      mockCallback.mockClear();

      registry.triggerUpdate();

      expect(mockCallback).toHaveBeenCalledWith(registry.getCommands());
    });

    it('should not fail if no callback is registered', () => {
      expect(() => registry.triggerUpdate()).not.toThrow();
    });
  });
});
