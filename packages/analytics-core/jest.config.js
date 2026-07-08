module.exports = {
  testEnvironment: 'node',
  passWithNoTests: true,
  roots: ['<rootDir>/src'],
  // Only *.test.ts / *.spec.ts are test suites; __tests__/ also holds shared helpers.
  testMatch: ['**/?(*.)+(spec|test).ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {}],
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/*.test.ts',
    '!src/**/*.spec.ts',
    '!src/**/__tests__/**',
    '!src/index.ts',
  ],
};
