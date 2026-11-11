import { caretAtLineEndByTap } from './caret.ts';
import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, openVaultByTouch } from './host.ts';

/**
 * #672: the phone's other two screens, by thumb — Today, and finding a note to
 * read. This spec runs only in the `phone` project (playwright.config.ts):
 * WebKit at 390×844 with a touch screen, on the stub host (e2e/host.ts),
 * which the same layout rule gives the same bar as the web build gets
 * (web-companion.phone.spec.ts says why Today and Notes are driven here).
 */

const PHONE = { width: 390, height: 844 };

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

const FILES: Record<string, string> = {
  '.atlas/types/task.md': TASK_TYPE,
  'Tasks/Sow the beans.md': note(['type: task', 'status: next-action'], 'A task.'),
  'Garden plan.md': '# Garden plan\n\nFirst line.\n',
  'Seed list.md': '# Seed list\n\nBeans.\n',
};

const bar = (page: Page) => page.getByRole('navigation', { name: 'Screens' });
const screen = (page: Page, name: 'Quick add' | 'Today' | 'Notes') =>
  bar(page).getByRole('button', { name, exact: true });
const search = (page: Page) => page.getByRole('dialog', { name: 'Search notes' });
const noteBody = (page: Page) => page.getByLabel('Note', { exact: true });

async function openGardenVault(page: Page) {
  const vault = await createVault();
  for (const folder of ['.atlas/types', 'Tasks']) await vault.mkdir(folder);
  for (const [path, text] of Object.entries(FILES)) await vault.write(path, text);
  await openVaultByTouch(page, vault, { now: NOW });
  return vault;
}

/** Nothing scrolls sideways: not the page, not the work's column. */
async function expectNoSidewaysScroll(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const root = document.documentElement;
        const main = document.querySelector('.shell__main');
        return {
          page: root.scrollWidth - root.clientWidth,
          main: main === null ? null : main.scrollWidth - main.clientWidth,
        };
      }),
    )
    .toEqual({ page: 0, main: 0 });
}

test('on a phone, Today lists the next actions, is marked in the bar, and a tapped tick finishes the task', async ({
  page,
}) => {
  expect(page.viewportSize()).toEqual(PHONE);
  const vault = await openGardenVault(page);
  await expect(screen(page, 'Today')).not.toHaveAttribute('aria-current', 'page');

  await screen(page, 'Today').tap();
  const today = page.getByRole('article', { name: 'Today' });
  const nextActions = today.getByRole('region', { name: 'Next actions', exact: true });
  await expect(nextActions.locator('.table__title')).toHaveText(['Sow the beans']);
  await expect(screen(page, 'Today')).toHaveAttribute('aria-current', 'page');
  await expectNoSidewaysScroll(page);

  await nextActions.getByRole('checkbox', { name: 'Mark Sow the beans done' }).tap();
  await expect(nextActions.locator('.table__title')).toHaveCount(0);
  await expectFile(vault, 'Tasks/Sow the beans.md').toContain('status: archive');
});

test('on a phone, Notes finds a note by search, opens it to read, and a tapped edit reaches the file', async ({
  page,
}) => {
  const vault = await openGardenVault(page);
  await screen(page, 'Today').tap();
  await expect(screen(page, 'Today')).toHaveAttribute('aria-current', 'page');

  await screen(page, 'Notes').tap();
  await expect(search(page)).toBeVisible();
  await search(page).getByRole('searchbox', { name: 'Search the vault' }).fill('Garden');
  const hit = search(page).getByRole('option', { name: /Garden plan/ });
  await expect(hit).toBeVisible();
  await expect(search(page).getByRole('option', { name: /Seed list/ })).toHaveCount(0);
  await hit.tap();

  await expect(search(page)).toHaveCount(0);
  await expect(noteBody(page).getByText('First line.')).toBeVisible();
  // A note is none of the bar's screens: Today's mark goes.
  await expect(screen(page, 'Today')).not.toHaveAttribute('aria-current', 'page');
  await expectNoSidewaysScroll(page);

  await caretAtLineEndByTap(noteBody(page).getByText('First line.'));
  await page.keyboard.type(' By thumb.');
  await expectFile(vault, 'Garden plan.md').toContain('First line. By thumb.');
});
