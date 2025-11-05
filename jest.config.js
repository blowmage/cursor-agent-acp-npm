module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
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

  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  // globalTeardown: '<rootDir>/tests/teardown.js', // Disabled for unit tests

  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },

  testTimeout: 10000,
  maxWorkers: 1,
  clearMocks: true,
  restoreMocks: true,
  errorOnDeprecated: true,
  forceExit: true,
  verbose: true,
};
