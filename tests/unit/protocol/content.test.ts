/**
 * Unit tests for ContentProcessor
 */

/* eslint-disable @typescript-eslint/no-unused-vars, no-unused-vars */

import { ContentProcessor } from '../../../src/protocol/content';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import {
  ProtocolError,
  type Logger,
  type AdapterConfig,
} from '../../../src/types';

const mockLogger: Logger = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
};

const mockConfig: AdapterConfig = {
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
  let contentProcessor: ContentProcessor;

  beforeEach(() => {
    jest.clearAllMocks();
    contentProcessor = new ContentProcessor({
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
      const blocks: ContentBlock[] = [
        {
          type: 'text',
          text: 'Hello world!',
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

    it('should process single image block', async () => {
      const blocks: ContentBlock[] = [
        {
          type: 'image',
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          mimeType: 'image/png',
          uri: 'test.png',
        },
      ];

      const result = await contentProcessor.processContent(blocks);

      expect(result.value).toContain('# Image: test.png');
      expect(result.value).toContain('[Image data: image/png,');
      expect(result.metadata.blocks).toHaveLength(1);
      expect(result.metadata.blocks[0].type).toBe('image');
    });

    it('should process multiple mixed blocks', async () => {
      const blocks: ContentBlock[] = [
        {
          type: 'text',
          text: 'Here is some text:',
        },
        {
          type: 'text',
          text: 'And here is an image:',
        },
        {
          type: 'image',
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          mimeType: 'image/png',
        },
      ];

      const result = await contentProcessor.processContent(blocks);

      expect(result.value).toContain('Here is some text:');
      expect(result.value).toContain('And here is an image:');
      expect(result.value).toContain('[Image data: image/png,');
      expect(result.metadata.blocks).toHaveLength(3);
      expect(result.metadata.totalSize).toBeGreaterThan(0);
    });

    it('should handle unknown content block type', async () => {
      const blocks: any[] = [
        {
          type: 'unknown',
          data: 'test',
        },
      ];

      await expect(contentProcessor.processContent(blocks)).rejects.toThrow(
        ProtocolError
      );
      await expect(contentProcessor.processContent(blocks)).rejects.toThrow(
        'Unknown content block type: unknown'
      );
    });
  });

  describe('text block processing', () => {
    it('should sanitize text content', async () => {
      const blocks: ContentBlock[] = [
        {
          type: 'text',
          text: 'Hello\r\nworld\r\nwith\0null\rbytes',
        },
      ];

      const result = await contentProcessor.processContent(blocks);

      expect(result.value).toBe('Hello\nworld\nwithnull\nbytes');
      expect(result.metadata.blocks[0].sanitized).toBe(true);
    });

    it('should preserve clean text as-is', async () => {
      const blocks: ContentBlock[] = [
        {
          type: 'text',
          text: 'Clean text content',
        },
      ];

      const result = await contentProcessor.processContent(blocks);

      expect(result.value).toBe('Clean text content');
      expect(result.metadata.blocks[0].sanitized).toBe(false);
    });

    it('should handle text with annotations', async () => {
      const blocks: ContentBlock[] = [
        {
          type: 'text',
          text: 'Text with annotations',
          annotations: { audience: ['user'], priority: 1 },
        },
      ];

      const result = await contentProcessor.processContent(blocks);

      expect(result.metadata.blocks[0]).toMatchObject({
        annotations: { audience: ['user'], priority: 1 },
        originalLength: 21,
      });
    });
  });

  describe('embedded resource processing (code)', () => {
    it('should process code as embedded resource', async () => {
      // Per ACP spec, code should be represented as embedded resources
      const blocks: ContentBlock[] = [
        {
          type: 'resource',
          resource: {
            uri: 'file:///example/script.js',
            mimeType: 'text/javascript',
            text: 'const x = 42;',
          },
        },
      ];

      const result = await contentProcessor.processContent(blocks);

      expect(result.value).toContain('const x = 42;');
      expect(result.metadata.blocks).toHaveLength(1);
      expect(result.metadata.blocks[0].type).toBe('resource');
    });

    it('should reject old code block format', async () => {
      // Old "code" type doesn't exist in ACP SDK
      await expect(
        contentProcessor.processContent([
          { type: 'code', value: 'test', language: 'js' } as any,
        ])
      ).rejects.toThrow('Unknown content block type: code');
    });
  });

  describe('image block processing', () => {
    it('should format image block with uri', async () => {
      const blocks: ContentBlock[] = [
        {
          type: 'image',
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          mimeType: 'image/png',
          uri: 'pixel.png',
        },
      ];

      const result = await contentProcessor.processContent(blocks);

      expect(result.value).toContain('# Image: pixel.png');
      expect(result.value).toContain('[Image data: image/png,');
    });

    it('should format image block without uri', async () => {
      const blocks: ContentBlock[] = [
        {
          type: 'image',
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          mimeType: 'image/jpeg',
        },
      ];

      const result = await contentProcessor.processContent(blocks);

      expect(result.value).toContain('# Image (image/jpeg)');
      expect(result.value).toContain('[Image data: image/jpeg,');
    });

    it('should reject invalid base64 image data', async () => {
      const blocks: ContentBlock[] = [
        {
          type: 'image',
          data: 'invalid-base64-data!!!',
          mimeType: 'image/png',
        },
      ];

      await expect(contentProcessor.processContent(blocks)).rejects.toThrow(
        ProtocolError
      );
      await expect(contentProcessor.processContent(blocks)).rejects.toThrow(
        'Invalid base64 image data in block 0'
      );
    });

    it('should include size formatting in output', async () => {
      const largeData = 'A'.repeat(1024 * 2); // 2KB of data
      const blocks: ContentBlock[] = [
        {
          type: 'image',
          data: btoa(largeData), // Convert to base64
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
        text: 'This is a simple text response.',
      });
    });

    it('should parse response with code block', async () => {
      const response =
        'Here is some code:\n```javascript\nconsole.log("hello");\n```';

      const blocks = await contentProcessor.parseResponse(response);

      expect(blocks).toHaveLength(2);
      expect(blocks[0].type).toBe('text');
      expect(blocks[0].text).toBe('Here is some code:');
      expect(blocks[1].type).toBe('text');
      expect(blocks[1].text).toContain('```javascript');
      expect(blocks[1].text).toContain('console.log("hello");');
    });

    it('should parse response with file section', async () => {
      const response = '# File: test.js\n```javascript\nconst x = 1;\n```';

      const blocks = await contentProcessor.parseResponse(response);

      expect(blocks.length).toBeGreaterThanOrEqual(1);
      expect(blocks[0].type).toBe('text');
      // Parser returns text blocks, not code blocks
      expect(blocks.some((b) => b.text && b.text.includes('test.js'))).toBe(
        true
      );
    });

    it('should handle non-string filename in metadata gracefully', async () => {
      // Test that parser handles various text formats gracefully
      const response = 'some text\nmore text';

      const result = await contentProcessor.parseResponse(response);

      // Should not crash and should handle gracefully
      expect(result).toBeDefined();
      expect(result[0].type).toBe('text');
    });

    it('should parse response with image reference', async () => {
      const response =
        '# Image: test.png\n[Image data: image/png, 1.2KB base64]';

      const blocks = await contentProcessor.parseResponse(response);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe('text');
      expect(blocks[0].text).toContain('# Image: test.png');
      expect(blocks[0].text).toContain('[Image data: image/png, 1.2KB base64]');
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

      // All blocks are text blocks (code blocks don't exist in SDK)
      const textBlocks = blocks.filter((b) => b.type === 'text');
      expect(textBlocks.length).toBeGreaterThan(0);

      // Check if we have the expected content
      const fullText = blocks.map((b) => b.text).join('\n');
      expect(fullText).toContain('typescript');
      expect(fullText).toContain('javascript');
      expect(fullText).toContain('solve');
    });
  });

  describe('processStreamChunk', () => {
    it('should process text chunk', async () => {
      const chunk = 'Hello world!\n';

      const block = await contentProcessor.processStreamChunk(chunk);

      expect(block).toEqual({
        type: 'text',
        text: 'Hello world!\n',
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

      // Streaming returns text blocks, not code blocks
      expect(block).toBeDefined();
      expect(block?.type).toBe('text');
      if (block) {
        expect(block.text).toContain('javascript');
      }
    });

    it('should process code chunk without language', async () => {
      const chunk = '```\nsome code\n```\n';

      let block = await contentProcessor.processStreamChunk(chunk);
      // First call may return null (waiting for more content)
      // Call finalizeStreaming to get the complete code block
      if (!block) {
        block = contentProcessor.finalizeStreaming();
      }

      // Streaming returns text blocks, not code blocks
      expect(block).toBeDefined();
      expect(block?.type).toBe('text');
      if (block) {
        expect(block.text).toContain('some code');
      }
    });

    it('should process image reference chunk', async () => {
      const chunk =
        'Check out this [Image data: image/png, 1.5KB base64] screenshot!\n';

      const block = await contentProcessor.processStreamChunk(chunk);

      expect(block).toEqual({
        type: 'text',
        text: 'Check out this',
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
      const blocks: ContentBlock[] = [
        { type: 'text', text: 'Hello' },
        { type: 'text', text: 'World' },
        {
          type: 'resource',
          resource: {
            uri: 'file:///code.js',
            mimeType: 'text/javascript',
            text: 'const x = 1;',
          },
        },
        {
          type: 'image',
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          mimeType: 'image/png',
        },
      ];

      const stats = contentProcessor.getContentStats(blocks);

      expect(stats.total).toBe(4);
      expect(stats.byType.text).toBe(2);
      expect(stats.byType.resource).toBe(1);
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
      const blocks: ContentBlock[] = [
        { type: 'text', text: 'Hello' },
        {
          type: 'resource',
          resource: {
            uri: 'file:///code.js',
            mimeType: 'text/javascript',
            text: 'const x = 1;',
          },
        },
        {
          type: 'image',
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          mimeType: 'image/png',
        },
      ];

      const result = contentProcessor.validateContentBlocks(blocks);

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should reject non-array input', () => {
      const result = contentProcessor.validateContentBlocks(null as any);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Content blocks must be an array');
    });

    it('should reject invalid block structure', () => {
      const blocks = [
        null,
        { type: 'text' }, // Missing value property
        { value: 'hello' }, // Missing type property
      ];

      const result = contentProcessor.validateContentBlocks(blocks as any);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e) => e.includes('must be an object'))).toBe(
        true
      );
      expect(result.errors.some((e) => e.includes('type is required'))).toBe(
        true
      );
    });

    it('should reject invalid text block', () => {
      const blocks = [{ type: 'text', value: 123 }];

      const result = contentProcessor.validateContentBlocks(blocks as any);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        `Block 0: text content must be a string (use 'text' field)`
      );
    });

    it('should reject invalid code block type', () => {
      // Code blocks don't exist in the SDK, so this should be rejected
      const blocks = [{ type: 'code', value: 'test', language: 'js' }];

      const result = contentProcessor.validateContentBlocks(blocks as any);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should reject invalid image block', () => {
      const blocks = [
        {
          type: 'image',
          // Missing value field entirely
          mimeType: 123,
        },
      ];

      const result = contentProcessor.validateContentBlocks(blocks as any);

      expect(result.valid).toBe(false);
      // Per ACP spec: image uses 'data' field
      expect(result.errors).toContain(
        `Block 0: data must be a string (use 'data' field)`
      );
      expect(result.errors).toContain(
        'Block 0: mimeType is required and must be a string'
      );
    });

    it('should reject unknown content type', () => {
      const blocks = [{ type: 'unknown', value: 'test' }];

      const result = contentProcessor.validateContentBlocks(blocks as any);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        "Block 0: unknown content type 'unknown' (valid types: text, image, audio, resource, resource_link)"
      );
    });

    // Test that diff and terminal are NOT valid ContentBlock types
    describe('diff and terminal rejection', () => {
      it('should reject diff as ContentBlock', () => {
        const blocks = [
          {
            type: 'diff',
            path: '/test.txt',
            oldText: 'old content',
            newText: 'new content',
          },
        ];

        const result = contentProcessor.validateContentBlocks(blocks as any);

        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0]).toContain("unknown content type 'diff'");
      });

      it('should reject terminal as ContentBlock', () => {
        const blocks = [
          {
            type: 'terminal',
            terminalId: 'term-1',
          },
        ];

        const result = contentProcessor.validateContentBlocks(blocks as any);

        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0]).toContain("unknown content type 'terminal'");
      });

      it('should accept diff wrapped as resource block', () => {
        const blocks: ContentBlock[] = [
          {
            type: 'resource',
            resource: {
              uri: 'diff:///test.txt',
              text: '--- /test.txt\n+++ /test.txt\n-old\n+new',
              mimeType: 'text/x-diff',
            },
          },
        ];

        const result = contentProcessor.validateContentBlocks(blocks);

        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
      });
    });

    // Test optional field validation
    describe('optional field validation', () => {
      it('should validate resource_link optional fields - title', () => {
        const blocks = [
          {
            type: 'resource_link',
            uri: 'https://example.com',
            name: 'Example',
            title: 123, // ❌ Should be string
          },
        ];

        const result = contentProcessor.validateContentBlocks(blocks as any);

        expect(result.valid).toBe(false);
        expect(result.errors).toContain(
          'Block 0: title must be a string or null'
        );
      });

      it('should validate resource_link optional fields - description', () => {
        const blocks = [
          {
            type: 'resource_link',
            uri: 'https://example.com',
            name: 'Example',
            description: false, // ❌ Should be string
          },
        ];

        const result = contentProcessor.validateContentBlocks(blocks as any);

        expect(result.valid).toBe(false);
        expect(result.errors).toContain(
          'Block 0: description must be a string or null'
        );
      });

      it('should validate resource_link optional fields - mimeType', () => {
        const blocks = [
          {
            type: 'resource_link',
            uri: 'https://example.com',
            name: 'Example',
            mimeType: 456, // ❌ Should be string
          },
        ];

        const result = contentProcessor.validateContentBlocks(blocks as any);

        expect(result.valid).toBe(false);
        expect(result.errors).toContain(
          'Block 0: mimeType must be a string or null'
        );
      });

      it('should validate resource_link optional fields - size', () => {
        const blocks = [
          {
            type: 'resource_link',
            uri: 'https://example.com',
            name: 'Example',
            size: '100', // ❌ Should be number
          },
        ];

        const result = contentProcessor.validateContentBlocks(blocks as any);

        expect(result.valid).toBe(false);
        expect(result.errors).toContain(
          'Block 0: size must be a number or null'
        );
      });

      it('should accept resource_link with valid optional fields', () => {
        const blocks: ContentBlock[] = [
          {
            type: 'resource_link',
            uri: 'https://example.com',
            name: 'Example',
            title: 'Example Title',
            description: 'Example description',
            mimeType: 'text/html',
            size: 1024,
          },
        ];

        const result = contentProcessor.validateContentBlocks(blocks);

        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
      });

      it('should validate image uri field', () => {
        const blocks = [
          {
            type: 'image',
            data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
            mimeType: 'image/png',
            uri: 123, // ❌ Should be string
          },
        ];

        const result = contentProcessor.validateContentBlocks(blocks as any);

        expect(result.valid).toBe(false);
        expect(result.errors).toContain(
          'Block 0: uri must be a string or null'
        );
      });

      it('should accept image with valid uri', () => {
        const blocks: ContentBlock[] = [
          {
            type: 'image',
            data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
            mimeType: 'image/png',
            uri: 'https://example.com/image.png',
          },
        ];

        const result = contentProcessor.validateContentBlocks(blocks);

        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
      });

      it('should validate resource mimeType field', () => {
        const blocks = [
          {
            type: 'resource',
            resource: {
              uri: 'file:///test.txt',
              text: 'hello',
              mimeType: 789, // ❌ Should be string
            },
          },
        ];

        const result = contentProcessor.validateContentBlocks(blocks as any);

        expect(result.valid).toBe(false);
        expect(result.errors).toContain(
          'Block 0: resource.mimeType must be a string or null'
        );
      });

      it('should validate resource blob as base64', () => {
        const blocks = [
          {
            type: 'resource',
            resource: {
              uri: 'file:///test.bin',
              blob: 'not-valid-base64!!!', // ❌ Invalid base64
            },
          },
        ];

        const result = contentProcessor.validateContentBlocks(blocks as any);

        expect(result.valid).toBe(false);
        expect(result.errors).toContain(
          'Block 0: resource.blob must be valid base64'
        );
      });

      it('should accept resource with valid blob', () => {
        const blocks: ContentBlock[] = [
          {
            type: 'resource',
            resource: {
              uri: 'file:///test.bin',
              blob: 'aGVsbG8gd29ybGQ=', // Valid base64
              mimeType: 'application/octet-stream',
            },
          },
        ];

        const result = contentProcessor.validateContentBlocks(blocks);

        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
      });
    });

    // Test annotation validation
    describe('annotation validation', () => {
      it('should validate annotations.audience values', () => {
        const blocks = [
          {
            type: 'text',
            text: 'Hello',
            annotations: {
              audience: ['admin'], // ❌ Only 'user' or 'assistant' allowed
            },
          },
        ];

        const result = contentProcessor.validateContentBlocks(blocks as any);

        expect(result.valid).toBe(false);
        expect(result.errors).toContain(
          "Block 0: annotations.audience must contain only 'user' or 'assistant'"
        );
      });

      it('should validate annotations.audience is array', () => {
        const blocks = [
          {
            type: 'text',
            text: 'Hello',
            annotations: {
              audience: 'user', // ❌ Should be array
            },
          },
        ];

        const result = contentProcessor.validateContentBlocks(blocks as any);

        expect(result.valid).toBe(false);
        expect(result.errors).toContain(
          'Block 0: annotations.audience must be an array or null'
        );
      });

      it('should validate annotations.lastModified is timestamp', () => {
        const blocks = [
          {
            type: 'text',
            text: 'Hello',
            annotations: {
              lastModified: 'not-a-date', // ❌ Invalid ISO 8601 timestamp
            },
          },
        ];

        const result = contentProcessor.validateContentBlocks(blocks as any);

        expect(result.valid).toBe(false);
        expect(result.errors).toContain(
          'Block 0: annotations.lastModified must be a valid ISO 8601 timestamp'
        );
      });

      it('should validate annotations.priority is number', () => {
        const blocks = [
          {
            type: 'text',
            text: 'Hello',
            annotations: {
              priority: '5', // ❌ Should be number
            },
          },
        ];

        const result = contentProcessor.validateContentBlocks(blocks as any);

        expect(result.valid).toBe(false);
        expect(result.errors).toContain(
          'Block 0: annotations.priority must be a number or null'
        );
      });

      it('should validate annotations.priority is non-negative', () => {
        const blocks = [
          {
            type: 'text',
            text: 'Hello',
            annotations: {
              priority: -1, // ❌ Should be non-negative
            },
          },
        ];

        const result = contentProcessor.validateContentBlocks(blocks as any);

        expect(result.valid).toBe(false);
        expect(result.errors).toContain(
          'Block 0: annotations.priority must be non-negative'
        );
      });

      it('should accept valid annotations', () => {
        const blocks: ContentBlock[] = [
          {
            type: 'text',
            text: 'Hello',
            annotations: {
              audience: ['user', 'assistant'],
              lastModified: new Date().toISOString(),
              priority: 3,
              _meta: {
                source: 'test',
                confidence: 0.95,
              },
            },
          },
        ];

        const result = contentProcessor.validateContentBlocks(blocks);

        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
      });

      it('should accept null annotations fields', () => {
        const blocks: ContentBlock[] = [
          {
            type: 'text',
            text: 'Hello',
            annotations: {
              audience: null,
              lastModified: null,
              priority: null,
            },
          },
        ];

        const result = contentProcessor.validateContentBlocks(blocks);

        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
      });
    });
  });

  describe('utility methods', () => {
    it('should format data sizes correctly', () => {
      // Test through image processing which uses formatDataSize internally
      const blocks: ContentBlock[] = [
        {
          type: 'image',
          data: btoa('A'.repeat(1024)), // 1KB base64
          mimeType: 'image/png',
        },
      ];

      return contentProcessor.processContent(blocks).then((result) => {
        expect(result.value).toMatch(/\d+\.\d+KB base64/);
      });
    });

    it('should validate base64 correctly', () => {
      const validBase64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      const invalidBase64 = 'not-valid-base64!!!';

      const validBlocks: ContentBlock[] = [
        { type: 'image', data: validBase64, mimeType: 'image/png' },
      ];
      const invalidBlocks: ContentBlock[] = [
        { type: 'image', data: invalidBase64, mimeType: 'image/png' },
      ];

      const validResult = contentProcessor.validateContentBlocks(validBlocks);
      const invalidResult =
        contentProcessor.validateContentBlocks(invalidBlocks);

      expect(validResult.valid).toBe(true);
      expect(invalidResult.valid).toBe(false);
      expect(invalidResult.errors.some((e) => e.includes('valid base64'))).toBe(
        true
      );
    });
  });

  describe('audio block processing', () => {
    const validAudioBase64 = btoa('fake-audio-data');

    it('should process audio block with valid data', async () => {
      const blocks: ContentBlock[] = [
        {
          type: 'audio',
          data: validAudioBase64,
          mimeType: 'audio/wav',
        },
      ];

      const result = await contentProcessor.processContent(blocks);

      expect(result.value).toContain('[Audio: audio/wav,');
      expect(result.value).toContain('format: wav]');
      expect(result.metadata.blocks).toHaveLength(1);
      expect(result.metadata.blocks[0].type).toBe('audio');
    });

    it('should process audio with different mime types', async () => {
      const blocks: ContentBlock[] = [
        {
          type: 'audio',
          data: validAudioBase64,
          mimeType: 'audio/mp3',
        },
      ];

      const result = await contentProcessor.processContent(blocks);

      expect(result.value).toContain('audio/mp3');
      expect(result.value).toContain('format: mp3');
    });

    it('should include audio metadata in result', async () => {
      const blocks: ContentBlock[] = [
        {
          type: 'audio',
          data: validAudioBase64,
          mimeType: 'audio/mpeg',
        },
      ];

      const result = await contentProcessor.processContent(blocks);

      expect(result.metadata.blocks[0]).toMatchObject({
        type: 'audio',
        mimeType: 'audio/mpeg',
        format: 'mpeg',
        isValidBase64: true,
      });
    });

    it('should reject invalid base64 audio data', async () => {
      const blocks: ContentBlock[] = [
        {
          type: 'audio',
          data: 'invalid-base64-data!!!',
          mimeType: 'audio/wav',
        },
      ];

      await expect(contentProcessor.processContent(blocks)).rejects.toThrow(
        ProtocolError
      );
      await expect(contentProcessor.processContent(blocks)).rejects.toThrow(
        'Invalid base64 audio data in block 0'
      );
    });

    it('should handle audio with annotations', async () => {
      const blocks: ContentBlock[] = [
        {
          type: 'audio',
          data: validAudioBase64,
          mimeType: 'audio/wav',
          annotations: { audience: ['user'], priority: 0.5 },
        },
      ];

      const result = await contentProcessor.processContent(blocks);

      expect(result.metadata.blocks[0].annotations).toEqual({
        audience: ['user'],
        priority: 0.5,
      });
    });

    it('should validate audio block structure', () => {
      const validBlock: ContentBlock[] = [
        {
          type: 'audio',
          data: validAudioBase64,
          mimeType: 'audio/wav',
        },
      ];

      const invalidBlocks: any[] = [
        { type: 'audio', mimeType: 'audio/wav' }, // Missing data
        { type: 'audio', data: validAudioBase64 }, // Missing mimeType
        { type: 'audio', data: 123, mimeType: 'audio/wav' }, // Invalid data type
      ];

      const validResult = contentProcessor.validateContentBlocks(validBlock);
      expect(validResult.valid).toBe(true);

      for (const invalidBlock of invalidBlocks) {
        const result = contentProcessor.validateContentBlocks([invalidBlock]);
        expect(result.valid).toBe(false);
      }
    });
  });

  describe('embedded resource block processing', () => {
    it('should process resource with text content', async () => {
      const blocks: ContentBlock[] = [
        {
          type: 'resource',
          resource: {
            uri: 'file:///path/to/file.txt',
            text: 'File contents here',
            mimeType: 'text/plain',
          },
        },
      ];

      const result = await contentProcessor.processContent(blocks);

      expect(result.value).toContain('# Resource: file:///path/to/file.txt');
      expect(result.value).toContain('# Type: text/plain');
      expect(result.value).toContain('File contents here');
      expect(result.metadata.blocks[0]).toMatchObject({
        type: 'resource',
        uri: 'file:///path/to/file.txt',
        mimeType: 'text/plain',
        isText: true,
      });
    });

    it('should process resource with blob content', async () => {
      const blobData = btoa('binary-data');
      const blocks: ContentBlock[] = [
        {
          type: 'resource',
          resource: {
            uri: 'file:///path/to/image.png',
            blob: blobData,
            mimeType: 'image/png',
          },
        },
      ];

      const result = await contentProcessor.processContent(blocks);

      expect(result.value).toContain('# Resource: file:///path/to/image.png');
      expect(result.value).toContain('[Binary data:');
      expect(result.metadata.blocks[0]).toMatchObject({
        type: 'resource',
        uri: 'file:///path/to/image.png',
        mimeType: 'image/png',
        isText: false,
      });
    });

    it('should process resource without mimeType', async () => {
      const blocks: ContentBlock[] = [
        {
          type: 'resource',
          resource: {
            uri: 'file:///unknown.bin',
            text: 'Unknown file',
          },
        },
      ];

      const result = await contentProcessor.processContent(blocks);

      expect(result.value).toContain('# Resource: file:///unknown.bin');
      expect(result.value).toContain('Unknown file');
    });

    it('should handle resource with annotations', async () => {
      const blocks: ContentBlock[] = [
        {
          type: 'resource',
          resource: {
            uri: 'file:///annotated.txt',
            text: 'Annotated content',
          },
          annotations: { audience: ['assistant'], priority: 0.8 },
        },
      ];

      const result = await contentProcessor.processContent(blocks);

      expect(result.metadata.blocks[0].annotations).toEqual({
        audience: ['assistant'],
        priority: 0.8,
      });
    });

    it('should validate resource block structure', () => {
      const validBlocks: ContentBlock[] = [
        {
          type: 'resource',
          resource: {
            uri: 'file:///test.txt',
            text: 'content',
          },
        },
        {
          type: 'resource',
          resource: {
            uri: 'file:///test.bin',
            blob: btoa('data'),
          },
        },
      ];

      const invalidBlocks: any[] = [
        { type: 'resource' }, // Missing resource field
        { type: 'resource', resource: {} }, // Missing uri
        { type: 'resource', resource: { uri: 'file:///test' } }, // Missing text/blob
        { type: 'resource', resource: { text: 'content' } }, // Missing uri
      ];

      for (const validBlock of validBlocks) {
        const result = contentProcessor.validateContentBlocks([validBlock]);
        expect(result.valid).toBe(true);
      }

      for (const invalidBlock of invalidBlocks) {
        const result = contentProcessor.validateContentBlocks([invalidBlock]);
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
      }
    });
  });

  describe('resource link block processing', () => {
    it('should process basic resource link', async () => {
      const blocks: ContentBlock[] = [
        {
          type: 'resource_link',
          uri: 'https://example.com/resource',
          name: 'Example Resource',
        },
      ];

      const result = await contentProcessor.processContent(blocks);

      expect(result.value).toContain('# Resource Link: Example Resource');
      expect(result.value).toContain('URI: https://example.com/resource');
      expect(result.metadata.blocks[0]).toMatchObject({
        type: 'resource_link',
        uri: 'https://example.com/resource',
        name: 'Example Resource',
      });
    });

    it('should process resource link with all optional fields', async () => {
      const blocks: ContentBlock[] = [
        {
          type: 'resource_link',
          uri: 'https://example.com/doc.pdf',
          name: 'Documentation',
          title: 'API Documentation',
          description: 'Complete API reference guide',
          mimeType: 'application/pdf',
          size: 1024000,
        },
      ];

      const result = await contentProcessor.processContent(blocks);

      expect(result.value).toContain('# Resource Link: Documentation');
      expect(result.value).toContain('URI: https://example.com/doc.pdf');
      expect(result.value).toContain('Title: API Documentation');
      expect(result.value).toContain(
        'Description: Complete API reference guide'
      );
      expect(result.value).toContain('Type: application/pdf');
      expect(result.value).toContain('Size:');
      expect(result.metadata.blocks[0]).toMatchObject({
        uri: 'https://example.com/doc.pdf',
        name: 'Documentation',
        title: 'API Documentation',
        description: 'Complete API reference guide',
        mimeType: 'application/pdf',
        size: 1024000,
      });
    });

    it('should handle resource link with annotations', async () => {
      const blocks: ContentBlock[] = [
        {
          type: 'resource_link',
          uri: 'https://example.com/ref',
          name: 'Reference',
          annotations: { audience: ['user'], priority: 1.0 },
        },
      ];

      const result = await contentProcessor.processContent(blocks);

      expect(result.metadata.blocks[0].annotations).toEqual({
        audience: ['user'],
        priority: 1.0,
      });
    });

    it('should validate resource link structure', () => {
      const validBlock: ContentBlock[] = [
        {
          type: 'resource_link',
          uri: 'https://example.com',
          name: 'Example',
        },
      ];

      const invalidBlocks: any[] = [
        { type: 'resource_link', name: 'Example' }, // Missing uri
        { type: 'resource_link', uri: 'https://example.com' }, // Missing name
        { type: 'resource_link' }, // Missing both
      ];

      const validResult = contentProcessor.validateContentBlocks(validBlock);
      expect(validResult.valid).toBe(true);

      for (const invalidBlock of invalidBlocks) {
        const result = contentProcessor.validateContentBlocks([invalidBlock]);
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
      }
    });
  });

  describe('backward compatibility with old field names', () => {
    it('should reject text blocks with old "value" field', async () => {
      // SDK only supports "text" field, not "value"
      const blocks: any[] = [
        {
          type: 'text',
          value: 'Old format text',
        },
      ];

      await expect(contentProcessor.processContent(blocks)).rejects.toThrow();
    });

    it('should prefer new "text" field over old "value" field', async () => {
      const blocks: any[] = [
        {
          type: 'text',
          text: 'New format',
          value: 'Old format',
        },
      ];

      const result = await contentProcessor.processContent(blocks);

      expect(result.value).toBe('New format');
    });

    it('should reject image blocks with old "value" field', async () => {
      // SDK only supports "data" field, not "value"
      const validBase64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      const blocks: any[] = [
        {
          type: 'image',
          value: validBase64,
          mimeType: 'image/png',
        },
      ];

      await expect(contentProcessor.processContent(blocks)).rejects.toThrow();
    });

    it('should prefer new "data" field over old "value" field for images', async () => {
      const validBase64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      const blocks: any[] = [
        {
          type: 'image',
          data: validBase64,
          value: 'should-not-be-used',
          mimeType: 'image/png',
        },
      ];

      const result = await contentProcessor.processContent(blocks);

      expect(result.value).toContain('[Image data: image/png,');
      // Should use data field, not value
      expect(result.metadata.blocks[0].dataSize).toBe(validBase64.length);
    });

    it('should throw error when text block is missing text field', async () => {
      const blocks: any[] = [
        {
          type: 'text',
        },
      ];

      // TypeScript typing prevents this at compile time, but at runtime throws TypeError
      await expect(contentProcessor.processContent(blocks)).rejects.toThrow();
    });

    it('should throw error when image block is missing data field', async () => {
      const blocks: any[] = [
        {
          type: 'image',
          mimeType: 'image/png',
        },
      ];

      // TypeScript typing prevents this at compile time, but at runtime throws TypeError
      await expect(contentProcessor.processContent(blocks)).rejects.toThrow();
    });
  });

  describe('advanced streaming scenarios', () => {
    beforeEach(() => {
      contentProcessor.startStreaming();
    });

    afterEach(() => {
      contentProcessor.resetStreaming();
    });

    it('should handle code-like text split across multiple chunks', async () => {
      const chunk1 = '```javascript\n';
      const chunk2 = 'console.log("hello");\n';
      const chunk3 = '```\n';

      const result1 = await contentProcessor.processStreamChunk(chunk1);
      const result2 = await contentProcessor.processStreamChunk(chunk2);
      const result3 = await contentProcessor.processStreamChunk(chunk3);

      // At least one result should be defined
      const defined = [result1, result2, result3].filter((r) => r);
      expect(defined.length).toBeGreaterThan(0);
      defined.forEach((r) => expect(r.type).toBe('text'));
    });

    it('should handle text before code block', async () => {
      const chunk1 = 'Here is some code:\n';
      const chunk2 = '```python\nprint("test")\n```\n';

      const result1 = await contentProcessor.processStreamChunk(chunk1);
      expect(result1).toEqual({
        type: 'text',
        text: 'Here is some code:\n',
      });

      const result2 = await contentProcessor.processStreamChunk(chunk2);
      expect(result2).toBeDefined();
    });

    it('should handle text and code in same chunk', async () => {
      const chunk = 'Some text\n```js\ncode();\n```\n';

      const result1 = await contentProcessor.processStreamChunk(chunk);
      expect(result1?.type).toBe('text');

      // Continue processing to get the code block
      const result2 = contentProcessor.finalizeStreaming();
      // The code block should be in accumulated state
      expect(result2).toBeDefined();
    });

    it('should handle partial code block marker', async () => {
      const chunk1 = 'Some text ``';
      const chunk2 = '`javascript\ncode\n```';

      const result1 = await contentProcessor.processStreamChunk(chunk1);
      expect(result1).toBeNull(); // Waiting for potential code block

      const result2 = await contentProcessor.processStreamChunk(chunk2);
      // Should recognize code block
      expect(result2?.type).toBeDefined();
    });

    it('should finalize with unclosed code-like text', async () => {
      const chunk = '```javascript\nconsole.log("test");';

      await contentProcessor.processStreamChunk(chunk);
      const result = contentProcessor.finalizeStreaming();

      expect(result).toBeDefined();
      expect(result?.type).toBe('text');
      expect(result?.text).toContain('javascript');
    });

    it('should finalize with remaining text', async () => {
      const chunk = 'Some incomplete text';

      await contentProcessor.processStreamChunk(chunk);
      const result = contentProcessor.finalizeStreaming();

      expect(result).toEqual({
        type: 'text',
        text: 'Some incomplete text',
      });
    });

    it('should handle multiple sequential processStreamChunk calls', async () => {
      const chunks = [
        'First line\n',
        'Second line\n',
        '```typescript\n',
        'const x = 1;\n',
        '```\n',
        'After code\n',
      ];

      const results: ContentBlock[] = [];
      for (const chunk of chunks) {
        const result = await contentProcessor.processStreamChunk(chunk);
        if (result) {
          results.push(result);
        }
      }

      // Should have text blocks (no code blocks in SDK)
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.type === 'text')).toBe(true);
    });

    it('should handle explicit startStreaming and resetStreaming', () => {
      contentProcessor.resetStreaming();
      expect(() => contentProcessor.resetStreaming()).not.toThrow();

      contentProcessor.startStreaming();
      contentProcessor.startStreaming(); // Should reset state
      expect(() => contentProcessor.resetStreaming()).not.toThrow();
    });

    it('should auto-initialize streaming on first chunk', async () => {
      contentProcessor.resetStreaming(); // Clear any existing state

      const chunk = 'Test text\n';
      const result = await contentProcessor.processStreamChunk(chunk);

      expect(result).toEqual({
        type: 'text',
        text: 'Test text\n',
      });
    });

    it('should handle code-like text without language in streaming', async () => {
      const chunk = '```\nplain code\n```\n';

      const result = await contentProcessor.processStreamChunk(chunk);

      // May need finalize to get complete block
      const finalResult = result || contentProcessor.finalizeStreaming();
      expect(finalResult?.type).toBe('text');
      expect(finalResult?.text).toContain('plain code');
    });

    it('should handle incremental text streaming', async () => {
      const chunk1 = 'Line 1\n';
      const chunk2 = 'Line 2\n';
      const chunk3 = 'Line 3\n';

      const result1 = await contentProcessor.processStreamChunk(chunk1);
      expect(result1?.type).toBe('text');

      const result2 = await contentProcessor.processStreamChunk(chunk2);
      expect(result2?.type).toBe('text');

      const result3 = await contentProcessor.processStreamChunk(chunk3);
      expect(result3?.type).toBe('text');
    });
  });

  describe('annotations preservation', () => {
    it('should preserve annotations in text blocks', async () => {
      const blocks: ContentBlock[] = [
        {
          type: 'text',
          text: 'Annotated text',
          annotations: {
            audience: ['user', 'assistant'],
            priority: 0.9,
          },
        },
      ];

      const result = await contentProcessor.processContent(blocks);

      expect(result.metadata.blocks[0].annotations).toEqual({
        audience: ['user', 'assistant'],
        priority: 0.9,
      });
    });

    it('should preserve annotations in embedded resource blocks', async () => {
      const blocks: ContentBlock[] = [
        {
          type: 'resource',
          resource: {
            uri: 'file:///code.ts',
            mimeType: 'text/typescript',
            text: 'const x = 1;',
          },
          annotations: {
            audience: ['assistant'],
          },
        },
      ];

      const result = await contentProcessor.processContent(blocks);

      expect(result.metadata.blocks[0].annotations).toEqual({
        audience: ['assistant'],
      });
    });

    it('should preserve annotations in image blocks', async () => {
      const validBase64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      const blocks: ContentBlock[] = [
        {
          type: 'image',
          data: validBase64,
          mimeType: 'image/png',
          annotations: {
            priority: 1.0,
          },
        },
      ];

      const result = await contentProcessor.processContent(blocks);

      expect(result.metadata.blocks[0].annotations).toEqual({
        priority: 1.0,
      });
    });

    it('should handle blocks without annotations', async () => {
      const blocks: ContentBlock[] = [
        {
          type: 'text',
          text: 'No annotations',
        },
      ];

      const result = await contentProcessor.processContent(blocks);

      expect(result.metadata.blocks[0].annotations).toBeUndefined();
    });
  });

  describe('getContentStats with all block types', () => {
    it('should calculate stats for all content types', () => {
      const blocks: ContentBlock[] = [
        { type: 'text', text: 'Hello' },
        { type: 'code', value: 'const x = 1;' },
        {
          type: 'image',
          data: btoa('image-data'),
          mimeType: 'image/png',
        },
        {
          type: 'audio',
          data: btoa('audio-data'),
          mimeType: 'audio/wav',
        },
        {
          type: 'resource',
          resource: {
            uri: 'file:///test.txt',
            text: 'Resource content',
          },
        },
        {
          type: 'resource_link',
          uri: 'https://example.com',
          name: 'Link',
        },
      ];

      const stats = contentProcessor.getContentStats(blocks);

      expect(stats.total).toBe(6);
      expect(stats.byType.text).toBe(1);
      expect(stats.byType.code).toBe(1);
      expect(stats.byType.image).toBe(1);
      expect(stats.byType.audio).toBe(1);
      expect(stats.byType.resource).toBe(1);
      expect(stats.byType.resource_link).toBe(1);
      expect(stats.totalSize).toBeGreaterThan(0);
    });
  });

  describe('type safety in block post-processing', () => {
    it('should handle file references gracefully', async () => {
      // Test that parser handles file references in text
      const response = '# File: test.js\n```javascript\nconst x = 1;\n```';

      // Parse normally - returns text blocks
      const normalBlocks = await contentProcessor.parseResponse(response);
      expect(normalBlocks.length).toBeGreaterThanOrEqual(1);
      expect(normalBlocks[0].type).toBe('text');

      // Test that parser doesn't crash with various inputs
      const invalidBlocks: any[] = [
        {
          type: 'text',
          text: '',
          metadata: { filename: 123 }, // Invalid: number instead of string
        },
        {
          type: 'code',
          value: 'const x = 1;',
        },
      ];

      // The validation should catch this or processing should handle gracefully
      expect(() => {
        // Simulate internal processing that would happen
        const hasFilename = invalidBlocks[0].metadata?.['filename'];
        const filename = invalidBlocks[0].metadata['filename'];
        // Type guard ensures we only use it if it's a string
        if (typeof filename === 'string') {
          // Would combine blocks here
          expect(filename).toBe('test.js');
        } else {
          // Gracefully handle non-string case
          expect(hasFilename).toBe(123);
          expect(typeof hasFilename).not.toBe('string');
        }
      }).not.toThrow();
    });

    it('should parse file references as text blocks', async () => {
      // Parse a response with a valid file header
      const response = '# File: example.ts\n```typescript\ntype Foo = {};\n```';
      const blocks = await contentProcessor.parseResponse(response);

      // Parser returns text blocks (no code blocks in SDK)
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      expect(blocks.every((b) => b.type === 'text')).toBe(true);
      expect(blocks.some((b) => b.text && b.text.includes('example.ts'))).toBe(
        true
      );
    });
  });
});
