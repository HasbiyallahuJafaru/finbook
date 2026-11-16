import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const noFloatMoney = {
  'no-restricted-globals': ['error', { name: 'parseFloat', message: 'Money is bigint minor units; use packages/money.' }, { name: 'Number', message: 'No Number() on money; use bigint via packages/money.' }],
  'no-restricted-properties': [
    'error',
    ...['round', 'floor', 'ceil', 'trunc'].map((property) => ({ object: 'Math', property, message: 'No Math rounding on money; use packages/money.' })),
    { property: 'toFixed', message: 'No toFixed on money; use packages/money.' },
  ],
  'no-restricted-syntax': ['error', { selector: "CallExpression[callee.name='Number']", message: 'No Number() on money; use bigint via packages/money.' }],
};

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/.open-next/**', '**/.cloudflare/**', '**/.turbo/**', 'graphify-out/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: { ...noFloatMoney, '@typescript-eslint/no-non-null-assertion': 'error', '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }] },
  },
  // tests may use Number() for loop counts and PRNG plumbing, never for money amounts
  {
    files: ['**/*.test.ts', '**/*.integration.ts'],
    rules: { 'no-restricted-globals': 'off', 'no-restricted-syntax': 'off', '@typescript-eslint/no-floating-promises': 'off' },
  },
  { files: ['**/*.mjs', '**/*.js'], ...tseslint.configs.disableTypeChecked },
);
