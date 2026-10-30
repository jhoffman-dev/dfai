/**
 * Skills are read on demand, never at launch (PR #620, ADR-0050 §6): opening
 * a vault that holds skills sends the host no command naming `.atlas/skills`,
 * and the sidebar lists none of a skill's files.
 */
import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost, sidebarSection } from './host.ts';

const SKILL = ['---', 'name: weekly-review', 'description: Reviews.', '---', '', 'Step.', ''].join(
  '\n',
);

interface RecordedCall {
  readonly command: string;
  readonly args: string;
}

/** Records every command the app sends the host, with its arguments as JSON. */
async function recordHostCalls(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (window !== window.top) return;
    const calls: { command: string; args: string }[] = [];
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: { invoke: (...args: unknown[]) => Promise<unknown> };
      }
    ).__TAURI_INTERNALS__;
    const invoke = internals.invoke;
    internals.invoke = (command, ...rest) => {
      if (typeof command === 'string' && !command.startsWith('plugin:event')) {
        // What a walk is told to skip names folders it never enters.
        const named = { ...((rest[0] ?? {}) as Record<string, unknown>) };
        delete named['skipDirectories'];
        let args: string;
        try {
          args = JSON.stringify(named);
        } catch {
          // An argument JSON cannot hold (bytes) names no path worth checking here.
          args = '';
        }
        calls.push({ command, args });
      }
      return invoke(command, ...rest);
    };
    Object.assign(window, { __recordedCalls: calls });
  });
}

const recorded = (page: Page): Promise<RecordedCall[]> =>
  page.evaluate(() => (window as unknown as { __recordedCalls: RecordedCall[] }).__recordedCalls);

test('opening a vault with skills sends the host nothing that names .atlas/skills', async ({
  page,
}) => {
  const vault = await createVault();
  await vault.mkdir('.atlas/skills/weekly-review/references');
  await vault.mkdir('.atlas/templates');
  await vault.write('.atlas/skills/weekly-review/SKILL.md', SKILL);
  await vault.write('.atlas/skills/weekly-review/references/guide.md', '# Guide\n');
  await vault.write('.atlas/templates/Meeting.md', '# Agenda\n');
  await vault.write('Plain.md', '# Plain\n');
  await installHost(page, vault);
  await recordHostCalls(page);

  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await expect(
    sidebarSection(page, 'userSpace').getByRole('treeitem', { name: 'Plain' }),
  ).toBeVisible();

  // Quiet first: the count is of everything launch asks, not of a moment in it.
  let seen = -1;
  await expect
    .poll(
      async () => {
        const now = (await recorded(page)).length;
        const quiet = now === seen;
        seen = now;
        return quiet;
      },
      { timeout: 15_000, intervals: [500] },
    )
    .toBe(true);

  const calls = await recorded(page);
  // The recorder sees paths: launch walks `.atlas` itself.
  expect(calls.filter(({ args }) => args.includes('.atlas')).length).toBeGreaterThan(0);
  const skillCalls = calls.filter(({ args }) => args.toLowerCase().includes('.atlas/skills'));
  expect(skillCalls).toEqual([]);

  const userSpace = sidebarSection(page, 'userSpace');
  await expect(userSpace.getByRole('treeitem', { name: 'SKILL', exact: true })).toHaveCount(0);
  await expect(userSpace.getByRole('treeitem', { name: 'guide', exact: true })).toHaveCount(0);
});
