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
import type { PromptOptions, StreamingPromptOptions } from '../../../src/cursor/cli-bridge';

export class MockCursorCliBridge {
  private config: AdapterConfig;
  private logger: Logger;
  private activeSessions = new Map<string, CursorSession>();
  private callCount = 0;

  constructor(config: AdapterConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  async checkAuthentication(): Promise<CursorAuthStatus> {
    return {
      authenticated: true,
      user: 'test-user',
      email: 'test@example.com',
      plan: 'pro',
    };
  }

  async getVersion(): Promise<string> {
    return '1.0.0-mock';
  }

  async executeCommand(
    command: string[],
    options: CursorCommandOptions = {}
  ): Promise<CursorResponse> {
    // Simulate quick command execution
    await new Promise((resolve) => setTimeout(resolve, 10));

    return {
      success: true,
      stdout: 'Mock command output',
      stderr: '',
      exitCode: 0,
    };
  }

  async startInteractiveSession(sessionId?: string): Promise<CursorSession> {
    const id = sessionId || `mock-session-${Date.now()}`;
    const session: CursorSession = {
      id,
      status: 'active',
      lastActivity: new Date(),
      metadata: {
        created: new Date(),
        type: 'interactive',
      },
    };

    this.activeSessions.set(id, session);
    return session;
  }

  async sendPrompt(options: PromptOptions): Promise<CursorResponse> {
    this.callCount++;

    // Simulate quick response
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Generate a simple mock response based on content
    const contentLower = options.content.value.toLowerCase();
    let response = 'This is a mock response from the cursor-agent simulator.';

    if (contentLower.includes('typescript')) {
      response = 'TypeScript is a statically typed superset of JavaScript that adds type safety.';
    } else if (contentLower.includes('code') || contentLower.includes('review')) {
      response = 'The code looks good. Consider adding error handling and type annotations.';
    } else if (contentLower.includes('help')) {
      response = 'I can help you with coding questions, code review, and technical explanations.';
    }

    return {
      success: true,
      stdout: response,
      stderr: '',
      exitCode: 0,
      metadata: {
        processedAt: new Date().toISOString(),
        contentLength: options.content.value.length,
        callNumber: this.callCount,
      },
    };
  }

  async sendStreamingPrompt(
    options: StreamingPromptOptions
  ): Promise<CursorResponse> {
    this.callCount++;

    // Simulate streaming chunks quickly
    const response = 'Streaming response chunk by chunk...';
    const chunks = response.match(/.{1,10}/g) || [response];

    for (const chunk of chunks) {
      await new Promise((resolve) => setTimeout(resolve, 5));

      if (options.abortSignal?.aborted) {
        return {
          success: false,
          stdout: '',
          stderr: 'Aborted',
          exitCode: 1,
          error: 'Request aborted',
        };
      }

      if (options.onChunk) {
        await options.onChunk({
          type: 'content',
          data: chunk,
        });
      }

      if (options.onProgress) {
        options.onProgress({
          step: 'streaming',
          progress: chunks.indexOf(chunk) + 1,
          total: chunks.length,
          message: `Chunk ${chunks.indexOf(chunk) + 1}/${chunks.length}`,
        });
      }
    }

    if (options.onChunk) {
      await options.onChunk({
        type: 'done',
        data: { complete: true },
      });
    }

    return {
      success: true,
      stdout: response,
      stderr: '',
      exitCode: 0,
      metadata: {
        streaming: true,
        chunks: chunks.length,
      },
    };
  }

  async sendSessionInput(sessionId: string, input: string): Promise<string> {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return `Mock response for: ${input}`;
  }

  async closeSession(sessionId: string): Promise<void> {
    this.activeSessions.delete(sessionId);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  getActiveSessions(): CursorSession[] {
    return Array.from(this.activeSessions.values());
  }

  async close(): Promise<void> {
    this.activeSessions.clear();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  // Test helpers
  getCallCount(): number {
    return this.callCount;
  }

  reset(): void {
    this.callCount = 0;
    this.activeSessions.clear();
  }
}
