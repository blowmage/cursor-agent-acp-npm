"use strict";
/**
 * Mock implementation of CursorCliBridge for integration tests
 *
 * This mock allows integration tests to run quickly without making
 * real calls to cursor-agent CLI, while still testing all other
 * components and their integration.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MockCursorCliBridge = void 0;
class MockCursorCliBridge {
    config;
    logger;
    activeSessions = new Map();
    callCount = 0;
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
    }
    async checkAuthentication() {
        return {
            authenticated: true,
            user: 'test-user',
            email: 'test@example.com',
            plan: 'pro',
        };
    }
    async getVersion() {
        return '1.0.0-mock';
    }
    async executeCommand(command, options = {}) {
        // Simulate quick command execution
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
            success: true,
            stdout: 'Mock command output',
            stderr: '',
            exitCode: 0,
        };
    }
    async startInteractiveSession(sessionId) {
        const id = sessionId || `mock-session-${Date.now()}`;
        const session = {
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
    async sendPrompt(options) {
        this.callCount++;
        // Simulate quick response
        await new Promise((resolve) => setTimeout(resolve, 50));
        // Generate a simple mock response based on content
        const contentLower = options.content.value.toLowerCase();
        let response = 'This is a mock response from the cursor-agent simulator.';
        if (contentLower.includes('typescript')) {
            response =
                'TypeScript is a statically typed superset of JavaScript that adds type safety.';
        }
        else if (contentLower.includes('code') ||
            contentLower.includes('review')) {
            response =
                'The code looks good. Consider adding error handling and type annotations.';
        }
        else if (contentLower.includes('help')) {
            response =
                'I can help you with coding questions, code review, and technical explanations.';
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
    async sendStreamingPrompt(options) {
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
    async sendSessionInput(sessionId, input) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return `Mock response for: ${input}`;
    }
    async closeSession(sessionId) {
        this.activeSessions.delete(sessionId);
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    getActiveSessions() {
        return Array.from(this.activeSessions.values());
    }
    async close() {
        this.activeSessions.clear();
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // Test helpers
    getCallCount() {
        return this.callCount;
    }
    reset() {
        this.callCount = 0;
        this.activeSessions.clear();
    }
}
exports.MockCursorCliBridge = MockCursorCliBridge;
//# sourceMappingURL=cursor-bridge-mock.js.map