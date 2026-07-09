module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: 'tsconfig.json',
    tsconfigRootDir: __dirname,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  root: true,
  env: {
    node: true,
  },
  // src/**/__fixtures__ is excluded from tsconfig.json (some fixtures are
  // deliberately broken), so typed linting cannot parse it either.
  ignorePatterns: [
    '.eslintrc.cjs',
    'vitest.config.ts',
    'dist',
    'node_modules',
    'web',
    'src/**/__fixtures__',
  ],
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
  },
};
