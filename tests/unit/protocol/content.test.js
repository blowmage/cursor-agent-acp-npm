"use strict";
/**
 * Unit tests for ContentProcessor
 */
Object.defineProperty(exports, "__esModule", { value: true });
/* eslint-disable @typescript-eslint/no-unused-vars, no-unused-vars */
const content_1 = require("../../../src/protocol/content");
const types_1 = require("../../../src/types");
const mockLogger = {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
};
const mockConfig = {
    logLevel: 'debug',
    sessionDir: '~/.cursor-sessions',
    maxSessions: 100,
    sessionTimeout: 3600000,
    tools: {
        filesystem: {
            enabled: true,
            allowedPaths: ['./'],
        },
        terminal: {
            enabled: true,
            maxProcesses: 5,
        },
    },
    cursor: {
        timeout: 30000,
        retries: 3,
    },
};
describe('ContentProcessor', () => {
    let contentProcessor;
    beforeEach(() => {
        jest.clearAllMocks();
        contentProcessor = new content_1.ContentProcessor({
            config: mockConfig,
            logger: mockLogger,
        });
    });
    describe('processContent', () => {
        it('should process empty content array', async () => {
            const result = await contentProcessor.processContent([]);
            expect(result.value).toBe('');
            expect(result.metadata.blocks).toEqual([]);
            expect(result.metadata.totalSize).toBe(0);
        });
        it('should process single text block', async () => {
            const blocks = [
                {
                    type: 'text',
                    value: 'Hello world!',
                },
            ];
            const result = await contentProcessor.processContent(blocks);
            expect(result.value).toBe('Hello world!');
            expect(result.metadata.blocks).toHaveLength(1);
            expect(result.metadata.blocks[0]).toMatchObject({
                index: 0,
                type: 'text',
                size: 12,
            });
            expect(result.metadata.totalSize).toBe(12);
        });
        it('should process single code block', async () => {
            const blocks = [
                {
                    type: 'code',
                    value: 'console.log("hello");',
                    language: 'javascript',
                    filename: 'test.js',
                },
            ];
            const result = await contentProcessor.processContent(blocks);
            expect(result.value).toContain('# File: test.js');
            expect(result.value).toContain('```javascript');
            expect(result.value).toContain('console.log("hello");');
            expect(result.value).toContain('```');
            expect(result.metadata.blocks).toHaveLength(1);
            expect(result.metadata.blocks[0].type).toBe('code');
        });
        it('should process single image block', async () => {
            const blocks = [
                {
                    type: 'image',
                    value: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
                    mimeType: 'image/png',
                    filename: 'test.png',
                },
            ];
            const result = await contentProcessor.processContent(blocks);
            expect(result.value).toContain('# Image: test.png');
            expect(result.value).toContain('[Image data: image/png,');
            expect(result.metadata.blocks).toHaveLength(1);
            expect(result.metadata.blocks[0].type).toBe('image');
        });
        it('should process multiple mixed blocks', async () => {
            const blocks = [
                {
                    type: 'text',
                    value: 'Here is some code:',
                },
                {
                    type: 'code',
                    value: 'const x = 42;',
                    language: 'typescript',
                },
                {
                    type: 'text',
                    value: 'And here is an image:',
                },
                {
                    type: 'image',
                    value: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
                    mimeType: 'image/png',
                },
            ];
            const result = await contentProcessor.processContent(blocks);
            expect(result.value).toContain('Here is some code:');
            expect(result.value).toContain('```typescript');
            expect(result.value).toContain('const x = 42;');
            expect(result.value).toContain('And here is an image:');
            expect(result.value).toContain('[Image data: image/png,');
            expect(result.metadata.blocks).toHaveLength(4);
            expect(result.metadata.totalSize).toBeGreaterThan(0);
        });
        it('should handle unknown content block type', async () => {
            const blocks = [
                {
                    type: 'unknown',
                    data: 'test',
                },
            ];
            await expect(contentProcessor.processContent(blocks)).rejects.toThrow(types_1.ProtocolError);
            await expect(contentProcessor.processContent(blocks)).rejects.toThrow('Unknown content block type: unknown');
        });
    });
    describe('text block processing', () => {
        it('should sanitize text content', async () => {
            const blocks = [
                {
                    type: 'text',
                    value: 'Hello\r\nworld\r\nwith\0null\rbytes',
                },
            ];
            const result = await contentProcessor.processContent(blocks);
            expect(result.value).toBe('Hello\nworld\nwithnull\nbytes');
            expect(result.metadata.blocks[0].sanitized).toBe(true);
        });
        it('should preserve clean text as-is', async () => {
            const blocks = [
                {
                    type: 'text',
                    value: 'Clean text content',
                },
            ];
            const result = await contentProcessor.processContent(blocks);
            expect(result.value).toBe('Clean text content');
            expect(result.metadata.blocks[0].sanitized).toBe(false);
        });
        it('should handle text with metadata', async () => {
            const blocks = [
                {
                    type: 'text',
                    value: 'Text with metadata',
                    metadata: { source: 'user', priority: 'high' },
                },
            ];
            const result = await contentProcessor.processContent(blocks);
            expect(result.metadata.blocks[0]).toMatchObject({
                source: 'user',
                priority: 'high',
                originalLength: 18,
            });
        });
    });
    describe('code block processing', () => {
        it('should format code block with language and filename', async () => {
            const blocks = [
                {
                    type: 'code',
                    value: 'function hello() {\n  return "world";\n}',
                    language: 'javascript',
                    filename: 'hello.js',
                },
            ];
            const result = await contentProcessor.processContent(blocks);
            expect(result.value).toBe('# File: hello.js\n```javascript\nfunction hello() {\n  return "world";\n}\n```');
        });
        it('should format code block with language only', async () => {
            const blocks = [
                {
                    type: 'code',
                    value: 'print("hello")',
                    language: 'python',
                },
            ];
            const result = await contentProcessor.processContent(blocks);
            expect(result.value).toBe('```python\nprint("hello")\n```');
        });
        it('should format code block without language', async () => {
            const blocks = [
                {
                    type: 'code',
                    value: 'some code',
                },
            ];
            const result = await contentProcessor.processContent(blocks);
            expect(result.value).toBe('```\nsome code\n```');
        });
        it('should handle code ending without newline', async () => {
            const blocks = [
                {
                    type: 'code',
                    value: 'const x = 1;',
                    language: 'js',
                },
            ];
            const result = await contentProcessor.processContent(blocks);
            expect(result.value).toBe('```js\nconst x = 1;\n```');
        });
        it('should include metadata in result', async () => {
            const blocks = [
                {
                    type: 'code',
                    value: 'test code',
                    language: 'typescript',
                    filename: 'test.ts',
                    metadata: { author: 'dev' },
                },
            ];
            const result = await contentProcessor.processContent(blocks);
            expect(result.metadata.blocks[0]).toMatchObject({
                language: 'typescript',
                filename: 'test.ts',
                codeLength: 9,
                hasLanguageHint: true,
                hasFilename: true,
                author: 'dev',
            });
        });
    });
    describe('image block processing', () => {
        it('should format image block with filename', async () => {
            const blocks = [
                {
                    type: 'image',
                    value: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
                    mimeType: 'image/png',
                    filename: 'pixel.png',
                },
            ];
            const result = await contentProcessor.processContent(blocks);
            expect(result.value).toContain('# Image: pixel.png');
            expect(result.value).toContain('[Image data: image/png,');
        });
        it('should format image block without filename', async () => {
            const blocks = [
                {
                    type: 'image',
                    value: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
                    mimeType: 'image/jpeg',
                },
            ];
            const result = await contentProcessor.processContent(blocks);
            expect(result.value).toContain('# Image (image/jpeg)');
            expect(result.value).toContain('[Image data: image/jpeg,');
        });
        it('should reject invalid base64 image data', async () => {
            const blocks = [
                {
                    type: 'image',
                    value: 'invalid-base64-data!!!',
                    mimeType: 'image/png',
                },
            ];
            await expect(contentProcessor.processContent(blocks)).rejects.toThrow(types_1.ProtocolError);
            await expect(contentProcessor.processContent(blocks)).rejects.toThrow('Invalid base64 image data in block 0');
        });
        it('should include size formatting in output', async () => {
            const largeData = 'A'.repeat(1024 * 2); // 2KB of data
            const blocks = [
                {
                    type: 'image',
                    value: btoa(largeData), // Convert to base64
                    mimeType: 'image/png',
                },
            ];
            const result = await contentProcessor.processContent(blocks);
            expect(result.value).toContain('KB base64'); // Should show size in KB
        });
    });
    describe('parseResponse', () => {
        it('should parse simple text response', async () => {
            const response = 'This is a simple text response.';
            const blocks = await contentProcessor.parseResponse(response);
            expect(blocks).toHaveLength(1);
            expect(blocks[0]).toEqual({
                type: 'text',
                value: 'This is a simple text response.',
            });
        });
        it('should parse response with code block', async () => {
            const response = 'Here is some code:\n```javascript\nconsole.log("hello");\n```';
            const blocks = await contentProcessor.parseResponse(response);
            expect(blocks).toHaveLength(2);
            expect(blocks[0].type).toBe('text');
            expect(blocks[1]).toEqual({
                type: 'code',
                language: 'javascript',
                value: 'console.log("hello");',
            });
        });
        it('should parse response with file section', async () => {
            const response = '# File: test.js\n```javascript\nconst x = 1;\n```';
            const blocks = await contentProcessor.parseResponse(response);
            expect(blocks).toHaveLength(1);
            expect(blocks[0]).toEqual({
                type: 'code',
                language: 'javascript',
                value: 'const x = 1;',
                filename: 'test.js',
            });
        });
        it('should parse response with image reference', async () => {
            const response = '# Image: test.png\n[Image data: image/png, 1.2KB base64]';
            const blocks = await contentProcessor.parseResponse(response);
            expect(blocks).toHaveLength(1);
            expect(blocks[0]).toEqual({
                type: 'text',
                value: '# Image: test.png\n[Image data: image/png, 1.2KB base64]',
                metadata: { isImageReference: true },
            });
        });
        it('should parse complex mixed response', async () => {
            const response = `Here's the solution:

# File: solution.ts
\`\`\`typescript
function solve(n: number): number {
  return n * 2;
}
\`\`\`

And here's a test:

\`\`\`javascript
console.log(solve(5)); // 10
\`\`\`

That should work!`;
            const blocks = await contentProcessor.parseResponse(response);
            expect(blocks.length).toBeGreaterThan(1);
            // Should have text, code with filename, and code without filename
            const textBlocks = blocks.filter((b) => b.type === 'text');
            const codeBlocks = blocks.filter((b) => b.type === 'code');
            expect(textBlocks.length).toBeGreaterThan(0);
            expect(codeBlocks.length).toBeGreaterThanOrEqual(1);
            // Check if we have the expected code blocks
            expect(codeBlocks.some((b) => b.language === 'typescript')).toBe(true);
            expect(codeBlocks.some((b) => b.language === 'javascript')).toBe(true);
        });
    });
    describe('processStreamChunk', () => {
        it('should process text chunk', async () => {
            const chunk = 'Hello world!\n';
            const block = await contentProcessor.processStreamChunk(chunk);
            expect(block).toEqual({
                type: 'text',
                value: 'Hello world!\n',
            });
        });
        it('should process code chunk', async () => {
            const chunk = '```javascript\nconsole.log("test");\n```\n';
            let block = await contentProcessor.processStreamChunk(chunk);
            // First call may return null (waiting for more content)
            // Call finalizeStreaming to get the complete code block
            if (!block) {
                block = contentProcessor.finalizeStreaming();
            }
            expect(block).toEqual({
                type: 'code',
                language: 'javascript',
                value: 'console.log("test");\n```\n',
            });
        });
        it('should process code chunk without language', async () => {
            const chunk = '```\nsome code\n```\n';
            let block = await contentProcessor.processStreamChunk(chunk);
            // First call may return null (waiting for more content)
            // Call finalizeStreaming to get the complete code block
            if (!block) {
                block = contentProcessor.finalizeStreaming();
            }
            expect(block).toEqual({
                type: 'code',
                value: 'some code\n```\n',
            });
        });
        it('should process image reference chunk', async () => {
            const chunk = 'Check out this [Image data: image/png, 1.5KB base64] screenshot!\n';
            const block = await contentProcessor.processStreamChunk(chunk);
            expect(block).toEqual({
                type: 'text',
                value: 'Check out this',
            });
        });
        it('should handle null/invalid chunk data', async () => {
            expect(await contentProcessor.processStreamChunk(null)).toBeNull();
            expect(await contentProcessor.processStreamChunk(undefined)).toBeNull();
            expect(await contentProcessor.processStreamChunk(123)).toBeNull();
        });
    });
    describe('getContentStats', () => {
        it('should return stats for empty array', () => {
            const stats = contentProcessor.getContentStats([]);
            expect(stats).toEqual({
                total: 0,
                byType: {},
                totalSize: 0,
            });
        });
        it('should return stats for mixed content', () => {
            const blocks = [
                { type: 'text', value: 'Hello' },
                { type: 'text', value: 'World' },
                { type: 'code', value: 'const x = 1;' },
                {
                    type: 'image',
                    value: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
                    mimeType: 'image/png',
                },
            ];
            const stats = contentProcessor.getContentStats(blocks);
            expect(stats.total).toBe(4);
            expect(stats.byType.text).toBe(2);
            expect(stats.byType.code).toBe(1);
            expect(stats.byType.image).toBe(1);
            expect(stats.totalSize).toBeGreaterThan(0);
        });
    });
    describe('validateContentBlocks', () => {
        it('should validate empty array', () => {
            const result = contentProcessor.validateContentBlocks([]);
            expect(result.valid).toBe(true);
            expect(result.errors).toEqual([]);
        });
        it('should validate valid content blocks', () => {
            const blocks = [
                { type: 'text', value: 'Hello' },
                { type: 'code', value: 'test', language: 'js' },
                {
                    type: 'image',
                    value: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
                    mimeType: 'image/png',
                },
            ];
            const result = contentProcessor.validateContentBlocks(blocks);
            expect(result.valid).toBe(true);
            expect(result.errors).toEqual([]);
        });
        it('should reject non-array input', () => {
            const result = contentProcessor.validateContentBlocks(null);
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('Content blocks must be an array');
        });
        it('should reject invalid block structure', () => {
            const blocks = [
                null,
                { type: 'text' }, // Missing value property
                { value: 'hello' }, // Missing type property
            ];
            const result = contentProcessor.validateContentBlocks(blocks);
            expect(result.valid).toBe(false);
            expect(result.errors.length).toBeGreaterThan(0);
            expect(result.errors.some((e) => e.includes('must be an object'))).toBe(true);
            expect(result.errors.some((e) => e.includes('value content must be a string'))).toBe(true);
            expect(result.errors.some((e) => e.includes('type is required'))).toBe(true);
        });
        it('should reject invalid text block', () => {
            const blocks = [{ type: 'text', value: 123 }];
            const result = contentProcessor.validateContentBlocks(blocks);
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('Block 0: value content must be a string');
        });
        it('should reject invalid code block', () => {
            const blocks = [{ type: 'code', value: 123, language: 456 }];
            const result = contentProcessor.validateContentBlocks(blocks);
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('Block 0: value content must be a string');
            expect(result.errors).toContain('Block 0: language must be a string');
        });
        it('should reject invalid image block', () => {
            const blocks = [
                {
                    type: 'image',
                    // Missing value field entirely
                    mimeType: 123,
                },
            ];
            const result = contentProcessor.validateContentBlocks(blocks);
            expect(result.valid).toBe(false);
            // When value is missing, it's undefined (not a string)
            expect(result.errors).toContain('Block 0: value must be a string');
            expect(result.errors).toContain('Block 0: mimeType is required and must be a string');
        });
        it('should reject unknown content type', () => {
            const blocks = [{ type: 'unknown', value: 'test' }];
            const result = contentProcessor.validateContentBlocks(blocks);
            expect(result.valid).toBe(false);
            expect(result.errors).toContain("Block 0: unknown content type 'unknown'");
        });
    });
    describe('utility methods', () => {
        it('should format data sizes correctly', () => {
            // Test through image processing which uses formatDataSize internally
            const blocks = [
                {
                    type: 'image',
                    value: btoa('A'.repeat(1024)), // 1KB base64
                    mimeType: 'image/png',
                },
            ];
            return contentProcessor.processContent(blocks).then((result) => {
                expect(result.value).toMatch(/\d+\.\d+KB base64/);
            });
        });
        it('should validate base64 correctly', () => {
            const validBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
            const invalidBase64 = 'not-valid-base64!!!';
            const validBlocks = [
                { type: 'image', value: validBase64, mimeType: 'image/png' },
            ];
            const invalidBlocks = [
                { type: 'image', value: invalidBase64, mimeType: 'image/png' },
            ];
            const validResult = contentProcessor.validateContentBlocks(validBlocks);
            const invalidResult = contentProcessor.validateContentBlocks(invalidBlocks);
            expect(validResult.valid).toBe(true);
            expect(invalidResult.valid).toBe(false);
            expect(invalidResult.errors.some((e) => e.includes('valid base64'))).toBe(true);
        });
    });
});
//# sourceMappingURL=content.test.js.map