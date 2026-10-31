/*
 * Attack on PR #689 (#656): ways to reach Tauri from the shared shell or the
 * web build that the zone in eslint.config.js lets through. Each case is
 * code that, if committed to packages/shell or apps/web, puts Tauri (or a
 * tauri… adapter, or the desktop's own composition) back into shared code
 * with lint green. `it.fails` until the zone rejects it.
 */
import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Noise every fixture trips, unrelated to the zone. */
const UNRELATED = ['@typescript-eslint/no-explicit-any', '@typescript-eslint/no-unused-vars'];

let eslint: ESLint;
beforeAll(async () => {
  eslint = new ESLint({ cwd: ROOT });
  await eslint.lintText('', { filePath: `${ROOT}packages/shell/src/probe.ts` });
}, 60_000);

/** Every error ESLint reports for `code` at `path`, by rule, but the unrelated noise. */
async function errors(path: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: `${ROOT}${path}` });
  return (result?.messages ?? [])
    .filter((message) => message.severity === 2 && !UNRELATED.includes(message.ruleId ?? ''))
    .map((message) => `${message.ruleId ?? 'parse'}: ${message.message}`);
}

const SHELL = 'packages/shell/src/notes/probe.ts';
const WEB = 'apps/web/src/probe.ts';

describe('the Tauri zone holds against a determined import (attack #689)', () => {
  it.fails.each([
    [SHELL, '../../../../apps/desktop/src/composition'],
    [WEB, '../../desktop/src/composition'],
  ])('rejects %s reaching the desktop composition by a relative path (%s)', async (path, to) => {
    const code = `import { composeDesktop } from '${to}';\nexport const x = composeDesktop;`;
    expect(await errors(path, code)).not.toEqual([]);
  });

  it.fails.each([
    [SHELL, '../../../adapters/src/vault/tauri-vault-fs'],
    [WEB, '../../../packages/adapters/src/vault/tauri-vault-fs'],
  ])('rejects %s reaching a tauri… adapter file by a relative path (%s)', async (path, to) => {
    const code = `import { tauriVaultFs } from '${to}';\nexport const x = tauriVaultFs;`;
    expect(await errors(path, code)).not.toEqual([]);
  });

  it.fails.each([SHELL, WEB])(
    'rejects a tauri… adapter taken from a dynamic import of @dfai/adapters in %s',
    async (path) => {
      const code = "export const x = async () => (await import('@dfai/adapters')).tauriVaultFs;";
      expect(await errors(path, code)).not.toEqual([]);
    },
  );

  it.fails.each([SHELL, WEB])('rejects reading the Tauri bridge off window in %s', async (path) => {
    const code = 'export const x = (window as any).__TAURI_INTERNALS__;';
    expect(await errors(path, code)).not.toEqual([]);
  });

  it.fails.each([SHELL, WEB])("rejects reading globalThis['__TAURI__'] in %s", async (path) => {
    const code = "export const x = (globalThis as any)['__TAURI__'];";
    expect(await errors(path, code)).not.toEqual([]);
  });

  it.fails('rejects apps/web importing the desktop app (@dfai/desktop)', async () => {
    const code = "import * as desktop from '@dfai/desktop';\nexport const x = desktop;";
    expect(await errors(WEB, code)).not.toEqual([]);
  });
});
