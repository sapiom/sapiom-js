module.exports = {
  testEnvironment: 'node',
  passWithNoTests: true,
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
