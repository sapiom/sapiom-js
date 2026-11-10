module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  transform: {
    // Type-check the tests against axios's CommonJS declarations, which
    // describe the build Jest loads. Without the mapping, ts-jest resolves
    // "axios" to index.d.ts for this package's files and to index.d.cts for
    // axios-mock-adapter, and since axios 1.19 an AxiosInstance from one file
    // is not assignable to an AxiosInstance from the other.
    '^.+\\.tsx?$': [
      'ts-jest',
      { tsconfig: { paths: { axios: ['./node_modules/axios/index.d.cts'] } } },
    ],
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
    '!src/index.ts',
  ],
};
