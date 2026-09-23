/**
 * Deliberately small: rules that catch real mistakes, not style opinions. Formatting is not
 * enforced here — a formatter fight in review costs more than it saves.
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { node: true, es2022: true },
  ignorePatterns: ['dist', 'node_modules', '*.js', '*.cjs'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    '@typescript-eslint/no-non-null-assertion': 'off', // used deliberately after explicit checks
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    eqeqeq: ['error', 'smart'],
    'no-return-await': 'error',
  },
  overrides: [
    {
      // Seeds and migrations print progress; tests assert with non-null assertions.
      files: ['src/db/seed*.ts', 'src/db/migrate.ts', 'test/**/*.ts', '**/*.spec.ts'],
      rules: { 'no-console': 'off' },
    },
  ],
};
