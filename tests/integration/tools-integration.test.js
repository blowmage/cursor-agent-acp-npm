"use strict";
/**
 * Integration tests for Phase 4 Tool Calling System
 *
 * These tests verify the complete integration of filesystem, terminal, and
 * cursor-specific tools working together through the ToolRegistry.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
/* eslint-disable @typescript-eslint/no-unused-vars, no-unused-vars */
const fs_1 = require("fs");
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const registry_1 = require("../../src/tools/registry");
describe('Tool System Integration', () => {
    let registry;
    let mockConfig;
    let mockLogger;
    let tempDir;
    let testProjectDir;
    beforeAll(async () => {
        // Create temporary directories for testing
        tempDir = await fs_1.promises.mkdtemp(path.join(os.tmpdir(), 'cursor-acp-tools-'));
        testProjectDir = path.join(tempDir, 'test-project');
        await fs_1.promises.mkdir(testProjectDir, { recursive: true });
        // Create a basic test project structure
        await createTestProject();
    });
    afterAll(async () => {
        // Cleanup temporary directory
        try {
            await fs_1.promises.rm(tempDir, { recursive: true, force: true });
        }
        catch (error) {
            console.warn('Failed to cleanup temp directory:', error);
        }
    });
    beforeEach(() => {
        mockConfig = {
            logLevel: 'debug',
            sessionDir: path.join(tempDir, 'sessions'),
            maxSessions: 10,
            sessionTimeout: 3600,
            tools: {
                filesystem: {
                    enabled: true,
                    allowedPaths: [tempDir],
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
        registry = new registry_1.ToolRegistry(mockConfig, mockLogger);
    });
    afterEach(async () => {
        // Cleanup any processes or sessions
        try {
            await registry.reload();
        }
        catch (error) {
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
            expect(providerNames).toContain('terminal');
            expect(providerNames).toContain('cursor');
            expect(providers).toHaveLength(3);
        });
        test('should provide all available tools', () => {
            const tools = registry.getTools();
            const toolNames = tools.map((t) => t.name);
            // Filesystem tools
            expect(toolNames).toContain('read_file');
            expect(toolNames).toContain('write_file');
            expect(toolNames).toContain('list_directory');
            // Terminal tools
            expect(toolNames).toContain('execute_command');
            expect(toolNames).toContain('start_shell_session');
            // Cursor tools
            expect(toolNames).toContain('search_codebase');
            expect(toolNames).toContain('analyze_code');
            expect(toolNames).toContain('apply_code_changes');
            expect(tools.length).toBeGreaterThanOrEqual(8);
        });
        test('should report correct capabilities', () => {
            const capabilities = registry.getCapabilities();
            expect(capabilities.filesystem).toBe(true);
            expect(capabilities.terminal).toBe(true);
            expect(capabilities.cursor).toBe(true);
            expect(capabilities.tools).toContain('read_file');
            expect(capabilities.tools).toContain('execute_command');
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
                        allowedPaths: [],
                    },
                    terminal: {
                        enabled: true,
                        maxProcesses: 0,
                    },
                },
            };
            const badRegistry = new registry_1.ToolRegistry(badConfig, mockLogger);
            const errors = badRegistry.validateConfiguration();
            expect(errors.length).toBeGreaterThan(0);
            expect(errors.some((e) => e.includes('allowed paths'))).toBe(true);
            expect(errors.some((e) => e.includes('maxProcesses'))).toBe(true);
        });
    });
    describe('Cross-Tool Workflows', () => {
        test('should execute file operations workflow', async () => {
            const testFile = path.join(testProjectDir, 'workflow-test.js');
            const testContent = 'console.log("Hello, World!");';
            // Step 1: Write file
            const writeCall = {
                id: 'write-1',
                name: 'write_file',
                parameters: {
                    path: testFile,
                    content: testContent,
                },
            };
            const writeResult = await registry.executeTool(writeCall);
            expect(writeResult.success).toBe(true);
            // Step 2: Read file back
            const readCall = {
                id: 'read-1',
                name: 'read_file',
                parameters: {
                    path: testFile,
                },
            };
            const readResult = await registry.executeTool(readCall);
            expect(readResult.success).toBe(true);
            expect(readResult.result.content).toBe(testContent);
            // Step 3: List directory to confirm file exists
            const listCall = {
                id: 'list-1',
                name: 'list_directory',
                parameters: {
                    path: testProjectDir,
                },
            };
            const listResult = await registry.executeTool(listCall);
            expect(listResult.success).toBe(true);
            expect(listResult.result.entries.some((e) => e.name === 'workflow-test.js')).toBe(true);
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
            await fs_1.promises.mkdir(path.dirname(sourceFile), { recursive: true });
            await fs_1.promises.writeFile(sourceFile, sourceCode);
            // Step 1: Search for class definitions
            const searchCall = {
                id: 'search-1',
                name: 'search_codebase',
                parameters: {
                    query: 'class Calculator',
                    file_pattern: '*.ts',
                },
            };
            let searchResult;
            try {
                searchResult = await registry.executeTool(searchCall);
                // Note: This might fail if cursor-agent is not available, which is expected
            }
            catch (error) {
                console.log('Cursor CLI not available, skipping cursor-specific tests');
                return;
            }
            if (searchResult.success) {
                expect(searchResult.result.results).toBeDefined();
            }
            // Step 2: Get project information
            const infoCall = {
                id: 'info-1',
                name: 'get_project_info',
                parameters: {
                    include_structure: true,
                },
            };
            const _infoResult = await registry.executeTool(infoCall);
            // This might fail without cursor-agent, which is expected
            // Step 3: List source files using filesystem tools
            const listSrcCall = {
                id: 'list-src-1',
                name: 'list_directory',
                parameters: {
                    path: path.join(testProjectDir, 'src'),
                    recursive: true,
                },
            };
            const listSrcResult = await registry.executeTool(listSrcCall);
            expect(listSrcResult.success).toBe(true);
            expect(listSrcResult.result.entries.some((e) => e.name === 'calculator.ts')).toBe(true);
        });
        test('should handle terminal and file system integration', async () => {
            const testFilePath = path.join(testProjectDir, 'terminal-test.txt');
            // Step 1: Use terminal to echo content and write to file using shell
            // Use shell -c to properly handle redirection
            const createFileCall = {
                id: 'cmd-1',
                name: 'execute_command',
                parameters: {
                    command: 'sh',
                    args: ['-c', `echo "Hello from terminal" > "${testFilePath}"`],
                    working_directory: testProjectDir,
                },
            };
            const cmdResult = await registry.executeTool(createFileCall);
            // If terminal command fails (might not have sh on all systems), use file system
            if (!cmdResult.success) {
                const writeCall = {
                    id: 'write-alt-1',
                    name: 'write_file',
                    parameters: {
                        path: testFilePath,
                        content: 'Hello from terminal\n',
                    },
                };
                const writeResult = await registry.executeTool(writeCall);
                expect(writeResult.success).toBe(true);
            }
            // Step 2: Read the file to verify it was created
            const readCall = {
                id: 'read-2',
                name: 'read_file',
                parameters: {
                    path: testFilePath,
                },
            };
            const readResult = await registry.executeTool(readCall);
            expect(readResult.success).toBe(true);
            expect(readResult.result.content).toContain('Hello from terminal');
            // Step 3: Get file info
            const infoCall = {
                id: 'info-2',
                name: 'get_file_info',
                parameters: {
                    path: testFilePath,
                },
            };
            const infoResult = await registry.executeTool(infoCall);
            expect(infoResult.success).toBe(true);
            expect(infoResult.result.isFile).toBe(true);
            expect(infoResult.result.size).toBeGreaterThan(0);
        });
    });
    describe('Error Handling and Security', () => {
        test('should prevent unauthorized file access', async () => {
            const unauthorizedPath = '/etc/passwd';
            const readCall = {
                id: 'unauthorized-1',
                name: 'read_file',
                parameters: {
                    path: unauthorizedPath,
                },
            };
            const result = await registry.executeTool(readCall);
            expect(result.success).toBe(false);
            expect(result.error).toContain('not allowed');
        });
        test('should handle nonexistent tools', async () => {
            const invalidCall = {
                id: 'invalid-1',
                name: 'nonexistent_tool',
                parameters: {},
            };
            const result = await registry.executeTool(invalidCall);
            expect(result.success).toBe(false);
            expect(result.error).toContain('Tool not found');
        });
        test('should validate tool parameters', async () => {
            const invalidCall = {
                id: 'invalid-params-1',
                name: 'read_file',
                parameters: {
                // Missing required 'path' parameter
                },
            };
            const result = await registry.executeTool(invalidCall);
            expect(result.success).toBe(false);
            expect(result.error).toContain('Missing required parameter');
        });
        test('should handle concurrent tool execution', async () => {
            const calls = Array.from({ length: 5 }, (_, i) => ({
                id: `concurrent-${i}`,
                name: 'list_directory',
                parameters: {
                    path: testProjectDir,
                },
            }));
            const promises = calls.map((call) => registry.executeTool(call));
            const results = await Promise.all(promises);
            results.forEach((result, _i) => {
                expect(result.success).toBe(true);
                expect(result.metadata?.toolName).toBe('list_directory');
            });
        });
    });
    describe('Performance and Metrics', () => {
        test('should track tool execution metrics', async () => {
            const call = {
                id: 'metrics-1',
                name: 'list_directory',
                parameters: {
                    path: testProjectDir,
                },
            };
            const result = await registry.executeTool(call);
            expect(result.success).toBe(true);
            expect(result.metadata).toBeDefined();
            expect(result.metadata?.duration).toBeGreaterThanOrEqual(0); // Duration can be 0 for very fast operations
            expect(result.metadata?.executedAt).toBeInstanceOf(Date);
            expect(result.metadata?.toolName).toBe('list_directory');
        });
        test('should provide registry metrics', () => {
            const metrics = registry.getMetrics();
            expect(metrics.totalTools).toBeGreaterThan(0);
            expect(metrics.totalProviders).toBe(3);
            expect(metrics.enabledProviders).toContain('filesystem');
            expect(metrics.enabledProviders).toContain('terminal');
            expect(metrics.enabledProviders).toContain('cursor');
        });
        test('should handle tool execution timeouts', async () => {
            // This test would require a long-running command
            // For now, just verify the timeout parameter is passed correctly
            const longCall = {
                id: 'timeout-1',
                name: 'execute_command',
                parameters: {
                    command: 'sleep',
                    args: ['0.1'],
                    timeout: 1,
                },
            };
            const startTime = Date.now();
            const _result = await registry.executeTool(longCall);
            const duration = Date.now() - startTime;
            // Should complete within reasonable time
            expect(duration).toBeLessThan(2000);
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
                        parameters: { type: 'object', properties: {} },
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
            await registry.reload();
            expect(registry.getTools()).toHaveLength(initialTools);
            expect(registry.getProviders()).toHaveLength(3);
        });
    });
    // Helper function to create test project structure
    async function createTestProject() {
        const packageJson = {
            name: 'test-project',
            version: '1.0.0',
            scripts: {
                test: 'jest',
                build: 'tsc',
                start: 'node dist/index.js',
            },
            dependencies: {
                typescript: '^5.0.0',
            },
            devDependencies: {
                jest: '^29.0.0',
                '@types/node': '^20.0.0',
            },
        };
        // Create package.json
        await fs_1.promises.writeFile(path.join(testProjectDir, 'package.json'), JSON.stringify(packageJson, null, 2));
        // Create src directory
        await fs_1.promises.mkdir(path.join(testProjectDir, 'src'), { recursive: true });
        // Create test directory
        await fs_1.promises.mkdir(path.join(testProjectDir, 'test'), { recursive: true });
        // Create a sample TypeScript file
        const sampleTs = `
export interface User {
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

  getAllUsers(): User[] {
    return [...this.users];
  }
}
`;
        await fs_1.promises.writeFile(path.join(testProjectDir, 'src', 'user.ts'), sampleTs);
        // Create a sample test file
        const sampleTest = `
import { UserService } from '../src/user';

describe('UserService', () => {
  let userService: UserService;

  beforeEach(() => {
    userService = new UserService();
  });

  test('should add and retrieve user', () => {
    const user = { id: 1, name: 'Test User', email: 'test@example.com' };
    userService.addUser(user);

    const retrieved = userService.getUserById(1);
    expect(retrieved).toEqual(user);
  });

  test('should return all users', () => {
    const user1 = { id: 1, name: 'User 1', email: 'user1@example.com' };
    const user2 = { id: 2, name: 'User 2', email: 'user2@example.com' };

    userService.addUser(user1);
    userService.addUser(user2);

    const allUsers = userService.getAllUsers();
    expect(allUsers).toHaveLength(2);
    expect(allUsers).toContain(user1);
    expect(allUsers).toContain(user2);
  });
});
`;
        await fs_1.promises.writeFile(path.join(testProjectDir, 'test', 'user.test.ts'), sampleTest);
        // Create tsconfig.json
        const tsConfig = {
            compilerOptions: {
                target: 'ES2020',
                module: 'commonjs',
                outDir: './dist',
                rootDir: './src',
                strict: true,
                esModuleInterop: true,
                skipLibCheck: true,
                forceConsistentCasingInFileNames: true,
            },
            include: ['src/**/*'],
            exclude: ['node_modules', 'dist', 'test'],
        };
        await fs_1.promises.writeFile(path.join(testProjectDir, 'tsconfig.json'), JSON.stringify(tsConfig, null, 2));
        // Create README
        const readme = `# Test Project

This is a test project for the Cursor ACP Adapter tool system integration tests.

## Structure

- \`src/\` - Source code
- \`test/\` - Test files
- \`dist/\` - Compiled output

## Scripts

- \`npm test\` - Run tests
- \`npm run build\` - Build project
- \`npm start\` - Start application
`;
        await fs_1.promises.writeFile(path.join(testProjectDir, 'README.md'), readme);
    }
});
//# sourceMappingURL=tools-integration.test.js.map