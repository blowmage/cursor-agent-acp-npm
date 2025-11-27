/**
 * JSON-RPC 2.0 Utilities
 *
 * Helper functions for JSON-RPC 2.0 protocol compliance.
 * Per spec: https://www.jsonrpc.org/specification
 */

import type { Error as JsonRpcError } from '@agentclientprotocol/sdk';

/**
 * Result of parameter validation
 */
export type ParamsValidationResult =
  | {
      valid: true;
      params: Record<string, unknown>;
    }
  | {
      valid: false;
      error: JsonRpcError;
    };

/**
 * Validates JSON-RPC 2.0 params for methods expecting object parameters.
 *
 * Per JSON-RPC 2.0 spec, params can be:
 * - An object (structured named parameters)
 * - An array (positional parameters)
 * - Omitted entirely (undefined)
 *
 * For ACP methods that require named parameters, this function validates
 * that params is an object and returns a proper JSON-RPC error (-32602)
 * if it's an array or primitive type.
 *
 * @param params - The request params to validate
 * @param methodName - The method name (for error messages)
 * @returns Validation result with either valid params or error
 *
 * @example
 * ```typescript
 * const validation = validateObjectParams(request.params, 'session/new');
 * if (!validation.valid) {
 *   return {
 *     jsonrpc: '2.0',
 *     id: request.id,
 *     error: validation.error,
 *   };
 * }
 * const params = validation.params;
 * ```
 */
export function validateObjectParams(
  params: unknown,
  methodName: string
): ParamsValidationResult {
  // Per JSON-RPC 2.0: undefined/null params are valid (treated as no params)
  if (params === undefined || params === null) {
    return { valid: true, params: {} };
  }

  // Check if params is an array (not allowed for named parameter methods)
  if (Array.isArray(params)) {
    return {
      valid: false,
      error: {
        code: -32602,
        message: `Invalid params for ${methodName}: expected object, got array`,
        data: {
          received: 'array',
          expected: 'object',
        },
      },
    };
  }

  // Check if params is a primitive type
  if (typeof params !== 'object') {
    return {
      valid: false,
      error: {
        code: -32602,
        message: `Invalid params for ${methodName}: expected object, got ${typeof params}`,
        data: {
          received: typeof params,
          expected: 'object',
        },
      },
    };
  }

  // params is a valid object
  return { valid: true, params: params as Record<string, unknown> };
}

/**
 * Creates a JSON-RPC 2.0 error response
 *
 * @param id - The request ID
 * @param error - The error object
 * @returns JSON-RPC error response
 */
export function createErrorResponse(
  id: string | number | null,
  error: JsonRpcError
): {
  jsonrpc: '2.0';
  id: string | number | null;
  error: JsonRpcError;
} {
  return {
    jsonrpc: '2.0',
    id,
    error,
  };
}

/**
 * Creates a JSON-RPC 2.0 success response
 *
 * @param id - The request ID
 * @param result - The result object
 * @returns JSON-RPC success response
 */
export function createSuccessResponse<T>(
  id: string | number | null,
  result: T
): {
  jsonrpc: '2.0';
  id: string | number | null;
  result: T;
} {
  return {
    jsonrpc: '2.0',
    id,
    result,
  };
}

/**
 * Standard JSON-RPC 2.0 error codes
 * Per spec: https://www.jsonrpc.org/specification#error_object
 */
export const JsonRpcErrorCode = {
  /** Invalid JSON was received by the server */
  PARSE_ERROR: -32700,
  /** The JSON sent is not a valid Request object */
  INVALID_REQUEST: -32600,
  /** The method does not exist / is not available */
  METHOD_NOT_FOUND: -32601,
  /** Invalid method parameter(s) */
  INVALID_PARAMS: -32602,
  /** Internal JSON-RPC error */
  INTERNAL_ERROR: -32603,
} as const;
