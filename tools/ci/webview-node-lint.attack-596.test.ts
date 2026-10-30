/*
 * Attack on PR #596 (#114): the webview's Node lint rules, through ESLint
 * with the repo's config on virtual paths. Ways around the rule, code that
 * only looks like Node, and the layer rules the flat-config change must keep.
 */
import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

let eslint: ESLint;
beforeAll(async () => {
  eslint = new ESLint({ cwd: ROOT });
  await eslint.lintText('', { filePath: `${ROOT}packages/domain/src/probe.ts` });
}, 60_000);

/** The rule ids of every restriction `code` breaks, linted as the file at `path`. */
async function restrictions(path: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: `${ROOT}${path}` });
  return (result?.messages ?? [])
    .filter((message) => /restricted/.test(message.ruleId ?? ''))
    .map((message) => message.ruleId ?? '');
}

const DOMAIN = 'packages/domain/src/activity/probe.ts';

describe('a Node global reached sideways (#114, attack on PR #596)', () => {
  it.each([
    ['destructured from globalThis', 'const { Buffer } = globalThis;\nexport const b = Buffer;'],
    ['through optional chaining', 'export const p = globalThis?.process;'],
    ['through a computed key', "export const p = globalThis['process'];"],
    ['as an optional call', "export const p = globalThis.require?.('x');"],
  ])('forbids a Node global %s', async (_how, code) => {
    expect(await restrictions(DOMAIN, code)).toEqual(['no-restricted-properties']);
  });

  // Types name a runtime the webview does not have, and @types/node does not
  // belong in its code: kept forbidden on purpose.
  it('forbids a type-only import from a Node built-in', async () => {
    expect(
      await restrictions(
        DOMAIN,
        "import type { Buffer } from 'node:buffer';\nexport type B = Buffer;",
      ),
    ).toEqual(['no-restricted-imports']);
  });
});

describe('what only looks like Node (#114, attack on PR #596)', () => {
  it.each([
    ['a local named process', 'const process = { run: () => 1 };\nexport const p = process.run();'],
    ['a local named global', 'const global = 1;\nexport const g = global;'],
    [
      'a domain object’s .process',
      'export const run = (job: { process(): void }) => job.process();',
    ],
    ['a message naming node:fs', "export const msg = 'do not import node:fs here';"],
  ])('lets through %s', async (_what, code) => {
    expect(await restrictions(DOMAIN, code)).toEqual([]);
  });
});

describe('Node test support reached from the webview (#114, attack on PR #596)', () => {
  it('forbids importing the SQLite support two folders up', async () => {
    expect(
      await restrictions(
        'packages/application/src/notes/sub/probe.ts',
        "import { openSqlite } from '../../testing/sqlite.ts';\nexport const o = openSqlite;",
      ),
    ).toEqual(['no-restricted-imports']);
  });

  it('forbids a barrel re-exporting the SQLite support', async () => {
    expect(
      await restrictions(
        'packages/application/src/notes/index.ts',
        "export * from '../testing/sqlite.ts';",
      ),
    ).toEqual(['no-restricted-imports']);
  });

  it('forbids a dynamic import() of the SQLite support', async () => {
    expect(
      await restrictions(
        'packages/application/src/notes/probe.ts',
        "export const load = () => import('../testing/sqlite.ts');",
      ),
    ).toHaveLength(1);
  });

  it('forbids a dynamic import() of a sibling’s SQLite support inside testing/', async () => {
    expect(
      await restrictions(
        'packages/application/src/testing/fake-probe.ts',
        "export const load = () => import('./query-index.ts');",
      ),
    ).toHaveLength(1);
  });
});

describe('the layer rules after the flat-config change (#114, attack on PR #596)', () => {
  it.each([
    ['packages/domain/src/notes/probe.ts', "import '@dfai/application';"],
    ['packages/domain/src/notes/probe.test.ts', "import '@dfai/application';"],
    ['packages/domain/src/calendar/zones.test-support.ts', "import '@dfai/application';"],
    ['packages/application/src/notes/probe.ts', "import '@dfai/adapters';"],
    ['packages/application/src/notes/probe.test.ts', "import '@dfai/adapters';"],
    ['packages/application/src/testing/fake-probe.ts', "import '@dfai/adapters';"],
    ['packages/application/src/testing/sqlite.ts', "import '@dfai/adapters';"],
    ['packages/adapters/src/vault/probe.ts', "import '@dfai/ui';"],
    ['packages/adapters/src/markdown/frontmatter-write-cases.attack-454.ts', "import '@dfai/ui';"],
    ['packages/ui/src/probe.tsx', "import '@dfai/adapters';"],
    ['packages/ui/src/probe.test.tsx', "import '@dfai/adapters';"],
  ])('still forbids an outward import in %s', async (path, code) => {
    expect(await restrictions(path, code)).toEqual(['no-restricted-imports']);
  });
});
