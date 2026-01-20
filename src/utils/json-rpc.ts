/**
 * JSON-RPC 2.0 Utilities
 *
 * Helper functions for JSON-RPC 2.0 protocol compliance.
 * Per spec: https://www.jsonrpc.org/specification
 */

import type {
  Error as JsonRpcError,
  RequestId,
} from '@agentclientprotocol/sdk';

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
 * Uses SDK's Result type structure for type safety and consistency with ACP specification.
 * Note: We use RequestId (null | bigint | string) instead of AnyResponse.id (string | number | null)
 * to match ACP SDK types.
 *
 * @param id - The request ID (per ACP SDK: null | bigint | string)
 * @param error - The error object (ACP Error type)
 * @returns JSON-RPC error response with ACP-compliant RequestId
 */
export function createErrorResponse(
  id: RequestId | undefined,
  error: JsonRpcError
): {
  jsonrpc: '2.0';
  id: RequestId;
  error: JsonRpcError;
} {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error,
  };
}

/**
 * Converts a request ID from AnyRequest format (string | number | null) to RequestId (null | bigint | string)
 * Per JSON-RPC 2.0 spec, request IDs can be string, number, or null
 * Per ACP SDK, RequestId is null | bigint | string
 *
 * This function bridges the gap between AnyRequest.id (which uses number) and RequestId (which uses bigint).
 * Numeric IDs are converted to bigint; fractional numeric IDs are truncated to their integer part before
 * conversion, and a warning is logged to make this behavior explicit.
 */
export function toRequestId(id: string | number | null | undefined): RequestId {
  if (id === null || id === undefined) {
    return null;
  }
  if (typeof id === 'number') {
    // Validate numeric ID before converting to bigint to avoid silent, surprising behavior.
    if (!Number.isFinite(id)) {
      throw new TypeError(
        'JSON-RPC request id must be a finite number when provided as a numeric value.'
      );
    }

    if (!Number.isInteger(id)) {
      // JSON-RPC 2.0 discourages fractional IDs; we truncate to the integer part but also log a warning
      // so that this potentially surprising behavior is visible at runtime.
      // eslint-disable-next-line no-console
      console.warn(
        `Fractional JSON-RPC request id '${id}' received; truncating to integer part before bigint conversion.`
      );
    }

    const truncated = Math.trunc(id);
    return BigInt(truncated);
  }
  return id;
}

/**
 * Creates a JSON-RPC 2.0 success response
 *
 * Uses SDK's Result type structure for type safety and consistency with ACP specification.
 * Note: We use RequestId (null | bigint | string) instead of AnyResponse.id (string | number | null)
 * to match ACP SDK types.
 *
 * @param id - The request ID (per ACP SDK: null | bigint | string)
 * @param result - The result object
 * @returns JSON-RPC success response with ACP-compliant RequestId, conforming to Result<T> structure
 */
export function createSuccessResponse<T>(
  id: RequestId | undefined,
  result: T
): {
  jsonrpc: '2.0';
  id: RequestId;
  result: T;
} {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
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
