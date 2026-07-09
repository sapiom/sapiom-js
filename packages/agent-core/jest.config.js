module.exports = {
  testEnvironment: 'node',
  passWithNoTests: true,
  // Telemetry defaults live; disable it globally so no test emits to the real
  // production collector. Tests that assert events ARE sent must opt in by
  // setting SAPIOM_ANALYTICS_ENDPOINT to the mock collector.
  setupFiles: ['<rootDir>/jest.telemetry-guard.js'],
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {}],
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@sapiom/tools/stub$': '<rootDir>/../tools/dist/cjs/stub/index.js',
    '^@sapiom/analytics-core/testing$':
      '<rootDir>/../analytics-core/dist/cjs/testing/index.js',
  },
};
