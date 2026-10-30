import { utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, type FakeVault } from './host.ts';
import { toastSaying } from './toasts.ts';

/**
 * #108: choosing tasks for today. On a fixed clock, Today chooses a task —
 * it heads the page under Chosen for today and the file carries the day —
 * and pressing it again takes it off, leaving the file byte for byte as it
 * was. The next day, yesterday's choice is under Carried over, to keep or drop.
 */

/** 2026-10-28, midday where the test runs. */
const NOW = new Date(2026, 9, 28, 12, 0, 0);
const TOMORROW = new Date(2026, 9, 29, 9, 0, 0);

const task = (frontmatter: string[]) =>
  ['---', 'type: task', ...frontmatter, '---', '', 'A task.', ''].join('\n');

const GTD_TASK_TYPE = [
  '---',
  'name: task',
  'label: Task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [inbox, backlog, next-action, in-progress, waiting, someday, longterm, archive]',
  '    done: archive',
  '  defer: date',
  '  due: date',
  '  completed: date',
  '---',
  '',
  '# Task',
  '',
].join('\n');

const CALL = task(['status: next-action', 'due: 2026-11-02 # before the proofs go out']);
const NOTES: Record<string, string> = {
  'Tasks/Call the printer.md': CALL,
  'Tasks/Book the hall.md': task(['status: next-action']),
  'Tasks/Draft the agenda.md': task(['status: in-progress']),
};

async function openVault(page: Page): Promise<FakeVault> {
  const vault = await createVault();
  for (const folder of ['.atlas/types', 'Tasks']) await vault.mkdir(folder);
  await vault.write('.atlas/types/task.md', GTD_TASK_TYPE);
  for (const [path, text] of Object.entries(NOTES)) {
    await vault.write(path, text);
    await utimes(join(vault.root, path), NOW, NOW);
  }
  await installHost(page, vault);
  await page.clock.setFixedTime(NOW);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await page.getByRole('list', { name: 'Go to' }).getByRole('button', { name: 'Today' }).click();
  await expect(today(page)).toBeVisible();
  return vault;
}

const today = (page: Page) => page.getByRole('article', { name: 'Today' });
const section = (page: Page, name: string) =>
  today(page).getByRole('region', { name, exact: true });
const itemsIn = (page: Page, name: string) => section(page, name).locator('.table__title');

test('Today chooses a task, lists it first, and takes it off leaving the file as it was', async ({
  page,
}) => {
  const vault = await openVault(page);
  // The Task type is given `focus` on opening, and nothing else of it changes.
  await expectFile(vault, '.atlas/types/task.md').toContain('focus:');
  await expectFile(vault, '.atlas/types/task.md').toContain('  completed: date\n');
  await expect(section(page, 'Chosen for today').getByText(/Nothing chosen yet/)).toBeVisible();
  await expect(itemsIn(page, 'Next actions')).toHaveText(['Call the printer', 'Book the hall']);

  await section(page, 'Next actions')
    .getByRole('button', { name: 'Choose Call the printer for today' })
    .click();

  await expect(itemsIn(page, 'Chosen for today')).toHaveText(['Call the printer']);
  await expect(itemsIn(page, 'Next actions')).toHaveText(['Book the hall']);
  await expect(toastSaying(page, 'Chose “Call the printer” for today.')).toBeVisible();
  await expectFile(vault, 'Tasks/Call the printer.md').toBe(
    CALL.replace('# before the proofs go out\n', '# before the proofs go out\nfocus: 2026-10-28\n'),
  );

  const takeOff = section(page, 'Chosen for today').getByRole('button', {
    name: 'Take Call the printer off today',
  });
  await expect(takeOff).toHaveAttribute('aria-pressed', 'true');
  await takeOff.click();

  await expect(section(page, 'Chosen for today').getByText(/Nothing chosen yet/)).toBeVisible();
  await expect(itemsIn(page, 'Next actions')).toHaveText(['Call the printer', 'Book the hall']);
  await expectFile(vault, 'Tasks/Call the printer.md').toBe(CALL);
});

test('the next day, yesterday’s choices are carried over, to keep for today or drop', async ({
  page,
}) => {
  const vault = await openVault(page);
  for (const title of ['Book the hall', 'Draft the agenda']) {
    await today(page)
      .getByRole('button', { name: `Choose ${title} for today` })
      .click();
    await expectFile(vault, `Tasks/${title}.md`).toContain('focus: 2026-10-28');
  }
  await expect(itemsIn(page, 'Chosen for today')).toHaveText(['Book the hall', 'Draft the agenda']);
  await expect(section(page, 'Carried over')).toHaveCount(0);

  // Midnight passes with the page open: nothing is written, the page reads the new day.
  await page.clock.setFixedTime(TOMORROW);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));

  await expect(itemsIn(page, 'Carried over')).toHaveText(['Book the hall', 'Draft the agenda']);
  await expect(section(page, 'Chosen for today').getByText(/Nothing chosen yet/)).toBeVisible();
  await expectFile(vault, 'Tasks/Book the hall.md').toContain('focus: 2026-10-28');

  const carried = section(page, 'Carried over');
  await carried.getByRole('button', { name: 'Keep Book the hall for today' }).click();
  await expect(itemsIn(page, 'Chosen for today')).toHaveText(['Book the hall']);
  await expectFile(vault, 'Tasks/Book the hall.md').toContain('focus: 2026-10-29');

  await carried.getByRole('button', { name: 'Drop Draft the agenda from today' }).click();
  await expect(section(page, 'Carried over')).toHaveCount(0);
  await expect(itemsIn(page, 'In progress')).toHaveText(['Draft the agenda']);
  await expectFile(vault, 'Tasks/Draft the agenda.md').toBe(NOTES['Tasks/Draft the agenda.md']);
});
