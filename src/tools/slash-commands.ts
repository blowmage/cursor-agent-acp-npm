/**
 * Slash Commands Registry
 *
 * Manages available slash commands that can be advertised to ACP clients.
 * Per ACP spec: https://agentclientprotocol.com/protocol/slash-commands
 *
 * Commands are registered and can be dynamically updated during a session.
 * All types use @agentclientprotocol/sdk for strict compliance.
 *
 * ## Usage Example
 *
 * ```typescript
 * const registry = new SlashCommandsRegistry(logger);
 *
 * // Register a command
 * registry.registerCommand(
 *   'web',
 *   'Search the web for information',
 *   'query to search for'
 * );
 *
 * // Register with change notification callback
 * registry.onChange((commands) => {
 *   // Send available_commands_update notification
 *   sendNotification({
 *     jsonrpc: '2.0',
 *     method: 'session/update',
 *     params: {
 *       sessionId: 'sess_123',
 *       update: {
 *         sessionUpdate: 'available_commands_update',
 *         availableCommands: commands
 *       }
 *     }
 *   });
 * });
 * ```
 *
 * ## Command Invocation
 *
 * Per ACP spec, commands are included as regular user messages in prompt requests:
 * ```
 * /web agent client protocol
 * ```
 *
 * The command text is sent to the agent as part of the prompt array:
 * ```json
 * {
 *   "prompt": [
 *     {
 *       "type": "text",
 *       "text": "/web agent client protocol"
 *     }
 *   ]
 * }
 * ```
 *
 * ## Dynamic Updates
 *
 * Per ACP spec: "The Agent can update the list of available commands at any time during
 * a session by sending another available_commands_update notification."
 *
 * Use the onChange callback to automatically send notifications when commands change,
 * or manually trigger updates by calling the callback with `getCommands()`.
 */

import type {
  AvailableCommand,
  AvailableCommandInput,
} from '@agentclientprotocol/sdk';
import type { Logger } from '../types';

/**
 * Callback invoked when the command list changes
 * Use this to send available_commands_update notifications to the client
 */
export type CommandsChangeCallback = (commands: AvailableCommand[]) => void;

/**
 * Registry for managing available slash commands
 *
 * Per ACP spec: Agents MAY advertise a set of slash commands that users can invoke.
 * These commands provide quick access to specific agent capabilities and workflows.
 *
 * @example
 * ```typescript
 * const registry = new SlashCommandsRegistry(logger);
 *
 * // Register commands
 * registry.registerCommand('test', 'Run tests for the current project');
 * registry.registerCommand('plan', 'Create a detailed implementation plan', 'description of what to plan');
 *
 * // Set up change notifications
 * registry.onChange((commands) => {
 *   adapter.sendAvailableCommandsUpdate(sessionId, commands);
 * });
 * ```
 */
export class SlashCommandsRegistry {
  private commands = new Map<string, AvailableCommand>();
  private logger: Logger;
  private changeCallback?: CommandsChangeCallback;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Register a callback to be invoked when commands change
   * Per ACP spec: Use this to send available_commands_update notifications
   *
   * @param callback - Function to call with updated command list
   *
   * @example
   * ```typescript
   * registry.onChange((commands) => {
   *   sendNotification({
   *     jsonrpc: '2.0',
   *     method: 'session/update',
   *     params: {
   *       sessionId: currentSessionId,
   *       update: {
   *         sessionUpdate: 'available_commands_update',
   *         availableCommands: commands
   *       }
   *     }
   *   });
   * });
   * ```
   */
  onChange(callback: CommandsChangeCallback): void {
    this.changeCallback = callback;
    this.logger.debug('Commands change callback registered');
  }

  /**
   * Notify listeners that commands have changed
   * Per ACP spec: Triggers available_commands_update notification
   */
  private notifyChange(): void {
    if (this.changeCallback) {
      this.changeCallback(this.getCommands());
    }
  }

  /**
   * Validate that a command object conforms to the ACP spec
   * Per ACP spec: name and description are required, input is optional
   *
   * @param command - The command to validate
   * @returns True if valid
   * @throws Error if command is invalid
   */
  static validateCommand(command: unknown): command is AvailableCommand {
    if (typeof command !== 'object' || command === null) {
      throw new Error('Command must be an object');
    }

    const cmd = command as Partial<AvailableCommand>;

    if (typeof cmd.name !== 'string' || cmd.name.trim() === '') {
      throw new Error('Command name must be a non-empty string');
    }

    if (typeof cmd.description !== 'string' || cmd.description.trim() === '') {
      throw new Error('Command description must be a non-empty string');
    }

    if (cmd.input !== undefined) {
      if (typeof cmd.input !== 'object' || cmd.input === null) {
        throw new Error('Command input must be an object if provided');
      }

      const input = cmd.input as Partial<AvailableCommandInput>;
      if (typeof input.hint !== 'string' || input.hint.trim() === '') {
        throw new Error('Command input.hint must be a non-empty string');
      }
    }

    return true;
  }

  /**
   * Type guard to check if an object is a valid AvailableCommand
   * Per ACP spec: Ensures strict type compliance
   *
   * @param command - The object to check
   * @returns True if the object is a valid AvailableCommand
   */
  static isValidCommand(command: unknown): command is AvailableCommand {
    try {
      return SlashCommandsRegistry.validateCommand(command);
    } catch {
      return false;
    }
  }

  /**
   * Register a new command or update an existing one
   * Per ACP spec: Commands provide quick access to specific agent capabilities
   *
   * @param name - Command name (e.g., "web", "test", "plan")
   *               Per ACP spec: Will be invoked by users as `/name` in prompts
   * @param description - Human-readable description of what the command does
   *                      Per ACP spec: Displayed to users in command lists
   * @param inputHint - Optional hint to display when input hasn't been provided yet
   *                    Per ACP spec: Helps users understand what input is expected
   *
   * @example
   * ```typescript
   * // Command without input
   * registry.registerCommand('test', 'Run tests for the current project');
   *
   * // Command with input hint
   * registry.registerCommand('web', 'Search the web', 'query to search for');
   *
   * // Users invoke: /web agent client protocol
   * ```
   */
  registerCommand(name: string, description: string, inputHint?: string): void {
    const command: AvailableCommand = {
      name,
      description,
      ...(inputHint && {
        input: {
          hint: inputHint,
        } as AvailableCommandInput,
      }),
    };

    // Validate command before adding
    SlashCommandsRegistry.validateCommand(command);

    this.commands.set(name, command);
    this.logger.debug('Registered slash command', { name, description });

    // Notify listeners of change (triggers available_commands_update)
    this.notifyChange();
  }

  /**
   * Get all registered commands as an array
   * Per ACP spec: Returns the list for available_commands_update notifications
   *
   * @returns Array of AvailableCommand objects
   *
   * @example
   * ```typescript
   * const commands = registry.getCommands();
   * // Send to client via available_commands_update
   * ```
   */
  getCommands(): AvailableCommand[] {
    return Array.from(this.commands.values());
  }

  /**
   * Update commands with a new set
   * Per ACP spec: "The Agent can update the list of available commands at any time"
   *
   * This replaces all existing commands with the provided set and triggers
   * an available_commands_update notification (if onChange callback is set).
   *
   * @param commands - Array of AvailableCommand objects
   *
   * @example
   * ```typescript
   * // Dynamically update based on context
   * if (projectHasTests) {
   *   registry.updateCommands([
   *     { name: 'test', description: 'Run tests' },
   *     { name: 'plan', description: 'Create plan' }
   *   ]);
   * }
   * ```
   */
  updateCommands(commands: AvailableCommand[]): void {
    // Validate all commands before clearing
    for (const command of commands) {
      SlashCommandsRegistry.validateCommand(command);
    }

    this.commands.clear();
    for (const command of commands) {
      this.commands.set(command.name, command);
    }
    this.logger.debug('Updated slash commands', {
      count: commands.length,
      names: commands.map((c) => c.name),
    });

    // Notify listeners of change (triggers available_commands_update)
    this.notifyChange();
  }

  /**
   * Remove a command by name
   * Per ACP spec: Triggers available_commands_update notification
   *
   * @param name - Command name to remove
   *
   * @example
   * ```typescript
   * // Remove when no longer relevant
   * registry.removeCommand('test');
   * ```
   */
  removeCommand(name: string): void {
    const removed = this.commands.delete(name);
    if (removed) {
      this.logger.debug('Removed slash command', { name });
      // Notify listeners of change (triggers available_commands_update)
      this.notifyChange();
    }
  }

  /**
   * Check if a command exists
   * Per ACP spec: Useful for conditional command registration
   *
   * @param name - Command name to check
   * @returns True if command exists
   */
  hasCommand(name: string): boolean {
    return this.commands.has(name);
  }

  /**
   * Get a specific command by name
   * Per ACP spec: Useful for introspection and validation
   *
   * @param name - Command name
   * @returns AvailableCommand or undefined if not found
   */
  getCommand(name: string): AvailableCommand | undefined {
    return this.commands.get(name);
  }

  /**
   * Clear all commands
   * Per ACP spec: Triggers available_commands_update notification
   *
   * @example
   * ```typescript
   * // Clear all commands when context changes
   * registry.clear();
   * ```
   */
  clear(): void {
    this.commands.clear();
    this.logger.debug('Cleared all slash commands');
    // Notify listeners of change (triggers available_commands_update)
    this.notifyChange();
  }

  /**
   * Get the number of registered commands
   * Per ACP spec: Useful for metrics and debugging
   *
   * @returns Number of commands
   */
  getCommandCount(): number {
    return this.commands.size;
  }

  /**
   * Manually trigger a commands change notification
   * Per ACP spec: Use this to re-send available_commands_update
   *
   * This is useful when you need to explicitly notify the client about
   * the current command list without making any changes.
   *
   * @example
   * ```typescript
   * // Re-send commands after reconnection
   * registry.triggerUpdate();
   * ```
   */
  triggerUpdate(): void {
    this.logger.debug('Manually triggering commands update');
    this.notifyChange();
  }
}
