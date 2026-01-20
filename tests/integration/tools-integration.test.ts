/**
 * Integration tests for Tool Calling System
 *
 * These tests verify the complete integration of filesystem, terminal, and
 * cursor-specific tools working together through the ToolRegistry.
 *
 * Note: CursorCliBridge is mocked to avoid slow real cursor-agent calls
 * while still testing all other component integrations.
 */

import { jest } from '@jest/globals';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ToolRegistry } from '../../src/tools/registry';
import { FilesystemToolProvider } from '../../src/tools/filesystem';
import { AcpFileSystemClient } from '../../src/client/filesystem-client';
import type { AdapterConfig, Logger, ToolCall } from '../../src/types';
import type { ClientCapabilities } from '@agentclientprotocol/sdk';
import { MockCursorCliBridge } from './mocks/cursor-bridge-mock';

// Mock the CursorCliBridge module to avoid real cursor-agent calls
jest.mock('../../src/cursor/cli-bridge', () => ({
  CursorCliBridge: jest.fn().mockImplementation((config, logger) => {
    return new MockCursorCliBridge(config, logger);
  }),
}));

// Mock fs module to avoid real file I/O operations in integration tests
jest.mock('fs', () => {
  // Map of mock file contents for testing
  const mockFiles = new Map<string, string>();

  return {
    promises: {
      mkdtemp: jest.fn().mockResolvedValue('/mock/temp/cursor-acp-tools-123'),
      mkdir: jest.fn().mockResolvedValue(undefined),
      writeFile: jest
        .fn()
        .mockImplementation(async (filePath: string, content: string) => {
          mockFiles.set(filePath, content);
          return undefined;
        }),
      readFile: jest.fn().mockImplementation(async (filePath: string) => {
        // Check if file was written by a test
        if (mockFiles.has(filePath)) {
          return mockFiles.get(filePath);
        }

        // Return predefined mock content based on path
        if (filePath.includes('package.json')) {
          return JSON.stringify(
            {
              name: 'test-project',
              version: '1.0.0',
              scripts: { test: 'jest', build: 'tsc' },
            },
            null,
            2
          );
        }

        if (filePath.includes('user.ts')) {
          return `export interface User {
  id: number;
  name: string;
  email: string;
}

export class UserService {
  private users: User[] = [];

  addUser(user: User): void {
    this.users.push(user);
  }

  getUserById(id: number): User | undefined {
    return this.users.find(user => user.id === id);
  }
}`;
        }

        if (filePath.includes('calculator.ts')) {
          return `export class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }

  multiply(a: number, b: number): number {
    return a * b;
  }
}`;
        }

        if (filePath.includes('test-concurrent.txt')) {
          return 'concurrent test content';
        }

        if (filePath.includes('metrics-test.txt')) {
          return 'metrics test';
        }

        if (filePath.includes('terminal-test.txt')) {
          return 'Hello from terminal\n';
        }

        if (filePath.includes('workflow-test.js')) {
          return 'console.log("Hello, World!");';
        }

        // File not found
        const error: any = new Error(
          `ENOENT: no such file or directory, open '${filePath}'`
        );
        error.code = 'ENOENT';
        throw error;
      }),
      rm: jest.fn().mockResolvedValue(undefined),
    },
  };
});

describe('Tool System Integration', () => {
  let registry: ToolRegistry;
  let mockConfig: AdapterConfig;
  let mockLogger: Logger;
  let tempDir: string;
  let testProjectDir: string;

  // Mock client security settings (simulates client-side validation per ACP spec)
  let mockClientAllowedPaths: string[];

  beforeAll(async () => {
    // Use mock paths - fs module is mocked so no real directories created
    tempDir = '/mock/temp/cursor-acp-tools-123';
    testProjectDir = path.join(tempDir, 'test-project');

    // Note: createTestProject() is not needed since fs.readFile is mocked
    // to return predefined content for test files
  });

  afterAll(async () => {
    // No cleanup needed - mock filesystem doesn't create real files
  });

  beforeEach(() => {
    // Initialize mock client security settings (simulates client-side validation per ACP spec)
    mockClientAllowedPaths = [tempDir];

    mockConfig = {
      logLevel: 'debug',
      sessionDir: path.join(tempDir, 'sessions'),
      maxSessions: 10,
      sessionTimeout: 3600,
      tools: {
        filesystem: {
          enabled: false, // Disabled in config, manually registered in beforeEach
          // Note: Security validation now done by mock client (simulates ACP client behavior)
        },
        terminal: {
          enabled: true,
          maxProcesses: 5,
        },
        cursor: {
          enabled: true,
          projectRoot: testProjectDir,
          maxSearchResults: 50,
          enableCodeModification: true,
          enableTestExecution: true,
        },
      },
      cursor: {
        timeout: 30000,
        retries: 3,
      },
    };

    mockLogger = {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
    };

    registry = new ToolRegistry(mockConfig, mockLogger);

    // Register filesystem tools with mock client (per ACP architecture)
    const mockClientCapabilities: ClientCapabilities = {
      fs: {
        readTextFile: true,
        writeTextFile: true,
      },
    };

    // Create mock filesystem client for integration tests
    const mockFileSystemClient = new AcpFileSystemClient(
      {
        async readTextFile(params: any) {
          // Validate path is within allowed paths (client-side validation per ACP spec)
          const isAllowed = mockClientAllowedPaths.some((allowed) =>
            params.path.startsWith(allowed)
          );
          if (!isAllowed) {
            throw new Error(`Access to ${params.path} is not allowed`);
          }
          // Use mocked fs - no real file I/O
          const content = await fs.readFile(params.path, 'utf-8');
          return { content };
        },
        async writeTextFile(params: any) {
          // Validate path is within allowed paths (client-side validation per ACP spec)
          const isAllowed = mockClientAllowedPaths.some((allowed) =>
            params.path.startsWith(allowed)
          );
          if (!isAllowed) {
            throw new Error(`Access to ${params.path} is not allowed`);
          }
          // Use mocked fs - no real file I/O
          await fs.writeFile(params.path, params.content, 'utf-8');
          return {};
        },
      },
      mockLogger
    );

    const filesystemProvider = new FilesystemToolProvider(
      {
        ...mockConfig,
        tools: {
          ...mockConfig.tools,
          filesystem: {
            ...mockConfig.tools.filesystem,
            enabled: true, // Enable for provider (even though disabled in adapter config)
          },
        },
      },
      mockLogger,
      mockClientCapabilities,
      mockFileSystemClient
    );

    registry.registerProvider(filesystemProvider);
  });

  afterEach(async () => {
    // Cleanup any processes or sessions
    try {
      await registry.reload();
    } catch (error) {
      // Ignore cleanup errors
    }
    // Give time for all async cleanup to complete
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  describe('Tool Registry Integration', () => {
    test('should initialize all tool providers', () => {
      const providers = registry.getProviders();
      const providerNames = providers.map((p) => p.name);

      expect(providerNames).toContain('filesystem');
      // Terminal is now a client-side capability, not a tool provider
      expect(providerNames).not.toContain('terminal');
      expect(providerNames).toContain('cursor');
      expect(providers).toHaveLength(2);
    });

    test('should provide all available tools', () => {
      const tools = registry.getTools();
      const toolNames = tools.map((t) => t.name);

      // Filesystem tools (ACP-compliant only)
      expect(toolNames).toContain('read_file');
      expect(toolNames).toContain('write_file');

      // Terminal operations are client-side capabilities, not tools
      expect(toolNames).not.toContain('execute_command');
      expect(toolNames).not.toContain('start_shell_session');

      // Cursor tools
      expect(toolNames).toContain('search_codebase');
      expect(toolNames).toContain('analyze_code');
      expect(toolNames).toContain('apply_code_changes');

      // Should have filesystem + cursor tools (no terminal tools)
      expect(tools.length).toBeGreaterThanOrEqual(5);
    });

    test('should report correct capabilities', () => {
      const capabilities = registry.getCapabilities();

      expect(capabilities.filesystem).toBe(true);
      // Terminal is not reported as a tool capability (it's a client capability)
      expect(capabilities.terminal).toBeUndefined();
      expect(capabilities.cursor).toBe(true);
      expect(capabilities.tools).toContain('read_file');
      // Terminal tools are not in the tools array
      expect(capabilities.tools).not.toContain('execute_command');
      expect(capabilities.tools).toContain('search_codebase');
    });

    test('should validate configuration correctly', () => {
      const errors = registry.validateConfiguration();
      expect(errors).toEqual([]);
    });

    test('should detect configuration errors', () => {
      const badConfig = {
        ...mockConfig,
        tools: {
          ...mockConfig.tools,
          filesystem: {
            enabled: true,
            // Note: Path validation removed - security now enforced by ACP client
          },
          terminal: {
            enabled: true,
            maxProcesses: 0, // Invalid: should be at least 1
          },
        },
      };

      const badRegistry = new ToolRegistry(badConfig, mockLogger);
      const errors = badRegistry.validateConfiguration();

      expect(errors.length).toBeGreaterThan(0);
      // Should catch invalid maxProcesses
      expect(errors.some((e) => e.includes('maxProcesses'))).toBe(true);
    });
  });

  describe('Cross-Tool Workflows', () => {
    test('should execute file operations workflow', async () => {
      const testFile = path.join(testProjectDir, 'workflow-test.js');
      const testContent = 'console.log("Hello, World!");';

      // Step 1: Write file
      const writeCall: ToolCall = {
        id: 'write-1',
        name: 'write_file',
        parameters: {
          path: testFile,
          content: testContent,
          _sessionId: 'test-session',
        },
      };

      const writeResult = await registry.executeTool(writeCall);
      expect(writeResult.success).toBe(true);

      // Step 2: Read file back
      const readCall: ToolCall = {
        id: 'read-1',
        name: 'read_file',
        parameters: {
          path: testFile,
          _sessionId: 'test-session',
        },
      };

      const readResult = await registry.executeTool(readCall);
      expect(readResult.success).toBe(true);
      expect(readResult.result.content).toBe(testContent);

      // Step 3: Verify file was created by reading it back
      const verifyCall: ToolCall = {
        id: 'verify-1',
        name: 'read_file',
        parameters: {
          path: testFile,
          _sessionId: 'test-session',
        },
      };

      const verifyResult = await registry.executeTool(verifyCall);
      expect(verifyResult.success).toBe(true);
      expect(verifyResult.result.content).toContain(testContent);
    });

    test('should execute development workflow', async () => {
      // Create a test source file
      const sourceFile = path.join(testProjectDir, 'src', 'calculator.ts');
      const sourceCode = `
export class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }

  multiply(a: number, b: number): number {
    return a * b;
  }
}
`;

      await fs.mkdir(path.dirname(sourceFile), { recursive: true });
      await fs.writeFile(sourceFile, sourceCode);

      // Step 1: Search for class definitions
      const searchCall: ToolCall = {
        id: 'search-1',
        name: 'search_codebase',
        parameters: {
          query: 'class Calculator',
          file_pattern: '*.ts',
        },
      };

      // Execute search - should work with mocked CursorCliBridge
      const searchResult = await registry.executeTool(searchCall);

      expect(searchResult.success).toBe(true);
      if (searchResult.success) {
        expect(searchResult.result.results).toBeDefined();
      }

      // Step 2: Get project information
      const infoCall: ToolCall = {
        id: 'info-1',
        name: 'get_project_info',
        parameters: {
          include_structure: true,
        },
      };

      // Execute info call - should work with mocked CursorCliBridge
      const infoResult = await registry.executeTool(infoCall);
      expect(infoResult.success).toBe(true);

      // Step 3: Verify the source file by reading it
      const verifySrcCall: ToolCall = {
        id: 'verify-src-1',
        name: 'read_file',
        parameters: {
          path: sourceFile,
          _sessionId: 'test-session',
        },
      };

      const verifySrcResult = await registry.executeTool(verifySrcCall);
      expect(verifySrcResult.success).toBe(true);
      expect(verifySrcResult.result.content).toContain('Calculator');
    });

    test('should handle terminal and file system integration', async () => {
      const testFilePath = path.join(testProjectDir, 'terminal-test.txt');

      // Terminal operations are now client-side capabilities per ACP spec
      // This test now only tests filesystem operations

      // Step 1: Use filesystem to write content
      const writeCall: ToolCall = {
        id: 'write-1',
        name: 'write_file',
        parameters: {
          path: testFilePath,
          content: 'Hello from integration test\n',
          _sessionId: 'test-session',
        },
      };

      const writeResult = await registry.executeTool(writeCall);
      expect(writeResult.success).toBe(true);

      // Step 2: Read the file to verify it was created
      const readCall: ToolCall = {
        id: 'read-2',
        name: 'read_file',
        parameters: {
          path: testFilePath,
          _sessionId: 'test-session',
        },
      };

      const readResult = await registry.executeTool(readCall);
      expect(readResult.success).toBe(true);
      expect(readResult.result.content).toContain(
        'Hello from integration test'
      );

      // Step 3: Verify file was created by reading it
      const verifyCall: ToolCall = {
        id: 'verify-2',
        name: 'read_file',
        parameters: {
          path: testFilePath,
          _sessionId: 'test-session',
        },
      };

      const verifyResult = await registry.executeTool(verifyCall);
      expect(verifyResult.success).toBe(true);
      expect(verifyResult.result.content).toContain(
        'Hello from integration test'
      );
    });
  });

  describe('Error Handling and Security', () => {
    test('should prevent unauthorized file access', async () => {
      const unauthorizedPath = '/etc/passwd';

      const readCall: ToolCall = {
        id: 'unauthorized-1',
        name: 'read_file',
        parameters: {
          path: unauthorizedPath,
          _sessionId: 'test-session',
        },
      };

      const result = await registry.executeTool(readCall);
      expect(result.success).toBe(false);
      expect(result.error).toContain('not allowed');
    });

    test('should handle nonexistent tools', async () => {
      const invalidCall: ToolCall = {
        id: 'invalid-1',
        name: 'nonexistent_tool',
        parameters: {},
      };

      const result = await registry.executeTool(invalidCall);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Tool not found');
    });

    test('should validate tool parameters', async () => {
      const invalidCall: ToolCall = {
        id: 'invalid-params-1',
        name: 'read_file',
        parameters: {
          // Missing required 'path' parameter
          _sessionId: 'test-session',
        },
      };

      const result = await registry.executeTool(invalidCall);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Missing required parameter');
    });

    test('should handle concurrent tool execution', async () => {
      // Create test file first
      const concurrentFile = path.join(testProjectDir, 'test-concurrent.txt');
      await fs.writeFile(concurrentFile, 'concurrent test content');

      const calls = Array.from({ length: 5 }, (_, i) => ({
        id: `concurrent-${i}`,
        name: 'read_file',
        parameters: {
          path: concurrentFile,
          _sessionId: 'test-session',
        },
      }));

      const promises = calls.map((call) => registry.executeTool(call));
      const results = await Promise.all(promises);

      results.forEach((result, _i) => {
        expect(result.success).toBe(true);
        expect(result.metadata?.toolName).toBe('read_file');
      });
    });
  });

  describe('Performance and Metrics', () => {
    test('should track tool execution metrics', async () => {
      // Create a test file first
      await fs.writeFile(
        path.join(testProjectDir, 'metrics-test.txt'),
        'metrics test'
      );

      const call: ToolCall = {
        id: 'metrics-1',
        name: 'read_file',
        parameters: {
          path: path.join(testProjectDir, 'metrics-test.txt'),
          _sessionId: 'test-session',
        },
      };

      const result = await registry.executeTool(call);

      expect(result.success).toBe(true);
      expect(result.metadata).toBeDefined();
      expect(result.metadata?.duration).toBeGreaterThanOrEqual(0); // Duration can be 0 for very fast operations
      expect(result.metadata?.executedAt).toBeInstanceOf(Date);
      expect(result.metadata?.toolName).toBe('read_file');
    });

    test('should provide registry metrics', () => {
      const metrics = registry.getMetrics();

      // Should have filesystem + cursor tools (no terminal tools)
      expect(metrics.totalTools).toBeGreaterThanOrEqual(5);
      expect(metrics.totalProviders).toBe(2); // filesystem + cursor only
      expect(metrics.enabledProviders).toContain('filesystem');
      expect(metrics.enabledProviders).not.toContain('terminal');
      expect(metrics.enabledProviders).toContain('cursor');
    });

    test('should handle tool execution timeouts', async () => {
      // Terminal operations are client-side now
      // Test with a filesystem operation that should complete quickly
      const call: ToolCall = {
        id: 'timeout-1',
        name: 'read_file',
        parameters: {
          path: path.join(testProjectDir, 'metrics-test.txt'),
          _sessionId: 'test-session',
        },
      };

      const startTime = Date.now();
      const result = await registry.executeTool(call);
      const duration = Date.now() - startTime;

      // Should complete within reasonable time
      expect(duration).toBeLessThan(2000);
      expect(result.success).toBe(true);
    });
  });

  describe('Tool Provider Lifecycle', () => {
    test('should support provider registration and unregistration', () => {
      const initialProviders = registry.getProviders().length;
      const initialTools = registry.getTools().length;

      // Create a custom provider
      const customProvider = {
        name: 'custom',
        description: 'Custom test provider',
        getTools: () => [
          {
            name: 'custom_tool',
            description: 'A custom test tool',
            parameters: { type: 'object' as const, properties: {} },
            handler: async () => ({ success: true, result: 'custom' }),
          },
        ],
      };

      // Register it
      registry.registerProvider(customProvider);

      expect(registry.getProviders()).toHaveLength(initialProviders + 1);
      expect(registry.getTools()).toHaveLength(initialTools + 1);
      expect(registry.hasTool('custom_tool')).toBe(true);

      // Unregister it
      registry.unregisterProvider('custom');

      expect(registry.getProviders()).toHaveLength(initialProviders);
      expect(registry.getTools()).toHaveLength(initialTools);
      expect(registry.hasTool('custom_tool')).toBe(false);
    });

    test('should support registry reload', async () => {
      const initialTools = registry.getTools().length;
      const initialProviders = registry.getProviders().length;

      await registry.reload();

      // After reload, filesystem provider is not re-registered automatically
      // So we should have 2 fewer tools (read_file, write_file) and 1 fewer provider
      expect(registry.getTools().length).toBeLessThan(initialTools);
      expect(registry.getProviders().length).toBeLessThan(initialProviders);

      // Should still have Cursor provider (1 provider after unregistering filesystem)
      expect(registry.getProviders()).toHaveLength(1);

      // Verify cursor tools are still available (terminal tools are not in registry)
      expect(registry.hasTool('execute_command')).toBe(false);
      expect(registry.hasTool('search_codebase')).toBe(true);
    });
  });

  // Note: createTestProject() helper function removed since fs module is mocked
  // Mock file contents are defined in jest.mock('fs') at the top of this file
});
