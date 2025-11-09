/**
 * HTTP Stream Adapter for ACP SDK
 *
 * Converts HTTP request/response to the Stream interface required by
 * AgentSideConnection. Enables SDK usage with HTTP transport.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { AnyMessage } from '@agentclientprotocol/sdk';

export interface HttpStream {
  writable: WritableStream<AnyMessage>;
  readable: ReadableStream<AnyMessage>;
}

/**
 * Creates an ACP Stream from HTTP request and response objects
 *
 * This adapter allows AgentSideConnection to work over HTTP by:
 * - Reading the request body as a single JSON-RPC message
 * - Buffering the response and sending when the connection closes
 * - Handling HTTP-specific concerns (headers, status codes)
 *
 * Note: HTTP is inherently request/response, not streaming like stdio.
 * Each HTTP request creates a new connection that closes after one message.
 *
 * **IMPORTANT:** The writable stream only supports a single write() call.
 * Multiple writes will throw an error to prevent silent data loss.
 */
export function httpToStream(
  req: IncomingMessage,
  res: ServerResponse
): HttpStream {
  let responseBuffer: AnyMessage | null = null;
  let responseWritten = false;

  // Readable stream - reads the HTTP request body
  const readable = new ReadableStream<AnyMessage>({
    async start(controller) {
      try {
        // Read the entire request body
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
        }
        const body = Buffer.concat(chunks).toString('utf-8');

        if (body.trim()) {
          try {
            const message = JSON.parse(body) as AnyMessage;
            controller.enqueue(message);
          } catch (error) {
            controller.error(
              new Error(
                `Invalid JSON in request body: ${error instanceof Error ? error.message : String(error)}`
              )
            );
            return;
          }
        }

        // HTTP is single request/response - close after reading
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  // Writable stream - buffers the response for HTTP
  const writable = new WritableStream<AnyMessage>({
    write(message) {
      // Prevent silent data loss - HTTP supports only one response per request
      if (responseBuffer !== null) {
        throw new Error(
          'HTTP stream does not support multiple writes. ' +
            'Each HTTP request can only send one response message. ' +
            'Previous message would be silently discarded.'
        );
      }
      // Buffer the response message
      // HTTP will send it when the stream closes
      responseBuffer = message;
    },

    close() {
      // Send the buffered response
      if (responseBuffer && !responseWritten) {
        try {
          const responseBody = JSON.stringify(responseBuffer);

          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(responseBody),
            'Access-Control-Allow-Origin': '*',
          });
          res.end(responseBody);
          responseWritten = true;
        } catch (error) {
          if (!responseWritten) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: null,
                error: {
                  code: -32603,
                  message: 'Internal error',
                  data: error instanceof Error ? error.message : String(error),
                },
              })
            );
            responseWritten = true;
          }
        }
      } else if (!responseWritten) {
        // No response buffer (notification) - send 204 No Content
        res.writeHead(204);
        res.end();
        responseWritten = true;
      }
    },

    abort(error) {
      // Handle stream abortion
      if (!responseWritten) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: {
              code: -32603,
              message: 'Connection aborted',
              data: error instanceof Error ? error.message : String(error),
            },
          })
        );
        responseWritten = true;
      }
    },
  });

  return { readable, writable };
}

/**
 * Creates an ACP Stream that wraps the HTTP stream with ndjson encoding
 *
 * This is a compatibility wrapper that provides the same interface as
 * ndJsonStream but works with HTTP request/response objects.
 */
export function httpStream(
  req: IncomingMessage,
  res: ServerResponse
): HttpStream {
  return httpToStream(req, res);
}
