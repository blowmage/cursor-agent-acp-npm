/**
 * Mock implementation of CursorCliBridge for integration tests
 *
 * This mock allows integration tests to run quickly without making
 * real calls to cursor-agent CLI, while still testing all other
 * components and their integration.
 */
import type {
  CursorCommandOptions,
  CursorResponse,
  CursorSession,
  CursorAuthStatus,
  AdapterConfig,
  Logger,
} from '../../../src/types';
import type {
  PromptOptions,
  StreamingPromptOptions,
} from '../../../src/cursor/cli-bridge';
export declare class MockCursorCliBridge {
  private config;
  private logger;
  private activeSessions;
  private callCount;
  constructor(config: AdapterConfig, logger: Logger);
  checkAuthentication(): Promise<CursorAuthStatus>;
  getVersion(): Promise<string>;
  executeCommand(
    command: string[],
    options?: CursorCommandOptions
  ): Promise<CursorResponse>;
  startInteractiveSession(sessionId?: string): Promise<CursorSession>;
  sendPrompt(options: PromptOptions): Promise<CursorResponse>;
  sendStreamingPrompt(options: StreamingPromptOptions): Promise<CursorResponse>;
  sendSessionInput(sessionId: string, input: string): Promise<string>;
  closeSession(sessionId: string): Promise<void>;
  getActiveSessions(): CursorSession[];
  close(): Promise<void>;
  getCallCount(): number;
  reset(): void;
}
//# sourceMappingURL=cursor-bridge-mock.d.ts.map
