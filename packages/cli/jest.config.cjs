module.exports = {
  testEnvironment: 'node',
  passWithNoTests: true,
  // Builds this package (and missing workspace deps) so the analytics e2e
  // suite always runs the current dist/bin.js.
  globalSetup: '<rootDir>/jest.global-setup.cjs',
  // Telemetry defaults live; disable it globally so no test emits to the real
  // production collector. Tests that assert events ARE sent must opt in by
  // setting SAPIOM_ANALYTICS_ENDPOINT to the mock collector.
  setupFiles: ['<rootDir>/jest.telemetry-guard.cjs'],
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {}],
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
