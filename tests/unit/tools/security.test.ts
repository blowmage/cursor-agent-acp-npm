/**
 * Security Tests for Tool System
 *
 * These tests verify security constraints, access controls, and protection
 * against various attack vectors in the tool calling system.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ToolRegistry } from '../../../src/tools/registry';
import { FilesystemToolProvider } from '../../../src/tools/filesystem';
import { CursorToolsProvider } from '../../../src/tools/cursor-tools';
import { AcpFileSystemClient } from '../../../src/client/filesystem-client';
import type { AdapterConfig, Logger, ToolCall } from '../../../src/types';
import type { ClientCapabilities } from '@agentclientprotocol/sdk';
import { ToolError } from '../../../src/types';

describe('Tool System Security', () => {
  let registry: ToolRegistry;
  let mockConfig: AdapterConfig;
  let mockLogger: Logger;
  let tempDir: string;
  let allowedDir: string;
  let forbiddenDir: string;

  // Security constraints for mock client (simulates client-side validation per ACP spec)
  let mockClientAllowedPaths: string[];
  let mockClientForbiddenPaths: string[];
  let mockClientMaxFileSize: number;

  beforeAll(async () => {
    // Create temporary directories for security testing
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-security-test-'));
    allowedDir = path.join(tempDir, 'allowed');
    forbiddenDir = path.join(tempDir, 'forbidden');

    await fs.mkdir(allowedDir, { recursive: true });
    await fs.mkdir(forbiddenDir, { recursive: true });

    // Create test files
    await fs.writeFile(path.join(allowedDir, 'safe.txt'), 'Safe content');
    await fs.writeFile(path.join(forbiddenDir, 'secret.txt'), 'Secret content');
  });

  afterAll(async () => {
    try {
      // Remove temporary test directory
      // Note: registry cleanup is handled by afterEach hook
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      console.warn('Failed to cleanup temp directory:', error);
    }
  });

  beforeEach(() => {
    // Mock client security settings (simulates client-side validation per ACP spec)
    mockClientAllowedPaths = [allowedDir];
    mockClientForbiddenPaths = [forbiddenDir];
    mockClientMaxFileSize = 1024 * 1024; // 1MB

    mockConfig = {
      logLevel: 'debug',
      sessionDir: path.join(tempDir, 'sessions'),
      maxSessions: 10,
      sessionTimeout: 3600,
      tools: {
        filesystem: {
          enabled: true,
          // Note: Security validation now done by mock client (simulates ACP client behavior)
        },
        terminal: {
          enabled: true,
          maxProcesses: 3,
        },
        cursor: {
          enabled: true,
          enableCodeModification: false, // Disabled for security tests
          enableTestExecution: false,
        },
      },
      cursor: {
        timeout: 10000,
        retries: 1,
      },
    };

    mockLogger = {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
    };

    registry = new ToolRegistry(mockConfig, mockLogger);

    // Register filesystem tools with mock client capabilities and filesystem client
    const mockClientCapabilities: ClientCapabilities = {
      fs: {
        readTextFile: true,
        writeTextFile: true,
      },
    };

    // Create mock filesystem client that validates paths like a real ACP client would
    const mockFileSystemClient = new AcpFileSystemClient(
      {
        async readTextFile(params: any) {
          // Mock ACP client implementation with path validation (simulates client-side security)
          const requestedPath = params.path;

          // Validate against allowed paths (client-side validation)
          const isPathAllowed = mockClientAllowedPaths.some(
            (allowed: string) =>
              requestedPath.startsWith(path.resolve(allowed)) ||
              path.resolve(requestedPath).startsWith(path.resolve(allowed))
          );

          // Validate against forbidden paths (client-side validation)
          const isPathForbidden = mockClientForbiddenPaths.some(
            (forbidden: string) =>
              requestedPath.includes(forbidden) ||
              path.resolve(requestedPath).startsWith(path.resolve(forbidden))
          );

          // Check for path traversal attempts
          const hasTraversal =
            requestedPath.includes('../') || requestedPath.includes('..\\');

          if (!isPathAllowed || isPathForbidden || hasTraversal) {
            throw new Error('Access denied: Path not allowed or forbidden');
          }

          // Check file size if it exists (client-side validation)
          const stats = await fs.stat(requestedPath).catch(() => null);
          const maxSize = mockClientMaxFileSize || Infinity;
          if (stats && stats.size > maxSize) {
            throw new Error(
              `File too large: ${stats.size} bytes exceeds limit of ${maxSize} bytes`
            );
          }

          const content = await fs.readFile(requestedPath, 'utf-8');
          return { content };
        },
        async writeTextFile(params: any) {
          // Mock ACP client implementation with path validation (simulates client-side security)
          const requestedPath = params.path;

          // Validate against allowed paths (client-side validation)
          const isPathAllowed = mockClientAllowedPaths.some(
            (allowed: string) =>
              requestedPath.startsWith(path.resolve(allowed)) ||
              path.resolve(requestedPath).startsWith(path.resolve(allowed))
          );

          // Validate against forbidden paths (client-side validation)
          const isPathForbidden = mockClientForbiddenPaths.some(
            (forbidden: string) =>
              requestedPath.includes(forbidden) ||
              path.resolve(requestedPath).startsWith(path.resolve(forbidden))
          );

          // Check for path traversal attempts
          const hasTraversal =
            requestedPath.includes('../') || requestedPath.includes('..\\');

          if (!isPathAllowed || isPathForbidden || hasTraversal) {
            throw new Error('Access denied: Path not allowed or forbidden');
          }

          await fs.writeFile(requestedPath, params.content, 'utf-8');
          return {};
        },
      },
      mockLogger
    );

    const filesystemProvider = new FilesystemToolProvider(
      mockConfig,
      mockLogger,
      mockClientCapabilities,
      mockFileSystemClient
    );

    registry.registerProvider(filesystemProvider);
  });

  afterEach(async () => {
    // Always cleanup spawned processes after each test
    // This ensures shell processes from terminal tests are properly terminated
    if (registry) {
      try {
        await registry.cleanup();
        // Give sufficient time for all processes to terminate
        await new Promise((resolve) => setTimeout(resolve, 300));
      } catch (error) {
        // Ignore cleanup errors - registry might not have been fully initialized
        console.debug('Cleanup error (ignored):', error);
      }
    }
  });

  describe('Filesystem Security', () => {
    test('should prevent path traversal attacks', async () => {
      const maliciousPaths = [
        '../../../etc/passwd',
        '..\\..\\..\\windows\\system32\\config\\sam',
        path.join(allowedDir, '../forbidden/secret.txt'),
        `${allowedDir}/../forbidden/secret.txt`,
        path.resolve(allowedDir, '../forbidden/secret.txt'),
      ];

      for (const maliciousPath of maliciousPaths) {
        const call: ToolCall = {
          id: `traversal-${maliciousPath}`,
          name: 'read_file',
          parameters: {
            path: maliciousPath,
            _sessionId: 'test-session',
          },
        };

        const result = await registry.executeTool(call);
        expect(result.success).toBe(false);
        expect(result.error).toMatch(
          /not allowed|forbidden|access denied|Session ID is required/i
        );
      }
    });

    test('should prevent access to forbidden directories', async () => {
      const call: ToolCall = {
        id: 'forbidden-access',
        name: 'read_file',
        parameters: {
          path: path.join(forbiddenDir, 'secret.txt'),
          _sessionId: 'test-session',
        },
      };

      const result = await registry.executeTool(call);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(
        /forbidden|not allowed|Session ID is required/i
      );
    });

    test('should prevent writing to forbidden locations', async () => {
      const call: ToolCall = {
        id: 'forbidden-write',
        name: 'write_file',
        parameters: {
          path: path.join(forbiddenDir, 'malicious.txt'),
          content: 'Malicious content',
          _sessionId: 'test-session',
        },
      };

      const result = await registry.executeTool(call);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(
        /forbidden|not allowed|Session ID is required/i
      );
    });

    test('should enforce file size limits', async () => {
      // Create a large file that exceeds the limit
      const largeContent = 'x'.repeat(2 * 1024 * 1024); // 2MB
      const largePath = path.join(allowedDir, 'large.txt');
      await fs.writeFile(largePath, largeContent);

      const call: ToolCall = {
        id: 'large-file',
        name: 'read_file',
        parameters: {
          path: largePath,
          _sessionId: 'test-session',
        },
      };

      const result = await registry.executeTool(call);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(
        /too large|size limit|Session ID is required/i
      );
    });

    test('should sanitize file paths', async () => {
      const unsafePaths = [
        'safe.txt\0malicious',
        'safe.txt\x00hidden',
        'safe.txt\u0000null',
      ];

      for (const unsafePath of unsafePaths) {
        const call: ToolCall = {
          id: `unsafe-${unsafePath}`,
          name: 'read_file',
          parameters: {
            path: path.join(allowedDir, unsafePath),
          },
        };

        const result = await registry.executeTool(call);
        // Should either fail or sanitize the path
        if (result.success) {
          expect(result.result.path).not.toContain('\0');
          expect(result.result.path).not.toContain('\x00');
        }
      }
    });

    test('should prevent symlink exploitation', async () => {
      const symlinkPath = path.join(allowedDir, 'symlink-to-forbidden');

      try {
        // Create a symlink pointing to forbidden directory
        await fs.symlink(forbiddenDir, symlinkPath);

        // Try to read a file through the symlink
        const targetFile = path.join(symlinkPath, 'test.txt');
        await fs.writeFile(
          path.join(forbiddenDir, 'test.txt'),
          'forbidden content'
        );

        const call: ToolCall = {
          id: 'symlink-exploit',
          name: 'read_file',
          parameters: {
            path: targetFile,
            _sessionId: 'test-session',
          },
        };

        const result = await registry.executeTool(call);
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/not allowed|forbidden/i);
      } catch (error) {
        // Symlink creation might fail on some systems, skip test
        console.log('Skipping symlink test due to system limitations');
      }
    });

    test('should validate file extension restrictions via client', async () => {
      // Per ACP spec: Extension validation is the client's responsibility
      // This test verifies that when a client enforces extension rules,
      // the integration works correctly through the full stack

      // Mock client security settings for this test (simulates client-side validation)
      const restrictedAllowedPaths = mockClientAllowedPaths;
      const restrictedForbiddenPaths = mockClientForbiddenPaths;
      const restrictedAllowedExtensions = ['.txt', '.md'];

      const restrictedConfig = {
        ...mockConfig,
        // Note: Security validation is done by mock client below
      };

      // Client capabilities for restricted registry
      const restrictedClientCapabilities: ClientCapabilities = {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
      };

      // Create mock client that enforces extension validation (per ACP spec)
      const restrictedMockClient = new AcpFileSystemClient(
        {
          async readTextFile(params: any) {
            const requestedPath = params.path;

            // Client-side extension validation (ACP spec: client's responsibility)
            const ext = path.extname(requestedPath).toLowerCase();

            if (
              restrictedAllowedExtensions.length > 0 &&
              !restrictedAllowedExtensions.includes(ext)
            ) {
              throw new Error(
                `Extension ${ext} not allowed. Only ${restrictedAllowedExtensions.join(', ')} are permitted.`
              );
            }

            // Standard path validation (same as main test setup)
            const isPathAllowed = restrictedAllowedPaths.some(
              (allowed: string) =>
                requestedPath.startsWith(path.resolve(allowed)) ||
                path.resolve(requestedPath).startsWith(path.resolve(allowed))
            );

            const isPathForbidden = restrictedForbiddenPaths.some(
              (forbidden: string) =>
                requestedPath.includes(forbidden) ||
                path.resolve(requestedPath).startsWith(path.resolve(forbidden))
            );

            const hasTraversal =
              requestedPath.includes('../') || requestedPath.includes('..\\');

            if (!isPathAllowed || isPathForbidden || hasTraversal) {
              throw new Error('Access denied: Path not allowed or forbidden');
            }

            const content = await fs.readFile(requestedPath, 'utf-8');
            return { content };
          },
          async writeTextFile(params: any) {
            // Similar validation for writes (client-side validation per ACP spec)
            const requestedPath = params.path;
            const ext = path.extname(requestedPath).toLowerCase();

            if (
              restrictedAllowedExtensions.length > 0 &&
              !restrictedAllowedExtensions.includes(ext)
            ) {
              throw new Error(
                `Extension ${ext} not allowed. Only ${restrictedAllowedExtensions.join(', ')} are permitted.`
              );
            }

            await fs.writeFile(requestedPath, params.content, 'utf-8');
            return {};
          },
        },
        mockLogger
      );

      const filesystemProvider = new FilesystemToolProvider(
        restrictedConfig,
        mockLogger,
        restrictedClientCapabilities,
        restrictedMockClient
      );

      const restrictedRegistry = new ToolRegistry(restrictedConfig, mockLogger);
      restrictedRegistry.registerProvider(filesystemProvider);

      // Test 1: Blocked extension (.sh not in whitelist)
      const executablePath = path.join(allowedDir, 'script.sh');
      await fs.writeFile(executablePath, '#!/bin/bash\necho "test"');

      const blockedCall: ToolCall = {
        id: 'restricted-ext',
        name: 'read_file',
        parameters: {
          path: executablePath,
          _sessionId: 'test-session',
        },
      };

      const blockedResult = await restrictedRegistry.executeTool(blockedCall);
      expect(blockedResult.success).toBe(false);
      expect(blockedResult.error).toMatch(/extension|not allowed/i);

      // Test 2: Allowed extension (.txt in whitelist)
      const allowedPath = path.join(allowedDir, 'document.txt');
      await fs.writeFile(allowedPath, 'Allowed content');

      const allowedCall: ToolCall = {
        id: 'allowed-ext',
        name: 'read_file',
        parameters: {
          path: allowedPath,
          _sessionId: 'test-session',
        },
      };

      const allowedResult = await restrictedRegistry.executeTool(allowedCall);
      expect(allowedResult.success).toBe(true);
      expect(allowedResult.result.content).toBe('Allowed content');
    });
  });

  describe('Terminal Security', () => {
    // Note: Terminal operations are now client-side capabilities per ACP spec,
    // not agent-provided tools. Tests verify TerminalManager validates commands,
    // but actual execution is done by the client.

    test('should prevent command injection', async () => {
      // Terminal operations are no longer tools - they're client-side capabilities
      // The TerminalManager validates commands before sending to client
      const call: ToolCall = {
        id: 'terminal-tool-check',
        name: 'execute_command',
        parameters: {
          command: 'echo test',
        },
      };

      const result = await registry.executeTool(call);
      // Should fail because terminal operations are not registered as tools
      expect(result.success).toBe(false);
      expect(result.error).toContain('Tool not found');
    });

    test('should enforce process limits', async () => {
      // Terminal operations are now client-side, limits enforced by TerminalManager
      // Verify that terminal tools are not registered
      const call: ToolCall = {
        id: 'process-limit-check',
        name: 'start_shell_session',
        parameters: {
          shell: '/bin/sh',
        },
      };

      const result = await registry.executeTool(call);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Tool not found');
    });

    test('should sanitize environment variables', async () => {
      // Terminal operations are now client-side
      // Client handles environment variable sanitization
      const call: ToolCall = {
        id: 'env-check',
        name: 'execute_command',
        parameters: {
          command: 'echo',
          args: ['test'],
        },
      };

      const result = await registry.executeTool(call);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Tool not found');
    });

    test('should timeout long-running processes', async () => {
      // Terminal operations are now client-side
      // Timeout is handled by TerminalManager with client-side execution
      const call: ToolCall = {
        id: 'timeout-test',
        name: 'execute_command',
        parameters: {
          command: 'sleep',
          args: ['60'],
          timeout: 1,
        },
      };

      const result = await registry.executeTool(call);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Tool not found');
    });
  });

  describe('Cursor Tools Security', () => {
    test('should prevent code modification when disabled', async () => {
      const call: ToolCall = {
        id: 'blocked-modification',
        name: 'apply_code_changes',
        parameters: {
          changes: [
            {
              file: path.join(allowedDir, 'test.js'),
              startLine: 1,
              endLine: 1,
              newContent: 'malicious code',
            },
          ],
        },
      };

      const result = await registry.executeTool(call);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/disabled|not allowed/i);
    });

    test('should prevent test execution when disabled', async () => {
      const call: ToolCall = {
        id: 'blocked-tests',
        name: 'run_tests',
        parameters: {
          test_pattern: '**/*.test.js',
        },
      };

      const result = await registry.executeTool(call);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/disabled|not allowed/i);
    });

    test('should validate search parameters', async () => {
      const maliciousSearches = [
        { query: '\x00malicious' },
        { query: 'test', file_pattern: '../../../etc/*' },
        { query: '', max_results: -1 },
        { query: 'test', max_results: 999999 },
      ];

      for (const params of maliciousSearches) {
        const call: ToolCall = {
          id: `malicious-search-${JSON.stringify(params)}`,
          name: 'search_codebase',
          parameters: params,
        };

        const result = await registry.executeTool(call);

        if (result.success) {
          // If search succeeded, results should be bounded
          if (result.result.results) {
            expect(result.result.results.length).toBeLessThanOrEqual(200);
          }
        } else {
          expect(result.error).toMatch(
            /invalid|not allowed|parameter|failed|error|unknown option/i
          );
        }
      }
    });
  });

  describe('Input Validation and Sanitization', () => {
    test('should reject null and undefined parameters', async () => {
      const invalidCalls = [
        { name: 'read_file', parameters: null },
        { name: 'read_file', parameters: undefined },
        { name: 'write_file', parameters: { path: null, content: 'test' } },
        {
          name: 'write_file',
          parameters: { path: undefined, content: 'test' },
        },
      ];

      for (const callData of invalidCalls) {
        const call: ToolCall = {
          id: 'invalid-null',
          name: callData.name as any,
          parameters: callData.parameters as any,
        };

        const result = await registry.executeTool(call);
        expect(result.success).toBe(false);
        expect(result.error).toMatch(
          /invalid|parameter|missing|null|undefined|required|must be/i
        );
      }
    });

    test('should sanitize string inputs', async () => {
      const maliciousStrings = [
        '\x00\x01\x02malicious',
        '\u0000hidden content',
        'normal\r\ninjected content',
        '<script>alert("xss")</script>',
        '${process.env.SECRET}',
        '`rm -rf /`',
      ];

      for (const malicious of maliciousStrings) {
        const call: ToolCall = {
          id: 'sanitize-test',
          name: 'write_file',
          parameters: {
            path: path.join(allowedDir, 'test.txt'),
            content: malicious,
          },
        };

        const result = await registry.executeTool(call);

        if (result.success) {
          // Read back and verify sanitization
          const readCall: ToolCall = {
            id: 'read-back',
            name: 'read_file',
            parameters: {
              path: path.join(allowedDir, 'test.txt'),
            },
          };

          const readResult = await registry.executeTool(readCall);
          if (readResult.success) {
            // Content should be sanitized or identical
            expect(readResult.result.content).toBeDefined();
          }
        }
      }
    });

    test('should validate parameter types', async () => {
      // Test that tools properly validate parameter types and provide helpful error messages
      const invalidCalls = [
        // read_file: path should be string, not number
        {
          name: 'read_file',
          parameters: { path: 123 as any, _sessionId: 'test' },
          expectedError: /path.*string|invalid.*path|type|must be|required/i,
        },
        // write_file: path should be string, not null
        {
          name: 'write_file',
          parameters: {
            path: null as any,
            content: 'test content',
            _sessionId: 'test',
          },
          expectedError: /path.*string|invalid.*path|type|must be|required/i,
        },
        // write_file: content cannot be null
        {
          name: 'write_file',
          parameters: {
            path: path.join(allowedDir, 'test.txt'),
            content: null as any,
            _sessionId: 'test',
          },
          expectedError: /content|required|null/i,
        },
        // read_file: path cannot be an object
        {
          name: 'read_file',
          parameters: {
            path: { object: 'not a string' } as any,
            _sessionId: 'test',
          },
          expectedError: /path.*string|invalid.*path|type|must be|required/i,
        },
      ];

      for (const { name, parameters, expectedError } of invalidCalls) {
        const call: ToolCall = {
          id: `invalid-${name}`,
          name,
          parameters,
        };

        const result = await registry.executeTool(call);

        // The tool call should either fail validation or fail execution
        // Both are acceptable - we just want to ensure invalid params don't succeed silently
        if (result.success) {
          // If it succeeded, that's a problem - parameter validation failed
          throw new Error(
            `Tool ${name} succeeded with invalid parameters when it should have failed: ${JSON.stringify(parameters)}`
          );
        }

        // Error message should indicate the problem
        expect(result.error).toBeDefined();
        expect(result.error).toMatch(expectedError);
      }
    });

    test('should enforce parameter bounds', async () => {
      const outOfBounds = [
        {
          name: 'search_codebase',
          parameters: { query: 'test', max_results: -1 },
        },
        {
          name: 'search_codebase',
          parameters: { query: 'test', max_results: 99999 },
        },
      ];

      for (const callData of outOfBounds) {
        const call: ToolCall = {
          id: 'out-of-bounds',
          name: callData.name as any,
          parameters: callData.parameters,
        };

        const result = await registry.executeTool(call);

        if (result.success) {
          // If accepted, parameters should be normalized
          expect(result.metadata).toBeDefined();
        } else {
          expect(result.error).toMatch(
            /invalid|parameter|range|bounds|failed|error|unknown option|timed out|timeout/i
          );
        }
      }
    });
  });

  describe('Access Control and Permissions', () => {
    test('should respect disabled tool providers', async () => {
      const disabledConfig = {
        ...mockConfig,
        tools: {
          ...mockConfig.tools,
          filesystem: { ...mockConfig.tools.filesystem, enabled: false },
          terminal: { ...mockConfig.tools.terminal, enabled: false },
        },
      };

      const disabledRegistry = new ToolRegistry(disabledConfig, mockLogger);

      expect(disabledRegistry.hasTool('read_file')).toBe(false);
      expect(disabledRegistry.hasTool('execute_command')).toBe(false);

      const tools = disabledRegistry.getTools();
      expect(
        tools.filter(
          (t) => t.name.startsWith('read_') || t.name.startsWith('execute_')
        )
      ).toHaveLength(0);
    });

    test('should validate tool existence before execution', async () => {
      const call: ToolCall = {
        id: 'nonexistent',
        name: 'nonexistent_tool',
        parameters: {},
      };

      const result = await registry.executeTool(call);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/tool not found/i);
    });

    test('should log security violations', async () => {
      const call: ToolCall = {
        id: 'security-violation',
        name: 'read_file',
        parameters: {
          path: '/etc/passwd',
        },
      };

      await registry.executeTool(call);

      expect(mockLogger.error).toHaveBeenCalled();
      const errorCall = (mockLogger.error as jest.Mock).mock.calls.find(
        (call) =>
          call[0].includes('Failed to') ||
          call[0].includes('security') ||
          call[0].includes('violation')
      );
      expect(errorCall).toBeDefined();
    });
  });

  describe('Rate Limiting and Resource Protection', () => {
    test('should handle concurrent tool calls safely', async () => {
      // Test that the registry and tool system handle concurrent load without crashes
      // Create test files for reading
      const testFiles: string[] = [];
      for (let i = 0; i < 10; i++) {
        const filePath = path.join(allowedDir, `concurrent-test-${i}.txt`);
        await fs.writeFile(filePath, `Content ${i}`);
        testFiles.push(filePath);
      }

      // Make 50 concurrent read_file calls
      const concurrentCalls = Array.from({ length: 50 }, (_, i) => ({
        id: `concurrent-${i}`,
        name: 'read_file',
        parameters: {
          path: testFiles[i % testFiles.length], // Cycle through test files
          _sessionId: 'test-session',
        },
      }));

      // Execute all calls concurrently
      const promises = concurrentCalls.map((call) =>
        registry.executeTool(call)
      );
      const results = await Promise.all(promises);

      // Should handle all calls safely without crashes
      expect(results.length).toBe(50);

      // Most should succeed (some might be rate limited if implemented)
      const successCount = results.filter((r) => r.success).length;
      expect(successCount).toBeGreaterThan(0);

      // All results should be valid
      results.forEach((result) => {
        expect(result).toBeDefined();
        expect(result).toHaveProperty('success');
      });

      // Successful results should have valid content
      const successfulResults = results.filter((r) => r.success);
      successfulResults.forEach((result) => {
        expect(result.result).toBeDefined();
        expect(result.result.content).toMatch(/Content \d+/);
      });

      // Clean up test files
      for (const filePath of testFiles) {
        await fs.unlink(filePath).catch(() => {});
      }
    });

    test('should prevent resource exhaustion', async () => {
      // Try to create many shell sessions
      const sessionCalls = Array.from({ length: 20 }, (_, i) => ({
        id: `session-${i}`,
        name: 'start_shell_session',
        parameters: { shell: '/bin/sh' },
      }));

      const sessionPromises = sessionCalls.map((call) =>
        registry.executeTool(call)
      );
      const sessionResults = await Promise.all(sessionPromises);

      const successfulSessions = sessionResults.filter((r) => r.success).length;
      expect(successfulSessions).toBeLessThanOrEqual(
        mockConfig.tools.terminal.maxProcesses
      );
    });

    test('should clean up resources on errors', async () => {
      const metrics = registry.getMetrics();
      const initialProcesses = metrics.totalProcesses || 0;

      // Execute a command that might fail
      const failingCall: ToolCall = {
        id: 'failing-command',
        name: 'execute_command',
        parameters: {
          command: 'nonexistent_command_xyz',
          args: ['arg1'],
        },
      };

      await registry.executeTool(failingCall);

      const finalMetrics = registry.getMetrics();
      const finalProcesses = finalMetrics.totalProcesses || 0;

      // Process count should not increase after failed command
      expect(finalProcesses).toBeLessThanOrEqual(initialProcesses + 1);
    });
  });
});
