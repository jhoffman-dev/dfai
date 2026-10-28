import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, type FakeHost, type FakeVault } from './host.ts';

/**
 * #110: today's note starts with the day. Made from the Today page, it shows
 * what is due or late and the next actions as live query blocks, above what
 * happened; a daily note already there is opened as it is, every byte kept.
 */

/** Midday local time, so the browser and this file read the same day. */
const NOW = new Date(2026, 9, 28, 12);
const today = NOW.toLocaleDateString('en-CA');
const DAILY = `Daily/${today.slice(0, 4)}`;

/** GTD's statuses and dates, and nothing else a vault might leave out: the blocks need no more. */
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
  '---',
  '',
  '# Task',
  '',
].join('\n');

const task = (...frontmatter: string[]) =>
  ['---', 'type: task', ...frontmatter, '---', '', 'A task.', ''].join('\n');

const TASKS: Record<string, string> = {
  'Tasks/Pay the plumber.md': task('status: next-action', 'due: 2026-10-20'),
  'Tasks/Send the invoice.md': task('status: in-progress', `due: ${today}`),
  'Tasks/Learn the cello.md': task('status: someday', 'due: 2026-10-02'),
  'Tasks/Call the bank.md': task('status: next-action'),
  'Tasks/Book the hall.md': task('status: next-action', 'defer: 2026-11-04'),
  'Tasks/Filed already.md': task('status: archive', 'due: 2026-10-21'),
};

/** A daily note James has already written in. */
const WRITTEN = [
  '---',
  'type: daily',
  '---',
  '',
  '## What happened',
  '',
  'Walked the beds with Mara Quill; the seed swap moved to Saturday.',
  '',
].join('\n');

async function openVault(
  page: Page,
  files: Record<string, string> = {},
): Promise<{ vault: FakeVault; host: FakeHost }> {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('Tasks');
  await vault.write('.atlas/types/task.md', GTD_TASK_TYPE);
  for (const [path, text] of Object.entries({ ...TASKS, ...files })) {
    await vault.mkdir(path.slice(0, path.lastIndexOf('/')));
    await vault.write(path, text);
  }
  const host = await installHost(page, vault);
  await page.clock.setFixedTime(NOW);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return { vault, host };
}

const blocks = (page: Page) =>
  page.getByRole('article', { name: today }).getByRole('group', { name: 'Query block' });
const titlesIn = (page: Page, nth: number) =>
  blocks(page).nth(nth).locator('.qresult__title, .list-view__title');

test.describe("today's note starts with the day", () => {
  test('made from the Today page, it shows what is due or late and the next actions, live', async ({
    page,
  }) => {
    const { vault } = await openVault(page);

    await page.getByRole('list', { name: 'Go to' }).getByRole('button', { name: 'Today' }).click();
    await page.getByRole('button', { name: 'Open today’s note' }).click();

    await expect(page.getByRole('article', { name: today })).toBeVisible();
    await expect(blocks(page)).toHaveCount(2);
    await expect(titlesIn(page, 0)).toHaveText(['Pay the plumber', 'Send the invoice']);
    await expect(titlesIn(page, 1)).toHaveText(['Call the bank']);

    const file = `${DAILY}/${today}.md`;
    await expectFile(vault, file).toMatch(
      /^---\ntype: daily\n---\n\n## Due and overdue\n\n```atlas-query\nlayout: list\n[\s\S]*\n```\n\n## Next actions\n\n```atlas-query\nlayout: list\n[\s\S]*\n```\n\n## What happened\n\n## What is next\n$/,
    );
    await expectFile(vault, file).toContain(`WHERE due <= ${today} AND`);
  });

  test('a daily note already written in is opened as it is, every byte kept', async ({ page }) => {
    const file = `${DAILY}/${today}.md`;
    const { vault, host } = await openVault(page, { [file]: WRITTEN });

    await page.keyboard.press('Meta+Shift+D');

    const note = page.getByRole('article', { name: today });
    await expect(note).toContainText('the seed swap moved to Saturday');
    await expect(blocks(page)).toHaveCount(0);
    expect(host.writesTo(file)).toBe(0);
    expect(await vault.read(file)).toBe(WRITTEN);
  });
});
