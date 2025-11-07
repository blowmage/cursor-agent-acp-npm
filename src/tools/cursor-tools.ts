/**
 * Cursor-Specific Tool Provider
 *
 * Provides tools that leverage Cursor CLI capabilities for code analysis,
 * search, modification, and project management tasks.
 */

import * as path from 'path';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import {
  ToolError,
  type AdapterConfig,
  type Logger,
  type Tool,
  type ToolProvider,
  type ToolResult,
} from '../types';
import { CursorCliBridge } from '../cursor/cli-bridge';

export interface CursorToolsConfig {
  enabled: boolean;
  projectRoot?: string;
  maxSearchResults?: number;
  enableCodeModification?: boolean;
  enableTestExecution?: boolean;
}

export interface SearchResult {
  file: string;
  line: number;
  column?: number | undefined;
  content: string;
  context?: string[] | undefined;
}

export interface CodeChange {
  file: string;
  startLine: number;
  endLine: number;
  newContent: string;
  description?: string | undefined;
}

export interface TestResult {
  file: string;
  suite: string;
  test: string;
  status: 'passed' | 'failed' | 'skipped';
  duration?: number | undefined;
  error?: string | undefined;
}

export class CursorToolsProvider implements ToolProvider {
  readonly name = 'cursor';
  readonly description =
    'Cursor CLI integration for code analysis and modification';

  // @ts-expect-error - Intentionally unused, reserved for future use
  private _config: AdapterConfig;
  private logger: Logger;
  private cursorConfig: CursorToolsConfig;
  private cliBridge: CursorCliBridge;

  constructor(
    config: AdapterConfig,
    logger: Logger,
    cliBridge?: CursorCliBridge
  ) {
    this._config = config;
    this.logger = logger;
    this.cursorConfig = {
      enabled: true,
      maxSearchResults: 50,
      enableCodeModification: true,
      enableTestExecution: true,
      ...config.tools?.cursor,
    };
    this.cliBridge = cliBridge || new CursorCliBridge(config, logger);

    this.logger.debug('CursorToolsProvider initialized', {
      enabled: this.cursorConfig.enabled,
      projectRoot: this.cursorConfig.projectRoot,
    });
  }

  getTools(): Tool[] {
    if (!this.cursorConfig.enabled) {
      this.logger.debug('Cursor tools disabled by configuration');
      return [];
    }

    return [
      {
        name: 'search_codebase',
        description:
          'Search for code patterns, symbols, or text across the codebase',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query (supports regex patterns)',
            },
            file_pattern: {
              type: 'string',
              description:
                'File pattern to limit search scope (e.g., "*.ts", "src/**")',
            },
            case_sensitive: {
              type: 'boolean',
              description:
                'Whether search should be case sensitive (default: false)',
            },
            include_context: {
              type: 'boolean',
              description:
                'Include surrounding lines as context (default: true)',
            },
            max_results: {
              type: 'number',
              description: 'Maximum number of results to return',
            },
          },
          required: ['query'],
        },
        handler: this.searchCodebase.bind(this),
      },
      {
        name: 'analyze_code',
        description:
          'Analyze code structure, dependencies, and quality metrics',
        parameters: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'Path to the file to analyze',
            },
            analysis_type: {
              type: 'string',
              enum: ['structure', 'dependencies', 'quality', 'all'],
              description: 'Type of analysis to perform',
            },
            include_metrics: {
              type: 'boolean',
              description: 'Include code quality metrics (default: true)',
            },
          },
          required: ['file_path'],
        },
        handler: this.analyzeCode.bind(this),
      },
      {
        name: 'apply_code_changes',
        description: 'Apply code changes to one or more files atomically',
        parameters: {
          type: 'object',
          properties: {
            changes: {
              type: 'array',
              items: {
                type: 'object',
                description:
                  'Code change object with file, startLine, endLine, newContent fields',
              },
              description: 'Array of code changes to apply',
            },
            dry_run: {
              type: 'boolean',
              description:
                'Preview changes without applying them (default: false)',
            },
            backup: {
              type: 'boolean',
              description:
                'Create backup copies before applying changes (default: true)',
            },
          },
          required: ['changes'],
        },
        handler: this.applyCodeChanges.bind(this),
      },
      {
        name: 'run_tests',
        description: "Execute tests using the project's test runner",
        parameters: {
          type: 'object',
          properties: {
            test_pattern: {
              type: 'string',
              description: 'Test file pattern or specific test to run',
            },
            test_framework: {
              type: 'string',
              enum: ['auto', 'jest', 'vitest', 'mocha', 'ava', 'tap'],
              description:
                'Test framework to use (auto-detect if not specified)',
            },
            watch_mode: {
              type: 'boolean',
              description: 'Run tests in watch mode (default: false)',
            },
            coverage: {
              type: 'boolean',
              description: 'Generate code coverage report (default: false)',
            },
            timeout: {
              type: 'number',
              description: 'Test execution timeout in seconds (default: 300)',
            },
          },
        },
        handler: this.runTests.bind(this),
      },
      {
        name: 'get_project_info',
        description:
          'Get information about the current project structure and configuration',
        parameters: {
          type: 'object',
          properties: {
            include_dependencies: {
              type: 'boolean',
              description: 'Include dependency information (default: true)',
            },
            include_scripts: {
              type: 'boolean',
              description:
                'Include available npm/package scripts (default: true)',
            },
            include_structure: {
              type: 'boolean',
              description:
                'Include project directory structure (default: false)',
            },
          },
        },
        handler: this.getProjectInfo.bind(this),
      },
      {
        name: 'explain_code',
        description: 'Get explanations and documentation for code snippets',
        parameters: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'Path to the file containing the code',
            },
            start_line: {
              type: 'number',
              description: 'Starting line number (1-based)',
            },
            end_line: {
              type: 'number',
              description: 'Ending line number (1-based)',
            },
            explanation_type: {
              type: 'string',
              enum: ['summary', 'detailed', 'technical', 'beginner'],
              description: 'Type of explanation to provide',
            },
          },
          required: ['file_path'],
        },
        handler: this.explainCode.bind(this),
      },
    ];
  }

  /**
   * Search the codebase for patterns or text
   */
  private async searchCodebase(
    params: Record<string, any>
  ): Promise<ToolResult> {
    try {
      const query = params['query'];
      const filePattern = params['file_pattern'] || '';
      const caseSensitive = params['case_sensitive'] || false;
      const includeContext = params['include_context'] !== false;
      const maxResults =
        params['max_results'] || this.cursorConfig.maxSearchResults || 50;

      this.logger.debug('Searching codebase', {
        query,
        filePattern,
        caseSensitive,
        maxResults,
      });

      // Build search command
      const searchArgs = ['search'];
      if (query) {
        searchArgs.push('--query', query);
      }
      if (filePattern) {
        searchArgs.push('--files', filePattern);
      }
      if (caseSensitive) {
        searchArgs.push('--case-sensitive');
      }
      if (maxResults) {
        searchArgs.push('--limit', maxResults.toString());
      }
      if (includeContext) {
        searchArgs.push('--context', '3');
      }

      const result = await this.cliBridge.executeCommand([
        'cursor-agent',
        ...searchArgs,
      ]);

      if (!result.success) {
        throw new ToolError(
          `Search failed: ${result.error}`,
          'search_codebase'
        );
      }

      if (!result.stdout) {
        this.logger.warn('Search completed but returned no output');
        return {
          success: true,
          result: {
            query,
            results: [],
            total: 0,
            truncated: false,
          },
        };
      }

      // Parse search results
      const searchResults = this.parseSearchResults(
        result.stdout,
        includeContext
      );

      // Extract locations from search results for tool call reporting
      const locations: Array<{ path: string; line?: number }> = searchResults
        .map((r) => ({
          path: path.resolve(r.file),
          line: r.line,
        }))
        .slice(0, 10); // Limit to first 10 locations

      return {
        success: true,
        result: {
          query,
          results: searchResults,
          total: searchResults.length,
          truncated: searchResults.length >= maxResults,
        },
        metadata: {
          searchTime: result.metadata?.['executionTime'] || 0,
          filePattern,
          caseSensitive,
          locations, // Include locations for tool call reporting
        },
      };
    } catch (error) {
      this.logger.error('Failed to search codebase', {
        error,
        query: params['query'],
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Analyze code structure and quality
   */
  private async analyzeCode(params: Record<string, any>): Promise<ToolResult> {
    try {
      const filePath = params['file_path'];
      const analysisType = params['analysis_type'] || 'all';
      const includeMetrics = params['include_metrics'] !== false;

      this.logger.debug('Analyzing code', { filePath, analysisType });

      // Validate file path
      if (!filePath || typeof filePath !== 'string') {
        throw new ToolError('Invalid file path', 'analyze_code');
      }

      const resolvedPath = path.resolve(filePath);

      // Build analysis command
      const analysisArgs = ['analyze', resolvedPath];
      if (analysisType !== 'all') {
        analysisArgs.push('--type', analysisType);
      }
      if (includeMetrics) {
        analysisArgs.push('--metrics');
      }

      const result = await this.cliBridge.executeCommand([
        'cursor-agent',
        ...analysisArgs,
      ]);

      if (!result.success) {
        throw new ToolError(`Analysis failed: ${result.error}`, 'analyze_code');
      }

      if (!result.stdout) {
        throw new ToolError(
          'Analysis completed but returned no output',
          'analyze_code'
        );
      }

      // Parse analysis results
      const analysis = this.parseAnalysisResults(result.stdout);

      // Include file location for tool call reporting
      const locations: Array<{ path: string; line?: number }> = [
        {
          path: resolvedPath,
        },
      ];

      return {
        success: true,
        result: {
          file: filePath,
          analysisType,
          ...analysis,
        },
        metadata: {
          analysisTime: result.metadata?.['executionTime'] || 0,
          includeMetrics,
          locations, // Include location for tool call reporting
        },
      };
    } catch (error) {
      this.logger.error('Failed to analyze code', {
        error,
        file: params['file_path'],
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Apply code changes atomically
   */
  private async applyCodeChanges(
    params: Record<string, any>
  ): Promise<ToolResult> {
    try {
      if (!this.cursorConfig.enableCodeModification) {
        throw new ToolError(
          'Code modification is disabled',
          'apply_code_changes'
        );
      }

      const changes: CodeChange[] = params['changes'];
      const dryRun = params['dry_run'] || false;
      const backup = params['backup'] !== false;

      this.logger.debug('Applying code changes', {
        changeCount: changes.length,
        dryRun,
        backup,
      });

      // Validate changes
      if (!Array.isArray(changes) || changes.length === 0) {
        throw new ToolError('No changes provided', 'apply_code_changes');
      }

      const validationErrors = this.validateCodeChanges(changes);
      if (validationErrors.length > 0) {
        throw new ToolError(
          `Invalid changes: ${validationErrors.join(', ')}`,
          'apply_code_changes'
        );
      }

      // Read old file contents to create diffs
      // Per ACP SDK: 'diff' is not a ContentBlock type, it's a ToolCallContent type
      // We wrap diffs in resource blocks with mimeType 'text/x-diff'
      const fs = await import('fs/promises');
      const diffs: Array<ContentBlock> = [];

      for (const change of changes) {
        const resolvedPath = path.resolve(change.file);
        let oldText: string | null = null;

        try {
          // Try to read existing file
          oldText = await fs.readFile(resolvedPath, 'utf-8');
        } catch (error) {
          // File doesn't exist - this is a new file
          oldText = null;
        }

        // Format as unified diff
        const diffText = this.formatUnifiedDiff(
          resolvedPath,
          oldText || '',
          change.newContent
        );

        // Wrap in resource block per ACP spec
        diffs.push({
          type: 'resource',
          resource: {
            uri: `diff://${resolvedPath}`,
            text: diffText,
            mimeType: 'text/x-diff',
          },
          annotations: {
            _meta: {
              diffType: 'unified',
              originalPath: resolvedPath,
              isNewFile: oldText === null,
            },
          },
        });
      }

      // Extract locations from changes
      const locations: Array<{ path: string; line?: number }> = changes.map(
        (change) => ({
          path: path.resolve(change.file),
          line: change.startLine,
        })
      );

      // Build apply command
      const applyArgs = ['apply-changes'];
      if (dryRun) {
        applyArgs.push('--dry-run');
      }
      if (backup) {
        applyArgs.push('--backup');
      }

      // Create temporary file with changes
      const changesJson = JSON.stringify(changes, null, 2);
      const tempFile = path.join(process.cwd(), '.cursor-changes.json');
      await fs.writeFile(tempFile, changesJson);

      try {
        applyArgs.push('--changes-file', tempFile);

        const result = await this.cliBridge.executeCommand([
          'cursor-agent',
          ...applyArgs,
        ]);

        if (!result.success) {
          throw new ToolError(
            `Apply changes failed: ${result.error}`,
            'apply_code_changes'
          );
        }

        if (!result.stdout) {
          throw new ToolError(
            'Apply changes completed but returned no output',
            'apply_code_changes'
          );
        }

        // Parse apply results
        const applyResults = this.parseApplyResults(result.stdout);

        return {
          success: true,
          result: {
            applied: !dryRun,
            changesCount: changes.length,
            ...applyResults,
          },
          metadata: {
            applyTime: result.metadata?.['executionTime'] || 0,
            dryRun,
            backup,
            diffs, // Include diffs for tool call reporting
            locations, // Include locations for tool call reporting
          },
        };
      } finally {
        // Clean up temp file
        try {
          await fs.unlink(tempFile);
        } catch {
          // Ignore cleanup errors
        }
      }
    } catch (error) {
      this.logger.error('Failed to apply code changes', { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Run tests using the project's test runner
   */
  private async runTests(params: Record<string, any>): Promise<ToolResult> {
    try {
      if (!this.cursorConfig.enableTestExecution) {
        throw new ToolError('Test execution is disabled', 'run_tests');
      }

      const testPattern = params['test_pattern'] || '';
      const testFramework = params['test_framework'] || 'auto';
      const watchMode = params['watch_mode'] || false;
      const coverage = params['coverage'] || false;
      const timeout = params['timeout'] || 300;

      this.logger.debug('Running tests', {
        testPattern,
        testFramework,
        watchMode,
        coverage,
      });

      // Build test command
      const testArgs = ['test'];
      if (testPattern) {
        testArgs.push('--pattern', testPattern);
      }
      if (testFramework !== 'auto') {
        testArgs.push('--framework', testFramework);
      }
      if (watchMode) {
        testArgs.push('--watch');
      }
      if (coverage) {
        testArgs.push('--coverage');
      }
      if (timeout) {
        testArgs.push('--timeout', timeout.toString());
      }

      const result = await this.cliBridge.executeCommand(
        ['cursor-agent', ...testArgs],
        {
          timeout: timeout * 1000,
        }
      );

      // Parse test results (even if command failed, we might have partial results)
      // Note: We allow empty stdout/stderr here since test output might be in either stream
      const testResults = this.parseTestResults(
        result.stdout ?? '',
        result.stderr ?? ''
      );

      return {
        success: result.success,
        result: {
          framework: testResults['framework'] || testFramework,
          ...testResults,
        },
        error: result.success ? undefined : result.error,
        metadata: {
          executionTime: result.metadata?.['executionTime'] || 0,
          watchMode,
          coverage,
        },
      };
    } catch (error) {
      this.logger.error('Failed to run tests', { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get project information and structure
   */
  private async getProjectInfo(
    params: Record<string, any>
  ): Promise<ToolResult> {
    try {
      const includeDependencies = params['include_dependencies'] !== false;
      const includeScripts = params['include_scripts'] !== false;
      const includeStructure = params['include_structure'] || false;

      this.logger.debug('Getting project info', {
        includeDependencies,
        includeScripts,
        includeStructure,
      });

      // Build info command
      const infoArgs = ['info'];
      if (includeDependencies) {
        infoArgs.push('--dependencies');
      }
      if (includeScripts) {
        infoArgs.push('--scripts');
      }
      if (includeStructure) {
        infoArgs.push('--structure');
      }

      const result = await this.cliBridge.executeCommand([
        'cursor-agent',
        ...infoArgs,
      ]);

      if (!result.success) {
        throw new ToolError(
          `Get project info failed: ${result.error}`,
          'get_project_info'
        );
      }

      if (!result.stdout) {
        throw new ToolError(
          'Get project info completed but returned no output',
          'get_project_info'
        );
      }

      // Parse project info
      const projectInfo = this.parseProjectInfo(result.stdout);

      return {
        success: true,
        result: projectInfo,
        metadata: {
          infoTime: result.metadata?.['executionTime'] || 0,
          includeDependencies,
          includeScripts,
          includeStructure,
        },
      };
    } catch (error) {
      this.logger.error('Failed to get project info', { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Explain code snippets
   */
  private async explainCode(params: Record<string, any>): Promise<ToolResult> {
    try {
      const filePath = params['file_path'];
      const startLine = params['start_line'];
      const endLine = params['end_line'];
      const explanationType = params['explanation_type'] || 'summary';

      this.logger.debug('Explaining code', {
        filePath,
        startLine,
        endLine,
        explanationType,
      });

      // Build explain command
      const explainArgs = ['explain', filePath];
      if (startLine) {
        explainArgs.push('--start-line', startLine.toString());
      }
      if (endLine) {
        explainArgs.push('--end-line', endLine.toString());
      }
      explainArgs.push('--type', explanationType);

      const result = await this.cliBridge.executeCommand([
        'cursor-agent',
        ...explainArgs,
      ]);

      if (!result.success) {
        throw new ToolError(
          `Code explanation failed: ${result.error}`,
          'explain_code'
        );
      }

      if (!result.stdout) {
        throw new ToolError(
          'Code explanation completed but returned no output',
          'explain_code'
        );
      }

      // Parse explanation
      const explanation = this.parseExplanation(result.stdout);

      // Include file location for tool call reporting
      const locations: Array<{ path: string; line?: number }> = [
        {
          path: path.resolve(filePath),
          line: startLine,
        },
      ];

      return {
        success: true,
        result: {
          file: filePath,
          startLine,
          endLine,
          explanationType,
          ...explanation,
        },
        metadata: {
          explanationTime: result.metadata?.['executionTime'] || 0,
          locations, // Include location for tool call reporting
        },
      };
    } catch (error) {
      this.logger.error('Failed to explain code', {
        error,
        file: params['file_path'],
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // Private helper methods

  private parseSearchResults(
    output: string,
    includeContext: boolean
  ): SearchResult[] {
    try {
      // Try to parse as JSON first
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return parsed.results || [];
      }

      // Fall back to text parsing
      const results: SearchResult[] = [];
      const lines = output.split('\n');
      let currentResult: Partial<SearchResult> | null = null;

      for (const line of lines) {
        const fileMatch = line.match(/^(.+):(\d+):(\d+)?:(.*)$/);
        if (fileMatch) {
          if (currentResult) {
            results.push(currentResult as SearchResult);
          }
          const file = fileMatch[1];
          const lineStr = fileMatch[2];
          const columnStr = fileMatch[3];
          const contentStr = fileMatch[4];
          if (!file || !lineStr || !contentStr) {
            continue;
          }
          currentResult = {
            file,
            line: parseInt(lineStr, 10),
            column: columnStr ? parseInt(columnStr, 10) : undefined,
            content: contentStr.trim(),
            ...(includeContext && { context: [] }),
          };
        } else if (currentResult && includeContext && line.trim()) {
          currentResult.context = currentResult.context || [];
          currentResult.context.push(line);
        }
      }

      if (currentResult) {
        results.push(currentResult as SearchResult);
      }

      return results;
    } catch (error) {
      this.logger.warn('Failed to parse search results', { error });
      return [];
    }
  }

  private parseAnalysisResults(output: string): Record<string, any> {
    try {
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }

      // Basic fallback parsing
      return {
        structure: { parsed: false },
        dependencies: [],
        metrics: {},
        raw: output,
      };
    } catch (error) {
      this.logger.warn('Failed to parse analysis results', { error });
      return { raw: output };
    }
  }

  private parseApplyResults(output: string): Record<string, any> {
    try {
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }

      return {
        success: output.includes('successfully applied'),
        modified: [],
        errors: [],
        raw: output,
      };
    } catch (error) {
      this.logger.warn('Failed to parse apply results', { error });
      return { raw: output };
    }
  }

  private parseTestResults(
    stdout: string,
    stderr: string
  ): Record<string, any> {
    try {
      const combined = `${stdout}\n${stderr}`;
      const jsonMatch = combined.match(/\{[\s\S]*"tests"[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }

      // Basic parsing for common test frameworks
      const results: TestResult[] = [];
      const lines = combined.split('\n');

      for (const line of lines) {
        const testMatch = line.match(
          /(PASS|FAIL|SKIP)\s+(.+?)(?:\s+\((\d+(?:\.\d+)?)s\))?/
        );
        if (testMatch) {
          const testName = testMatch[2];
          const statusStr = testMatch[1];
          if (!testName || !statusStr) {
            continue;
          }
          results.push({
            file: testName,
            suite: '',
            test: testName,
            status: statusStr.toLowerCase() as 'passed' | 'failed' | 'skipped',
            duration: testMatch[3] ? parseFloat(testMatch[3]) : undefined,
          });
        }
      }

      return {
        framework: 'unknown',
        tests: results,
        summary: {
          total: results.length,
          passed: results.filter((r) => r.status === 'passed').length,
          failed: results.filter((r) => r.status === 'failed').length,
          skipped: results.filter((r) => r.status === 'skipped').length,
        },
        raw: combined,
      };
    } catch (error) {
      this.logger.warn('Failed to parse test results', { error });
      return { raw: `${stdout}\n${stderr}` };
    }
  }

  private parseProjectInfo(output: string): Record<string, any> {
    try {
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }

      return {
        name: 'unknown',
        version: '0.0.0',
        dependencies: {},
        devDependencies: {},
        scripts: {},
        raw: output,
      };
    } catch (error) {
      this.logger.warn('Failed to parse project info', { error });
      return { raw: output };
    }
  }

  private parseExplanation(output: string): Record<string, any> {
    try {
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }

      return {
        explanation: output,
        complexity: 'unknown',
        suggestions: [],
      };
    } catch (error) {
      this.logger.warn('Failed to parse explanation', { error });
      return { explanation: output };
    }
  }

  private validateCodeChanges(changes: CodeChange[]): string[] {
    const errors: string[] = [];

    for (let i = 0; i < changes.length; i++) {
      const change = changes[i];
      if (!change) {
        errors.push(`Change ${i + 1}: Missing change object`);
        continue;
      }
      const prefix = `Change ${i + 1}`;

      if (!change.file || typeof change.file !== 'string') {
        errors.push(`${prefix}: Invalid file path`);
      }

      if (typeof change.startLine !== 'number' || change.startLine < 1) {
        errors.push(`${prefix}: Invalid start line`);
      }

      if (
        typeof change.endLine !== 'number' ||
        change.endLine < change.startLine
      ) {
        errors.push(`${prefix}: Invalid end line`);
      }

      if (typeof change.newContent !== 'string') {
        errors.push(`${prefix}: Invalid new content`);
      }
    }

    return errors;
  }

  /**
   * Format a unified diff for displaying file changes
   * Per ACP: diffs should be wrapped in resource blocks with mimeType 'text/x-diff'
   */
  private formatUnifiedDiff(
    filePath: string,
    oldContent: string,
    newContent: string
  ): string {
    const lines: string[] = [];

    // Add diff header
    lines.push(`--- ${filePath}`);
    lines.push(`+++ ${filePath}`);

    // For simplicity, we'll show the entire file as changed
    // A more sophisticated implementation would show only changed lines
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');

    // Add hunk header
    lines.push(`@@ -1,${oldLines.length} +1,${newLines.length} @@`);

    // Show old lines
    if (oldContent) {
      for (const line of oldLines) {
        lines.push(`-${line}`);
      }
    }

    // Show new lines
    for (const line of newLines) {
      lines.push(`+${line}`);
    }

    return lines.join('\n');
  }
}
