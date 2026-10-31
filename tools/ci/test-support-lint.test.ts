/*
 * The lint rule that keeps tests and their support files out of the app:
 * a `*.test-support.ts` file may use the packages' test support, so the app
 * may not import it, nor a test. Run through ESLint with the repo's own config
 * over text given a path.
 */
import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RULE = '@typescript-eslint/no-restricted-imports';

let eslint: ESLint;
// Loading the config and its plugins takes seconds on a busy machine: once, under a hook's own timeout.
beforeAll(async () => {
  eslint = new ESLint({ cwd: ROOT });
  await eslint.lintText('', { filePath: `${ROOT}packages/adapters/src/markdown/probe.ts` });
}, 60_000);

async function findings(path: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: `${ROOT}${path}` });
  return (result?.messages ?? [])
    .filter((message) => message.ruleId === RULE)
    .map((message) => message.message);
}

const IMPORTS = [
  "import { describeSeeds } from './captures-roundtrip-615c.test-support.ts';",
  "import { describeSeeds } from './captures-roundtrip-615c.test-support';",
  "import { cases } from './frontmatter-write.test.ts';",
  "import { cases } from '../markdown/frontmatter-write.test';",
];

describe('importing a test or its support', () => {
  it.each(IMPORTS)('is refused in the app: %s', async (line) => {
    expect(
      await findings('packages/adapters/src/markdown/probe.ts', `${line}\nexport {};\n`),
    ).toEqual([expect.stringContaining('A test or its support is for tests')]);
  });

  it.each(IMPORTS)('is allowed in a test: %s', async (line) => {
    expect(await findings('packages/adapters/src/markdown/probe.test.ts', `${line}\n`)).toEqual([]);
  });

  it('is allowed in another support file, and in test tooling', async () => {
    expect(
      await findings('packages/adapters/src/markdown/probe.test-support.ts', `${IMPORTS[0]}\n`),
    ).toEqual([]);
    expect(await findings('tools/ci/probe.ts', `${IMPORTS[0]}\n`)).toEqual([]);
  });

  it('still refuses the packages’ test support in the app, beside it', async () => {
    expect(
      await findings(
        'packages/adapters/src/markdown/probe.ts',
        "import { seededRandom } from '@dfai/domain/testing';\nexport {};\n",
      ),
    ).toEqual([expect.stringContaining('Test support is for tests')]);
  });

  it('leaves an ordinary module alone', async () => {
    expect(
      await findings(
        'packages/adapters/src/markdown/probe.ts',
        "import { renderBlock } from './markdown-blocks.ts';\nexport {};\n",
      ),
    ).toEqual([]);
  });
});
