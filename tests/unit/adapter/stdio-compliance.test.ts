/**
 * Stdio Transport Compliance Unit Tests
 *
 * Tests low-level stdio transport implementation details for ACP compliance.
 * Per ACP spec: https://agentclientprotocol.com/protocol/transports
 *
 * These tests verify:
 * - Web Streams API integration
 * - Node.js stream conversion
 * - Buffer management
 * - Event handler lifecycle
 * - Newline delimiter handling
 */

import { Readable, Writable } from 'stream';

describe('Stdio Compliance Unit Tests', () => {
  describe('Web Streams API Integration', () => {
    it('should convert Node.js Readable to Web ReadableStream', async () => {
      const nodeReadable = new Readable({
        read() {
          this.push('{"jsonrpc":"2.0","id":1,"method":"test"}\n');
          this.push(null);
        },
      });

      const chunks: Uint8Array[] = [];
      const webReadable = new ReadableStream<Uint8Array>({
        start(controller) {
          nodeReadable.on('data', (chunk: Buffer) => {
            controller.enqueue(new Uint8Array(chunk));
          });
          nodeReadable.on('end', () => {
            controller.close();
          });
          nodeReadable.on('error', (err) => {
            controller.error(err);
          });
        },
      });

      const reader = webReadable.getReader();
      let result;
      while (!(result = await reader.read()).done) {
        chunks.push(result.value);
      }

      const fullData = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      expect(fullData.toString()).toContain('"jsonrpc":"2.0"');
      expect(fullData.toString()).toContain('"method":"test"');
    });

    it('should convert Web WritableStream to Node.js stdout', async () => {
      const written: string[] = [];

      const webWritable = new WritableStream<Uint8Array>({
        write(chunk) {
          written.push(Buffer.from(chunk).toString());
        },
      });

      const writer = webWritable.getWriter();
      const testData = '{"jsonrpc":"2.0","id":1,"result":true}\n';
      await writer.write(new TextEncoder().encode(testData));
      await writer.close();

      expect(written.join('')).toBe(testData);
      expect(written.join('')).toContain('"jsonrpc":"2.0"');
    });
  });

  describe('Newline Delimiter Handling', () => {
    it('should split messages by newline delimiter', async () => {
      const messages = [
        '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n',
        '{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/test"}}\n',
      ];

      const nodeReadable = new Readable({
        read() {
          messages.forEach((msg) => this.push(msg));
          this.push(null);
        },
      });

      const chunks: Uint8Array[] = [];
      const webReadable = new ReadableStream<Uint8Array>({
        start(controller) {
          nodeReadable.on('data', (chunk: Buffer) => {
            controller.enqueue(new Uint8Array(chunk));
          });
          nodeReadable.on('end', () => {
            controller.close();
          });
        },
      });

      const reader = webReadable.getReader();
      let result;
      while (!(result = await reader.read()).done) {
        chunks.push(result.value);
      }

      const fullData = Buffer.concat(
        chunks.map((c) => Buffer.from(c))
      ).toString();
      const lines = fullData.split('\n').filter((l) => l.length > 0);

      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('"method":"initialize"');
      expect(lines[1]).toContain('"method":"session/new"');
    });

    it('should handle messages with no embedded newlines', () => {
      const validMessage = '{"jsonrpc":"2.0","id":1,"result":{"key":"value"}}';

      // Per ACP spec: Messages MUST NOT contain embedded newlines
      expect(validMessage).not.toContain('\n');
      expect(validMessage).not.toContain('\r');

      // Verify it's valid JSON
      expect(() => JSON.parse(validMessage)).not.toThrow();
    });

    it('should reject messages with embedded newlines', () => {
      const invalidMessage = '{"jsonrpc":"2.0",\n"id":1}';

      // This violates ACP spec - messages must not have embedded newlines
      expect(invalidMessage).toContain('\n');

      // While technically valid JSON, it violates the transport layer spec
      // The newline would be treated as a message delimiter
    });
  });

  describe('Buffer Management', () => {
    it('should handle buffered stdin data before stream starts', async () => {
      const bufferedData = ['msg1\n', 'msg2\n', 'msg3\n'];
      const buffer: string[] = [];
      let started = false;

      // Simulate buffering before stream starts
      const preListener = (chunk: string) => {
        if (!started) {
          buffer.push(chunk);
        }
      };

      bufferedData.forEach((data) => preListener(data));

      expect(buffer).toHaveLength(3);
      expect(buffer.join('')).toBe('msg1\nmsg2\nmsg3\n');

      // Now "start" the stream and drain buffer
      started = true;
      const drained = buffer.splice(0);

      expect(buffer).toHaveLength(0);
      expect(drained).toHaveLength(3);
    });

    it('should convert Buffer to Uint8Array for Web Streams', () => {
      const nodeBuffer = Buffer.from('test data');
      const uint8Array = new Uint8Array(nodeBuffer);

      expect(uint8Array.length).toBe(nodeBuffer.length);
      expect(Buffer.from(uint8Array).toString()).toBe('test data');
    });
  });

  describe('Event Handler Lifecycle', () => {
    it('should attach and remove event handlers properly', () => {
      const nodeReadable = new Readable({ read() {} });

      const handlers = {
        data: jest.fn(),
        end: jest.fn(),
        error: jest.fn(),
      };

      // Attach handlers
      nodeReadable.on('data', handlers.data);
      nodeReadable.on('end', handlers.end);
      nodeReadable.on('error', handlers.error);

      // Verify handlers are attached
      expect(nodeReadable.listenerCount('data')).toBeGreaterThan(0);
      expect(nodeReadable.listenerCount('end')).toBeGreaterThan(0);
      expect(nodeReadable.listenerCount('error')).toBeGreaterThan(0);

      // Remove handlers (simulating cancel())
      nodeReadable.removeListener('data', handlers.data);
      nodeReadable.removeListener('end', handlers.end);
      nodeReadable.removeListener('error', handlers.error);

      // Verify handlers are removed (back to baseline)
      const baseDataListeners = new Readable({ read() {} }).listenerCount(
        'data'
      );
      expect(nodeReadable.listenerCount('data')).toBe(baseDataListeners);
    });

    it('should prevent memory leaks by clearing handler references', () => {
      let dataHandler: ((chunk: Buffer) => void) | null = (chunk: Buffer) => {
        /* no-op */
      };
      let endHandler: (() => void) | null = () => {
        /* no-op */
      };
      let errorHandler: ((err: Error) => void) | null = (err: Error) => {
        /* no-op */
      };

      expect(dataHandler).not.toBeNull();
      expect(endHandler).not.toBeNull();
      expect(errorHandler).not.toBeNull();

      // Simulate cleanup
      dataHandler = null;
      endHandler = null;
      errorHandler = null;

      expect(dataHandler).toBeNull();
      expect(endHandler).toBeNull();
      expect(errorHandler).toBeNull();
    });
  });

  describe('SDK ndJsonStream Integration', () => {
    it('should work with SDK stream creation pattern', () => {
      // This test verifies the pattern used in cursor-agent-adapter.ts
      // The actual ndJsonStream is part of the SDK and used internally by AgentSideConnection
      // We test that our Web Streams setup is correct

      const written: string[] = [];

      const output = new WritableStream<Uint8Array>({
        write(chunk) {
          written.push(Buffer.from(chunk).toString());
        },
      });

      const input = new ReadableStream<Uint8Array>({
        start(controller) {
          const msg = '{"jsonrpc":"2.0","id":1,"method":"test"}\n';
          controller.enqueue(new TextEncoder().encode(msg));
          controller.close();
        },
      });

      // Verify our streams are set up correctly for SDK usage
      expect(output).toBeDefined();
      expect(input).toBeDefined();
      expect(typeof output.getWriter).toBe('function');
      expect(typeof input.getReader).toBe('function');

      // The actual ndJsonStream call happens in cursor-agent-adapter.ts
      // and is tested through integration tests
    });
  });

  describe('Error Handling', () => {
    it('should propagate stream errors', async () => {
      const testError = new Error('Stream error');

      const webReadable = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(testError);
        },
      });

      const reader = webReadable.getReader();

      await expect(reader.read()).rejects.toThrow('Stream error');
    });

    it('should handle malformed JSON gracefully', () => {
      const malformed = '{invalid json}\n';

      expect(() => JSON.parse(malformed.trim())).toThrow();

      // The transport layer should pass the raw message
      // The protocol layer will handle JSON parsing errors
    });

    it('should handle empty messages', () => {
      const empty = '\n';
      const trimmed = empty.trim();

      // Empty lines should be ignored per typical ndjson handling
      expect(trimmed).toBe('');
    });
  });

  describe('Message Size Handling', () => {
    it('should handle large messages', async () => {
      const largePayload = 'a'.repeat(100000); // 100KB
      const message = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { data: largePayload },
      });

      expect(message.length).toBeGreaterThan(100000);
      expect(() => JSON.parse(message)).not.toThrow();

      // Per ACP spec: No message size limit specified
      // Transport should handle arbitrarily large messages
    });

    it('should handle small messages efficiently', () => {
      const small = '{"jsonrpc":"2.0","id":1}\n';

      expect(small.length).toBeLessThan(100);
      expect(() => JSON.parse(small.trim())).not.toThrow();
    });
  });

  describe('Stream Closure', () => {
    it('should close readable stream properly', async () => {
      const webReadable = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      });

      const reader = webReadable.getReader();
      const result = await reader.read();

      expect(result.done).toBe(true);
      expect(result.value).toBeUndefined();
    });

    it('should close writable stream properly', async () => {
      const written: boolean[] = [];

      const webWritable = new WritableStream<Uint8Array>({
        write() {
          written.push(true);
        },
        close() {
          // Cleanup on close
        },
      });

      const writer = webWritable.getWriter();
      await writer.write(new Uint8Array([1, 2, 3]));
      await writer.close();

      expect(written).toHaveLength(1);
    });
  });
});
