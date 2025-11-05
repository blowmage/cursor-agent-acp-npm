declare global {
  namespace jest {
    interface Matchers<R> {
      toBeValidSessionId(): R;
      toBeValidAcpResponse(): R;
      toBeValidInitializeResult(): R;
    }
  }
}
export declare const testHelpers: {
  createMockAcpRequest: (
    method: string,
    params?: any,
    id?: string | number
  ) => {
    jsonrpc: '2.0';
    method: string;
    params: any;
    id: string | number;
  };
  createMockAcpResponse: (
    result: any,
    id?: string | number
  ) => {
    jsonrpc: '2.0';
    result: any;
    id: string | number;
  };
  createMockAcpError: (
    code: number,
    message: string,
    id?: string | number
  ) => {
    jsonrpc: '2.0';
    error: {
      code: number;
      message: string;
    };
    id: string | number;
  };
  generateTestSessionId: () => string;
  wait: (ms: number) => Promise<void>;
  createTempDir: () => Promise<string>;
  cleanupTempDir: (dirPath: string) => Promise<void>;
};
export declare const TEST_CONSTANTS: {
  readonly DEFAULT_TIMEOUT: 5000;
  readonly LONG_TIMEOUT: 10000;
  readonly SHORT_TIMEOUT: 1000;
  readonly MOCK_SESSION_ID: 'mock-session-12345';
  readonly MOCK_USER_ID: 'test-user';
  readonly SAMPLE_TEXT_CONTENT: 'This is sample text content for testing';
  readonly SAMPLE_CODE_CONTENT: 'console.log("Hello, world!");';
  readonly ACP_PROTOCOL_VERSION: 1;
};
//# sourceMappingURL=setup.d.ts.map
