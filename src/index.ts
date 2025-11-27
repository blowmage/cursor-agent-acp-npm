/**
 * Cursor Agent ACP Adapter
 *
 * A full-featured Agent Client Protocol (ACP) adapter for Cursor CLI,
 * enabling seamless AI-powered coding assistance in ACP-compliant editors like Zed.
 */

export { CursorAgentAdapter } from './adapter/cursor-agent-adapter';
export { SessionManager } from './session/manager';
export { CursorCliBridge } from './cursor/cli-bridge';
export { ToolRegistry } from './tools/registry';
export { SlashCommandsRegistry } from './tools/slash-commands';

// Type exports
export type {
  // Core adapter types
  AdapterConfig,
  AdapterOptions,

  // Session types
  SessionInfo,
  SessionMetadata,
  SessionData,

  // Tool types
  Tool,
  ToolProvider,
  ToolCall,
  ToolResult,

  // Cursor types
  CursorCommand,
  CursorResponse,
  CursorSession,

  // Error types
  AdapterError,
  ProtocolError,
  CursorError,
} from './types';

// Protocol types
export type { InitializationConfig } from './protocol/initialization';

// Import the type for the default config
import type { AdapterConfig } from './types';

// Re-export useful utilities
export { createLogger } from './utils/logger';
export { validateConfig } from './utils/config';
export { formatError } from './utils/error-formatter';

// Version information
export const VERSION = '0.1.0';
export const PROTOCOL_VERSION = '0.1.0';

// Default configuration
export const DEFAULT_CONFIG: AdapterConfig = {
  logLevel: 'info',
  sessionDir: '~/.cursor-sessions',
  maxSessions: 100,
  sessionTimeout: 3600000, // 1 hour
  tools: {
    filesystem: {
      enabled: true,
    },
    terminal: {
      enabled: true,
      maxProcesses: 5,
    },
  },
  cursor: {
    timeout: 30000,
    retries: 3,
  },
};
