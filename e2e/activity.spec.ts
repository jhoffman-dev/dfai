import { utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost, sidebarSection, type FakeHost } from './host.ts';

/**
 * U-28: the Activity log. An automation run shows up in it; a red notice
 * shows up in it and badges its row in the sidebar until the page is opened;
 * the filters narrow it to errors; and a line opens what it is about.
 */

const TASK_TYPE = [
  '---',
  'name: task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [backlog, doing, done]',
  '---',
  '',
].join('\n');

const RULE = [
  '---',
  'atlas: automation',
  'name: Tidy tasks',
  'enabled: true',
  'when: manually',
  'which: FROM task WHERE status = done',
  'olderThanDays: 30',
  'do: archive',
  'id: Tidy tasks',
  '---',
  '',
].join('\n');

const DAY_MS = 86_400_000;

async function openVault(page: Page): Promise<{ host: FakeHost; root: string }> {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/automations');
  await vault.mkdir('Tasks');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write('.atlas/automations/Tidy tasks.md', RULE);
  const old = new Date(Date.now() - 40 * DAY_MS);
  for (const name of ['Old done', 'Also done']) {
    await vault.write(`Tasks/${name}.md`, '---\ntype: task\nstatus: done\n---\n\nPrivate words.\n');
    await utimes(join(vault.root, `Tasks/${name}.md`), old, old);
  }
  const host = await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return { host, root: vault.root };
}

const goTo = (page: Page) => page.getByRole('list', { name: 'Go to' });
const activityPage = (page: Page) => page.getByRole('article', { name: 'Activity' });
const lines = (page: Page) =>
  activityPage(page).getByRole('list', { name: 'Activity lines' }).getByRole('listitem');

test('an automation run, a red notice and the filters, in the Activity log', async ({ page }) => {
  const { host, root } = await openVault(page);

  // Run the automation by hand.
  await goTo(page).getByRole('button', { name: 'Automations', exact: true }).click();
  const automations = page.getByRole('article', { name: 'Automations' });
  await automations.getByRole('button', { name: 'Run Tidy tasks now' }).click();

  // Its summary is the newest line of the Activity page, linked to its rule.
  await goTo(page).getByRole('button', { name: 'Activity', exact: true }).click();
  const run = lines(page).filter({ hasText: 'Tidy tasks: Ran by hand. Archived 2 notes.' });
  await expect(run).toHaveCount(1);
  await expect(run).toContainText('Automations');
  await expect(run).toContainText('Info');
  await expect(run.getByRole('button', { name: 'Open Tidy tasks' })).toBeVisible();
  // A line is one of the table view's 34px hairline rows (UI v2 slice 13b).
  await expect.poll(async () => (await run.boundingBox())?.height).toBe(34);

  // Nothing is badged while there are no errors.
  await expect(goTo(page).getByRole('button', { name: 'Activity', exact: true })).toBeVisible();

  // A red notice, away from the page: creating a note fails.
  await goTo(page).getByRole('button', { name: 'Automations', exact: true }).click();
  host.failNext('create_note', 'the disk is full');
  await page.getByRole('button', { name: 'New note' }).click();
  await page.getByRole('menuitem', { name: 'Blank note' }).click();
  await expect(page.locator('.notice').filter({ hasText: 'the disk is full' })).toBeVisible();

  // The row is badged with the errors since the page was last open.
  const badged = goTo(page).getByRole('button', { name: /^Activity, \d+ new errors?$/ });
  await expect(badged).toBeVisible();
  await expect(badged.locator('.sidebar__badge')).toHaveText(/^[1-9]\d*$/);

  // Opening the page sees them: the badge goes.
  await badged.click();
  await expect(goTo(page).getByRole('button', { name: 'Activity', exact: true })).toBeVisible();

  // One failure, one line: the notice where creating the note gave up (A28-01).
  await expect(lines(page).filter({ hasText: 'the disk is full' })).toHaveCount(1);

  // Errors only: the failure, not the run.
  const everything = await lines(page).count();
  await activityPage(page).getByRole('radio', { name: 'Errors only' }).click();
  await expect(lines(page).filter({ hasText: 'Tidy tasks' })).toHaveCount(0);
  await expect(lines(page).filter({ hasText: 'the disk is full' })).not.toHaveCount(0);
  await expect.poll(() => lines(page).count()).toBeLessThan(everything);
  for (const line of await lines(page).all()) await expect(line).toContainText('Error');

  // Each kind is a filter of its own: App shows the red notice, as the window showed it.
  await activityPage(page).getByRole('button', { name: 'App' }).click();
  await expect(lines(page)).toHaveCount(1);
  await expect(lines(page).first()).toContainText('the disk is full');

  // Back to everything, then search.
  await activityPage(page).getByRole('button', { name: 'App' }).click();
  await activityPage(page).getByRole('radio', { name: 'Everything' }).click();
  await activityPage(page).getByRole('searchbox', { name: 'Search activity' }).fill('archived');
  await expect(lines(page)).toHaveCount(1);

  // A line opens what it is about: the rule's line opens the Automations page.
  await lines(page).first().getByRole('button', { name: 'Open Tidy tasks' }).click();
  await expect(page.getByRole('article', { name: 'Automations' })).toBeVisible();

  // Kept outside the vault, one JSON line each, with no machine path or note contents.
  const kept = host.activityLog();
  // The run and the one failure: a failure is one line (A28-01).
  expect(kept.trim().split('\n').length).toBeGreaterThanOrEqual(2);
  expect(kept).not.toContain(root);
  expect(kept).not.toContain('Private words');
});

test('renaming a note with links to it keeps no error line for the offer to update them', async ({
  page,
}) => {
  const vault = await createVault();
  await vault.write('plan.md', '# Plan\n\nThe plan.\n');
  await vault.write('two.md', '# Two\n\nSee [[plan]] first.\n');
  const host = await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();

  const pages = sidebarSection(page, 'userSpace');
  await pages.getByRole('treeitem', { name: 'plan', exact: true }).hover();
  await pages.getByRole('button', { name: 'Options for plan', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Rename/ }).click();
  const name = pages.getByRole('textbox', { name: 'Name for plan' });
  await name.fill('Roadmap');
  await name.press('Enter');
  await expect(page.getByRole('alert').filter({ hasText: 'at “plan”' })).toBeVisible();

  // Then a real failure, whose line is written after anything recorded before it.
  host.failNext('create_note', 'the disk is full');
  await page.getByRole('button', { name: 'New note' }).click();
  await page.getByRole('menuitem', { name: 'Blank note' }).click();
  await expect.poll(() => host.activityLog()).toContain('the disk is full');

  // The offer is a question, not a failure: the only error kept is the real one.
  const errors = host
    .activityLog()
    .split('\n')
    .filter((line) => line.includes('"level":"error"'));
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain('the disk is full');
});
