// Flat config. The "architecture" block is the dependency rule from CLAUDE.md made mechanical:
// domain depends on nothing, application on domain, adapters on both, presentation on application.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

/**
 * The app's state libraries (#238): stores and queries belong to `apps/desktop`,
 * so the packages stay plain and `packages/ui` stays prop-driven.
 */
const appStateOnly = ['zustand', 'zustand/*', '@tanstack/react-query'];

/** Every layer that must stay out of a given layer's imports. */
const forbidden = {
  domain: [
    '@dfai/application',
    '@dfai/adapters',
    '@dfai/ui',
    'react*',
    '@tauri-apps/*',
    ...appStateOnly,
  ],
  application: ['@dfai/adapters', '@dfai/ui', 'react*', '@tauri-apps/*', ...appStateOnly],
  adapters: ['@dfai/ui', 'react*', ...appStateOnly],
  ui: ['@dfai/adapters', ...appStateOnly],
};

const architecture = Object.entries(forbidden).map(([layer, patterns]) => ({
  files: [`packages/${layer}/**/*.{ts,tsx}`],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: patterns.map((group) => ({
          group: [group],
          message: `packages/${layer} must not import ${group} — dependencies point inward.`,
        })),
      },
    ],
  },
}));

export default tseslint.config(
  {
    // `.claude/worktrees` holds whole copies of this repo while an agent works
    // in one. Linting them resolves files against the wrong tsconfig root and
    // buries the real output in hundreds of parse errors.
    ignores: [
      '**/dist/**',
      '**/target/**',
      '**/coverage/**',
      '**/src-tauri/gen/**',
      '.claude/**',
      'design/out/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: ['packages/ui/**/*.tsx', 'apps/**/*.tsx'],
    plugins: { react, 'react-hooks': reactHooks },
    languageOptions: react.configs.flat.recommended.languageOptions,
    // Pinned rather than detected: eslint-plugin-react 7.37's detection breaks on ESLint 10.
    settings: { react: { version: '19.3' } },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...reactHooks.configs['recommended-latest'].rules,
      // The automatic JSX runtime makes the React import unnecessary.
      'react/react-in-jsx-scope': 'off',
    },
  },
  ...architecture,
  {
    // Test support (`@dfai/<package>/testing…`) wraps built-ins, fakes the
    // clock and opens SQLite: it is for tests and test tooling, never for the
    // app. Its own rule name, so the architecture rule above is not replaced.
    files: ['**/*.{ts,tsx,mjs}'],
    ignores: [
      '**/*.test.{ts,tsx}',
      '**/*.spec.ts',
      'packages/*/src/testing/**',
      'tools/**',
      'e2e/**',
      'vitest.config.ts',
      'vitest.setup.ts',
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@dfai/*/testing', '@dfai/*/testing/*'],
              message: 'Test support is for tests: import it only from a test or test tooling.',
            },
          ],
        },
      ],
    },
  },
  {
    // The MCP server is a translator onto the local API (ADR-0016): it may know
    // the contract's types and nothing else of the app — no rules, no I/O code.
    files: ['apps/mcp/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@dfai/application'],
              allowTypeImports: true,
              message: 'apps/mcp may import only types from @dfai/application — the API contract.',
            },
            ...['@dfai/domain', '@dfai/adapters', '@dfai/ui', 'react*', '@tauri-apps/*'].map(
              (group) => ({
                group: [group],
                message: `apps/mcp must not import ${group} — it speaks the API, not the app.`,
              }),
            ),
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', 'tools/**/*.{mjs,ts}'],
    rules: { 'no-console': 'off' },
  },
  {
    // A <StrictMode> inside a test's wrapper does not run effects twice under
    // React 19, so a test that means the double mount must ask for it (#159).
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...[
          "ImportDeclaration[source.value='react'] > ImportSpecifier[imported.name='StrictMode']",
          "MemberExpression[object.name='React'][property.name='StrictMode']",
          "JSXMemberExpression[object.name='React'][property.name='StrictMode']",
        ].map((selector) => ({
          selector,
          message:
            'Render with `{ reactStrictMode: true }` (render or renderHook) to mount twice as main.tsx does.',
        })),
      ],
    },
  },
  {
    // e2e/fixtures.ts's `test` removes the temp folders a test's host made (issue #397).
    files: ['e2e/**/*.spec.ts', 'tools/perf/**/*.spec.ts', 'tools/design/**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@playwright/test',
              importNames: ['test'],
              message: "Import `test` from e2e/fixtures.ts, which removes the test's temp folders.",
            },
          ],
        },
      ],
    },
  },
  {
    // End and Home do not move the caret in WebKit on macOS, and ProseMirror
    // can put the caret back 20 ms after a click (#445, #448).
    files: ['e2e/**/*.spec.ts'],
    // These press End and Home on lists and tables whose own keyboard
    // handling is under test, never in the editor.
    ignores: [
      'e2e/sidebar-geometry.attack-332.spec.ts',
      'e2e/sidebar-keyboard.spec.ts',
      'e2e/sidebar-scroll.spec.ts',
      'e2e/table-grouped.attack-252.spec.ts',
      'e2e/table-keyboard.attack-244.spec.ts',
      'e2e/table-keyboard.spec.ts',
      'e2e/today-optimistic.attack-274.spec.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...[
          // press('End'), press("Shift+Home")
          "CallExpression[callee.property.name='press'][arguments.0.value=/^(Shift\\+)?(End|Home)$/]",
          // press(`End`)
          "CallExpression[callee.property.name='press'][arguments.0.quasis.0.value.raw=/^(Shift\\+)?(End|Home)$/]",
        ].map((selector) => ({
          selector,
          message:
            'End and Home do not move the caret in WebKit on macOS: use caretAtLineEnd or caretAtLineStart from e2e/caret.ts.',
        })),
      ],
    },
  },
);
