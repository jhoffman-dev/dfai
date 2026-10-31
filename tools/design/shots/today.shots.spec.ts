// `pnpm shots`: the Today page. What the shots specs share, and why they assert
// nothing, is in kit.ts.
import { join } from 'node:path';
import { expect, test } from '../../../e2e/fixtures.ts';
import { createVault, installHost, type FakeVault } from '../../../e2e/host.ts';
import { OUT, THEME_KEY, SETTLE_MS, openVault, useTheme } from './kit.ts';

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

/** #111: the Today page on a fixed day, each section holding something. */
const TODAY_NOW = new Date(2026, 9, 13, 9, 0, 0);

async function todayVault(): Promise<FakeVault> {
  const vault = await createVault();
  for (const folder of ['.atlas/types', 'People', 'Projects', 'Tasks', 'Inbox']) {
    await vault.mkdir(folder);
  }
  const fm = (lines: string[]) => ['---', ...lines, '---', '', ''].join('\n');
  await vault.write(
    '.atlas/types/task.md',
    fm([
      'name: task',
      'label: Task',
      'properties:',
      '  status:',
      '    kind: select',
      '    options: [inbox, backlog, next-action, in-progress, waiting, someday, longterm, archive]',
      '    done: archive',
      '  waiting_on:',
      '    kind: relation',
      '    target: person',
      '  contexts:',
      '    kind: multi-select',
      '  defer: date',
      '  due: date',
    ]),
  );
  await vault.write('.atlas/types/project.md', fm(['name: project', 'label: Project']));
  await vault.write('.atlas/types/person.md', fm(['name: person', 'label: Person']));
  const tasks: Record<string, string[]> = {
    'Renew the licence': ['status: backlog', 'due: 2026-10-09', 'project: "[[Larkspur rollout]]"'],
    'Reply to the auditor': ['status: next-action', 'due: 2026-10-12', 'contexts: ["@email"]'],
    'Send the figures': [
      'status: next-action',
      'due: 2026-10-13',
      'project: "[[Larkspur rollout]]"',
    ],
    'Book the venue': ['status: someday', 'defer: 2026-10-13'],
    'Clear the shed': ['status: backlog', 'defer: 2026-10-09'],
    'Draft the plan': [
      'status: in-progress',
      'project: "[[DFAI]]"',
      'contexts: ["@desk", "@deep"]',
    ],
    'Ship the Today page': ['status: next-action', 'project: "[[DFAI]]"', 'contexts: ["@desk"]'],
    'Write the guide entry': ['status: next-action', 'project: "[[DFAI]]"', 'due: 2026-10-16'],
    'Order the seed trays': [
      'status: next-action',
      'project: "[[Garden]]"',
      'contexts: ["@errands"]',
    ],
    'Call the bank': ['status: next-action', 'contexts: ["@phone"]'],
    'Quote from Larkspur': ['status: waiting', 'waiting_on: "[[Mara Quill]]"'],
    'Signed contract': ['status: waiting', 'waiting_on: "[[Mara Quill]]"'],
    'Venue shortlist': ['status: waiting', 'waiting_on: "[[Tobias Fenn]]"'],
  };
  for (const [title, lines] of Object.entries(tasks)) {
    await vault.write(`Tasks/${title}.md`, fm(['type: task', ...lines]));
  }
  for (const person of ['Mara Quill', 'Tobias Fenn']) {
    await vault.write(`People/${person}.md`, fm(['type: person']));
  }
  for (const project of ['DFAI', 'Garden', 'Larkspur rollout', 'Shed']) {
    await vault.write(`Projects/${project}.md`, fm(['type: project', 'status: active']));
  }
  await vault.write('Inbox/Idea.md', 'A thought.\n');
  return vault;
}

for (const theme of ['light', 'dark'] as const) {
  test(`today shots, ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1500 });
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
      key: THEME_KEY,
      value: theme,
    });
    await installHost(page, await todayVault());
    await page.clock.setFixedTime(TODAY_NOW);
    await page.goto('/');
    await openVault(page);
    await useTheme(page, theme);
    await page.getByRole('list', { name: 'Go to' }).getByRole('button', { name: 'Today' }).click();
    await expect(page.getByRole('article', { name: 'Today' })).toBeVisible();
    await page.waitForTimeout(SETTLE_MS);
    await page.screenshot({ path: join(OUT, `today-${theme}.png`), animations: 'disabled' });
    await page.getByRole('button', { name: 'Move Call the bank to…' }).click();
    await expect(page.getByRole('menu')).toBeVisible();
    await page.waitForTimeout(SETTLE_MS);
    await page.screenshot({ path: join(OUT, `today-menu-${theme}.png`), animations: 'disabled' });
  });
}
