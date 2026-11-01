/*
 * Attack on PR #699 (#657): ways the screen can still ask which platform it
 * is on, or decide from a platform's capabilities, that the lint rule does
 * not see. Each `it.fails` is a bypass the rule lets through today; the plain
 * `it`s are probes the rule already holds. Same harness as
 * platform-check-lint.test.ts: the repo's own ESLint config.
 */
import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RULES = ['no-restricted-imports', 'no-restricted-syntax'];

let eslint: ESLint;
beforeAll(async () => {
  eslint = new ESLint({ cwd: ROOT });
  await eslint.lintText('', { filePath: `${ROOT}packages/ui/src/probe.tsx` });
}, 60_000);

/** Whether linting `code` as the file at `path` reports it under the zone's import or syntax rules. */
async function refused(path: string, code: string): Promise<boolean> {
  const [result] = await eslint.lintText(code, { filePath: `${ROOT}${path}` });
  return (result?.messages ?? []).some((message) => RULES.includes(message.ruleId ?? ''));
}

const UI = 'packages/ui/src/probe.tsx';
const SHELL = 'packages/shell/src/probe.tsx';

describe('platform-check lint, bypasses (#699 attack)', () => {
  it.fails.each([UI, SHELL])(
    'refuses the device read by destructuring navigator in %s',
    async (path) => {
      expect(
        await refused(path, 'const { platform } = navigator;\nexport const p = platform;'),
      ).toBe(true);
    },
  );

  it.fails.each([UI, SHELL])(
    'refuses the device read by destructuring navigator under another name in %s',
    async (path) => {
      expect(
        await refused(path, 'const { userAgent: ua } = navigator;\nexport const p = ua;'),
      ).toBe(true);
    },
  );

  it.fails.each([UI, SHELL])(
    'refuses the device read with a computed key, navigator["platform"], in %s',
    async (path) => {
      expect(await refused(path, "export const p = () => navigator['platform'];")).toBe(true);
    },
  );

  it.fails.each([UI, SHELL])(
    "refuses the device read through window['navigator'] in %s",
    async (path) => {
      expect(await refused(path, "export const p = () => window['navigator'].userAgent;")).toBe(
        true,
      );
    },
  );

  it.each([UI, SHELL])(
    'refuses the device read through globalThis.navigator in %s',
    async (path) => {
      expect(await refused(path, 'export const p = () => globalThis.navigator.platform;')).toBe(
        true,
      );
    },
  );

  it.fails.each([UI, SHELL])(
    "refuses a platform's capabilities reached by a dynamic import in %s",
    async (path) => {
      const code =
        "export const caps = async () => (await import('@dfai/domain')).WEB_CAPABILITIES;";
      expect(await refused(path, code)).toBe(true);
    },
  );

  it.each([UI, SHELL])(
    'refuses the decision reached through a namespace import in %s',
    async (path) => {
      const code =
        "import * as app from '@dfai/application';\nexport const f = app.entryPointsOffered;";
      expect(await refused(path, code)).toBe(true);
    },
  );

  it.each([UI, SHELL])('refuses the decision imported under another name in %s', async (path) => {
    const code =
      "import { entryPointsOffered as offeredFor } from '@dfai/application';\nexport const f = offeredFor;";
    expect(await refused(path, code)).toBe(true);
  });

  it.fails.each([UI, SHELL])(
    'refuses a platform flag in constant case, IS_WEB, in %s',
    async (path) => {
      expect(await refused(path, 'export const f = (IS_WEB: boolean) => IS_WEB;')).toBe(true);
    },
  );

  it.fails.each([UI, SHELL])(
    'refuses a platform name matched by startsWith in %s',
    async (path) => {
      expect(
        await refused(path, "export const f = (where: string) => where.startsWith('mac');"),
      ).toBe(true);
    },
  );

  it.fails(
    'refuses the device asked in packages/application, the layer the screen calls for its answers',
    async () => {
      // A helper the UI would import from @dfai/application: the platform check moves one layer in.
      const code = "export const onIPad = () => navigator.userAgent.includes('iPad');";
      expect(await refused('packages/application/src/platform/probe.ts', code)).toBe(true);
    },
  );
});
