import { expect, test, type Page } from './fixtures.ts';
import { dragWithTouch } from './drag.ts';
import { createVault, expectFile, openVaultByTouch, sidebarSection } from './host.ts';

/**
 * #661: the core loop on an iPad, by finger. This spec runs only in the `ipad`
 * project (playwright.config.ts), which gives the page a touch screen and a
 * coarse pointer; every step taps or drags by touch, never clicks. What each
 * gesture does in depth is touch.spec.ts's; this holds the whole day together.
 */

/** 2026-10-13, midday where the test runs, so Today and this file agree. */
const NOW = new Date(2026, 9, 13, 12, 0, 0);

const note = (frontmatter: string[], body: string) =>
  ['---', ...frontmatter, '---', '', body, ''].join('\n');

const TASK_TYPE = note(
  [
    'name: task',
    'label: Task',
    'properties:',
    '  status:',
    '    kind: select',
    '    options: [inbox, next-action, in-progress, archive]',
    '    done: archive',
    '  completed: date',
  ],
  '# Task',
);

/** Chores sit on a board of three columns, all within an iPad's width. */
const CHORE_TYPE = note(
  [
    'name: chore',
    'label: Chore',
    'properties:',
    '  stage:',
    '    kind: select',
    '    options: [backlog, doing, done]',
  ],
  '# Chore',
);

const BOARD = note(['atlas: view', 'type: chore', 'layout: board', 'groupBy: stage'], '# Board');

const FILES: Record<string, string> = {
  '.atlas/types/task.md': TASK_TYPE,
  '.atlas/types/chore.md': CHORE_TYPE,
  '.atlas/views/Board.md': BOARD,
  'Tasks/Sow the beans.md': note(['type: task', 'status: next-action'], 'A task.'),
  'Inbox/Seed swap idea.md': note(['type: task', 'status: inbox'], 'Ask Mara Quill.'),
  'Chores/Mend the fence.md': note(['type: chore', 'stage: backlog'], '# Mend the fence'),
  'Garden plan.md': '# Garden plan\n\nFirst line.\n',
};

async function openGardenVault(page: Page) {
  const vault = await createVault();
  for (const folder of ['.atlas/types', '.atlas/views', 'Tasks', 'Inbox', 'Chores']) {
    await vault.mkdir(folder);
  }
  for (const [path, text] of Object.entries(FILES)) await vault.write(path, text);
  await openVaultByTouch(page, vault, { now: NOW });
  return vault;
}

const goTo = (page: Page, name: RegExp) =>
  page.getByRole('list', { name: 'Go to' }).getByRole('button', { name });

test('on an iPad, a finger runs the day: Today, a tick, the Inbox, a note, a card', async ({
  page,
}) => {
  await test.step('the page is a touch screen', async () => {
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
  });
  const vault = await openGardenVault(page);

  const today = page.getByRole('article', { name: 'Today' });
  const nextActions = today.getByRole('region', { name: 'Next actions', exact: true });
  await test.step('Today, by a tap', async () => {
    await goTo(page, /^Today/).tap();
    await expect(nextActions.locator('.table__title')).toHaveText(['Sow the beans']);
  });

  await test.step('a tapped tick finishes the task', async () => {
    await nextActions.getByRole('checkbox', { name: 'Mark Sow the beans done' }).tap();
    await expect(nextActions.locator('.table__title')).toHaveCount(0);
    await expectFile(vault, 'Tasks/Sow the beans.md').toContain('status: archive');
  });

  await test.step('the Inbox, by a tap', async () => {
    await goTo(page, /^Inbox/).tap();
    const inbox = page.getByRole('article', { name: 'Inbox' });
    await expect(inbox.getByRole('button', { name: 'Seed swap idea' })).toBeVisible();
  });

  await test.step('a note, opened and edited by a tap', async () => {
    await page.getByRole('treeitem', { name: 'Garden plan', exact: true }).tap();
    const line = page.getByLabel('Note', { exact: true }).getByText('First line.');
    const box = await line.boundingBox();
    if (box === null) throw new Error('The note’s first line is not on the page.');
    // The far right of the line's block, where a tap leaves the caret at its end.
    await line.tap({ position: { x: box.width - 1, y: box.height / 2 } });
    await page.keyboard.type(' Tapped.');
    await expectFile(vault, 'Garden plan.md').toContain('First line. Tapped.');
  });

  await test.step('a card, dragged by a finger', async () => {
    await sidebarSection(page, 'views').getByRole('button', { name: 'Board', exact: true }).tap();
    await dragWithTouch(page, {
      from: page.locator('.board__card[data-path="Chores/Mend the fence.md"]'),
      to: page.locator('.board').getByRole('region', { name: 'Done', exact: true }),
      overText: 'is over Done.',
    });
    await expectFile(vault, 'Chores/Mend the fence.md').toContain('stage: done');
  });
});
