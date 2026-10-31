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
const TAURI_ADAPTER =
  "import { tauriVaultFs } from '@dfai/adapters';\nexport const x = tauriVaultFs;";
const TAURI_LATER = "export const x = () => import('@tauri-apps/api/core');";
const PLAIN_ADAPTER =
  "import { remarkMarkdown } from '@dfai/adapters';\nexport const x = remarkMarkdown;";
const READER = "import { pdfJsReader } from '@dfai/adapters/pdf';\nexport const x = pdfJsReader;";

/** The shared shell's code and tests, and the web's: none may reach Tauri. */
const SHARED = [
  'packages/shell/src/probe.ts',
  'packages/shell/src/notes/probe.tsx',
  'packages/shell/src/probe.test.ts',
  'apps/web/src/probe.ts',
  'apps/web/src/probe.test.tsx',
];

describe('Tauri outside apps/desktop (#656)', () => {
  it.each(SHARED)('forbids an import of Tauri itself in %s', async (path) => {
    const found = await importFindings(path, TAURI_API);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('@tauri-apps/*');
  });

  it.each(SHARED)('forbids a tauri… adapter by name in %s', async (path) => {
    const found = await importFindings(path, TAURI_ADAPTER);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('tauri… adapters');
  });

  it.each(['packages/shell/src/probe.ts', 'apps/web/src/probe.ts'])(
    'forbids Tauri loaded later, by import(), in %s',
    async (path) => {
      const found = await importFindings(path, TAURI_LATER);
      expect(found).toHaveLength(1);
      expect(found[0]).toContain('apps/desktop');
    },
  );

  it.each(SHARED)('lets the adapters that are not Tauri’s through in %s', async (path) => {
    expect(await importFindings(path, PLAIN_ADAPTER)).toEqual([]);
  });

  it('lets the shell load the readers’ own adapters', async () => {
    expect(await importFindings('packages/shell/src/reader/probe.ts', READER)).toEqual([]);
  });

  it.each([TAURI_API, TAURI_ADAPTER, TAURI_LATER])(
    'leaves Tauri to the desktop’s composition root: %s',
    async (code) => {
      expect(await importFindings('apps/desktop/src/probe.ts', code)).toEqual([]);
    },
  );

  it.each([
    ['packages/ui/src/probe.ts', '@dfai/shell'],
    ['packages/application/src/probe.ts', '@dfai/shell'],
    ['packages/shell/src/probe.ts', '@dfai/desktop'],
  ])('keeps the shell outermost: %s may not import %s', async (path, module) => {
    const found = await importFindings(path, `import { x } from '${module}';\nexport const y = x;`);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(module);
  });
});
