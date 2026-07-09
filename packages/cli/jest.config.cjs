module.exports = {
  testEnvironment: 'node',
  passWithNoTests: true,
  // Builds this package (and missing workspace deps) so the analytics e2e
  // suite always runs the current dist/bin.js.
  globalSetup: '<rootDir>/jest.global-setup.cjs',
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
