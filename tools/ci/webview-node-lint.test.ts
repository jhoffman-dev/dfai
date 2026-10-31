/*
 * The lint rule that keeps Node's globals and modules out of the webview's
 * code (#114), run through ESLint with the repo's own config over text given
 * a path, so each case shows where the rule holds and where it is exempt.
 */
import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const NODE_RULES = [
  'no-restricted-globals',
  'no-restricted-imports',
  'no-restricted-properties',
  'no-restricted-syntax',
];

let eslint: ESLint;
// Loading the config and its plugins takes seconds on a busy machine, so it is
// done once here, under a hook's own timeout, rather than inside the first case.
beforeAll(async () => {
  eslint = new ESLint({ cwd: ROOT });
  await eslint.lintText('', { filePath: `${ROOT}packages/domain/src/probe.ts` });
}, 60_000);

/** The Node rules' findings for `code` linted as the file at `path`. */
async function nodeFindings(path: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: `${ROOT}${path}` });
  return (result?.messages ?? [])
    .filter((message) => NODE_RULES.includes(message.ruleId ?? ''))
    .map((message) => message.message);
}

const WEBVIEW = [
  'packages/domain/src/activity/probe.ts',
  'packages/application/src/probe.ts',
  'packages/adapters/src/vault/probe.ts',
  'packages/ui/src/probe.tsx',
  'apps/desktop/src/probe.ts',
];

const NODE_ONLY = [
  'packages/domain/src/activity/probe.test.ts',
  // Test support that runs on Node, each named in the config.
  'packages/application/src/testing/node-sqlite.ts',
  'packages/application/src/testing/query-index.ts',
  'apps/desktop/src/sync/two-macs.harness.ts',
  'apps/desktop/src/styles.test-support.ts',
  'packages/domain/src/calendar/zones.test-support.ts',
  'packages/adapters/src/markdown/frontmatter-write-cases.attack-454.ts',
  'tools/ci/probe.ts',
  'apps/mcp/src/probe.ts',
  'e2e/probe.ts',
];

describe('Node in the webview’s code (#114)', () => {
  it.each(WEBVIEW)('forbids each Node-only global in %s, naming what to use', async (path) => {
    const found = await nodeFindings(
      path,
      [
        "export const size = Buffer.byteLength('a');",
        'export const dev = process.env.NODE_ENV;',
        'export const here = [__dirname, __filename];',
        "export const lib = require('x');",
        'export const root = global;',
        'setImmediate(() => {});',
        'clearImmediate(undefined);',
      ].join('\n'),
    );
    expect(found).toHaveLength(8);
    expect(found[0]).toContain(
      "Buffer is Node's, and the webview has none (#114). Use TextEncoder/TextDecoder, Uint8Array, or utf8Length from @dfai/domain.",
    );
  });

  it.each(WEBVIEW)('forbids importing a Node built-in in %s', async (path) => {
    const found = await nodeFindings(
      path,
      [
        "import { readFileSync } from 'node:fs';",
        "import { join } from 'path';",
        "import { readFile } from 'fs/promises';",
        'console.warn(readFileSync, join, readFile);',
      ].join('\n'),
    );
    expect(found).toHaveLength(3);
    expect(found.every((message) => message.includes('The webview has no Node'))).toBe(true);
  });

  it.each(WEBVIEW)('forbids a dynamic import of a Node built-in in %s', async (path) => {
    const found = await nodeFindings(
      path,
      [
        "export const a = () => import('node:fs');",
        "export const b = () => import('fs/promises');",
        'export const c = () => import(`path`);',
        "export const d = () => import('./path');",
        "export const e = () => import('pathe');",
      ].join('\n'),
    );
    expect(found).toHaveLength(3);
    expect(found.every((message) => message.includes('The webview has no Node'))).toBe(true);
  });

  it('forbids a Node global reached through the global object', async () => {
    const found = await nodeFindings(
      'packages/domain/src/probe.ts',
      'export const ok = globalThis.process !== undefined && window.Buffer !== undefined;',
    );
    expect(found).toHaveLength(2);
  });

  it('lets through what only shares a name with Node: a local file, a package, a local variable', async () => {
    const found = await nodeFindings(
      'packages/ui/src/probe.ts',
      [
        "import { a } from './path';",
        "import { b } from 'pathe';",
        "import { c } from '@dfai/domain';",
        'const process = (n: number) => n;',
        'export const out = [a, b, c, process(1), globalThis.crypto];',
      ].join('\n'),
    );
    expect(found).toEqual([]);
  });

  it.each(NODE_ONLY)('leaves Node to code that runs in it: %s', async (path) => {
    const found = await nodeFindings(
      path,
      "import { readFileSync } from 'node:fs';\nexport const x = [readFileSync, Buffer, process.env, __dirname];",
    );
    expect(found).toEqual([]);
  });

  it.each([
    'packages/application/src/testing/fake-ports.ts',
    'apps/desktop/src/sync/probe.harness.ts',
    'packages/ui/src/probe.fixture.ts',
    'packages/adapters/src/probe.attack-1.ts',
  ])(
    'holds test support not named as Node’s to the rule, since the barrels export it: %s',
    async (path) => {
      expect(await nodeFindings(path, 'export const x = process.env;')).toHaveLength(1);
    },
  );

  it.each([
    [
      'the production barrel',
      'packages/application/src/index.ts',
      "export * from './testing/sqlite.ts';",
    ],
    [
      'an alias',
      'apps/desktop/src/probe.ts',
      "import { atlasQueryIndex } from '@dfai/application/testing/sqlite';\nexport const x = atlasQueryIndex;",
    ],
    [
      'app code',
      'apps/desktop/src/probe.ts',
      "import { sectionFiles } from './styles.test-support.ts';\nexport const x = sectionFiles;",
    ],
    [
      'app code, deeper',
      'apps/desktop/src/notes/probe.ts',
      "import { x } from '../sync/two-macs.harness';\nexport const y = x;",
    ],
    [
      'the domain',
      'packages/domain/src/calendar/probe.ts',
      "import { x } from './zones.test-support.ts';\nexport const y = x;",
    ],
    [
      'other test support',
      'packages/application/src/testing/fake-ports.ts',
      "import { x } from './query-index.ts';\nexport const y = x;",
    ],
  ])('forbids importing Node’s test support from %s', async (_case, path, code) => {
    const found = await nodeFindings(path, code);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('runs on Node');
  });

  it('lets a production file import its own sibling that shares a test support file’s name', async () => {
    const found = await nodeFindings(
      'packages/application/src/meetings/probe.ts',
      "import { x } from './meeting-files.ts';\nexport const y = x;",
    );
    expect(found).toEqual([]);
  });

  it('keeps the layer rule in the webview’s files beside the Node one', async () => {
    const found = await nodeFindings(
      'packages/domain/src/probe.ts',
      "import { x } from '@dfai/application';\nexport const y = x;",
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(
      'packages/domain must not import @dfai/application — dependencies point inward.',
    );
  });
});
