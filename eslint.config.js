// Flat config. The "architecture" block is the dependency rule from CLAUDE.md made mechanical:
// domain depends on nothing, application on domain, adapters on both, presentation on application.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import { builtinModules } from 'node:module';

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

const layerPatterns = (layer) =>
  forbidden[layer].map((group) => ({
    group: [group],
    message: `packages/${layer} must not import ${group} — dependencies point inward.`,
  }));

const architecture = Object.keys(forbidden).map((layer) => ({
  files: [`packages/${layer}/**/*.{ts,tsx}`],
  rules: { 'no-restricted-imports': ['error', { patterns: layerPatterns(layer) }] },
}));

/**
 * Code that runs in Tauri's webview, where there is no Node (#114). Node's
 * globals and modules pass typecheck and every unit test there, since Vitest
 * runs on Node, and fail only in WebKit: `Buffer.byteLength` in the domain did
 * (PR #99). `pnpm check:node-builtins` is the same rule over the built bundle (#53).
 */
const webview = [
  'packages/{domain,application,adapters,ui}/src/**/*.{ts,tsx}',
  'apps/desktop/src/**/*.{ts,tsx}',
];

/** The SQLite test support: SQL run for real through `node:sqlite`, and what is built on it. */
const sqliteSupport = [
  'node-sqlite',
  'sqlite',
  'sqlite-index',
  'query-index',
  'fts-search',
  'tag-index',
  'automation-vault',
  'assistant-vault',
  'meeting-files',
];

/**
 * Test support that runs on Node, by name. Other test support is held to the
 * webview's rule like the app, since the barrels export it (`@dfai/application`
 * re-exports its fakes), and nothing else in the webview's code may import these.
 */
const nodeSupport = [
  // Reads the stylesheet's section files from disk, as the build ships them.
  'apps/desktop/src/styles.test-support.ts',
  // Two simulated Macs syncing through the real git, over the real disk (U-29).
  'apps/desktop/src/sync/two-macs.harness.ts',
  // Judges a rewrite with node:util's deep equality.
  'packages/adapters/src/markdown/frontmatter-write-cases.attack-454.ts',
  // Sets the process's time zone, which is how Node takes one.
  'packages/domain/src/calendar/zones.test-support.ts',
  ...sqliteSupport.map((name) => `packages/application/src/testing/${name}.ts`),
];

/**
 * What runs only in Node inside those folders. Everything else that runs in
 * Node — tools/, e2e/, apps/mcp, the configs — is outside them to begin with.
 */
const nodeOnly = [
  // Tests run in Vitest, on Node.
  '**/*.test.{ts,tsx}',
  ...nodeSupport,
];

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * An import of Node's test support, relative or through an alias. The SQLite
 * files are matched with their folder, since a production module shares a name
 * (`meetings/meeting-files.ts`); their siblings' `./` imports are matched below.
 */
const supportTails = nodeSupport.map((path) =>
  path.includes('/testing/')
    ? `testing/${path.split('/').pop().replace(/\.ts$/, '')}`
    : path.split('/').pop().replace(/\.ts$/, ''),
);
const SUPPORT_MESSAGE =
  'This test support runs on Node, and the webview has none: import it only from a test (#114).';
const noNodeSupport = {
  regex: `(^|/)(${supportTails.map(escapeRegex).join('|')})(\\.ts)?$`,
  message: SUPPORT_MESSAGE,
};
const noSqliteSibling = {
  regex: `^\\./(${sqliteSupport.map(escapeRegex).join('|')})(\\.ts)?$`,
  message: SUPPORT_MESSAGE,
};

/** Each Node-only global, and what the webview has instead. */
const NODE_GLOBALS = {
  Buffer: 'Use TextEncoder/TextDecoder, Uint8Array, or utf8Length from @dfai/domain.',
  process: 'Use import.meta.env for build flags; ask the host through a port for the rest.',
  __dirname: 'Use import.meta.url.',
  __filename: 'Use import.meta.url.',
  require: 'Use import.',
  global: 'Use globalThis.',
  setImmediate: 'Use queueMicrotask or setTimeout.',
  clearImmediate: 'Use clearTimeout.',
  module: 'Use export: CommonJS is Node’s.',
  exports: 'Use export: CommonJS is Node’s.',
};

const nodeBuiltinNames = builtinModules
  .filter((name) => !name.startsWith('node:'))
  .map(escapeRegex);

/** `node:fs`, `fs`, `fs/promises`, by exact name: `./path` or `pathe` is not Node's. */
const noNodeModules = {
  regex: `^(node:.*|(${nodeBuiltinNames.join('|')})(/.*)?)$`,
  message:
    'The webview has no Node: keep this in tools/, a test, or test support, or use a Web API (#114).',
};

/**
 * The same restrictions for `import()`, which no-restricted-imports does not
 * look at. A selector's regex ends at its first `/`, so each slash is `\x2F`.
 */
const dynamicImports = (restrictions) => [
  'error',
  ...restrictions.flatMap(({ regex, message }) => {
    const pattern = regex.replaceAll('\\/', '\\x2F').replaceAll('/', '\\x2F');
    return [
      `ImportExpression > Literal[value=/${pattern}/]`,
      `ImportExpression > TemplateLiteral > TemplateElement[value.raw=/${pattern}/]`,
    ].map((selector) => ({ selector, message }));
  }),
];

const webviewNode = [
  ...Object.keys(forbidden).map((layer) => ({
    files: [`packages/${layer}/src/**/*.{ts,tsx}`],
    ignores: nodeOnly,
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [...layerPatterns(layer), noNodeModules, noNodeSupport] },
      ],
    },
  })),
  {
    // The rest of the application's test support, beside the SQLite files.
    files: ['packages/application/src/testing/**/*.{ts,tsx}'],
    ignores: nodeOnly,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...layerPatterns('application'),
            noNodeModules,
            noNodeSupport,
            noSqliteSibling,
          ],
        },
      ],
    },
  },
  {
    files: ['apps/desktop/src/**/*.{ts,tsx}'],
    ignores: nodeOnly,
    rules: { 'no-restricted-imports': ['error', { patterns: [noNodeModules, noNodeSupport] }] },
  },
  {
    files: webview,
    ignores: nodeOnly,
    rules: {
      'no-restricted-globals': [
        'error',
        ...Object.entries(NODE_GLOBALS).map(([name, instead]) => ({
          name,
          message: `${name} is Node's, and the webview has none (#114). ${instead}`,
        })),
      ],
      'no-restricted-syntax': dynamicImports([noNodeModules, noNodeSupport]),
      // The same globals reached through the global object.
      'no-restricted-properties': [
        'error',
        ...['globalThis', 'window', 'self'].flatMap((object) =>
          Object.entries(NODE_GLOBALS).map(([property, instead]) => ({
            object,
            property,
            message: `${property} is Node's, and the webview has none (#114). ${instead}`,
          })),
        ),
      ],
    },
  },
  {
    // After the block above, whose `import()` rule it repeats with the siblings added.
    files: ['packages/application/src/testing/**/*.{ts,tsx}'],
    ignores: nodeOnly,
    rules: {
      'no-restricted-syntax': dynamicImports([noNodeModules, noNodeSupport, noSqliteSibling]),
    },
  },
];

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
      // Generated by `pnpm n8n:build`: the capture writer bundled for n8n (#103).
      'tools/n8n/capture-markdown.bundle.js',
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
  // After the architecture, whose rule it repeats for the webview's files with Node added.
  ...webviewNode,
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
