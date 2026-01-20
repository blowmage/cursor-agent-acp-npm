module.exports = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  testMatch: ['**/tests/unit/**/*.test.ts', '**/tests/unit/**/*.spec.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/tests/integration/', '/tests/fixtures/'],

  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/**/index.ts', '!src/bin/**/*'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary', 'html', 'lcov'],
  coverageThreshold: {
    global: { branches: 20, functions: 25, lines: 30, statements: 30 },
  },

  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@tests/(.*)$': '<rootDir>/tests/$1',
  },

  // Transform ES modules from node_modules that Jest can't handle
  transformIgnorePatterns: [
    'node_modules/(?!(@agentclientprotocol|zod|uuid)/)',
  ],

  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  // globalTeardown: '<rootDir>/tests/teardown.js', // Disabled for unit tests

  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: 'tsconfig.json',
      useESM: true,
    }],
    '^.+\\.m?js$': ['ts-jest', {
      tsconfig: {
        module: 'commonjs',
      },
    }],
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
