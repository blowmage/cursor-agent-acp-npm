/**
 * Unit tests for CursorToolsProvider
 *
 * Tests the cursor-specific tools for code analysis, search, modification,
 * and project management functionality.
 */

import { jest } from '@jest/globals';
import { CursorToolsProvider } from '../../../src/tools/cursor-tools';
import { CursorCliBridge } from '../../../src/cursor/cli-bridge';
import type { AdapterConfig, Logger } from '../../../src/types';
import { ToolError } from '../../../src/types';
import fs from 'fs/promises';

// Mock the CursorCliBridge to prevent real cursor-agent calls
jest.mock('../../../src/cursor/cli-bridge', () => {
  return {
    CursorCliBridge: jest.fn().mockImplementation(() => {
      return {
        executeCommand: jest.fn(),
        sendPrompt: jest.fn(),
        sendStreamingPrompt: jest.fn(),
        checkConnectivity: jest.fn(),
        authenticate: jest.fn(),
        getAuthStatus: jest.fn(),
        checkAuthentication: jest.fn(),
        getVersion: jest.fn(),
        startInteractiveSession: jest.fn(),
        sendSessionInput: jest.fn(),
        closeSession: jest.fn(),
        getActiveSessions: jest.fn(),
        close: jest.fn(),
      };
    }),
  };
});

describe('CursorToolsProvider', () => {
  let provider: CursorToolsProvider;
  let mockConfig: AdapterConfig;
  let mockLogger: Logger;
  let mockCliBridge: jest.Mocked<CursorCliBridge>;

  beforeEach(() => {
    mockConfig = {
      logLevel: 'debug',
      sessionDir: '/tmp/test-sessions',
      maxSessions: 10,
      sessionTimeout: 3600,
      tools: {
        filesystem: {
          enabled: true,
        },
        terminal: {
          enabled: true,
          maxProcesses: 5,
        },
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
      },
    };

    mockLogger = {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
    };

    mockCliBridge = {
      executeCommand: jest.fn(),
      sendPrompt: jest.fn(),
      sendStreamingPrompt: jest.fn(),
      checkConnectivity: jest.fn(),
      authenticate: jest.fn(),
      getAuthStatus: jest.fn(),
    } as any;

    provider = new CursorToolsProvider(mockConfig, mockLogger, mockCliBridge);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    test('should initialize with default configuration', () => {
      expect(provider.name).toBe('cursor');
      expect(provider.description).toContain('Cursor CLI integration');
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'CursorToolsProvider initialized',
        expect.objectContaining({
          enabled: true,
          projectRoot: undefined,
        })
      );
    });

    test('should handle disabled configuration', () => {
      const disabledConfig = {
        ...mockConfig,
        tools: {
          ...mockConfig.tools,
          cursor: {
            enabled: false,
          },
        },
      };

      const disabledProvider = new CursorToolsProvider(
        disabledConfig,
        mockLogger,
        mockCliBridge
      );

      expect(disabledProvider.getTools()).toEqual([]);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Cursor tools disabled by configuration'
      );
    });
  });

  describe('getTools', () => {
    test('should return all cursor tools when enabled', () => {
      const tools = provider.getTools();

      expect(tools).toHaveLength(6);
      expect(tools.map((t) => t.name)).toEqual([
        'search_codebase',
        'analyze_code',
        'apply_code_changes',
        'run_tests',
        'get_project_info',
        'explain_code',
      ]);
    });

    test('should return empty array when disabled', () => {
      const disabledConfig = {
        ...mockConfig,
        tools: {
          ...mockConfig.tools,
          cursor: {
            enabled: false,
          },
        },
      };

      const disabledProvider = new CursorToolsProvider(
        disabledConfig,
        mockLogger,
        mockCliBridge
      );

      expect(disabledProvider.getTools()).toEqual([]);
    });

    test('should have correct tool schemas', () => {
      const tools = provider.getTools();

      const searchTool = tools.find((t) => t.name === 'search_codebase');
      expect(searchTool).toBeDefined();
      expect(searchTool!.parameters.required).toEqual(['query']);
      expect(searchTool!.parameters.properties.query.type).toBe('string');

      const analyzeTool = tools.find((t) => t.name === 'analyze_code');
      expect(analyzeTool).toBeDefined();
      expect(analyzeTool!.parameters.required).toEqual(['file_path']);

      const applyTool = tools.find((t) => t.name === 'apply_code_changes');
      expect(applyTool).toBeDefined();
      expect(applyTool!.parameters.required).toEqual(['changes']);
    });
  });

  describe('searchCodebase', () => {
    test('should execute search with basic query', async () => {
      const mockResult = {
        success: true,
        stdout: JSON.stringify({
          results: [
            {
              file: 'src/test.ts',
              line: 10,
              column: 5,
              content: 'function test() {',
              context: ['// Some context', '  return true;'],
            },
          ],
        }),
        stderr: '',
        metadata: { executionTime: 150 },
      };

      mockCliBridge.executeCommand.mockResolvedValue(mockResult);

      const tools = provider.getTools();
      const searchTool = tools.find((t) => t.name === 'search_codebase')!;

      const result = await searchTool.handler({
        query: 'function test',
      });

      expect(result.success).toBe(true);
      expect(result.result.query).toBe('function test');
      expect(result.result.results).toHaveLength(1);
      expect(result.result.results[0].file).toBe('src/test.ts');

      expect(mockCliBridge.executeCommand).toHaveBeenCalledWith(
        expect.arrayContaining([
          'cursor-agent',
          'search',
          '--query',
          'function test',
        ])
      );
    });

    test('should handle search with file pattern and case sensitivity', async () => {
      const mockResult = {
        success: true,
        stdout: JSON.stringify({ results: [] }),
        stderr: '',
        metadata: { executionTime: 100 },
      };

      mockCliBridge.executeCommand.mockResolvedValue(mockResult);

      const tools = provider.getTools();
      const searchTool = tools.find((t) => t.name === 'search_codebase')!;

      await searchTool.handler({
        query: 'TestClass',
        file_pattern: '*.ts',
        case_sensitive: true,
        max_results: 20,
      });

      expect(mockCliBridge.executeCommand).toHaveBeenCalledWith([
        'cursor-agent',
        'search',
        '--query',
        'TestClass',
        '--files',
        '*.ts',
        '--case-sensitive',
        '--limit',
        '20',
        '--context',
        '3',
      ]);
    });

    test('should handle search failure', async () => {
      const mockResult = {
        success: false,
        stdout: '',
        stderr: '',
        error: 'Search command failed',
      };

      mockCliBridge.executeCommand.mockResolvedValue(mockResult);

      const tools = provider.getTools();
      const searchTool = tools.find((t) => t.name === 'search_codebase')!;

      const result = await searchTool.handler({
        query: 'nonexistent',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Search failed');
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to search codebase',
        expect.objectContaining({
          query: 'nonexistent',
        })
      );
    });

    test('should parse text-based search results', async () => {
      const mockResult = {
        success: true,
        stdout: `src/file1.ts:10:5:function test() {
src/file1.ts:11:  return true;
src/file2.ts:25:1:const test = () => {`,
        stderr: '',
        metadata: { executionTime: 120 },
      };

      mockCliBridge.executeCommand.mockResolvedValue(mockResult);

      const tools = provider.getTools();
      const searchTool = tools.find((t) => t.name === 'search_codebase')!;

      const result = await searchTool.handler({
        query: 'test',
      });

      expect(result.success).toBe(true);
      expect(result.result.results).toHaveLength(2);
      expect(result.result.results[0]).toEqual({
        file: 'src/file1.ts',
        line: 10,
        column: 5,
        content: 'function test() {',
        context: ['src/file1.ts:11:  return true;'],
      });
    });
  });

  describe('analyzeCode', () => {
    test('should analyze code file', async () => {
      const mockResult = {
        success: true,
        stdout: JSON.stringify({
          structure: {
            functions: ['test', 'helper'],
            classes: ['TestClass'],
            imports: ['fs', 'path'],
          },
          dependencies: ['lodash', '@types/node'],
          metrics: {
            complexity: 3,
            maintainability: 85,
            testCoverage: 92,
          },
        }),
        stderr: '',
        metadata: { executionTime: 500 },
      };

      mockCliBridge.executeCommand.mockResolvedValue(mockResult);

      const tools = provider.getTools();
      const analyzeTool = tools.find((t) => t.name === 'analyze_code')!;

      const result = await analyzeTool.handler({
        file_path: 'src/test.ts',
        analysis_type: 'all',
      });

      expect(result.success).toBe(true);
      expect(result.result.file).toBe('src/test.ts');
      expect(result.result.structure.functions).toContain('test');
      expect(result.result.metrics.complexity).toBe(3);

      expect(mockCliBridge.executeCommand).toHaveBeenCalledWith(
        expect.arrayContaining([
          'cursor-agent',
          'analyze',
          expect.stringContaining('test.ts'),
          '--metrics',
        ])
      );
    });

    test('should handle specific analysis type', async () => {
      const mockResult = {
        success: true,
        stdout: JSON.stringify({
          dependencies: ['react', 'typescript'],
        }),
        stderr: '',
      };

      mockCliBridge.executeCommand.mockResolvedValue(mockResult);

      const tools = provider.getTools();
      const analyzeTool = tools.find((t) => t.name === 'analyze_code')!;

      await analyzeTool.handler({
        file_path: 'src/component.tsx',
        analysis_type: 'dependencies',
        include_metrics: false,
      });

      expect(mockCliBridge.executeCommand).toHaveBeenCalledWith(
        expect.arrayContaining([
          'cursor-agent',
          'analyze',
          expect.stringContaining('component.tsx'),
          '--type',
          'dependencies',
        ])
      );
    });

    test('should handle invalid file path', async () => {
      const tools = provider.getTools();
      const analyzeTool = tools.find((t) => t.name === 'analyze_code')!;

      const result = await analyzeTool.handler({
        file_path: '',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid file path');
    });
  });

  describe('applyCodeChanges', () => {
    test('should apply code changes successfully', async () => {
      const mockResult = {
        success: true,
        stdout: JSON.stringify({
          success: true,
          modified: ['src/test.ts', 'src/helper.ts'],
          errors: [],
        }),
        stderr: '',
        metadata: { executionTime: 800 },
      };

      mockCliBridge.executeCommand.mockResolvedValue(mockResult);

      // Mock fs.writeFile and fs.unlink
      jest.spyOn(fs, 'writeFile').mockResolvedValue(undefined);
      jest.spyOn(fs, 'unlink').mockResolvedValue(undefined);

      const tools = provider.getTools();
      const applyTool = tools.find((t) => t.name === 'apply_code_changes')!;

      const changes = [
        {
          file: 'src/test.ts',
          startLine: 10,
          endLine: 15,
          newContent: 'function updated() {\n  return "new";\n}',
          description: 'Update function implementation',
        },
      ];

      const result = await applyTool.handler({
        changes,
        dry_run: false,
        backup: true,
      });

      expect(result.success).toBe(true);
      expect(result.result.applied).toBe(true);
      expect(result.result.changesCount).toBe(1);

      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('.cursor-changes.json'),
        expect.stringContaining(JSON.stringify(changes, null, 2))
      );

      expect(mockCliBridge.executeCommand).toHaveBeenCalledWith(
        expect.arrayContaining([
          'cursor-agent',
          'apply-changes',
          '--backup',
          '--changes-file',
        ])
      );
    });

    test('should handle dry run mode', async () => {
      const mockResult = {
        success: true,
        stdout: JSON.stringify({
          preview: ['src/test.ts: 5 lines would be changed'],
          errors: [],
        }),
        stderr: '',
      };

      mockCliBridge.executeCommand.mockResolvedValue(mockResult);

      const fs = require('fs/promises');
      jest.spyOn(fs, 'writeFile').mockResolvedValue(undefined);
      jest.spyOn(fs, 'unlink').mockResolvedValue(undefined);

      const tools = provider.getTools();
      const applyTool = tools.find((t) => t.name === 'apply_code_changes')!;

      const result = await applyTool.handler({
        changes: [
          {
            file: 'src/test.ts',
            startLine: 1,
            endLine: 5,
            newContent: 'new content',
          },
        ],
        dry_run: true,
      });

      expect(result.success).toBe(true);
      expect(result.result.applied).toBe(false);

      expect(mockCliBridge.executeCommand).toHaveBeenCalledWith(
        expect.arrayContaining(['cursor-agent', 'apply-changes', '--dry-run'])
      );
    });

    test('should handle disabled code modification', async () => {
      const restrictedConfig = {
        ...mockConfig,
        tools: {
          ...mockConfig.tools,
          cursor: {
            ...mockConfig.tools.cursor!,
            enableCodeModification: false,
          },
        },
      };

      const restrictedProvider = new CursorToolsProvider(
        restrictedConfig,
        mockLogger,
        mockCliBridge
      );

      const tools = restrictedProvider.getTools();
      const applyTool = tools.find((t) => t.name === 'apply_code_changes')!;

      const result = await applyTool.handler({
        changes: [
          {
            file: 'src/test.ts',
            startLine: 1,
            endLine: 1,
            newContent: 'test',
          },
        ],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Code modification is disabled');
    });

    test('should validate changes', async () => {
      const tools = provider.getTools();
      const applyTool = tools.find((t) => t.name === 'apply_code_changes')!;

      const result = await applyTool.handler({
        changes: [
          {
            file: '',
            startLine: -1,
            endLine: 0,
            newContent: 123,
          },
        ],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid changes');
    });
  });

  describe('runTests', () => {
    test('should run tests successfully', async () => {
      const mockResult = {
        success: true,
        stdout: JSON.stringify({
          framework: 'jest',
          tests: [
            {
              file: 'test/example.test.ts',
              suite: 'Example',
              test: 'should work',
              status: 'passed',
              duration: 0.025,
            },
          ],
          summary: {
            total: 15,
            passed: 14,
            failed: 1,
            skipped: 0,
          },
        }),
        stderr: '',
        metadata: { executionTime: 5000 },
      };

      mockCliBridge.executeCommand.mockResolvedValue(mockResult);

      const tools = provider.getTools();
      const testTool = tools.find((t) => t.name === 'run_tests')!;

      const result = await testTool.handler({
        test_pattern: '**/*.test.ts',
        test_framework: 'jest',
        coverage: true,
        timeout: 60,
      });

      expect(result.success).toBe(true);
      expect(result.result.framework).toBe('jest');
      expect(result.result.summary.total).toBe(15);

      expect(mockCliBridge.executeCommand).toHaveBeenCalledWith(
        [
          'cursor-agent',
          'test',
          '--pattern',
          '**/*.test.ts',
          '--framework',
          'jest',
          '--coverage',
          '--timeout',
          '60',
        ],
        { timeout: 60000 }
      );
    });

    test('should handle test failures', async () => {
      const mockResult = {
        success: false,
        stdout: 'FAIL test/broken.test.ts',
        stderr: 'Test execution failed',
        error: 'Tests failed',
      };

      mockCliBridge.executeCommand.mockResolvedValue(mockResult);

      const tools = provider.getTools();
      const testTool = tools.find((t) => t.name === 'run_tests')!;

      const result = await testTool.handler({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Tests failed');
    });

    test('should handle disabled test execution', async () => {
      const restrictedConfig = {
        ...mockConfig,
        tools: {
          ...mockConfig.tools,
          cursor: {
            ...mockConfig.tools.cursor!,
            enableTestExecution: false,
          },
        },
      };

      const restrictedProvider = new CursorToolsProvider(
        restrictedConfig,
        mockLogger,
        mockCliBridge
      );

      const tools = restrictedProvider.getTools();
      const testTool = tools.find((t) => t.name === 'run_tests')!;

      const result = await testTool.handler({});

      expect(result.success).toBe(false);
      expect(result.error).toContain('Test execution is disabled');
    });
  });

  describe('getProjectInfo', () => {
    test('should get complete project information', async () => {
      const mockResult = {
        success: true,
        stdout: JSON.stringify({
          name: 'test-project',
          version: '1.0.0',
          dependencies: {
            react: '^18.0.0',
            typescript: '^5.0.0',
          },
          devDependencies: {
            jest: '^29.0.0',
          },
          scripts: {
            test: 'jest',
            build: 'tsc',
          },
          structure: {
            directories: ['src', 'test', 'dist'],
            files: 42,
          },
        }),
        stderr: '',
        metadata: { executionTime: 200 },
      };

      mockCliBridge.executeCommand.mockResolvedValue(mockResult);

      const tools = provider.getTools();
      const infoTool = tools.find((t) => t.name === 'get_project_info')!;

      const result = await infoTool.handler({
        include_dependencies: true,
        include_scripts: true,
        include_structure: true,
      });

      expect(result.success).toBe(true);
      expect(result.result.name).toBe('test-project');
      expect(result.result.dependencies.react).toBe('^18.0.0');
      expect(result.result.scripts.test).toBe('jest');

      expect(mockCliBridge.executeCommand).toHaveBeenCalledWith([
        'cursor-agent',
        'info',
        '--dependencies',
        '--scripts',
        '--structure',
      ]);
    });

    test('should handle minimal project info request', async () => {
      const mockResult = {
        success: true,
        stdout: JSON.stringify({
          name: 'minimal-project',
          version: '0.1.0',
        }),
        stderr: '',
      };

      mockCliBridge.executeCommand.mockResolvedValue(mockResult);

      const tools = provider.getTools();
      const infoTool = tools.find((t) => t.name === 'get_project_info')!;

      const result = await infoTool.handler({
        include_dependencies: false,
        include_scripts: false,
        include_structure: false,
      });

      expect(result.success).toBe(true);

      expect(mockCliBridge.executeCommand).toHaveBeenCalledWith([
        'cursor-agent',
        'info',
      ]);
    });
  });

  describe('explainCode', () => {
    test('should explain code snippet', async () => {
      const mockResult = {
        success: true,
        stdout: JSON.stringify({
          explanation: 'This function implements a binary search algorithm...',
          complexity: 'O(log n)',
          suggestions: [
            'Consider adding input validation',
            'Add type annotations for better type safety',
          ],
        }),
        stderr: '',
        metadata: { executionTime: 1500 },
      };

      mockCliBridge.executeCommand.mockResolvedValue(mockResult);

      const tools = provider.getTools();
      const explainTool = tools.find((t) => t.name === 'explain_code')!;

      const result = await explainTool.handler({
        file_path: 'src/search.ts',
        start_line: 10,
        end_line: 25,
        explanation_type: 'detailed',
      });

      expect(result.success).toBe(true);
      expect(result.result.file).toBe('src/search.ts');
      expect(result.result.explanation).toContain('binary search');
      expect(result.result.suggestions).toHaveLength(2);

      expect(mockCliBridge.executeCommand).toHaveBeenCalledWith([
        'cursor-agent',
        'explain',
        'src/search.ts',
        '--start-line',
        '10',
        '--end-line',
        '25',
        '--type',
        'detailed',
      ]);
    });

    test('should explain entire file when no line range specified', async () => {
      const mockResult = {
        success: true,
        stdout: JSON.stringify({
          explanation: 'This file contains utility functions...',
          complexity: 'medium',
          suggestions: [],
        }),
        stderr: '',
      };

      mockCliBridge.executeCommand.mockResolvedValue(mockResult);

      const tools = provider.getTools();
      const explainTool = tools.find((t) => t.name === 'explain_code')!;

      await explainTool.handler({
        file_path: 'src/utils.ts',
        explanation_type: 'summary',
      });

      expect(mockCliBridge.executeCommand).toHaveBeenCalledWith([
        'cursor-agent',
        'explain',
        'src/utils.ts',
        '--type',
        'summary',
      ]);
    });
  });

  describe('error handling', () => {
    test('should handle CLI bridge errors gracefully', async () => {
      mockCliBridge.executeCommand.mockRejectedValue(
        new Error('CLI not found')
      );

      const tools = provider.getTools();
      const searchTool = tools.find((t) => t.name === 'search_codebase')!;

      const result = await searchTool.handler({
        query: 'test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('CLI not found');
      expect(mockLogger.error).toHaveBeenCalled();
    });

    test('should handle malformed JSON responses', async () => {
      const mockResult = {
        success: true,
        stdout: 'invalid json {',
        stderr: '',
      };

      mockCliBridge.executeCommand.mockResolvedValue(mockResult);

      const tools = provider.getTools();
      const analyzeTool = tools.find((t) => t.name === 'analyze_code')!;

      const result = await analyzeTool.handler({
        file_path: 'src/test.ts',
      });

      expect(result.success).toBe(true);
      expect(result.result.raw).toBe('invalid json {');
    });
  });
});
