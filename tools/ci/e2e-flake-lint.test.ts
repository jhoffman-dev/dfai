/*
 * The lint rules for the three shapes most flaky e2e tests share (#798): a key
 * before the focus lands, a value read once, and a wait by time. Run through
 * ESLint with the repo's own config over text given a path in e2e/.
 */
import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SPEC = 'e2e/probe.spec.ts';

let eslint: ESLint;
// Loading the config and its plugins takes seconds on a busy machine: once, under a hook's own timeout.
beforeAll(async () => {
  eslint = new ESLint({ cwd: ROOT });
  await eslint.lintText('', { filePath: `${ROOT}${SPEC}` });
}, 60_000);

/** What `rule` reports for `body`, run inside a test in `path`. */
async function findings(rule: string, body: string, path = SPEC): Promise<string[]> {
  const code = [
    "import { expect, test } from './fixtures.ts';",
    '',
    'test("probe", async ({ page }) => {',
    "  const field = page.getByRole('textbox');",
    body,
    '});',
    '',
  ].join('\n');
  const [result] = await eslint.lintText(code, { filePath: `${ROOT}${path}` });
  return (result?.messages ?? [])
    .filter((message) => message.ruleId === `e2e-flake/${rule}`)
    .map((message) => message.message);
}

describe('e2e-flake/no-wait-for-timeout', () => {
  it('refuses a wait by time, and says what to wait on instead', async () => {
    expect(await findings('no-wait-for-timeout', '  await page.waitForTimeout(300);')).toEqual([
      expect.stringContaining('Wait for a condition, not a time'),
    ]);
  });

  it('leaves a wait on a condition alone', async () => {
    expect(
      await findings('no-wait-for-timeout', "  await expect(field).toHaveText('Done');"),
    ).toEqual([]);
  });

  it('is only for e2e/', async () => {
    expect(
      await findings(
        'no-wait-for-timeout',
        '  await page.waitForTimeout(300);',
        'tools/ci/probe.ts',
      ),
    ).toEqual([]);
  });
});

describe('e2e-flake/no-one-shot-read', () => {
  it.each([
    ["  expect(await field.textContent()).toBe('Done');", 'toHaveText'],
    ["  expect(await field.innerText()).toBe('Done');", 'toHaveText'],
    ["  expect(await field.inputValue()).toBe('Done');", 'toHaveValue'],
    ["  expect(await field.getAttribute('aria-label')).toBe('Done');", 'toHaveAttribute'],
    ['  expect(await field.count()).toBe(2);', 'toHaveCount'],
    ['  expect(await field.isVisible()).toBe(true);', 'toBeVisible'],
    ['  expect(await field.isChecked()).toBe(true);', 'toBeChecked'],
    ["  expect.soft(await field.textContent()).toBe('Done');", 'toHaveText'],
    ["  expect((await field.textContent())?.trim(), 'the field').toBe('Done');", 'toHaveText'],
    ['  expect((await field.boundingBox())!.height).toBe(28);', 'expect.poll'],
  ])('refuses %s, naming %s', async (line, instead) => {
    expect(await findings('no-one-shot-read', line)).toEqual([
      expect.stringMatching(new RegExp(`reads once.*${instead.replace('.', '\\.')}`)),
    ]);
  });

  it.each([
    "  await expect(field).toHaveText('Done');",
    "  await expect.poll(() => field.textContent()).toBe('Done');",
    "  await expect.poll(async () => (await field.textContent())?.trim()).toBe('Done');",
    // A retried block reads again on each try.
    '  await expect(async () => expect(await field.count()).toBe(2)).toPass();',
    // A read kept for later is not an assertion on it.
    '  const before = await field.count();\n  expect(before).toBeGreaterThan(0);',
    // Reading a file the host wrote is not a Locator read.
    "  expect(await page.evaluate(() => document.title)).toBe('DFAI');",
  ])('leaves alone %s', async (line) => {
    expect(await findings('no-one-shot-read', line)).toEqual([]);
  });
});

describe('e2e-flake/no-keys-after-focus', () => {
  it.each([
    "  await field.focus();\n  await page.keyboard.press('Enter');",
    "  await field.focus();\n  await page.keyboard.type('Done');",
    "  await field.focus();\n  // A comment between is no wait.\n  await page.keyboard.insertText('Done');",
    "  await field.click();\n  await page.keyboard.type('Done');",
    "  if (field) {\n    await field.focus();\n    await page.keyboard.press('Space');\n  }",
  ])('refuses %s, and points at the helpers', async (lines) => {
    expect(await findings('no-keys-after-focus', lines)).toEqual([
      expect.stringContaining('use focusThenPress, focusThenType or clickThenType'),
    ]);
  });

  it.each([
    "  await field.focus();\n  await expect(field).toBeFocused();\n  await page.keyboard.press('Enter');",
    // A click before a shortcut or Escape: the key is for the page, not a field.
    "  await field.click();\n  await page.keyboard.press('Escape');",
    // Locator.press focuses its own element first.
    "  await field.focus();\n  await field.press('Enter');",
    "  await field.fill('Done');\n  await page.keyboard.press('Enter');",
  ])('leaves alone %s', async (lines) => {
    expect(await findings('no-keys-after-focus', lines)).toEqual([]);
  });
});

/*
 * Attack on PR #801: flaky shapes the rules let through. Each is `it.fails`
 * (the project's attack idiom) until the rule catches it; drop `.fails` with
 * the fix.
 */
describe('e2e-flake/no-keys-after-focus misses (attack #801)', () => {
  it.fails('refuses keys sent through page.keyboard kept in a variable', async () => {
    const lines =
      "  const { keyboard } = page;\n  await field.focus();\n  await keyboard.press('Enter');";
    expect(await findings('no-keys-after-focus', lines)).toHaveLength(1);
  });

  it.fails('refuses keys pressed in a loop right after focus()', async () => {
    const lines =
      "  await field.focus();\n  for (const key of ['ArrowDown', 'Enter']) await page.keyboard.press(key);";
    expect(await findings('no-keys-after-focus', lines)).toHaveLength(1);
  });

  it.fails('refuses typing right after a double click', async () => {
    const lines = "  await field.dblclick();\n  await page.keyboard.type('Done');";
    expect(await findings('no-keys-after-focus', lines)).toHaveLength(1);
  });

  it.fails(
    'refuses an editing key right after a click, which races the caret as typing does',
    async () => {
      const lines = "  await field.click();\n  await page.keyboard.press('Backspace');";
      expect(await findings('no-keys-after-focus', lines)).toHaveLength(1);
    },
  );

  it.fails('refuses keys right after a helper that only focuses', async () => {
    const lines =
      "  const focusField = () => field.focus();\n  await focusField();\n  await page.keyboard.press('Enter');";
    expect(await findings('no-keys-after-focus', lines)).toHaveLength(1);
  });

  it('refuses keys after focusing a locator kept in a variable', async () => {
    const lines =
      "  const row = page.getByRole('row');\n  await row.focus();\n  await page.keyboard.press('Enter');";
    expect(await findings('no-keys-after-focus', lines)).toHaveLength(1);
  });
});

describe('e2e-flake/no-one-shot-read misses (attack #801)', () => {
  it.fails('refuses a one-shot read given to the matcher rather than to expect()', async () => {
    const lines = '  const rows = 2;\n  expect(rows).toBe(await field.count());';
    expect(await findings('no-one-shot-read', lines)).toHaveLength(1);
  });

  it.fails('refuses a one-shot Locator.evaluate read of the page', async () => {
    const line = '  expect(await field.evaluate((element) => element.scrollTop)).toBe(0);';
    expect(await findings('no-one-shot-read', line)).toHaveLength(1);
  });

  it.fails('refuses text read into a variable and asserted on the next line', async () => {
    const lines = "  const text = await field.textContent();\n  expect(text).toBe('Done');";
    expect(await findings('no-one-shot-read', lines)).toHaveLength(1);
  });
});

describe('e2e-flake/no-wait-for-timeout misses (attack #801)', () => {
  it.fails('refuses a wait by time built from setTimeout', async () => {
    const line = '  await new Promise((done) => setTimeout(done, 300));';
    expect(await findings('no-wait-for-timeout', line)).toHaveLength(1);
  });

  it.fails('refuses a wait by time from node:timers/promises', async () => {
    const lines =
      "  const { setTimeout: sleep } = await import('node:timers/promises');\n  await sleep(300);";
    expect(await findings('no-wait-for-timeout', lines)).toHaveLength(1);
  });
});
