/**
 * Client Connection Interface
 *
 * Provides an interface for calling ACP client methods. This abstracts
 * the underlying connection mechanism (stdio, HTTP, AgentSideConnection, etc.)
 * and allows the adapter to call client methods in an ACP-compliant way.
 *
 * Per ACP spec: https://agentclientprotocol.com/protocol/file-system
 */

import type {
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk';

/**
 * Interface for calling ACP client methods
 *
 * This interface can be implemented by:
 * - AgentSideConnection (from SDK)
 * - Custom JSON-RPC transport (stdio, HTTP)
 * - Test mocks
 */
export interface ClientConnection {
  /**
   * Call the fs/read_text_file method on the client
   * Per ACP spec: https://agentclientprotocol.com/protocol/file-system
   */
  readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse>;

  /**
   * Call the fs/write_text_file method on the client
   * Per ACP spec: https://agentclientprotocol.com/protocol/file-system
   */
  writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse>;
}
