/*
 * Second attack on PR #689 (#656): the regex zone that 8869c6e7 put in
 * eslint.config.js. Each case is code that, committed where it says, reaches
 * Tauri or the application's fakes from what the web build bundles with lint
 * green — or, the last, a harmless name the zone refuses. Each was `it.fails`
 * until the zone answered it.
 */
import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const IMPORT_RULES = ['no-restricted-imports', 'no-restricted-syntax'];

let eslint: ESLint;
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

const SHELL = 'packages/shell/src/probe.ts';
const WEB = 'apps/web/src/probe.ts';
const TAURI_API = "import { invoke } from '@tauri-apps/api/core';\nexport const x = invoke;";
const TAURI_ADAPTERS =
  "import { tauriVaultFs } from '@dfai/adapters/tauri';\nexport const x = tauriVaultFs;";

describe('the Tauri zone, second attack (#689)', () => {
  it.each([SHELL, WEB])(
    'refuses Tauri’s globals named by a template literal in %s',
    async (path) => {
      const code =
        'const w = window as unknown as Record<string, unknown>;\nexport const x = w[`__TAURI_INTERNALS__`];';
      expect(await importFindings(path, code)).not.toEqual([]);
    },
  );

  it('refuses the application’s fakes loaded by import() in the web', async () => {
    const code = "export const x = () => import('@dfai/application').then((m) => m.fakeVaultFs);";
    expect(await importFindings(WEB, code)).not.toEqual([]);
  });

  // The shell draws @dfai/ui and the web bundles it: Tauri there is Tauri in the web build.
  it('refuses Tauri in packages/ui, which the shell and the web draw', async () => {
    expect(await importFindings('packages/ui/src/probe.tsx', TAURI_API)).not.toEqual([]);
  });

  // The Tauri adapters sit beside the others (kindle/tauri-kindle.ts): only the root barrel's
  // own exports keep them out of what the web composes, and nothing lints those.
  it('refuses a tauri… adapter exported from the root @dfai/adapters barrel', async () => {
    const code = "export { tauriKindleNotebook } from './kindle/tauri-kindle.ts';";
    expect(await importFindings('packages/adapters/src/index.ts', code)).not.toEqual([]);
  });

  // The zone's globs are *.{ts,tsx}; TypeScript and Vite take .mts as well.
  it('refuses the Tauri adapters from a .mts file in the shell', async () => {
    expect(await importFindings('packages/shell/src/probe.mts', TAURI_ADAPTERS)).not.toEqual([]);
  });

  it.each([SHELL, WEB])(
    'lets a local name that only starts with tauri through in %s',
    async (path) => {
      const code = 'const tauriLike = 1;\nexport const tauriConfigured = tauriLike > 0;';
      expect(await importFindings(path, code)).toEqual([]);
    },
  );
});
