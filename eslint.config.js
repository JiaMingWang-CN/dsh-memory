import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '.codegraph/**', '.agents/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: [
      'src/shared/**/*.ts',
      'src/core/**/*.ts',
      'src/agy/**/*.ts',
      'src/desktop/**/*.ts',
      'src/desktop/**/*.tsx',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: ['@deepseek-ai/*'],
        },
      ],
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
      },
    },
  },
  {
    files: ['eslint.config.js'],
    languageOptions: {
      sourceType: 'module',
    },
  },
)
