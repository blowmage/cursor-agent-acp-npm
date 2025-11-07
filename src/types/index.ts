/**
 * Internal type definitions for Cursor Agent ACP Adapter
 *
 * This file contains only internal implementation types.
 * For ACP protocol types, import directly from '@agentclientprotocol/sdk'.
 */

import type {
  ContentBlock,
  Role,
  RequestPermissionRequest,
} from '@agentclientprotocol/sdk';

// ============================================================================
// Internal Implementation Types
// ============================================================================

export interface SessionMetadata {
  name?: string;
  title?: string;
  description?: string;
  tags?: string[];
  projectPath?: string;
  userId?: string;
  cwd?: string; // Working directory for session
  mcpServers?: any[]; // MCP server configurations
  mode?: string; // Current session mode ID
  model?: string; // Current session model ID
  [key: string]: any;
}

export type SessionStatus = 'active' | 'inactive' | 'expired' | 'error';

export interface SessionState {
  lastActivity: Date;
  messageCount: number;
  tokenCount?: number;
  status: SessionStatus;
  currentMode?: string; // Current mode ID
  currentModel?: string; // Current model ID
}

// ============================================================================
// Session Modes
// Per ACP spec: https://agentclientprotocol.com/protocol/session-modes
// ============================================================================

export interface SessionMode {
  id: string;
  name: string;
  description: string;
  systemPrompt?: string;
  availableTools?: string[];
  permissionBehavior?: 'strict' | 'permissive' | 'auto';
}

// ============================================================================
// Session Models (UNSTABLE in ACP spec)
// ============================================================================

export interface SessionModel {
  id: string;
  name: string;
  provider?: string;
  contextWindow?: number;
  capabilities?: string[];
}

export interface SessionInfo {
  id: string;
  metadata: SessionMetadata;
  createdAt: Date;
  updatedAt: Date;
  status: SessionStatus;
}

export interface SessionData {
  id: string;
  metadata: SessionMetadata;
  conversation: ConversationMessage[];
  state: SessionState;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationMessage {
  id: string;
  role: Role;
  content: ContentBlock[];
  timestamp: Date;
  metadata?: Record<string, any>;
}

export interface SessionListParams {
  limit?: number;
  offset?: number;
  filter?: SessionFilter;
}

export interface SessionFilter {
  tags?: string[];
  userId?: string;
  startDate?: Date;
  endDate?: Date;
}

export interface SessionListResult {
  items: SessionSummary[];
  total: number;
  hasMore: boolean;
}

export interface SessionSummary {
  id: string;
  metadata: Partial<SessionMetadata>;
  messageCount: number;
  createdAt: Date;
  updatedAt: Date;
  lastMessageAt?: Date;
}

export interface SessionUpdateParams {
  sessionId: string;
  metadata?: Partial<SessionMetadata>;
}

export interface SessionDeleteParams {
  sessionId: string;
}

export interface ToolCallParams {
  name: string;
  parameters?: Record<string, any>;
}

export interface ToolCall {
  id: string;
  name: string;
  parameters: Record<string, any>;
}

export interface StreamChunk {
  type: 'content' | 'progress' | 'error' | 'done';
  data?: any;
  error?: string;
}

export interface StreamProgress {
  current: number;
  total?: number;
  message?: string;
  step?: string;
  progress?: number;
}

// Permission Outcome Type (internal)
export type PermissionOutcome =
  | { outcome: 'cancelled' }
  | { outcome: 'selected'; optionId: string };

export type RequestPermissionParams = RequestPermissionRequest;

export interface Tool {
  name: string;
  description: string;
  parameters: ToolParameters;
  handler: ToolHandler;
}

export interface ToolParameters {
  type: 'object';
  properties: Record<string, ToolParameter>;
  required?: string[];
}

export interface ToolParameter {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  enum?: any[];
  items?: ToolParameter;
  properties?: Record<string, ToolParameter>;
}

export type ToolHandler = (params: Record<string, any>) => Promise<ToolResult>;

export interface ToolResult {
  success: boolean;
  result?: any | undefined;
  error?: string | undefined;
  metadata?: Record<string, any> | undefined;
}

export interface ToolProvider {
  name: string;
  description: string;
  getTools(): Tool[];
}

export interface CursorCommand {
  command: string[];
  options?: CursorCommandOptions;
}

export interface CursorCommandOptions {
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
  input?: string;
  session?: string;
}

export interface CursorResponse {
  success: boolean;
  stdout?: string | undefined;
  stderr?: string | undefined;
  exitCode?: number | undefined;
  error?: string | undefined;
  metadata?: Record<string, any> | undefined;
}

export interface CursorSession {
  id: string;
  status: 'active' | 'inactive' | 'error';
  lastActivity: Date;
  metadata?: Record<string, any>;
}

export interface CursorAuthStatus {
  authenticated: boolean;
  userId?: string;
  user?: string;
  email?: string;
  plan?: string;
  error?: string;
}

export interface Logger {
  error(message: string, meta?: any): void;
  warn(message: string, meta?: any): void;
  info(message: string, meta?: any): void;
  debug(message: string, meta?: any): void;
}

export interface AdapterConfig {
  logLevel: 'error' | 'warn' | 'info' | 'debug';
  sessionDir: string;
  maxSessions: number;
  sessionTimeout: number;
  tools: {
    filesystem: {
      enabled: boolean;
      allowedPaths: string[];
    };
    terminal: {
      enabled: boolean;
      maxProcesses: number;
    };
    cursor?: {
      enabled?: boolean;
      projectRoot?: string;
      maxSearchResults?: number;
      enableCodeModification?: boolean;
      enableTestExecution?: boolean;
    };
  };
  cursor: {
    timeout: number;
    retries: number;
  };
}

export interface AdapterOptions {
  config?: Partial<AdapterConfig>;
  logger?: Logger;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface ConfigValidationRule {
  path: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required?: boolean;
  min?: number;
  max?: number;
  pattern?: RegExp;
  validator?: (value: any) => boolean;
}

export interface ConnectivityTestResult {
  success: boolean;
  version?: string;
  authenticated?: boolean;
  error?: string;
}

// ============================================================================
// Error Classes
// ============================================================================

export class AdapterError extends Error {
  readonly code: string;
  override readonly cause?: Error;

  constructor(message: string, code: string, cause?: Error) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
    if (cause) {
      this.cause = cause;
    }
  }
}

export class ProtocolError extends AdapterError {
  constructor(message: string, cause?: Error) {
    super(message, 'PROTOCOL_ERROR', cause);
    this.name = 'ProtocolError';
  }
}

export class CursorError extends AdapterError {
  constructor(message: string, cause?: Error) {
    super(message, 'CURSOR_ERROR', cause);
    this.name = 'CursorError';
  }
}

export class SessionError extends AdapterError {
  readonly sessionId?: string | undefined;

  constructor(
    message: string,
    sessionId?: string | undefined,
    cause?: Error | undefined
  ) {
    super(message, 'SESSION_ERROR', cause);
    this.name = 'SessionError';
    this.sessionId = sessionId;
  }
}

export class ToolError extends AdapterError {
  readonly toolName?: string | undefined;

  constructor(
    message: string,
    toolName?: string | undefined,
    cause?: Error | undefined
  ) {
    super(message, 'TOOL_ERROR', cause);
    this.name = 'ToolError';
    this.toolName = toolName;
  }
}
