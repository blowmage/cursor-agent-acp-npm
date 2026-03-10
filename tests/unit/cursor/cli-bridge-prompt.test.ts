/**
 * Unit tests for CursorCliBridge sendPrompt and sendStreamingPrompt
 *
 * Tests the --force and --trust flag behavior based on config.cursor settings.
 */

import { CursorCliBridge } from '../../../src/cursor/cli-bridge';
import type { AdapterConfig, Logger, CursorResponse } from '../../../src/types';

const mockExecuteCommand = jest.fn();
const mockExecuteStreamingCommand = jest.fn();

jest.mock('fs/promises', () => ({
  writeFile: jest.fn().mockResolvedValue(undefined),
  unlink: jest.fn().mockResolvedValue(undefined),
}));

describe('CursorCliBridge - sendPrompt and sendStreamingPrompt', () => {
  let bridge: CursorCliBridge;
  let mockConfig: AdapterConfig;
  let mockLogger: Logger;

  const baseConfig = (overrides?: Partial<AdapterConfig['cursor']>): AdapterConfig => ({
    logLevel: 'error',
    sessionDir: '/tmp/test-sessions',
    maxSessions: 10,
    sessionTimeout: 3600,
    tools: {
      filesystem: { enabled: true },
      terminal: { enabled: true, maxProcesses: 5 },
      cursor: {
        enabled: true,
        maxSearchResults: 50,
        enableCodeModification: true,
        enableTestExecution: true,
      },
    },
    cursor: {
      timeout: 30000,
      retries: 3,
      ...overrides,
    },
  });

  beforeEach(() => {
    mockLogger = {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
    };

    mockExecuteCommand.mockResolvedValue({
      success: true,
      stdout: JSON.stringify({ result: 'test response' }),
      stderr: '',
      exitCode: 0,
    } as CursorResponse);

    mockExecuteStreamingCommand.mockResolvedValue({
      success: true,
      stdout: '',
      stderr: '',
      exitCode: 0,
    } as CursorResponse);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('sendPrompt - --force and --trust flags', () => {
    test('should include --force and --trust when both are true in config', async () => {
      mockConfig = baseConfig({ force: true, trust: true });
      bridge = new CursorCliBridge(mockConfig, mockLogger);
      jest.spyOn(bridge as any, 'executeCommand').mockImplementation(mockExecuteCommand);

      await bridge.sendPrompt({
        sessionId: 'test-session',
        content: { value: 'hello', metadata: {} },
      });

      const args = mockExecuteCommand.mock.calls[0][0];
      expect(args).toContain('--force');
      expect(args).toContain('--trust');
    });

    test('should omit --force and --trust when both are false/undefined in config', async () => {
      mockConfig = baseConfig({ force: false, trust: false });
      bridge = new CursorCliBridge(mockConfig, mockLogger);
      jest.spyOn(bridge as any, 'executeCommand').mockImplementation(mockExecuteCommand);

      await bridge.sendPrompt({
        sessionId: 'test-session',
        content: { value: 'hello', metadata: {} },
      });

      const args = mockExecuteCommand.mock.calls[0][0];
      expect(args).not.toContain('--force');
      expect(args).not.toContain('--trust');
    });
  });

  describe('sendStreamingPrompt - --force and --trust flags', () => {
    test('should include --force and --trust when both are true in config', async () => {
      mockConfig = baseConfig({ force: true, trust: true });
      bridge = new CursorCliBridge(mockConfig, mockLogger);
      jest
        .spyOn(bridge as any, 'executeStreamingCommand')
        .mockImplementation(mockExecuteStreamingCommand);

      await bridge.sendStreamingPrompt({
        sessionId: 'test-session',
        content: { value: 'hello', metadata: {} },
      });

      const args = mockExecuteStreamingCommand.mock.calls[0][0];
      expect(args).toContain('--force');
      expect(args).toContain('--trust');
    });

    test('should omit both when force and trust are undefined (default)', async () => {
      mockConfig = baseConfig();
      bridge = new CursorCliBridge(mockConfig, mockLogger);
      jest
        .spyOn(bridge as any, 'executeStreamingCommand')
        .mockImplementation(mockExecuteStreamingCommand);

      await bridge.sendStreamingPrompt({
        sessionId: 'test-session',
        content: { value: 'hello', metadata: {} },
      });

      const args = mockExecuteStreamingCommand.mock.calls[0][0];
      expect(args).not.toContain('--force');
      expect(args).not.toContain('--trust');
    });
  });

  describe('sendPrompt - args structure', () => {
    test('should pass correct base args for cursor-agent', async () => {
      mockConfig = baseConfig({ force: true, trust: true });
      bridge = new CursorCliBridge(mockConfig, mockLogger);
      jest.spyOn(bridge as any, 'executeCommand').mockImplementation(mockExecuteCommand);

      await bridge.sendPrompt({
        sessionId: 'test-session',
        content: { value: 'explain this code', metadata: {} },
      });

      const args = mockExecuteCommand.mock.calls[0][0];
      expect(args).toContain('--print');
      expect(args).toContain('--output-format');
      expect(args).toContain('json');
      expect(args).toContain('explain this code');
    });

    test('should add --model when specified in metadata', async () => {
      mockConfig = baseConfig();
      bridge = new CursorCliBridge(mockConfig, mockLogger);
      jest.spyOn(bridge as any, 'executeCommand').mockImplementation(mockExecuteCommand);

      await bridge.sendPrompt({
        sessionId: 'test-session',
        content: { value: 'hello', metadata: {} },
        metadata: { model: 'claude-3-opus' },
      });

      const args = mockExecuteCommand.mock.calls[0][0];
      expect(args).toContain('--model');
      expect(args).toContain('claude-3-opus');
    });

    test('should add --resume when cursorChatId in metadata', async () => {
      mockConfig = baseConfig();
      bridge = new CursorCliBridge(mockConfig, mockLogger);
      jest.spyOn(bridge as any, 'executeCommand').mockImplementation(mockExecuteCommand);

      await bridge.sendPrompt({
        sessionId: 'test-session',
        content: { value: 'hello', metadata: {} },
        metadata: { cursorChatId: 'chat-abc-123' },
      });

      const args = mockExecuteCommand.mock.calls[0][0];
      expect(args).toContain('--resume');
      expect(args).toContain('chat-abc-123');
    });
  });

  describe('sendStreamingPrompt - args structure', () => {
    test('should pass correct base args including agent subcommand', async () => {
      mockConfig = baseConfig({ force: true, trust: true });
      bridge = new CursorCliBridge(mockConfig, mockLogger);
      jest
        .spyOn(bridge as any, 'executeStreamingCommand')
        .mockImplementation(mockExecuteStreamingCommand);

      await bridge.sendStreamingPrompt({
        sessionId: 'test-session',
        content: { value: 'stream this', metadata: {} },
      });

      const args = mockExecuteStreamingCommand.mock.calls[0][0];
      expect(args).toContain('agent');
      expect(args).toContain('--print');
      expect(args).toContain('--output-format');
      expect(args).toContain('stream-json');
      expect(args).toContain('--stream-partial-output');
      expect(args).toContain('stream this');
    });

    test('should add --model when specified in metadata', async () => {
      mockConfig = baseConfig();
      bridge = new CursorCliBridge(mockConfig, mockLogger);
      jest
        .spyOn(bridge as any, 'executeStreamingCommand')
        .mockImplementation(mockExecuteStreamingCommand);

      await bridge.sendStreamingPrompt({
        sessionId: 'test-session',
        content: { value: 'hello', metadata: {} },
        metadata: { model: 'claude-3-sonnet' },
      });

      const args = mockExecuteStreamingCommand.mock.calls[0][0];
      expect(args).toContain('--model');
      expect(args).toContain('claude-3-sonnet');
    });

    test('should add --resume when cursorChatId in metadata', async () => {
      mockConfig = baseConfig();
      bridge = new CursorCliBridge(mockConfig, mockLogger);
      jest
        .spyOn(bridge as any, 'executeStreamingCommand')
        .mockImplementation(mockExecuteStreamingCommand);

      await bridge.sendStreamingPrompt({
        sessionId: 'test-session',
        content: { value: 'hello', metadata: {} },
        metadata: { cursorChatId: 'chat-xyz-456' },
      });

      const args = mockExecuteStreamingCommand.mock.calls[0][0];
      expect(args).toContain('--resume');
      expect(args).toContain('chat-xyz-456');
    });
  });

  describe('error handling', () => {
    test('sendPrompt should throw when executeCommand fails', async () => {
      mockConfig = baseConfig();
      bridge = new CursorCliBridge(mockConfig, mockLogger);
      jest.spyOn(bridge as any, 'executeCommand').mockResolvedValue({
        success: false,
        stdout: '',
        stderr: 'cursor-agent error',
        exitCode: 1,
        error: 'cursor-agent error',
      } as CursorResponse);

      await expect(
        bridge.sendPrompt({
          sessionId: 'test-session',
          content: { value: 'hello', metadata: {} },
        })
      ).rejects.toThrow();
    });

    test('sendStreamingPrompt should throw when executeStreamingCommand fails', async () => {
      mockConfig = baseConfig();
      bridge = new CursorCliBridge(mockConfig, mockLogger);
      jest
        .spyOn(bridge as any, 'executeStreamingCommand')
        .mockRejectedValue(new Error('Stream failed'));

      await expect(
        bridge.sendStreamingPrompt({
          sessionId: 'test-session',
          content: { value: 'hello', metadata: {} },
        })
      ).rejects.toThrow('Stream failed');
    });
  });
});
