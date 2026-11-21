// Flat config. The layer blocks are the dependency rule made mechanical:
// domain → nothing; application → domain; adapters → application + domain;
// ui → application (and domain types); app → anything.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import { builtinModules } from 'node:module';

const NO_NODE = 'The browser has no Node: src/ may not import a Node built-in (tools/ may).';
// Exact names, not patterns: a pattern `domain` (a Node module) would match our own folder.
const NODE_BUILTIN_PATHS = builtinModules.map((name) => ({ name, message: NO_NODE }));
const NODE_BUILTINS = { regex: '^node:', message: NO_NODE };

/** Another module's internals: cross-module imports go through its `index.ts`. */
const INTERNALS = {
  regex: '(^|/)(domain|application|adapters)/[^/]+/(?!index\\.ts$)[^/]+$',
  message: 'Import the module’s public entry (its index.ts), not its files.',
};

const layer = (name) => ({
  regex: `(^|/)${name}(/|$)`,
  message: `The dependency rule forbids this layer importing ${name}/.`,
});

/** Any package at all: the inner layers depend on nothing outside src/. */
const ANY_PACKAGE = {
  regex: '^[^.]',
  message: 'Domain and application are pure TypeScript: no packages.',
};

const restrict = (...patterns) => ({
  'no-restricted-imports': [
    'error',
    { paths: NODE_BUILTIN_PATHS, patterns: [NODE_BUILTINS, INTERNALS, ...patterns] },
  ],
});

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'test-results', 'playwright-report'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      ...restrict(),
      'no-restricted-globals': [
        'error',
        ...['Buffer', 'process', 'require', 'global', '__dirname', '__filename'].map((name) => ({
          name,
          message: 'The browser has no Node.',
        })),
      ],
    },
  },
  {
    files: ['src/domain/**/*.ts'],
    rules: restrict(
      ANY_PACKAGE,
      layer('application'),
      layer('adapters'),
      layer('ui'),
      layer('app'),
    ),
  },
  {
    files: ['src/application/**/*.ts'],
    rules: restrict(ANY_PACKAGE, layer('adapters'), layer('ui'), layer('app')),
  },
  {
    files: ['src/adapters/**/*.ts'],
    rules: restrict(layer('ui'), layer('app')),
  },
  {
    files: ['src/ui/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...restrict({ ...layer('domain'), allowTypeImports: true }, layer('adapters'), layer('app')),
    },
  },
  {
    files: ['src/app/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ['tools/**/*.ts', 'e2e/**/*.ts', '*.config.{ts,js}'],
    languageOptions: { globals: { ...globals.node } },
  },
);
