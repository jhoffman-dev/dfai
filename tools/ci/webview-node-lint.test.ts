/*
 * The lint rule that keeps Node's globals and modules out of the webview's
 * code (#114), run through ESLint with the repo's own config over text given
 * a path, so each case shows where the rule holds and where it is exempt.
 */
import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const NODE_RULES = ['no-restricted-globals', 'no-restricted-imports', 'no-restricted-properties'];

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
  'packages/application/src/testing/probe.ts',
  'apps/desktop/src/sync/probe.harness.ts',
  'apps/desktop/src/probe.test-support.ts',
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
