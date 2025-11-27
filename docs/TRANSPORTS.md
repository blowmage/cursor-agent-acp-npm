# ACP Transport Layer

This document describes the transport layer implementation for the Cursor Agent ACP Adapter.

## Overview

The Cursor Agent ACP Adapter implements the **stdio transport** as specified in the [ACP Transport Specification](https://agentclientprotocol.com/protocol/transports). This is the default and recommended transport mechanism for the Agent Client Protocol.

## Stdio Transport

### Specification Compliance

The stdio transport follows the ACP specification exactly:

1. **Process Model**: Client launches agent as a subprocess
2. **Input Stream**: Agent reads JSON-RPC messages from `stdin`
3. **Output Stream**: Agent writes JSON-RPC messages to `stdout`
4. **Logging Stream**: Agent writes diagnostic logs to `stderr`
5. **Message Delimiter**: Messages are separated by newlines (`\n`)
6. **Message Format**: Each message is a single-line JSON-RPC 2.0 object
7. **No Embedded Newlines**: Messages MUST NOT contain `\n` or `\r` characters

### Implementation Details

#### Web Streams API

The implementation uses the Web Streams API to convert Node.js streams:

```typescript
// stdout: WritableStream<Uint8Array>
const output = new WritableStream<Uint8Array>({
  write(chunk) {
    process.stdout.write(chunk);
  },
});

// stdin: ReadableStream<Uint8Array>
const input = new ReadableStream<Uint8Array>({
  start(controller) {
    process.stdin.on('data', (chunk: Buffer) => {
      controller.enqueue(new Uint8Array(chunk));
    });
    process.stdin.on('end', () => controller.close());
    process.stdin.on('error', (err) => controller.error(err));
  },
});
```

#### SDK Integration

The adapter uses `@agentclientprotocol/sdk` for protocol handling:

```typescript
import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';

// Create newline-delimited JSON stream
const stream = ndJsonStream(output, input);

// Create agent connection
const connection = new AgentSideConnection((conn) => {
  return new AgentImplementation(adapter, conn, logger);
}, stream);
```

#### Buffer Management

The implementation includes stdin buffering to prevent message loss during initialization:

```typescript
// Buffer stdin data before stream starts
const stdinBuffer: Buffer[] = [];
const preDataListener = (chunk: Buffer) => {
  stdinBuffer.push(chunk);
};
process.stdin.on('data', preDataListener);

// Later, drain buffered data into stream
for (const chunk of stdinBuffer) {
  controller.enqueue(new Uint8Array(chunk));
}
stdinBuffer.length = 0;
```

### Message Format

#### Request Example

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}
```

Each message is followed by a newline character (`\n`).

#### Response Example

```json
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentInfo":{"name":"cursor-agent-acp","version":"0.2.0"}}}
```

#### Notification Example (No ID)

```json
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess_123","update":{"sessionUpdate":"available_commands_update"}}}
```

### Error Handling

#### Malformed JSON

If a message contains invalid JSON, the SDK handles the parse error and the connection reports it appropriately.

#### Stream Errors

Stream errors (stdin close, stdout write failure) are propagated through the Web Streams error mechanism:

```typescript
process.stdin.on('error', (err) => {
  controller.error(err);
});
```

#### Connection Lifecycle

The connection closes gracefully when stdin ends:

```typescript
process.stdin.on('end', () => {
  controller.close();
});
```

### Logging

Per ACP specification, diagnostic logging uses `stderr`:

```typescript
// All logger output goes to stderr, not stdout
const logger = createLogger({ level: 'info' });
logger.info('Adapter started'); // → stderr
```

This ensures `stdout` is reserved exclusively for JSON-RPC messages.

## Why Stdio?

The stdio transport is the default for ACP because:

### 1. Universal Support

Every editor and IDE supports subprocess management and can easily integrate an stdio-based agent.

### 2. Simple & Reliable

Stdio is a well-understood IPC mechanism with:
- No network configuration required
- No port conflicts
- No firewall issues
- Clear ownership and lifecycle

### 3. Process Isolation

Each client gets its own agent process:
- Independent state
- Natural sandboxing
- Easy resource limits

### 4. Standard Protocol

The ACP spec defines stdio as the primary transport:
- Documented behavior
- Consistent across implementations
- SDK support

## Testing

### Integration Tests

See [`tests/integration/stdio-transport.test.ts`](../tests/integration/stdio-transport.test.ts) for comprehensive transport-level tests:

- Newline-delimited message format
- Multiple sequential messages
- Error handling
- Large message support
- Concurrent requests

### Unit Tests

See [`tests/unit/adapter/stdio-compliance.test.ts`](../tests/unit/adapter/stdio-compliance.test.ts) for low-level stream tests:

- Web Streams API integration
- Buffer management
- Event handler lifecycle
- Message delimiter handling

## Common Issues

### Message Not Received

**Symptom**: Agent doesn't respond to messages

**Causes**:
1. Message missing newline delimiter
2. Message contains embedded newlines
3. stdout being used for logging

**Solution**:
- Ensure each message ends with `\n`
- Verify messages don't contain `\n` or `\r`
- Use stderr for all logging

### Connection Hangs

**Symptom**: Agent process doesn't exit

**Causes**:
1. stdin not closed by client
2. Agent not listening for stdin end
3. Pending async operations

**Solution**:
- Client must close stdin when done
- Agent waits for `connection.closed`
- Proper async cleanup

### Malformed JSON

**Symptom**: Parse errors or connection failures

**Causes**:
1. Invalid JSON syntax
2. Multi-line JSON formatting
3. Incomplete messages

**Solution**:
- Use `JSON.stringify()` for serialization
- Single-line format only
- Complete messages with `\n`

## Performance Considerations

### Buffering

Node.js streams buffer data automatically, but consider:

- **Large Messages**: May require multiple chunks
- **Backpressure**: Handle write stream backpressure
- **Memory**: Monitor buffer sizes for large payloads

### Throughput

Stdio transport is efficient for most use cases:

- **Typical Latency**: <1ms for small messages
- **Throughput**: Limited by JSON parse/stringify, not I/O
- **Concurrency**: Single-threaded but async operations

## References

- [ACP Transport Specification](https://agentclientprotocol.com/protocol/transports)
- [JSON-RPC 2.0 Specification](https://www.jsonrpc.org/specification)
- [Web Streams API](https://developer.mozilla.org/en-US/docs/Web/API/Streams_API)
- [`@agentclientprotocol/sdk` Documentation](https://www.npmjs.com/package/@agentclientprotocol/sdk)

## Implementation Files

Key files implementing the stdio transport:

- [`src/adapter/cursor-agent-adapter.ts`](../src/adapter/cursor-agent-adapter.ts) - `startStdio()` method
- [`src/adapter/agent-implementation.ts`](../src/adapter/agent-implementation.ts) - Agent interface implementation
- [`src/bin/cursor-agent-acp.ts`](../src/bin/cursor-agent-acp.ts) - CLI entry point

## Future Considerations

The ACP specification mentions a draft HTTP transport proposal, but it is not standardized. This implementation focuses exclusively on the stdio transport as the stable, recommended transport mechanism.

If HTTP support is needed in the future, it should:
1. Wait for ACP spec finalization
2. Use the same SDK types
3. Maintain stdio as the default
4. Be clearly documented as experimental
