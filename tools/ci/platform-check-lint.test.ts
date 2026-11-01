/*
 * The lint rule that keeps the screen from asking which platform it is on
 * (#657): packages/ui and packages/shell read which entry points are offered,
 * decided in the application from a platform's capabilities, and never the
 * capabilities or the platform themselves. Run through ESLint with the repo's
 * own config, as tauri-zone-lint.test.ts runs the Tauri zone.
 */
import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RULES = ['no-restricted-imports', 'no-restricted-syntax'];
const SAYS = 'which entry points are offered';

let eslint: ESLint;
// Loading the config and its plugins takes seconds on a busy machine: once, under a hook's own timeout.
beforeAll(async () => {
  eslint = new ESLint({ cwd: ROOT });
  await eslint.lintText('', { filePath: `${ROOT}packages/ui/src/probe.tsx` });
}, 60_000);

/** Whether linting `code` as the file at `path` finds a platform check. */
async function refused(path: string, code: string): Promise<boolean> {
  const [result] = await eslint.lintText(code, { filePath: `${ROOT}${path}` });
  return (result?.messages ?? []).some(
    (message) => RULES.includes(message.ruleId ?? '') && message.message.includes(SAYS),
  );
}

const SCREEN = [
  'packages/ui/src/probe.tsx',
  'packages/ui/src/settings/probe.ts',
  'packages/shell/src/probe.tsx',
  'packages/shell/src/settings/probe.ts',
];

const CHECKS = {
  'a platform compared': "export const f = (platform: string) => platform === 'web';",
  'a platform compared, the other way round':
    "export const f = (platform: string) => 'web' !== platform;",
  'a platform read off an object':
    "export const f = (host: { platform: string }) => host.platform == 'desktop';",
  'a switch on the platform':
    'export function f(platform: string) { switch (platform) { default: return 1; } }',
  'a flag naming one': 'export const f = (isWeb: boolean) => isWeb;',
  'the web’s capabilities':
    "import { WEB_CAPABILITIES } from '@dfai/domain';\nexport const x = WEB_CAPABILITIES;",
  'the desktop’s capabilities':
    "import { DESKTOP_CAPABILITIES } from '@dfai/domain';\nexport const x = DESKTOP_CAPABILITIES;",
  'what a platform lacks':
    "import { capabilitiesLacking } from '@dfai/domain';\nexport const x = capabilitiesLacking;",
} as const;

const CASES = SCREEN.flatMap((path) =>
  Object.entries(CHECKS).map(([what, code]) => ({ path, what, code })),
);

describe('the screen never asks which platform it is on (#657)', () => {
  it.each(CASES)('refuses $what in $path', async ({ path, code }) => {
    expect(await refused(path, code)).toBe(true);
  });

  it.each(SCREEN)('lets %s read what is offered', async (path) => {
    const code = [
      "import { EVERY_ENTRY_POINT, type EntryPointsOffered } from '@dfai/application';",
      'export const f = (offered: EntryPointsOffered = EVERY_ENTRY_POINT) => offered.kindleSettings;',
    ].join('\n');
    expect(await refused(path, code)).toBe(false);
  });

  it('lets the shell be handed a platform’s capabilities as a type, to decide from', async () => {
    const code = [
      "import type { PlatformCapabilities } from '@dfai/domain';",
      'export type Handed = { readonly capabilities: PlatformCapabilities };',
    ].join('\n');
    expect(await refused('packages/shell/src/probe.tsx', code)).toBe(false);
  });

  it.each([
    'apps/desktop/src/probe.ts',
    'apps/web/src/probe.ts',
    'packages/shell/src/probe.test.tsx',
  ])('lets %s name a platform’s capabilities: a composition root, or a test', async (path) => {
    const code =
      "import { WEB_CAPABILITIES } from '@dfai/domain';\nexport const x = WEB_CAPABILITIES;";
    expect(await refused(path, code)).toBe(false);
  });
});
