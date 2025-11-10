/**
 * Configuration validation utility module
 *
 * Provides validation functions for the Cursor Agent ACP Adapter configuration.
 */

import type {
  AdapterConfig,
  ValidationResult,
  ConfigValidationRule,
} from '../types';

/**
 * Validation rules for the adapter configuration
 */
const CONFIG_VALIDATION_RULES: ConfigValidationRule[] = [
  {
    path: 'logLevel',
    type: 'string',
    required: true,
    validator: (value: any) =>
      ['error', 'warn', 'info', 'debug'].includes(value),
  },
  {
    path: 'sessionDir',
    type: 'string',
    required: true,
  },
  {
    path: 'maxSessions',
    type: 'number',
    required: true,
    min: 1,
    max: 1000,
  },
  {
    path: 'sessionTimeout',
    type: 'number',
    required: true,
    min: 60000, // 1 minute
    max: 86400000, // 24 hours
  },
  {
    path: 'tools.filesystem.enabled',
    type: 'boolean',
    required: true,
  },
  {
    path: 'tools.terminal.enabled',
    type: 'boolean',
    required: true,
  },
  {
    path: 'tools.terminal.maxProcesses',
    type: 'number',
    required: true,
    min: 1,
    max: 20,
  },
  {
    path: 'cursor.timeout',
    type: 'number',
    required: true,
    min: 5000, // 5 seconds
    max: 300000, // 5 minutes
  },
  {
    path: 'cursor.retries',
    type: 'number',
    required: true,
    min: 0,
    max: 10,
  },
];

/**
 * Validates the adapter configuration
 */
export function validateConfig(config: AdapterConfig): ValidationResult {
  const errors: string[] = [];

  for (const rule of CONFIG_VALIDATION_RULES) {
    const value = getNestedValue(config, rule.path);
    const error = validateValue(value, rule, rule.path);
    if (error) {
      errors.push(error);
    }
  }

  // Additional custom validations
  const customErrors = performCustomValidations(config);
  errors.push(...customErrors);

  return {
    valid: errors.length === 0,
    errors,
  };
}

// Helper functions

/**
 * Gets a nested value from an object using dot notation
 */
function getNestedValue(obj: any, path: string): any {
  return path.split('.').reduce((current, key) => {
    return current?.[key];
  }, obj);
}

/**
 * Validates a single value against a rule
 */
function validateValue(
  value: any,
  rule: ConfigValidationRule,
  path: string
): string | null {
  // Check if required
  if (rule.required && (value === undefined || value === null)) {
    return `Missing required configuration: ${path}`;
  }

  if (value === undefined || value === null) {
    return null; // Optional value not provided
  }

  // Check type
  const actualType = Array.isArray(value) ? 'array' : typeof value;
  if (actualType !== rule.type) {
    return `Invalid type for ${path}: expected ${rule.type}, got ${actualType}`;
  }

  // Check numeric constraints
  if (rule.type === 'number') {
    if (rule.min !== undefined && value < rule.min) {
      return `Value for ${path} is too small: ${value} (minimum: ${rule.min})`;
    }
    if (rule.max !== undefined && value > rule.max) {
      return `Value for ${path} is too large: ${value} (maximum: ${rule.max})`;
    }
  }

  // Check string pattern
  if (rule.type === 'string' && rule.pattern && !rule.pattern.test(value)) {
    return `Value for ${path} does not match required pattern`;
  }

  // Custom validator
  if (rule.validator && !rule.validator(value)) {
    return `Invalid value for ${path}: ${String(value)}`;
  }

  return null;
}

/**
 * Performs additional custom validations
 */
function performCustomValidations(config: AdapterConfig): string[] {
  const errors: string[] = [];

  // Validate session timeout is reasonable
  if (config.sessionTimeout < 60000) {
    errors.push('Session timeout should be at least 1 minute');
  }

  // Validate cursor timeout vs retries
  const totalTimeout = config.cursor.timeout * (config.cursor.retries + 1);
  if (totalTimeout > 600000) {
    // 10 minutes
    errors.push(
      'Total cursor command timeout (timeout * retries) should not exceed 10 minutes'
    );
  }

  return errors;
}
