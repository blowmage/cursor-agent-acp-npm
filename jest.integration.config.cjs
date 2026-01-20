module.exports = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  testMatch: ['**/tests/integration/**/*.test.ts', '**/tests/integration/**/*.spec.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/tests/unit/', '/tests/fixtures/'],

  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@tests/(.*)$': '<rootDir>/tests/$1',
  },

  // Transform ES modules from node_modules that Jest can't handle
  transformIgnorePatterns: [
    'node_modules/(?!(@agentclientprotocol|zod|uuid)/)',
  ],

  setupFiles: ['<rootDir>/tests/integration/env.ts'],
  setupFilesAfterEnv: ['<rootDir>/tests/integration/setup.ts'],
  globalTeardown: '<rootDir>/tests/integration/teardown.ts',
  // testSequencer: '<rootDir>/tests/integration/sequencer.js', // Disabled - not needed with maxWorkers: 1

  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: 'tsconfig.json',
      useESM: true,
    }],
    '^.+\\.m?js$': ['ts-jest', { tsconfig: { module: 'commonjs' } }],
  },

  testTimeout: 10000,
  maxWorkers: 1,
  clearMocks: true,
  restoreMocks: true,
  errorOnDeprecated: true,
  detectOpenHandles: true,
  forceExit: true,
  verbose: true,
};
