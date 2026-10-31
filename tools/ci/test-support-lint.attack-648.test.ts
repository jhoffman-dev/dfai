/*
 * Attack on PR #648: imports that bring a test, or a suite's support file,
 * into the app past the rule that keeps them out (eslint.config.js, the
 * `@typescript-eslint/no-restricted-imports` block). Each way
 * through that was found is closed, and held closed here.
 */
import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const APP_FILE = 'packages/adapters/src/markdown/probe.ts';

let eslint: ESLint;
beforeAll(async () => {
  eslint = new ESLint({ cwd: ROOT });
  await eslint.lintText('', { filePath: `${ROOT}${APP_FILE}` });
}, 60_000);

/** Every finding of any import-restricting rule on `code`, as if it were the app's `APP_FILE`. */
async function refusals(code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: `${ROOT}${APP_FILE}` });
  return (result?.messages ?? [])
    .filter((message) => /restricted-imports/.test(message.ruleId ?? ''))
    .map((message) => message.message);
}

describe('test code reaching the app past the lint rule', () => {
  it('refuses a static re-export of a support file', async () => {
    expect(
      await refusals("export * from './captures-roundtrip-615c.test-support.ts';\n"),
    ).not.toEqual([]);
  });

  it('refuses a dynamic import() of a support file', async () => {
    expect(
      await refusals(
        "export const load = () => import('./captures-roundtrip-615c.test-support.ts');\n",
      ),
    ).not.toEqual([]);
  });

  it('refuses importing a Playwright spec, which the rule lets use test support', async () => {
    expect(
      await refusals("import { cases } from './frontmatter-write.spec.ts';\nexport { cases };\n"),
    ).not.toEqual([]);
  });

  it('refuses a relative import of a package’s testing folder, which may re-export support', async () => {
    // `packages/*/src/testing/**` is ignored by the rule, so it may re-export a `.test-support` file.
    expect(
      await refusals(
        "import { seededRandom } from '../../../domain/src/testing/index.ts';\nexport { seededRandom };\n",
      ),
    ).not.toEqual([]);
  });
});
