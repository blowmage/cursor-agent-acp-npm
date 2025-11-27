/**
 * Extension Registry
 *
 * Manages extension method and notification handlers for ACP extensibility.
 * Per ACP spec: https://agentclientprotocol.com/protocol/extensibility
 *
 * Extension methods and notifications MUST start with an underscore (_) to avoid
 * conflicts with future protocol versions.
 * All types use @agentclientprotocol/sdk for strict compliance.
 *
 * ## Usage Example
 *
 * ```typescript
 * import { ExtensionRegistry } from '@blowmage/cursor-agent-acp';
 *
 * const registry = new ExtensionRegistry(logger);
 *
 * // Register an extension method
 * // Method names MUST start with underscore and SHOULD use namespaces
 * registry.registerMethod('_myapp/custom_action', async (params) => {
 *   // Handle the method
 *   return { success: true, result: params.input };
 * });
 *
 * // Register an extension notification
 * registry.registerNotification('_myapp/status_update', async (params) => {
 *   // Handle notification (one-way, no response)
 *   console.log('Status:', params.status);
 * });
 * ```
 *
 * ## Naming Conventions
 *
 * Per ACP spec, extension names MUST:
 * - Start with underscore (_)
 * - Use namespaces to avoid conflicts (e.g., `_myapp/method`)
 * - Follow format: `_namespace/name` or `_name` (without slash)
 *
 * Extension names are advertised in capabilities as follows:
 * - `_namespace/method` → `_meta.namespace.methods`
 * - `_method` (no slash) → `_meta.method.methods` (method name used as namespace)
 *
 * ## Invocation from Clients
 *
 * Clients invoke extension methods via JSON-RPC:
 * ```json
 * {
 *   "jsonrpc": "2.0",
 *   "id": 1,
 *   "method": "_myapp/custom_action",
 *   "params": { "input": "value" }
 * }
 * ```
 *
 * Clients send extension notifications via JSON-RPC (no response expected):
 * ```json
 * {
 *   "jsonrpc": "2.0",
 *   "method": "_myapp/status_update",
 *   "params": { "status": "running" }
 * }
 * ```
 */

import type { Logger } from '../types';

/**
 * Extension method request parameters
 * Per ACP spec: Arbitrary JSON-RPC params object
 */
export type ExtMethodRequest = Record<string, unknown>;

/**
 * Extension method response
 * Per ACP spec: Arbitrary JSON-RPC result object
 */
export type ExtMethodResponse = Record<string, unknown>;

/**
 * Extension notification parameters
 * Per ACP spec: Arbitrary JSON-RPC params object
 */
export type ExtNotificationParams = Record<string, unknown>;

/**
 * Handler function for extension methods
 * Receives params and returns result
 * Per ACP SDK Agent interface signature
 */
export type ExtensionMethodHandler = (
  params: ExtMethodRequest
) => Promise<ExtMethodResponse>;

/**
 * Handler function for extension notifications
 * Receives params and returns void (notifications are one-way)
 * Per ACP SDK Agent interface signature
 */
export type ExtensionNotificationHandler = (
  params: ExtNotificationParams
) => Promise<void>;

/**
 * Registry for managing extension methods and notifications
 */
export class ExtensionRegistry {
  private methods = new Map<string, ExtensionMethodHandler>();
  private notifications = new Map<string, ExtensionNotificationHandler>();
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Validate extension method/notification name
   * Per ACP spec: Extension names MUST start with underscore
   *
   * @param name - The name to validate
   * @returns True if valid, false otherwise
   */
  private isValidExtensionName(name: string): boolean {
    return typeof name === 'string' && name.length > 0 && name.startsWith('_');
  }

  /**
   * Register an extension method handler
   * Per ACP spec: Extension methods MUST start with underscore
   *
   * @param name - Extension method name (e.g., "_namespace/method")
   * @param handler - Handler function for the method
   * @throws Error if name is invalid
   */
  registerMethod(name: string, handler: ExtensionMethodHandler): void {
    if (!this.isValidExtensionName(name)) {
      throw new Error(
        `Extension method name must start with underscore: ${name}`
      );
    }

    if (typeof handler !== 'function') {
      throw new Error('Extension method handler must be a function');
    }

    this.methods.set(name, handler);
    this.logger.debug('Registered extension method', { name });
  }

  /**
   * Register an extension notification handler
   * Per ACP spec: Extension notifications MUST start with underscore
   *
   * @param name - Extension notification name (e.g., "_namespace/notification")
   * @param handler - Handler function for the notification
   * @throws Error if name is invalid
   */
  registerNotification(
    name: string,
    handler: ExtensionNotificationHandler
  ): void {
    if (!this.isValidExtensionName(name)) {
      throw new Error(
        `Extension notification name must start with underscore: ${name}`
      );
    }

    if (typeof handler !== 'function') {
      throw new Error('Extension notification handler must be a function');
    }

    this.notifications.set(name, handler);
    this.logger.debug('Registered extension notification', { name });
  }

  /**
   * Check if an extension method is registered
   *
   * @param name - Extension method name
   * @returns True if registered
   */
  hasMethod(name: string): boolean {
    return this.methods.has(name);
  }

  /**
   * Check if an extension notification is registered
   *
   * @param name - Extension notification name
   * @returns True if registered
   */
  hasNotification(name: string): boolean {
    return this.notifications.has(name);
  }

  /**
   * Call an extension method
   * Per ACP spec: Returns result or throws error
   *
   * @param name - Extension method name
   * @param params - Method parameters
   * @returns Method result
   * @throws Error if method not found or handler throws
   */
  async callMethod(
    name: string,
    params: ExtMethodRequest
  ): Promise<ExtMethodResponse> {
    const handler = this.methods.get(name);

    if (!handler) {
      throw new Error(`Extension method not found: ${name}`);
    }

    this.logger.debug('Calling extension method', { name, params });

    try {
      const result = await handler(params);
      this.logger.debug('Extension method completed', { name });
      return result;
    } catch (error) {
      this.logger.error('Extension method error', {
        name,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Send an extension notification
   * Per ACP spec: Notifications are one-way and SHOULD be ignored if unrecognized
   *
   * @param name - Extension notification name
   * @param params - Notification parameters
   * @returns Promise that resolves when notification is handled
   */
  async sendNotification(
    name: string,
    params: ExtNotificationParams
  ): Promise<void> {
    const handler = this.notifications.get(name);

    if (!handler) {
      // Per ACP spec: SHOULD ignore unrecognized notifications
      this.logger.debug('Unrecognized extension notification ignored', {
        name,
      });
      return;
    }

    this.logger.debug('Sending extension notification', { name, params });

    try {
      await handler(params);
      this.logger.debug('Extension notification handled', { name });
    } catch (error) {
      // Log but don't throw - notifications are best-effort
      this.logger.warn('Extension notification handler error', {
        name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get list of registered extension methods
   * Used for advertising capabilities in initialization
   *
   * @returns Array of registered method names
   */
  getRegisteredMethods(): string[] {
    return Array.from(this.methods.keys());
  }

  /**
   * Get list of registered extension notifications
   * Used for advertising capabilities in initialization
   *
   * @returns Array of registered notification names
   */
  getRegisteredNotifications(): string[] {
    return Array.from(this.notifications.keys());
  }

  /**
   * Remove an extension method handler
   *
   * @param name - Extension method name to remove
   */
  unregisterMethod(name: string): void {
    const removed = this.methods.delete(name);
    if (removed) {
      this.logger.debug('Unregistered extension method', { name });
    }
  }

  /**
   * Remove an extension notification handler
   *
   * @param name - Extension notification name to remove
   */
  unregisterNotification(name: string): void {
    const removed = this.notifications.delete(name);
    if (removed) {
      this.logger.debug('Unregistered extension notification', { name });
    }
  }

  /**
   * Clear all registered methods and notifications
   */
  clear(): void {
    this.methods.clear();
    this.notifications.clear();
    this.logger.debug('Cleared all extension methods and notifications');
  }

  /**
   * Get count of registered methods
   *
   * @returns Number of registered methods
   */
  getMethodCount(): number {
    return this.methods.size;
  }

  /**
   * Get count of registered notifications
   *
   * @returns Number of registered notifications
   */
  getNotificationCount(): number {
    return this.notifications.size;
  }
}
