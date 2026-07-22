// E2E config — runs the real, prod-hitting deploy test in ./e2e.
// Kept separate from the default `jest` run (which only covers ./src) so
// unit tests stay offline. Gated at runtime on SAPIOM_API_KEY + RUN_E2E.
module.exports = {
  testEnvironment: 'node',
  passWithNoTests: true,
  roots: ['<rootDir>/e2e'],
  testMatch: ['**/*.e2e.spec.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { module: 'commonjs' } }],
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  testTimeout: 300_000,
};
