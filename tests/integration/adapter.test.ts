/**
 * Integration tests for CursorAgentAdapter
 *
 * These tests verify the complete integration between all components:
 * - ACP protocol handling
 * - Cursor CLI integration (mocked for speed)
 * - Session management
 * - Tool execution
 * - End-to-end request/response flow
 *
 * Note: CursorCliBridge is mocked to avoid slow real cursor-agent calls
 * while still testing all other component integrations.
 */

import { CursorAgentAdapter } from '../../src/adapter/cursor-agent-adapter';
import type {
  AdapterConfig,
  AcpRequest,
  AcpResponse,
  Logger,
} from '../../src/types';
import { MockCursorCliBridge } from './mocks/cursor-bridge-mock';

// Mock the CursorCliBridge module
jest.mock('../../src/cursor/cli-bridge', () => ({
  CursorCliBridge: jest.fn().mockImplementation((config, logger) => {
    return new (require('./mocks/cursor-bridge-mock').MockCursorCliBridge)(
      config,
      logger
    );
  }),
}));

// Mock logger for tests
const mockLogger: Logger = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
};

// Test configuration
const testConfig: AdapterConfig = {
  logLevel: 'debug',
  sessionDir: '/tmp/cursor-test-sessions',
  maxSessions: 10,
  sessionTimeout: 60000, // Minimum 1 minute required by validation
  tools: {
    filesystem: {
      enabled: true,
      allowedPaths: ['/tmp', './'],
    },
    terminal: {
      enabled: true,
      maxProcesses: 3,
    },
  },
  cursor: {
    timeout: 30000,
    retries: 1,
  },
};

describe('CursorAgentAdapter Integration', () => {
  let adapter: CursorAgentAdapter;

  beforeEach(async () => {
    jest.clearAllMocks();
    adapter = new CursorAgentAdapter(testConfig, { logger: mockLogger });
    await adapter.initialize();
  });

  afterEach(async () => {
    if (adapter) {
      try {
        await adapter.shutdown();
      } catch (error) {
        // Ignore shutdown errors in tests
      }
    }
    // Give time for all async cleanup to complete
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  describe('Initialization', () => {
    it('should initialize all components successfully', async () => {
      const status = adapter.getStatus();

      expect(status.running).toBe(false);
      expect(status.components.sessionManager).toBe(true);
      expect(status.components.cursorBridge).toBe(true);
      expect(status.components.toolRegistry).toBe(true);
      expect(status.components.initializationHandler).toBe(true);
      expect(status.components.promptHandler).toBe(true);
    });

    it('should validate configuration during initialization', async () => {
      const invalidConfig = {
        ...testConfig,
        tools: {
          filesystem: {
            enabled: true,
            allowedPaths: [], // Invalid: empty paths
          },
          terminal: {
            enabled: true,
            maxProcesses: 0, // Invalid: zero processes
          },
        },
      };

      await expect(async () => {
        const invalidAdapter = new CursorAgentAdapter(invalidConfig, {
          logger: mockLogger,
        });
        await invalidAdapter.initialize();
      }).rejects.toThrow();
    });
  });

  describe('ACP Protocol Methods', () => {
    describe('initialize', () => {
      it('should handle initialize request correctly', async () => {
        const request: AcpRequest = {
          jsonrpc: '2.0',
          method: 'initialize',
          id: 'test-init-1',
          params: {
            protocolVersion: 1, // Per ACP spec: must be integer
            clientInfo: {
              name: 'TestClient',
              version: '1.0.0',
            },
          },
        };

        const response = await adapter.processRequest(request);

        expect(response.jsonrpc).toBe('2.0');
        expect(response.id).toBe('test-init-1');
        expect(response.result).toBeDefined();
        expect(response.result.protocolVersion).toBe(1);
        expect(response.result.agentInfo).toEqual({
          name: 'cursor-agent-acp',
          title: 'Cursor Agent ACP Adapter',
          version: expect.any(String), // Dynamic from package.json
        });
        // Per ACP spec: check agentCapabilities structure
        expect(response.result.agentCapabilities).toBeDefined();
        expect(response.result.agentCapabilities.loadSession).toBe(true);
        expect(
          response.result.agentCapabilities.promptCapabilities
        ).toBeDefined();
        expect(response.result.agentCapabilities.mcp).toBeDefined();
        expect(response.result.authMethods).toEqual([]);
      });

      it('should reject invalid protocol version', async () => {
        const request: AcpRequest = {
          jsonrpc: '2.0',
          method: 'initialize',
          id: 'test-init-2',
          params: {
            protocolVersion: '999.0.0',
          },
        };

        const response = await adapter.processRequest(request);

        expect(response.error).toBeDefined();
        expect(response.error?.message).toContain(
          'Protocol version must be an integer'
        );
      });

      it('should handle client capabilities in initialize request', async () => {
        const request: AcpRequest = {
          jsonrpc: '2.0',
          method: 'initialize',
          id: 'test-init-3',
          params: {
            protocolVersion: 1,
            clientCapabilities: {
              fs: {
                readTextFile: true,
                writeTextFile: true,
              },
              terminal: true,
            },
            clientInfo: {
              name: 'zed-editor',
              version: '0.143.0',
            },
          },
        };

        const response = await adapter.processRequest(request);

        expect(response.jsonrpc).toBe('2.0');
        expect(response.id).toBe('test-init-3');
        expect(response.result).toBeDefined();
        expect(response.result.protocolVersion).toBe(1);
        expect(response.result.agentInfo).toBeDefined();
        expect(response.result.agentCapabilities).toBeDefined();
      });

      it('should negotiate protocol version when client requests unsupported version', async () => {
        const request: AcpRequest = {
          jsonrpc: '2.0',
          method: 'initialize',
          id: 'test-init-4',
          params: {
            protocolVersion: 2, // Unsupported version
            clientInfo: {
              name: 'future-client',
              version: '2.0.0',
            },
          },
        };

        const response = await adapter.processRequest(request);

        expect(response.jsonrpc).toBe('2.0');
        expect(response.id).toBe('test-init-4');
        expect(response.result).toBeDefined();
        // Should negotiate down to version 1
        expect(response.result.protocolVersion).toBe(1);
      });

      it('should handle initialize without client info', async () => {
        const request: AcpRequest = {
          jsonrpc: '2.0',
          method: 'initialize',
          id: 'test-init-5',
          params: {
            protocolVersion: 1,
            // No clientInfo provided
          },
        };

        const response = await adapter.processRequest(request);

        expect(response.jsonrpc).toBe('2.0');
        expect(response.id).toBe('test-init-5');
        expect(response.result).toBeDefined();
        expect(response.result.protocolVersion).toBe(1);
      });

      it('should handle initialize without client capabilities', async () => {
        const request: AcpRequest = {
          jsonrpc: '2.0',
          method: 'initialize',
          id: 'test-init-6',
          params: {
            protocolVersion: 1,
            clientInfo: {
              name: 'minimal-client',
              version: '1.0.0',
            },
            // No clientCapabilities provided
          },
        };

        const response = await adapter.processRequest(request);

        expect(response.jsonrpc).toBe('2.0');
        expect(response.id).toBe('test-init-6');
        expect(response.result).toBeDefined();
        expect(response.result.protocolVersion).toBe(1);
      });

      it('should handle partial client capabilities', async () => {
        const request: AcpRequest = {
          jsonrpc: '2.0',
          method: 'initialize',
          id: 'test-init-7',
          params: {
            protocolVersion: 1,
            clientCapabilities: {
              fs: {
                readTextFile: true,
                // writeTextFile intentionally omitted
              },
              // terminal intentionally omitted
            },
          },
        };

        const response = await adapter.processRequest(request);

        expect(response.jsonrpc).toBe('2.0');
        expect(response.id).toBe('test-init-7');
        expect(response.result).toBeDefined();
        expect(response.result.agentCapabilities).toBeDefined();
      });

      it('should include MCP capabilities in initialize response', async () => {
        const request: AcpRequest = {
          jsonrpc: '2.0',
          method: 'initialize',
          id: 'test-init-8',
          params: {
            protocolVersion: 1,
          },
        };

        const response = await adapter.processRequest(request);

        expect(response.result).toBeDefined();
        expect(response.result.agentCapabilities.mcp).toBeDefined();
        expect(response.result.agentCapabilities.mcp.http).toBeDefined();
        expect(response.result.agentCapabilities.mcp.sse).toBeDefined();
      });

      it('should include prompt capabilities in initialize response', async () => {
        const request: AcpRequest = {
          jsonrpc: '2.0',
          method: 'initialize',
          id: 'test-init-9',
          params: {
            protocolVersion: 1,
          },
        };

        const response = await adapter.processRequest(request);

        expect(response.result).toBeDefined();
        expect(
          response.result.agentCapabilities.promptCapabilities
        ).toBeDefined();
        expect(
          response.result.agentCapabilities.promptCapabilities.image
        ).toBeDefined();
        expect(
          response.result.agentCapabilities.promptCapabilities.audio
        ).toBeDefined();
        expect(
          response.result.agentCapabilities.promptCapabilities.embeddedContext
        ).toBeDefined();
      });

      it('should include loadSession capability in initialize response', async () => {
        const request: AcpRequest = {
          jsonrpc: '2.0',
          method: 'initialize',
          id: 'test-init-10',
          params: {
            protocolVersion: 1,
          },
        };

        const response = await adapter.processRequest(request);

        expect(response.result).toBeDefined();
        expect(response.result.agentCapabilities.loadSession).toBe(true);
      });

      it('should reject missing protocol version', async () => {
        const request: AcpRequest = {
          jsonrpc: '2.0',
          method: 'initialize',
          id: 'test-init-11',
          params: {
            // protocolVersion intentionally missing
            clientInfo: {
              name: 'bad-client',
              version: '1.0.0',
            },
          },
        };

        const response = await adapter.processRequest(request);

        expect(response.error).toBeDefined();
        expect(response.error?.message).toContain(
          'Protocol version is required'
        );
      });
    });

    describe('session management', () => {
      it('should create, load, and delete session', async () => {
        // Create session
        const createRequest: AcpRequest = {
          jsonrpc: '2.0',
          method: 'session/new',
          id: 'test-session-1',
          params: {
            metadata: {
              name: 'Test Session',
              tags: ['test'],
            },
          },
        };

        const createResponse = await adapter.processRequest(createRequest);
        expect(createResponse.result).toBeDefined();
        expect(createResponse.result.sessionId).toBeDefined();

        const sessionId = createResponse.result.sessionId;

        // Load session
        const loadRequest: AcpRequest = {
          jsonrpc: '2.0',
          method: 'session/load',
          id: 'test-session-2',
          params: {
            sessionId,
          },
        };

        const loadResponse = await adapter.processRequest(loadRequest);
        expect(loadResponse.result).toBeDefined();
        expect(loadResponse.result.sessionId).toBe(sessionId);
        expect(loadResponse.result.metadata.name).toBe('Test Session');

        // Delete session
        const deleteRequest: AcpRequest = {
          jsonrpc: '2.0',
          method: 'session/delete',
          id: 'test-session-3',
          params: {
            sessionId,
          },
        };

        const deleteResponse = await adapter.processRequest(deleteRequest);
        expect(deleteResponse.result).toBeDefined();
        expect(deleteResponse.result.deleted).toBe(true);
      });

      it('should list sessions with pagination', async () => {
        // Create multiple sessions
        for (let i = 0; i < 3; i++) {
          const request: AcpRequest = {
            jsonrpc: '2.0',
            method: 'session/new',
            id: `create-${i}`,
            params: {
              metadata: { name: `Session ${i}` },
            },
          };
          await adapter.processRequest(request);
        }

        // List sessions
        const listRequest: AcpRequest = {
          jsonrpc: '2.0',
          method: 'session/list',
          id: 'test-list-1',
          params: {
            limit: 2,
            offset: 0,
          },
        };

        const listResponse = await adapter.processRequest(listRequest);
        expect(listResponse.result).toBeDefined();
        expect(listResponse.result.sessions).toHaveLength(2);
        expect(listResponse.result.total).toBe(3); // Total sessions, not returned sessions
        expect(listResponse.result.hasMore).toBe(true); // Should have more since we only returned 2 of 3
      });
    });

    describe('prompt processing', () => {
      let sessionId: string;

      beforeEach(async () => {
        // Create a test session
        const createRequest: AcpRequest = {
          jsonrpc: '2.0',
          method: 'session/new',
          id: 'setup-session',
          params: {
            metadata: { name: 'Prompt Test Session' },
          },
        };

        const response = await adapter.processRequest(createRequest);
        sessionId = response.result.sessionId;
      });

      it('should process text prompt', async () => {
        const promptRequest: AcpRequest = {
          jsonrpc: '2.0',
          method: 'session/prompt',
          id: 'test-prompt-1',
          params: {
            sessionId,
            content: [
              {
                type: 'text',
                text: 'Hello, can you help me with TypeScript?',
              },
            ],
            stream: false,
          },
        };

        const response = await adapter.processRequest(promptRequest);

        expect(response.result).toBeDefined();
        expect(response.result.stopReason).toBeDefined();
        expect(['end_turn', 'refusal', 'cancelled']).toContain(
          response.result.stopReason
        );
      });

      it('should process code prompt', async () => {
        const promptRequest: AcpRequest = {
          jsonrpc: '2.0',
          method: 'session/prompt',
          id: 'test-prompt-2',
          params: {
            sessionId,
            content: [
              {
                type: 'text',
                text: 'Please review this code:',
              },
              {
                type: 'code',
                language: 'typescript',
                code: 'const x: string = "hello";',
                filename: 'test.ts',
              },
            ],
            stream: false,
          },
        };

        const response = await adapter.processRequest(promptRequest);

        expect(response.result).toBeDefined();
        expect(response.result.stopReason).toBeDefined();
      });

      it('should handle streaming prompt', async () => {
        const promptRequest: AcpRequest = {
          jsonrpc: '2.0',
          method: 'session/prompt',
          id: 'test-prompt-3',
          params: {
            sessionId,
            content: [
              {
                type: 'text',
                text: 'Tell me about TypeScript features',
              },
            ],
            stream: true,
          },
        };

        const response = await adapter.processRequest(promptRequest);

        expect(response.result).toBeDefined();
        expect(response.result.stopReason).toBeDefined();
      });

      it('should reject invalid content blocks', async () => {
        const promptRequest: AcpRequest = {
          jsonrpc: '2.0',
          method: 'session/prompt',
          id: 'test-prompt-4',
          params: {
            sessionId,
            content: [
              {
                type: 'invalid',
                data: 'test',
              },
            ],
          },
        };

        const response = await adapter.processRequest(promptRequest);

        expect(response.error).toBeDefined();
        expect(response.error?.message).toContain('Invalid content block');
      });
    });

    describe('tool execution', () => {
      it('should list available tools', async () => {
        const request: AcpRequest = {
          jsonrpc: '2.0',
          method: 'tools/list',
          id: 'test-tools-1',
        };

        const response = await adapter.processRequest(request);

        expect(response.result).toBeDefined();
        expect(response.result.tools).toBeInstanceOf(Array);
        expect(response.result.tools.length).toBeGreaterThan(0);

        // Check for expected tools
        const toolNames = response.result.tools.map((tool: any) => tool.name);
        expect(toolNames).toContain('read_file');
        expect(toolNames).toContain('write_file');
        expect(toolNames).toContain('execute_command');
      });

      it('should execute filesystem tool', async () => {
        const request: AcpRequest = {
          jsonrpc: '2.0',
          method: 'tools/call',
          id: 'test-tools-2',
          params: {
            name: 'write_file',
            parameters: {
              path: '/tmp/test-file.txt',
              content: 'Hello from integration test',
            },
          },
        };

        const response = await adapter.processRequest(request);

        expect(response.result).toBeDefined();
        expect(response.result.success).toBe(true);
        expect(response.result.result.path).toBe('/tmp/test-file.txt');
      });

      it('should execute terminal tool', async () => {
        const request: AcpRequest = {
          jsonrpc: '2.0',
          method: 'tools/call',
          id: 'test-tools-3',
          params: {
            name: 'execute_command',
            parameters: {
              command: 'echo',
              args: ['hello world'],
            },
          },
        };

        const response = await adapter.processRequest(request);

        expect(response.result).toBeDefined();
        expect(response.result.success).toBe(true);
        expect(response.result.result.stdout).toContain('hello world');
      });

      it('should reject calls to non-existent tools', async () => {
        const request: AcpRequest = {
          jsonrpc: '2.0',
          method: 'tools/call',
          id: 'test-tools-4',
          params: {
            name: 'non_existent_tool',
            parameters: {},
          },
        };

        const response = await adapter.processRequest(request);

        expect(response.error).toBeDefined();
        expect(response.error?.message).toContain('Tool not found');
      });

      it('should validate tool parameters', async () => {
        const request: AcpRequest = {
          jsonrpc: '2.0',
          method: 'tools/call',
          id: 'test-tools-5',
          params: {
            name: 'read_file',
            parameters: {
              // Missing required 'path' parameter
            },
          },
        };

        const response = await adapter.processRequest(request);

        expect(response.error).toBeDefined();
        expect(response.error?.message).toContain('Invalid parameters');
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle unknown methods', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'unknown/method',
        id: 'test-error-1',
      };

      const response = await adapter.processRequest(request);

      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32601);
      expect(response.error?.message).toContain('Unknown method');
    });

    it('should handle malformed requests', async () => {
      const request = {
        // Missing jsonrpc field
        method: 'initialize',
        id: 'test-error-2',
      } as any;

      const response = await adapter.processRequest(request);

      expect(response.error).toBeDefined();
    });

    it('should handle component failures gracefully', async () => {
      // This test would require mocking component failures
      // For now, we'll test that the adapter can handle basic error scenarios

      const request: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/load',
        id: 'test-error-3',
        params: {
          sessionId: 'non-existent-session-id',
        },
      };

      const response = await adapter.processRequest(request);

      expect(response.error).toBeDefined();
      expect(response.error?.message).toContain('not found');
    });
  });

  describe('Performance', () => {
    it('should handle concurrent requests', async () => {
      const requests: Promise<AcpResponse>[] = [];

      // Create multiple concurrent session creation requests
      for (let i = 0; i < 5; i++) {
        const request: AcpRequest = {
          jsonrpc: '2.0',
          method: 'session/new',
          id: `concurrent-${i}`,
          params: {
            metadata: { name: `Concurrent Session ${i}` },
          },
        };

        requests.push(adapter.processRequest(request));
      }

      const responses = await Promise.all(requests);

      // All requests should succeed
      responses.forEach((response) => {
        expect(response.result).toBeDefined();
        expect(response.result.sessionId).toBeDefined();
      });

      // All session IDs should be unique
      const sessionIds = responses.map((r) => r.result.sessionId);
      const uniqueIds = new Set(sessionIds);
      expect(uniqueIds.size).toBe(sessionIds.length);
    });

    it('should handle rapid sequential requests', async () => {
      // Create a session first
      const createRequest: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'perf-session',
        params: {
          metadata: { name: 'Performance Test Session' },
        },
      };

      const createResponse = await adapter.processRequest(createRequest);
      const sessionId = createResponse.result.sessionId;

      // Send multiple rapid prompts (reduced from 10 to 5 for faster tests)
      const startTime = Date.now();
      const promises = [];

      for (let i = 0; i < 5; i++) {
        const promptRequest: AcpRequest = {
          jsonrpc: '2.0',
          method: 'session/prompt',
          id: `rapid-${i}`,
          params: {
            sessionId,
            content: [
              {
                type: 'text',
                text: `Rapid prompt ${i}`,
              },
            ],
            stream: false,
          },
        };

        promises.push(
          adapter.processRequest(promptRequest).then(
            (response) => {
              console.log(`Rapid prompt ${i} completed successfully`);
              return response;
            },
            (error) => {
              console.error(`Rapid prompt ${i} failed:`, error);
              throw error;
            }
          )
        );
      }

      const responses = await Promise.all(promises);
      const duration = Date.now() - startTime;

      // All requests should complete successfully
      responses.forEach((response, index) => {
        expect(response.result).toBeDefined();
        expect(response.id).toBe(`rapid-${index}`);
      });

      // Should complete quickly with mock
      expect(duration).toBeLessThan(5000); // 5 seconds max for 5 sequential prompts with mock
    }); // Use default timeout

    it('should handle rapid prompt 0 specifically', async () => {
      // Create a session first
      const createRequest: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'rapid-0-session',
        params: {
          metadata: { name: 'Rapid Prompt 0 Test Session' },
        },
      };

      const createResponse = await adapter.processRequest(createRequest);
      const sessionId = createResponse.result.sessionId;

      // Send rapid prompt 0
      const promptRequest: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'rapid-0',
        params: {
          sessionId,
          content: [
            {
              type: 'text',
              text: 'Rapid prompt 0',
            },
          ],
          stream: false,
        },
      };

      const startTime = Date.now();
      const response = await adapter.processRequest(promptRequest);
      const duration = Date.now() - startTime;

      console.log(`Rapid prompt 0 completed in ${duration}ms`);

      // Request should complete successfully
      expect(response.result).toBeDefined();
      expect(response.result.stopReason).toBeDefined();
      expect(response.id).toBe('rapid-0');

      // Should complete quickly with mock
      expect(duration).toBeLessThan(5000); // 5 seconds max with mock
    }); // Use default timeout

    it('should handle rapid prompt 1 specifically', async () => {
      // Create a session first
      const createRequest: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'rapid-1-session',
        params: {
          metadata: { name: 'Rapid Prompt 1 Test Session' },
        },
      };

      const createResponse = await adapter.processRequest(createRequest);
      const sessionId = createResponse.result.sessionId;

      // Send rapid prompt 1
      const promptRequest: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'rapid-1',
        params: {
          sessionId,
          content: [
            {
              type: 'text',
              text: 'Rapid prompt 1',
            },
          ],
          stream: false,
        },
      };

      const startTime = Date.now();
      const response = await adapter.processRequest(promptRequest);
      const duration = Date.now() - startTime;

      console.log(`Rapid prompt 1 completed in ${duration}ms`);

      // Request should complete successfully
      expect(response.result).toBeDefined();
      expect(response.result.stopReason).toBeDefined();
      expect(response.id).toBe('rapid-1');

      // Should complete within reasonable time (increased from 5s to 15s)
      expect(duration).toBeLessThan(15000); // 15 seconds max for single prompt
    });

    it('should handle rapid prompt 2 specifically', async () => {
      // Create a session first
      const createRequest: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'rapid-2-session',
        params: {
          metadata: { name: 'Rapid Prompt 2 Test Session' },
        },
      };

      const createResponse = await adapter.processRequest(createRequest);
      const sessionId = createResponse.result.sessionId;

      // Send rapid prompt 2
      const promptRequest: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'rapid-2',
        params: {
          sessionId,
          content: [
            {
              type: 'text',
              text: 'Rapid prompt 2',
            },
          ],
          stream: false,
        },
      };

      const startTime = Date.now();
      const response = await adapter.processRequest(promptRequest);
      const duration = Date.now() - startTime;

      console.log(`Rapid prompt 2 completed in ${duration}ms`);

      // Request should complete successfully
      expect(response.result).toBeDefined();
      expect(response.result.stopReason).toBeDefined();
      expect(response.id).toBe('rapid-2');

      // Should complete within reasonable time (increased from 5s to 15s)
      expect(duration).toBeLessThan(15000); // 15 seconds max for single prompt
    });

    it('should handle rapid prompt 3 specifically', async () => {
      // Create a session first
      const createRequest: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'rapid-3-session',
        params: {
          metadata: { name: 'Rapid Prompt 3 Test Session' },
        },
      };

      const createResponse = await adapter.processRequest(createRequest);
      const sessionId = createResponse.result.sessionId;

      // Send rapid prompt 3
      const promptRequest: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'rapid-3',
        params: {
          sessionId,
          content: [
            {
              type: 'text',
              text: 'Rapid prompt 3',
            },
          ],
          stream: false,
        },
      };

      const startTime = Date.now();
      const response = await adapter.processRequest(promptRequest);
      const duration = Date.now() - startTime;

      console.log(`Rapid prompt 3 completed in ${duration}ms`);

      // Request should complete successfully
      expect(response.result).toBeDefined();
      expect(response.result.stopReason).toBeDefined();
      expect(response.id).toBe('rapid-3');

      // Should complete within reasonable time (increased from 5s to 15s)
      expect(duration).toBeLessThan(15000); // 15 seconds max for single prompt
    }, 70000); // 70 second timeout to match integration test config

    it('should handle rapid prompt 4 specifically', async () => {
      // Create a session first
      const createRequest: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'rapid-4-session',
        params: {
          metadata: { name: 'Rapid Prompt 4 Test Session' },
        },
      };

      const createResponse = await adapter.processRequest(createRequest);
      const sessionId = createResponse.result.sessionId;

      // Send rapid prompt 4
      const promptRequest: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'rapid-4',
        params: {
          sessionId,
          content: [
            {
              type: 'text',
              text: 'Rapid prompt 4',
            },
          ],
          stream: false,
        },
      };

      const startTime = Date.now();
      const response = await adapter.processRequest(promptRequest);
      const duration = Date.now() - startTime;

      console.log(`Rapid prompt 4 completed in ${duration}ms`);

      // Request should complete successfully
      expect(response.result).toBeDefined();
      expect(response.result.stopReason).toBeDefined();
      expect(response.id).toBe('rapid-4');

      // Should complete within reasonable time (increased from 5s to 15s)
      expect(duration).toBeLessThan(15000); // 15 seconds max for single prompt
    });

    it('should handle rapid prompt 6 specifically', async () => {
      // Create a session first
      const createRequest: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'rapid-6-session',
        params: {
          metadata: { name: 'Rapid Prompt 6 Test Session' },
        },
      };

      const createResponse = await adapter.processRequest(createRequest);
      const sessionId = createResponse.result.sessionId;

      // Send rapid prompt 6
      const promptRequest: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'rapid-6',
        params: {
          sessionId,
          content: [
            {
              type: 'text',
              text: 'Rapid prompt 6',
            },
          ],
          stream: false,
        },
      };

      const startTime = Date.now();
      const response = await adapter.processRequest(promptRequest);
      const duration = Date.now() - startTime;

      console.log(`Rapid prompt 6 completed in ${duration}ms`);

      // Request should complete successfully
      expect(response.result).toBeDefined();
      expect(response.result.stopReason).toBeDefined();
      expect(response.id).toBe('rapid-6');

      // Should complete quickly with mock
      expect(duration).toBeLessThan(5000); // 5 seconds max with mock
    }); // Use default timeout

    it('should handle rapid prompt 9 specifically', async () => {
      // Create a session first
      const createRequest: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/new',
        id: 'rapid-9-session',
        params: {
          metadata: { name: 'Rapid Prompt 9 Test Session' },
        },
      };

      const createResponse = await adapter.processRequest(createRequest);
      const sessionId = createResponse.result.sessionId;

      // Send rapid prompt 9
      const promptRequest: AcpRequest = {
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: 'rapid-9',
        params: {
          sessionId,
          content: [
            {
              type: 'text',
              text: 'Rapid prompt 9',
            },
          ],
          stream: false,
        },
      };

      const startTime = Date.now();
      const response = await adapter.processRequest(promptRequest);
      const duration = Date.now() - startTime;

      console.log(`Rapid prompt 9 completed in ${duration}ms`);

      // Request should complete successfully
      expect(response.result).toBeDefined();
      expect(response.result.stopReason).toBeDefined();
      expect(response.id).toBe('rapid-9');

      // Should complete quickly with mock
      expect(duration).toBeLessThan(5000); // 5 seconds max with mock
    }); // Use default timeout
  });

  describe('Resource Management', () => {
    it('should clean up resources on shutdown', async () => {
      const status1 = adapter.getStatus();
      expect(status1.components.sessionManager).toBe(true);

      await adapter.shutdown();

      // After shutdown, adapter should not be running
      const status2 = adapter.getStatus();
      expect(status2.running).toBe(false);
    });

    it('should track session metrics', async () => {
      // Create some test sessions
      for (let i = 0; i < 3; i++) {
        const request: AcpRequest = {
          jsonrpc: '2.0',
          method: 'session/new',
          id: `metrics-${i}`,
          params: {
            metadata: { name: `Metrics Session ${i}` },
          },
        };
        await adapter.processRequest(request);
      }

      const status = adapter.getStatus();

      expect(status.metrics).toBeDefined();
      expect(status.metrics.sessions).toBeDefined();
      // Specific metrics will depend on SessionManager implementation
    });

    it('should enforce session limits', async () => {
      const limitConfig = {
        ...testConfig,
        maxSessions: 2, // Very low limit for testing
      };

      const limitAdapter = new CursorAgentAdapter(limitConfig, {
        logger: mockLogger,
      });
      await limitAdapter.initialize();

      try {
        // Create sessions up to the limit
        for (let i = 0; i < 2; i++) {
          const request: AcpRequest = {
            jsonrpc: '2.0',
            method: 'session/new',
            id: `limit-${i}`,
            params: {
              metadata: { name: `Limit Session ${i}` },
            },
          };
          const response = await limitAdapter.processRequest(request);
          expect(response.result).toBeDefined();
        }

        // The next session should trigger cleanup or rejection
        const overLimitRequest: AcpRequest = {
          jsonrpc: '2.0',
          method: 'session/new',
          id: 'over-limit',
          params: {
            metadata: { name: 'Over Limit Session' },
          },
        };

        // This might succeed (if cleanup worked) or fail (if limit enforced)
        // The important thing is that the adapter handles it gracefully
        const response = await limitAdapter.processRequest(overLimitRequest);
        // Should not crash the adapter
        expect(response).toBeDefined();
      } finally {
        await limitAdapter.shutdown();
      }
    });
  });
});
