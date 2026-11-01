/*
 * The lint zone that keeps Tauri out of the shell every platform shares and
 * out of the web build (#656), run through ESLint with the repo's own config
 * over text given a path, as webview-node-lint.test.ts runs the Node rule.
 */
import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const IMPORT_RULES = ['no-restricted-imports', 'no-restricted-syntax'];

let eslint: ESLint;
// Loading the config and its plugins takes seconds on a busy machine: once, under a hook's own timeout.
beforeAll(async () => {
  eslint = new ESLint({ cwd: ROOT });
  await eslint.lintText('', { filePath: `${ROOT}packages/shell/src/probe.ts` });
}, 60_000);

/** The import rules' findings for `code` linted as the file at `path`. */
async function importFindings(path: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: `${ROOT}${path}` });
  return (result?.messages ?? [])
    .filter((message) => IMPORT_RULES.includes(message.ruleId ?? ''))
    .map((message) => message.message);
}

const TAURI_API = "import { invoke } from '@tauri-apps/api/core';\nexport const x = invoke;";
const TAURI_ADAPTERS =
  "import { tauriVaultFs } from '@dfai/adapters/tauri';\nexport const x = tauriVaultFs;";
const TAURI_LATER = "export const x = () => import('@tauri-apps/api/core');";
const TAURI_ADAPTERS_LATER = "export const x = () => import('@dfai/adapters/tauri');";
const PLAIN_ADAPTER =
  "import { remarkMarkdown } from '@dfai/adapters';\nexport const x = remarkMarkdown;";
const READER = "import { pdfJsReader } from '@dfai/adapters/pdf';\nexport const x = pdfJsReader;";
const FAKE = "import { fakeVaultFs } from '@dfai/application';\nexport const x = fakeVaultFs;";

/** The shared shell's code and tests, and the web's: none may reach Tauri. */
const SHARED = [
  'packages/shell/src/probe.ts',
  'packages/shell/src/notes/probe.tsx',
  'packages/shell/src/probe.test.ts',
  'apps/web/src/probe.ts',
  'apps/web/src/probe.test.tsx',
];

/** Whether any finding says `words`. */
const says = (found: readonly string[], words: string) =>
  found.some((message) => message.includes(words));

describe('Tauri outside apps/desktop (#656)', () => {
  it.each(SHARED)('forbids an import of Tauri itself in %s', async (path) => {
    expect(says(await importFindings(path, TAURI_API), '@tauri-apps/*')).toBe(true);
  });

  it.each(SHARED)('forbids the Tauri adapters’ entry in %s', async (path) => {
    expect(says(await importFindings(path, TAURI_ADAPTERS), '@dfai/adapters/tauri')).toBe(true);
  });

  it.each(SHARED)('forbids Tauri, or its adapters, loaded by import() in %s', async (path) => {
    for (const code of [TAURI_LATER, TAURI_ADAPTERS_LATER]) {
      expect(says(await importFindings(path, code), 'apps/desktop')).toBe(true);
    }
  });

  it.each(['apps/web/src/probe.ts', 'packages/shell/src/probe.test.ts', 'apps/web/src/a.test.ts'])(
    'lets the root barrel, which holds no Tauri, through in %s',
    async (path) => {
      expect(await importFindings(path, PLAIN_ADAPTER)).toEqual([]);
    },
  );

  it('keeps the shell’s own code to the readers’ adapters: the rest comes through ports', async () => {
    const found = await importFindings('packages/shell/src/notes/probe.ts', PLAIN_ADAPTER);
    expect(says(found, 'but for /pdf and /epub')).toBe(true);
    const later = "export const x = () => import('@dfai/adapters');";
    expect(says(await importFindings('packages/shell/src/probe.ts', later), 'ports')).toBe(true);
    expect(await importFindings('packages/shell/src/reader/probe.ts', READER)).toEqual([]);
  });

  it('keeps the application’s fakes out of the web’s own code, and lets its tests use them', async () => {
    expect(says(await importFindings('apps/web/src/probe.ts', FAKE), 'test support')).toBe(true);
    expect(await importFindings('apps/web/src/probe.test.ts', FAKE)).toEqual([]);
  });

  it('keeps Tauri in the adapters to the tauri-* modules and their entry', async () => {
    const plain = 'packages/adapters/src/sync/probe.ts';
    expect(says(await importFindings(plain, TAURI_API), 'tauri-* module')).toBe(true);
    const sibling = "import { tauriGit } from './tauri-git.ts';\nexport const x = tauriGit;";
    expect(says(await importFindings(plain, sibling), 'tauri-* module')).toBe(true);
    expect(await importFindings('packages/adapters/src/sync/tauri-probe.ts', TAURI_API)).toEqual(
      [],
    );
    const entry = "export { tauriGit } from '../sync/tauri-git.ts';";
    expect(await importFindings('packages/adapters/src/tauri/index.ts', entry)).toEqual([]);
  });

  it.each([TAURI_API, TAURI_ADAPTERS, TAURI_LATER, TAURI_ADAPTERS_LATER])(
    'leaves Tauri to the desktop’s composition root: %s',
    async (code) => {
      expect(await importFindings('apps/desktop/src/probe.ts', code)).toEqual([]);
    },
  );

  it.each([
    ['packages/ui/src/probe.ts', '@dfai/shell'],
    ['packages/application/src/probe.ts', '@dfai/shell'],
    ['packages/shell/src/probe.ts', '@dfai/desktop'],
    ['packages/shell/src/probe.ts', '@dfai/web'],
    ['apps/web/src/probe.ts', '@dfai/desktop'],
  ])('keeps the shell outermost: %s may not import %s', async (path, module) => {
    const found = await importFindings(path, `import { x } from '${module}';\nexport const y = x;`);
    expect(says(found, module)).toBe(true);
  });
});
