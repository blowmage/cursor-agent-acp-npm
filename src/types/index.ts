/**
 * Type definitions for Cursor Agent ACP Adapter
 *
 * This file contains all the core type definitions used throughout the adapter.
 */

// ============================================================================
// Core Adapter Types
// ============================================================================

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

// ============================================================================
// ACP Protocol Types (JSON-RPC 2.0)
// ============================================================================

export interface AcpRequest {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, any>;
  id: string | number;
}

export interface AcpResponse {
  jsonrpc: '2.0';
  result?: any;
  error?: AcpError;
  id: string | number | null;
}

export interface AcpNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, any>;
}

export interface AcpError {
  code: number;
  message: string;
  data?: any;
}

// ============================================================================
// Session Types
// ============================================================================

export interface SessionInfo {
  id: string;
  metadata: SessionMetadata;
  createdAt: Date;
  updatedAt: Date;
  status: SessionStatus;
}

export interface SessionMetadata {
  name?: string;
  title?: string;
  description?: string;
  tags?: string[];
  projectPath?: string;
  userId?: string;
  [key: string]: any;
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
  role: 'user' | 'assistant' | 'system';
  content: ContentBlock[];
  timestamp: Date;
  metadata?: Record<string, any> | undefined;
}

export type SessionStatus = 'active' | 'inactive' | 'expired' | 'error';

export interface SessionState {
  lastActivity: Date;
  messageCount: number;
  tokenCount?: number;
  currentTool?: string;
  context?: Record<string, any>;
}

// ============================================================================
// Content Types
// ============================================================================

export type ContentBlock =
  | TextContentBlock
  | CodeContentBlock
  | ImageContentBlock;

export interface TextContentBlock {
  type: 'text';
  value: string;
  metadata?: Record<string, any>;
}

export interface CodeContentBlock {
  type: 'code';
  value: string;
  language?: string;
  filename?: string;
  metadata?: Record<string, any>;
}

export interface ImageContentBlock {
  type: 'image';
  value: string; // (base64 encoded)
  mimeType: string;
  filename?: string;
  metadata?: Record<string, any>;
}

// ============================================================================
// Tool Types
// ============================================================================

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

export interface ToolCall {
  id: string;
  name: string;
  parameters: Record<string, any>;
}

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

// ============================================================================
// Cursor CLI Types
// ============================================================================

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
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: string;
  metadata?: Record<string, any>;
}

export interface CursorSession {
  id: string;
  status: 'active' | 'inactive' | 'error';
  lastActivity: Date;
  metadata?: Record<string, any>;
}

export interface CursorAuthStatus {
  authenticated: boolean;
  user?: string;
  email?: string;
  plan?: string;
  error?: string;
}

// ============================================================================
// Error Types
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
  readonly sessionId?: string;

  constructor(message: string, sessionId?: string, cause?: Error) {
    super(message, 'SESSION_ERROR', cause);
    this.name = 'SessionError';
    if (sessionId) {
      this.sessionId = sessionId;
    }
  }
}

export class ToolError extends AdapterError {
  readonly toolName?: string;

  constructor(message: string, toolName?: string, cause?: Error) {
    super(message, 'TOOL_ERROR', cause);
    this.name = 'ToolError';
    if (toolName) {
      this.toolName = toolName;
    }
  }
}

// ============================================================================
// Utility Types
// ============================================================================

export interface Logger {
  error(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  info(message: string, ...args: any[]): void;
  debug(message: string, ...args: any[]): void;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface ConnectivityTestResult {
  success: boolean;
  version?: string;
  authenticated?: boolean;
  error?: string;
}

// ============================================================================
// ACP Method Types
// ============================================================================

// Per ACP spec: https://agentclientprotocol.com/protocol/initialization
export interface InitializeParams {
  protocolVersion: number; // REQUIRED per ACP spec: protocol versions are integers (1, 2, etc.)
  clientCapabilities?: ClientCapabilities; // OPTIONAL but SHOULD be provided per ACP spec
  clientInfo?: {
    // OPTIONAL but SHOULD be provided per ACP spec
    name: string; // REQUIRED if clientInfo provided
    title?: string; // OPTIONAL: human-readable display name
    version: string; // REQUIRED if clientInfo provided
  };
}

export interface InitializeResult {
  protocolVersion: number; // ACP spec: must match or negotiate down from client's version
  agentCapabilities: AgentCapabilities; // ACP spec: use "agentCapabilities" not "capabilities"
  agentInfo: {
    // ACP spec: use "agentInfo" not "serverInfo" (this is an Agent)
    // Required (will be required in future protocol versions)
    name: string;
    title?: string; // Optional: human-readable display name
    version: string;
  };
  authMethods: string[]; // ACP spec: array of supported auth methods (empty if none)
}

// Per ACP spec: Client capabilities
export interface ClientCapabilities {
  fs?: {
    readTextFile?: boolean; // fs/read_text_file method available
    writeTextFile?: boolean; // fs/write_text_file method available
  };
  terminal?: boolean; // All terminal/* methods available
  _meta?: Record<string, any>; // Custom capability extensions
}

// Per ACP spec: Agent capabilities
export interface AgentCapabilities {
  loadSession?: boolean; // session/load method available (default: false)
  promptCapabilities?: PromptCapabilities;
  mcp?: McpCapabilities;
  _meta?: Record<string, any>; // Custom capability extensions
}

// Per ACP spec: Prompt content capabilities
export interface PromptCapabilities {
  image?: boolean; // ContentBlock::Image supported (default: false)
  audio?: boolean; // ContentBlock::Audio supported (default: false)
  embeddedContext?: boolean; // ContentBlock::Resource supported (default: false)
}

// Per ACP spec: MCP server connection capabilities
export interface McpCapabilities {
  http?: boolean; // Connect to MCP servers over HTTP (default: false)
  sse?: boolean; // Connect to MCP servers over SSE (default: false, deprecated)
}

// Legacy type for backward compatibility
export interface ServerCapabilities extends AgentCapabilities {
  // Deprecated fields for backward compatibility
  sessionManagement?: boolean;
  streaming?: boolean;
  toolCalling?: boolean;
  fileSystem?: boolean;
  terminal?: boolean;
  contentTypes?: string[];
}

export interface SessionNewParams {
  cwd: string; // Per ACP spec: absolute path to working directory
  mcpServers: any[]; // Array of MCP server configs
}

export interface SessionNewResult {
  sessionId: string; // Required per ACP spec
  modes?: SessionModeState | null; // Optional per ACP spec
  models?: SessionModelState | null; // Optional per ACP spec
}

// ACP spec types for session modes
export interface SessionModeState {
  currentModeId: string;
  availableModes: SessionMode[];
}

export interface SessionMode {
  id: string;
  name: string;
  description?: string | null;
}

// ACP spec types for session models
export interface SessionModelState {
  currentModelId: string;
  availableModels: ModelInfo[];
}

export interface ModelInfo {
  modelId: string;
  name: string;
  description?: string | null;
}

export interface SessionLoadParams {
  sessionId: string;
}

export interface SessionLoadResult {
  sessionId: string;
  metadata: SessionMetadata;
  conversation: ConversationMessage[];
}

export interface SessionListParams {
  limit?: number;
  offset?: number;
  filter?: Record<string, any>;
}

export interface SessionListResult {
  sessions: SessionInfo[];
  total: number;
  hasMore: boolean;
}

export interface SessionUpdateParams {
  sessionId: string;
  metadata: Partial<SessionMetadata>;
}

export interface SessionUpdateResult {
  sessionId: string;
  metadata: SessionMetadata;
}

export interface SessionDeleteParams {
  sessionId: string;
}

export interface SessionDeleteResult {
  sessionId: string;
  deleted: boolean;
}

export interface SessionPromptParams {
  sessionId: string;
  content: ContentBlock[];
  stream?: boolean;
  metadata?: Record<string, any>;
}

export interface MessagePart {
  content: string;
  content_type: string; // e.g., "text/plain", "application/json" (snake_case per ACP spec)
  content_encoding?: 'plain' | 'base64'; // Optional encoding
  name?: string; // Optional: makes this part an Artifact
  metadata?: Record<string, any>; // Optional: additional context
}

export interface AgentMessage {
  role: 'agent' | `agent/${string}`; // Supports "agent" or "agent/{name}" format
  parts: MessagePart[];
}

export interface SessionPromptResult {
  stopReason:
    | 'end_turn'
    | 'max_tokens'
    | 'max_turn_requests'
    | 'refusal'
    | 'cancelled'; // Required per ACP spec - indicates why agent stopped processing
}

// ============================================================================
// Stream Types
// ============================================================================

export interface StreamChunk {
  type: 'content' | 'metadata' | 'error' | 'done';
  data: any;
}

export interface StreamProgress {
  step: string;
  progress: number;
  total?: number;
  message?: string;
}

// ============================================================================
// Configuration Validation Types
// ============================================================================

export interface ConfigValidationRule {
  path: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required?: boolean;
  min?: number;
  max?: number;
  pattern?: RegExp;
  validator?: (value: any) => boolean;
}

// ============================================================================
// Transport Types
// ============================================================================

export interface TransportMessage {
  content: string;
  timestamp: Date;
}

export interface StdioTransport {
  send(message: string): Promise<void>;
  onMessage(handler: (message: string) => void): void;
  close(): Promise<void>;
}

export interface HttpTransport {
  port: number;
  start(): Promise<void>;
  stop(): Promise<void>;
}
