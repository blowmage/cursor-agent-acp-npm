/**
 * Unit tests for JSON-RPC 2.0 utilities
 */

import {
  validateObjectParams,
  createErrorResponse,
  createSuccessResponse,
  JsonRpcErrorCode,
} from '../../../src/utils/json-rpc';

describe('JSON-RPC Utilities', () => {
  describe('validateObjectParams', () => {
    it('should accept undefined params', () => {
      const result = validateObjectParams(undefined, 'test/method');

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.params).toEqual({});
      }
    });

    it('should accept null params', () => {
      const result = validateObjectParams(null, 'test/method');

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.params).toEqual({});
      }
    });

    it('should accept object params', () => {
      const params = { key: 'value', number: 42 };
      const result = validateObjectParams(params, 'test/method');

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.params).toEqual(params);
      }
    });

    it('should accept empty object params', () => {
      const result = validateObjectParams({}, 'test/method');

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.params).toEqual({});
      }
    });

    it('should reject array params', () => {
      const result = validateObjectParams([1, 2, 3], 'test/method');

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error.code).toBe(-32602);
        expect(result.error.message).toContain('expected object, got array');
        expect(result.error.data).toEqual({
          received: 'array',
          expected: 'object',
        });
      }
    });

    it('should reject string params', () => {
      const result = validateObjectParams('string-param', 'test/method');

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error.code).toBe(-32602);
        expect(result.error.message).toContain('expected object, got string');
        expect(result.error.data).toEqual({
          received: 'string',
          expected: 'object',
        });
      }
    });

    it('should reject number params', () => {
      const result = validateObjectParams(42, 'test/method');

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error.code).toBe(-32602);
        expect(result.error.message).toContain('expected object, got number');
        expect(result.error.data).toEqual({
          received: 'number',
          expected: 'object',
        });
      }
    });

    it('should reject boolean params', () => {
      const result = validateObjectParams(true, 'test/method');

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error.code).toBe(-32602);
        expect(result.error.message).toContain('expected object, got boolean');
        expect(result.error.data).toEqual({
          received: 'boolean',
          expected: 'object',
        });
      }
    });

    it('should include method name in error message', () => {
      const result = validateObjectParams([1, 2], 'session/new');

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error.message).toContain('session/new');
      }
    });
  });

  describe('createErrorResponse', () => {
    it('should create proper error response structure', () => {
      const error = {
        code: -32602,
        message: 'Invalid params',
      };

      const response = createErrorResponse(1, error);

      expect(response).toEqual({
        jsonrpc: '2.0',
        id: 1,
        error,
      });
    });

    it('should handle null id', () => {
      const error = {
        code: -32600,
        message: 'Invalid Request',
      };

      const response = createErrorResponse(null, error);

      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBeNull();
      expect(response.error).toEqual(error);
    });

    it('should handle string id', () => {
      const error = {
        code: -32601,
        message: 'Method not found',
      };

      const response = createErrorResponse('req-123', error);

      expect(response.id).toBe('req-123');
    });
  });

  describe('createSuccessResponse', () => {
    it('should create proper success response structure', () => {
      const result = { success: true, data: 'test' };

      const response = createSuccessResponse(1, result);

      expect(response).toEqual({
        jsonrpc: '2.0',
        id: 1,
        result,
      });
    });

    it('should handle null result', () => {
      const response = createSuccessResponse(2, null);

      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe(2);
      expect(response.result).toBeNull();
    });

    it('should handle array result', () => {
      const result = [1, 2, 3];
      const response = createSuccessResponse(3, result);

      expect(response.result).toEqual(result);
    });
  });

  describe('JsonRpcErrorCode', () => {
    it('should have standard error codes', () => {
      expect(JsonRpcErrorCode.PARSE_ERROR).toBe(-32700);
      expect(JsonRpcErrorCode.INVALID_REQUEST).toBe(-32600);
      expect(JsonRpcErrorCode.METHOD_NOT_FOUND).toBe(-32601);
      expect(JsonRpcErrorCode.INVALID_PARAMS).toBe(-32602);
      expect(JsonRpcErrorCode.INTERNAL_ERROR).toBe(-32603);
    });
  });
});
