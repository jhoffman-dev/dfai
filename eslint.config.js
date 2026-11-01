// Flat config. The "architecture" block is the dependency rule from CLAUDE.md made mechanical:
// domain depends on nothing, application on domain, adapters on both, presentation on application.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';

/**
 * The app's state libraries (#238): stores and queries belong to the app shell
 * (`packages/shell`), so the other packages stay plain and `packages/ui` stays prop-driven.
 */
const appStateOnly = ['zustand', 'zustand/*', '@tanstack/react-query'];

/** The shell, and the apps that compose it: outermost, so no package imports them. */
const composed = ['@dfai/shell', '@dfai/desktop', '@dfai/web'];

const TAURI_ONLY_WHY =
  'Tauri is apps/desktop’s alone; the shell and the web build compose without it (#656).';

/**
 * Tauri, and the adapters that speak to its host (`@dfai/adapters/tauri`):
 * only `apps/desktop` composes them (#656). The shell is every platform's, and
 * a browser has no Tauri to answer them.
 */
const tauriOnly = [
  { group: ['@tauri-apps/*'], why: TAURI_ONLY_WHY },
  { group: ['@dfai/adapters/tauri'], why: TAURI_ONLY_WHY },
  { group: ['@dfai/desktop', '@dfai/desktop/*'], why: TAURI_ONLY_WHY },
];

/**
 * Another package's or app's files by a relative path, which skips its public
 * entry and every rule on it: `../../desktop/src/composition` reached Tauri
 * from the web with the entry rules green (#689).
 */
const OTHER_PACKAGE_PATH =
  '(^|/)(apps|packages)/|(^|/)(adapters|application|desktop|domain|mcp|shell|ui|web)/src(/|$)';
const otherPackageByPath = {
  regex: OTHER_PACKAGE_PATH,
  what: 'another package’s files by a relative path',
  why: 'import its public entry (@dfai/…) instead (#656).',
};

/**
 * The adapters the shell may import itself: only the readers' entries, which
 * are no platform's. Everything else a platform hands it through ports (#656).
 * Its tests may use the root barrel, which holds no Tauri.
 */
const shellAdapters = {
  // A regex, not a group: a group cannot let a path back in below one it refuses.
  regex: '^@dfai/adapters(/(?!pdf$|epub$).*)?$',
  what: '@dfai/adapters, but for /pdf and /epub',
  why: 'a platform hands the shell its adapters through ports (#656).',
};

/** The forms of `export` a module's names are read from, each with how it names them. */
const EXPORT_FORMS = [
  // export { a, b as c } from …, export type { … }
  [/^export\s+(?:type\s+)?\{([^}]*)\}/gm, (list) => list.split(',')],
  // export const a, export function a, export class a, export interface a, …
  [
    /^export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|interface|type|enum)\s+([\w$]+)/gm,
    (name) => [name],
  ],
  // export * as a from …
  [/^export\s+\*\s+as\s+([\w$]+)/gm, (name) => [name]],
];

/**
 * Every name a module exports, following `export * from` into the modules it
 * names. A form it cannot read stops the config loading, rather than leaving
 * a name out of the rule that depends on the list (#689).
 */
function exportedNames(url, seen = new Set()) {
  if (seen.has(url.href)) return [];
  seen.add(url.href);
  const source = readFileSync(url, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const read = new Set();
  const names = EXPORT_FORMS.flatMap(([form, split]) =>
    [...source.matchAll(form)].flatMap((match) => {
      read.add(match.index);
      return split(match[1]);
    }),
  );
  const starred = [...source.matchAll(/^export\s+\*\s+from\s+'([^']+)'/gm)].flatMap((match) => {
    read.add(match.index);
    return exportedNames(new URL(match[1], url), seen);
  });
  const unread = [...source.matchAll(/^export\b/gm)].filter((match) => !read.has(match.index));
  if (unread.length > 0) {
    const line = source.slice(unread[0].index).split('\n')[0];
    throw new Error(`eslint.config.js cannot read this export in ${url.pathname}: ${line}`);
  }
  const bare = (name) =>
    name
      .trim()
      .replace(/^type\s+/, '')
      .split(/\s+as\s+/)
      .pop();
  return [...names.map(bare), ...starred].filter(Boolean);
}

/** Every name `@dfai/application` re-exports from its test support, read from its files. */
const applicationTestSupport = [
  ...new Set(
    exportedNames(new URL('./packages/application/src/testing/index.ts', import.meta.url)),
  ),
];

/** The web build composes real adapters, never the application's fakes, which drop what they are handed. */
const noTestSupport = {
  group: ['@dfai/application'],
  importNames: applicationTestSupport,
  what: '@dfai/application’s test support',
  why: 'a fake keeps nothing; the web composes its own ports (#656).',
};

/** Every layer that must stay out of a given layer's imports. */
const forbidden = {
  domain: [
    '@dfai/application',
    '@dfai/adapters',
    '@dfai/ui',
    'react*',
    '@tauri-apps/*',
    ...appStateOnly,
    ...composed,
  ],
  application: [
    '@dfai/adapters',
    '@dfai/ui',
    'react*',
    '@tauri-apps/*',
    ...appStateOnly,
    ...composed,
  ],
  adapters: ['@dfai/ui', 'react*', ...appStateOnly, ...composed],
  // The shell draws it and the web bundles it: Tauri here is Tauri in the web build (#689).
  ui: ['@dfai/adapters', ...appStateOnly, ...composed, tauriOnly[0]],
  shell: [...tauriOnly, otherPackageByPath, '@dfai/web', '@dfai/web/*'],
};

const PLATFORM_CHECK_WHY =
  'the screen reads which entry points are offered (entryPointsOffered, #657), never which platform it is on.';

/** A platform's capabilities, read by the screen itself rather than decided for it. */
const platformValues = {
  group: ['@dfai/domain'],
  importNames: [
    'PLATFORM_CAPABILITIES',
    'DESKTOP_CAPABILITIES',
    'WEB_CAPABILITIES',
    'capabilitiesLacking',
  ],
  what: 'a platform’s capabilities',
  why: PLATFORM_CHECK_WHY,
};

/**
 * What decides from a platform's capabilities: only the shell's mount
 * (`mount-shell.tsx`) is handed them and asks; everything else reads its answer.
 */
const platformDecision = [
  {
    group: ['@dfai/domain'],
    importNames: ['PlatformCapabilities', 'PlatformCapability'],
    what: 'a platform’s capabilities',
    why: PLATFORM_CHECK_WHY,
  },
  {
    group: ['@dfai/application'],
    importNames: ['entryPointsOffered', 'capabilitiesNeeded'],
    what: 'the decision from a platform’s capabilities',
    why: `only mount-shell.tsx makes it — ${PLATFORM_CHECK_WHY}`,
  },
];

/** The one file in the shell that is handed a platform's capabilities and decides from them. */
const SHELL_MOUNT = 'packages/shell/src/mount-shell.tsx';

/** What a layer's production code, but not its tests, must also stay out of. */
const forbiddenOutsideTests = {
  shell: [shellAdapters, platformValues, ...platformDecision],
  ui: [platformValues, ...platformDecision],
};

/**
 * A forbidden entry as `no-restricted-imports` takes it: a module's name, or
 * a pattern (`group` or `regex`, maybe narrowed to `importNames`) with what it
 * names and why it is refused.
 */
const restriction = (where, entry) => {
  const {
    what,
    why = 'dependencies point inward.',
    ...match
  } = typeof entry === 'string' ? { group: [entry] } : entry;
  const named = what ?? (match.group ?? [match.regex]).join(', ');
  return { ...match, message: `${where} must not import ${named} — ${why}` };
};

const layerPatterns = (layer, { tests = true } = {}) =>
  [...forbidden[layer], ...(tests ? [] : (forbiddenOutsideTests[layer] ?? []))].map((entry) =>
    restriction(`packages/${layer}`, entry),
  );

/** The web app: its own composition root, on everything but Tauri and the desktop's files. */
const webPatterns = [...tauriOnly, otherPackageByPath, '@dfai/shell/*'].map((entry) =>
  restriction('apps/web', entry),
);
const webProductionPatterns = [...webPatterns, restriction('apps/web', noTestSupport)];

/**
 * Tauri reached without an import: its globals on the window, named as an
 * identifier, a string or a template (#689).
 */
const NO_TAURI_SYNTAX = [
  'Identifier[name=/^__TAURI/]',
  'Literal[value=/^__TAURI/]',
  'TemplateElement[value.raw=/__TAURI/]',
].map((selector) => ({
  selector,
  message: `Shared code must not reach Tauri’s globals — ${TAURI_ONLY_WHY}`,
}));

/** The platforms by name, as a string comparison could ask after one. */
const PLATFORM_NAMES = '/^(web|desktop|ios|ipad|iphone|windows|macos|mac|android|tauri)$/i';
/** What `navigator` says of the device. */
const NAVIGATOR_SNIFFS = '/^(platform|userAgent|userAgentData|oscpu|vendor)$/';

/** A platform asked for by name: compared, or named as a flag (#657). */
const NO_PLATFORM_CHECK = [
  ...['left', 'right'].flatMap((side) => [
    `BinaryExpression[operator=/^[!=]==?$/][${side}.name=/^platform$/i]`,
    `BinaryExpression[operator=/^[!=]==?$/][${side}.property.name=/^platform$/i]`,
  ]),
  'SwitchStatement[discriminant.name=/^platform$/i]',
  'SwitchStatement[discriminant.property.name=/^platform$/i]',
  'Identifier[name=/^is(Web|Desktop|Windows|Mac|MacOS|IPad|IOS|Browser|Tauri)$/]',
  // The same flag in constant case: IS_WEB, ON_IPAD.
  'Identifier[name=/^(IS|ON)_?(WEB|DESKTOP|IPAD|IOS|MAC|MACOS|WINDOWS|TAURI)$/]',
  // A platform named as a string: compared, or looked for in a list.
  ...['left', 'right'].map(
    (side) => `BinaryExpression[operator=/^[!=]==?$/][${side}.value=${PLATFORM_NAMES}]`,
  ),
  `CallExpression[callee.property.name='includes'] > Literal[value=${PLATFORM_NAMES}]`,
  `CallExpression[callee.property.name='includes'][callee.object.type='ArrayExpression'] Literal[value=${PLATFORM_NAMES}]`,
  // Or matched by a string's own methods: startsWith('mac'), indexOf('web').
  `CallExpression[callee.property.name=/^(startsWith|endsWith|indexOf|lastIndexOf|match|search)$/] > Literal[value=${PLATFORM_NAMES}]`,
].map((selector) => ({
  selector,
  message: `The screen must not ask which platform it is on — ${PLATFORM_CHECK_WHY}`,
}));

/**
 * The browser asked which device it runs on (#657). Production code only: a
 * test may read it to press the command key its platform uses, and the
 * shortcuts read it for that alone (`app-shortcuts.ts`).
 */
const NO_DEVICE_SNIFF = [
  // navigator.platform, navigator['platform'], window.navigator…, window['navigator']…
  ...['name', 'value'].flatMap((key) => [
    `MemberExpression[object.name='navigator'][property.${key}=${NAVIGATOR_SNIFFS}]`,
    `MemberExpression[object.property.name='navigator'][property.${key}=${NAVIGATOR_SNIFFS}]`,
    `MemberExpression[object.property.value='navigator'][property.${key}=${NAVIGATOR_SNIFFS}]`,
  ]),
  // const { platform } = navigator, under any name.
  "VariableDeclarator[id.type='ObjectPattern'][init.name='navigator']",
  "VariableDeclarator[id.type='ObjectPattern'][init.property.name='navigator']",
  "VariableDeclarator[id.type='ObjectPattern'][init.property.value='navigator']",
].map((selector) => ({
  selector,
  message: `Only a composition root may ask the browser which device it is on — ${PLATFORM_CHECK_WHY}`,
}));

/**
 * A platform's capability values named in the screen's own code: reached by
 * an `import()` or any other way the import rule cannot read (#657).
 */
const NO_CAPABILITY_VALUES = [
  'Identifier[name=/^(PLATFORM_CAPABILITIES|DESKTOP_CAPABILITIES|WEB_CAPABILITIES|capabilitiesLacking)$/]',
].map((selector) => ({
  selector,
  message: `The screen must not read a platform's capabilities — ${PLATFORM_CHECK_WHY}`,
}));

/** What the screen's production code may not do besides: ask the device, or name the capabilities. */
const NO_PLATFORM_SNIFF = [...NO_DEVICE_SNIFF, ...NO_CAPABILITY_VALUES];

/** The test files of a package's source, which may read the device to press its command key. */
const testsOf = (root) => [`${root}/**/*.test.{ts,tsx}`, `${root}/**/*.test-support.ts`];

/**
 * The syntax rules of code every platform shares (packages/ui, packages/shell,
 * #689): no `import()` of what the zone refuses, no Tauri globals, and no
 * question of which platform it is on (#657). Its production code may not ask
 * the browser which device it is on either, save the shortcuts, which read
 * it for the command key alone.
 */
const screenSyntax = (root, dynamicRestrictions) => {
  const shared = [...dynamicImports(dynamicRestrictions), ...NO_TAURI_SYNTAX, ...NO_PLATFORM_CHECK];
  const shortcuts = 'packages/shell/src/app-shortcuts.ts';
  return [
    {
      // The shell draws packages/ui and the web bundles it (#689).
      files: [`${root}/**/*.{ts,tsx,mts,cts}`],
      ignores: [...nodeOnly, ...testsOf(root), shortcuts],
      rules: { 'no-restricted-syntax': [...shared, ...NO_PLATFORM_SNIFF] },
    },
    {
      files: [...testsOf(root), ...(root === 'packages/shell/src' ? [shortcuts] : [])],
      ignores: nodeOnly,
      rules: { 'no-restricted-syntax': shared },
    },
  ];
};

/**
 * The web's own code loads the adapters and the application statically, so
 * the names it takes are the ones the rules above can read: off a module
 * loaded with `import()`, any name could be a tauri… adapter or a fake (#689).
 */
const noWebLoadedLater = [
  {
    regex: '^@dfai/(adapters|application)$',
    message:
      'Import @dfai/adapters and @dfai/application statically, so the zone can see what is taken (#689).',
  },
];

/** A <StrictMode> in a test, which React 19 does not mount twice (#159). */
const STRICT_MODE_IN_TESTS = [
  "ImportDeclaration[source.value='react'] > ImportSpecifier[imported.name='StrictMode']",
  "MemberExpression[object.name='React'][property.name='StrictMode']",
  "JSXMemberExpression[object.name='React'][property.name='StrictMode']",
].map((selector) => ({
  selector,
  message:
    'Render with `{ reactStrictMode: true }` (render or renderHook) to mount twice as main.tsx does.',
}));

/** The same modules, refused when loaded with `import()`. */
const noTauriImport = [
  { regex: '^@tauri-apps/', message: TAURI_ONLY_WHY },
  { regex: '^@dfai/adapters/tauri$', message: TAURI_ONLY_WHY },
  { regex: '^@dfai/desktop(/|$)', message: TAURI_ONLY_WHY },
  {
    regex: OTHER_PACKAGE_PATH,
    message: 'Import another package by its public entry (@dfai/…), not its files (#656).',
  },
];
/** Tauri, and a `tauri-*` module or the `tauri/` entry, as an adapter that is neither imports them. */
const ADAPTER_TAURI_WHY =
  'only a tauri-* module speaks to Tauri, so the root barrel holds none of it (#689).';
const adapterTauriOnly = [
  { regex: '^@tauri-apps/', what: '@tauri-apps/*', why: ADAPTER_TAURI_WHY },
  { regex: '(^|/)tauri(-[^/]*|/.*)?$', what: 'a tauri-* module', why: ADAPTER_TAURI_WHY },
];

/** And for the shell's production code, the adapters it may not import itself. */
const noShellAdaptersImport = {
  regex: shellAdapters.regex,
  message: shellAdapters.why,
};

const architecture = [
  ...Object.keys(forbidden).map((layer) => ({
    files: [`packages/${layer}/**/*.{ts,tsx,mts,cts}`],
    rules: { 'no-restricted-imports': ['error', { patterns: layerPatterns(layer) }] },
  })),
  {
    files: ['apps/web/**/*.{ts,tsx,mts,cts}'],
    rules: { 'no-restricted-imports': ['error', { patterns: webPatterns }] },
  },
];

/**
 * Code that runs in Tauri's webview, where there is no Node (#114). Node's
 * globals and modules pass typecheck and every unit test there, since Vitest
 * runs on Node, and fail only in WebKit: `Buffer.byteLength` in the domain did
 * (PR #99). `pnpm check:node-builtins` is the same rule over the built bundle (#53).
 */
const webview = [
  'packages/{domain,application,adapters,ui,shell}/src/**/*.{ts,tsx,mts,cts}',
  'apps/{desktop,web}/src/**/*.{ts,tsx,mts,cts}',
];

/** The SQLite test support: SQL run for real through `node:sqlite`, and what is built on it. */
const sqliteSupport = [
  'node-sqlite',
  'sqlite',
  'sqlite-index',
  'index-schema',
  'index-schema-guard',
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
  'packages/shell/src/styles.test-support.ts',
  // Two simulated Macs syncing through the real git, over the real disk (U-29).
  'packages/shell/src/sync/two-macs.harness.ts',
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
  '**/*.test.{ts,tsx,mts,cts}',
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

/**
 * A test, a suite's support file, a Playwright spec, or a package's testing
 * folder, as an import names it: test code, which the app never loads.
 */
const TEST_CODE =
  /(^|\/)[^/]*\.(test|test-support|spec)(\.[^/]*)?$|(^|\/)src\/testing(\/|$)|^@dfai\/[^/]+\/testing(\/|$)/;

/**
 * `no-restricted-imports` reads only static imports: this is its rule for an
 * `import()` of test code. A template's holes are read as any text.
 */
const testCode = {
  rules: {
    'no-restricted-imports-dynamic': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          testCode:
            'A test or its support is for tests: import it only from a test or test tooling.',
        },
      },
      create: (context) => ({
        ImportExpression(node) {
          const { source } = node;
          const named =
            source.type === 'Literal' && typeof source.value === 'string'
              ? source.value
              : source.type === 'TemplateLiteral'
                ? source.quasis.map((quasi) => quasi.value.cooked).join('*')
                : null;
          if (named !== null && TEST_CODE.test(named))
            context.report({ node, messageId: 'testCode' });
        },
      }),
    },
  },
};

const webviewNode = [
  ...Object.keys(forbidden).map((layer) => ({
    files: [`packages/${layer}/src/**/*.{ts,tsx,mts,cts}`],
    ignores: nodeOnly,
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [...layerPatterns(layer, { tests: false }), noNodeModules, noNodeSupport] },
      ],
    },
  })),
  {
    // A suite's own support is test code: held as the shell's tests are, not its production code.
    files: ['packages/shell/src/**/*.test-support.ts'],
    ignores: nodeOnly,
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [...layerPatterns('shell'), noNodeModules, noNodeSupport] },
      ],
    },
  },
  {
    // The rest of the application's test support, beside the SQLite files.
    files: ['packages/application/src/testing/**/*.{ts,tsx,mts,cts}'],
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
    files: ['apps/desktop/src/**/*.{ts,tsx,mts,cts}'],
    ignores: nodeOnly,
    rules: { 'no-restricted-imports': ['error', { patterns: [noNodeModules, noNodeSupport] }] },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx,mts,cts}'],
    ignores: nodeOnly,
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [...webProductionPatterns, noNodeModules, noNodeSupport] },
      ],
    },
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
    files: ['packages/application/src/testing/**/*.{ts,tsx,mts,cts}'],
    ignores: nodeOnly,
    rules: {
      'no-restricted-syntax': dynamicImports([noNodeModules, noNodeSupport, noSqliteSibling]),
    },
  },
  {
    // The same, with Tauri added, for the code every platform shares and the web's own.
    files: ['apps/web/src/**/*.{ts,tsx,mts,cts}'],
    ignores: nodeOnly,
    rules: {
      'no-restricted-syntax': [
        ...dynamicImports([noNodeModules, noNodeSupport, ...noTauriImport, ...noWebLoadedLater]),
        ...NO_TAURI_SYNTAX,
      ],
    },
  },
  {
    // The layers the screen asks for its answers may not ask the device either: only the
    // composition roots in apps/ may (#657). Their tests and test support keep the rule above.
    files: ['packages/{domain,application}/src/**/*.{ts,tsx,mts,cts}'],
    ignores: [
      ...nodeOnly,
      'packages/{domain,application}/src/**/*.test.{ts,tsx}',
      'packages/{domain,application}/src/testing/**',
    ],
    rules: {
      'no-restricted-syntax': [
        ...dynamicImports([noNodeModules, noNodeSupport]),
        ...NO_DEVICE_SNIFF,
      ],
    },
  },
  ...screenSyntax('packages/ui/src', [noNodeModules, noNodeSupport, ...noTauriImport]),
  ...screenSyntax('packages/shell/src', [
    noNodeModules,
    noNodeSupport,
    ...noTauriImport,
    noShellAdaptersImport,
  ]),
  {
    // The shell's mount is handed a platform's capabilities and decides from them (#657).
    files: [SHELL_MOUNT],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...[...forbidden.shell, shellAdapters, platformValues].map((entry) =>
              restriction('packages/shell', entry),
            ),
            noNodeModules,
            noNodeSupport,
          ],
        },
      ],
    },
  },
  {
    // Only a `tauri-*` module, or the `tauri/` entry, speaks to Tauri: anything
    // else in the adapters (the root barrel among them) reaching one would put
    // Tauri back in what the web composes (#689).
    files: ['packages/adapters/src/**/*.{ts,tsx,mts,cts}'],
    ignores: [...nodeOnly, '**/tauri-*', 'packages/adapters/src/tauri/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...layerPatterns('adapters', { tests: false }),
            noNodeModules,
            noNodeSupport,
            ...adapterTauriOnly.map((entry) =>
              restriction('An adapter that is not tauri-*', entry),
            ),
          ],
        },
      ],
      'no-restricted-syntax': dynamicImports([
        noNodeModules,
        noNodeSupport,
        ...adapterTauriOnly.map(({ regex, why }) => ({ regex, message: why })),
      ]),
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
      // The sign-in function's bundle, built before a deploy (#663).
      'apps/auth-function/lib/**',
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
    files: ['packages/{ui,shell}/**/*.tsx', 'apps/**/*.tsx'],
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
      '**/*.test.{ts,tsx,mts,cts}',
      // A suite's own support may use test support; the pattern below keeps the app from importing it.
      '**/*.test-support.ts',
      '**/*.spec.ts',
      'packages/*/src/testing/**',
      'tools/**',
      'e2e/**',
      'vitest.config.ts',
      'vitest.setup.ts',
    ],
    plugins: { 'test-code': testCode },
    rules: {
      'test-code/no-restricted-imports-dynamic': 'error',
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@dfai/*/testing', '@dfai/*/testing/*'],
              message: 'Test support is for tests: import it only from a test or test tooling.',
            },
            {
              // A test, a spec or a suite's support file: ignored above so that
              // tests may import them, and so never imported by the app.
              group: [
                '**/*.test-support',
                '**/*.test-support.*',
                '**/*.test',
                '**/*.test.*',
                '**/*.spec',
                '**/*.spec.*',
                // A package's test support by its path rather than its alias.
                '**/src/testing',
                '**/src/testing/**',
              ],
              message:
                'A test or its support is for tests: import it only from a test or test tooling.',
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
    // The sign-in function deploys on its own, installed by Firebase from its
    // package.json (#663, ADR-0052): it can reach no workspace package. Its
    // tests may drive the web build's real sign-in against it.
    files: ['apps/auth-function/src/**/*.ts'],
    ignores: ['**/*.test.ts', '**/*.test-support.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@dfai/*'],
              message: 'apps/auth-function deploys alone: it may not import a workspace package.',
            },
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
    rules: { 'no-restricted-syntax': ['error', ...STRICT_MODE_IN_TESTS] },
  },
  {
    // After the block above, whose rule it repeats: the shell's and the web's tests
    // may not reach Tauri either, by import() or off the window (#689).
    files: [
      'packages/{shell,ui}/**/*.test.{ts,tsx,mts,cts}',
      'apps/web/**/*.test.{ts,tsx,mts,cts}',
    ],
    rules: {
      'no-restricted-syntax': [
        ...dynamicImports(noTauriImport),
        ...NO_TAURI_SYNTAX,
        ...STRICT_MODE_IN_TESTS,
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
