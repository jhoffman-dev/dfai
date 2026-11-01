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
  'a platform’s name compared, under another name':
    "export const f = (where: string) => where === 'iPad';",
  'a platform’s name compared the other way round':
    "export const f = (kind: string) => 'windows' !== kind;",
  'a platform’s name looked for in a list':
    "export const f = (where: string) => ['web', 'ios'].includes(where);",
  'a platform’s name looked for in a string':
    "export const f = (where: string) => where.includes('macos');",
  'the device asked of the browser': 'export const f = () => navigator.platform;',
  'the browser’s name asked of it': 'export const f = () => navigator.userAgent;',
  'the device asked through the window': 'export const f = () => window.navigator.userAgentData;',
  'the web’s capabilities':
    "import { WEB_CAPABILITIES } from '@dfai/domain';\nexport const x = WEB_CAPABILITIES;",
  'the desktop’s capabilities':
    "import { DESKTOP_CAPABILITIES } from '@dfai/domain';\nexport const x = DESKTOP_CAPABILITIES;",
  'what a platform lacks':
    "import { capabilitiesLacking } from '@dfai/domain';\nexport const x = capabilitiesLacking;",
  'a platform’s capabilities, as a type':
    "import type { PlatformCapabilities } from '@dfai/domain';\nexport type X = PlatformCapabilities;",
  'the decision from them':
    "import { entryPointsOffered } from '@dfai/application';\nexport const x = entryPointsOffered;",
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

  it.each(SCREEN)(
    'lets %s compare a kind that only shares a name with a platform',
    async (path) => {
      // A citation's kind is 'web' (ask-answer.tsx): a switch case is no platform check.
      const code =
        "export function f(kind: string) { switch (kind) { case 'web': return 1; default: return 0; } }";
      expect(await refused(path, code)).toBe(false);
    },
  );

  it('lets the shell’s mount be handed a platform’s capabilities and decide from them', async () => {
    const code = [
      "import { entryPointsOffered } from '@dfai/application';",
      "import type { PlatformCapabilities } from '@dfai/domain';",
      'export const decide = (capabilities: PlatformCapabilities) => entryPointsOffered(capabilities);',
    ].join('\n');
    expect(await refused('packages/shell/src/mount-shell.tsx', code)).toBe(false);
  });

  it('holds the shell’s mount to the rest of the zone', async () => {
    const code =
      "import { WEB_CAPABILITIES } from '@dfai/domain';\nexport const x = WEB_CAPABILITIES;";
    expect(await refused('packages/shell/src/mount-shell.tsx', code)).toBe(true);
  });

  it.each([
    'packages/shell/src/app-shortcuts.ts',
    'packages/shell/src/probe.test.tsx',
    'packages/ui/src/probe.test.tsx',
  ])('lets %s read the device, for the command key it presses', async (path) => {
    expect(await refused(path, 'export const mac = () => /Mac/.test(navigator.platform);')).toBe(
      false,
    );
  });

  it('still refuses a platform compared in the shortcuts, which read the device', async () => {
    const code = "export const f = (platform: string) => platform === 'web';";
    expect(await refused('packages/shell/src/app-shortcuts.ts', code)).toBe(true);
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
