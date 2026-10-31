/**
 * Attack on PR #428 (slice 6b, the center peek wired to the app). Each test
 * names the invariant it holds the peek to; the ones that fail are bugs.
 */
import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, sidebarSection, type FakeVault } from './host.ts';
import { caretAtLineEnd } from './caret.ts';

const TASKS = 12;
const TASK_TYPE = [
  '---',
  'name: task',
  'label: Task',
  'properties:',
  '  due:',
  '    kind: date',
  '---',
  '',
].join('\n');
const title = (at: number) => `Errand ${String(at).padStart(3, '0')}`;
const errand = (at: number) =>
  [
    '---',
    'type: task',
    'due: 2026-10-01',
    '---',
    '',
    `# ${title(at)}`,
    '',
    `Body of errand ${at}.`,
    '',
    'See [[#Goals]] below.',
    '',
    '## Goals',
    '',
    `Goal of errand ${at}.`,
    '',
  ].join('\n');

async function openVault(
  page: Page,
  plan = '# Plan\n\nFirst see [[Errand 002]] today.\n',
): Promise<FakeVault> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.mkdir('Errands');
  for (let at = 1; at <= TASKS; at += 1) await vault.write(`Errands/${title(at)}.md`, errand(at));
  await vault.write('Plan.md', plan);
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return vault;
}

async function openTaskTable(page: Page): Promise<void> {
  await sidebarSection(page, 'types')
    .getByRole('button', { name: /^Task, \d+ notes?$/ })
    .click();
  await expect(page.locator('.table__count', { hasText: `${TASKS} tasks` })).toBeVisible();
}

const rowName = (page: Page, at: number) =>
  page.locator('.table__row .table__link', { hasText: title(at) });
const peek = (page: Page) => page.getByRole('dialog');

async function chord(page: Page, key: string, { shift = false } = {}) {
  await page.keyboard.down('Meta');
  if (shift) await page.keyboard.down('Shift');
  await page.keyboard.press(key);
  if (shift) await page.keyboard.up('Shift');
  await page.keyboard.up('Meta');
}

test('typing then ⌥↓ writes the typing to the note it was typed in, once, and not the next', async ({
  page,
}) => {
  const vault = await openVault(page);
  await openTaskTable(page);
  await rowName(page, 4).click();
  const dialog = page.getByRole('dialog', { name: title(4) });
  await caretAtLineEnd(dialog.getByText('Body of errand 4.'));
  await page.keyboard.type(' Typed in four.');
  await page.keyboard.press('Alt+ArrowDown');
  const next = page.getByRole('dialog', { name: title(5) });
  await expect(next).toBeVisible();
  await caretAtLineEnd(next.getByText('Body of errand 5.'));
  await page.keyboard.type(' Typed in five.');
  await page.keyboard.press('Escape');
  await expect(peek(page)).toHaveCount(0);

  await expectFile(vault, `Errands/${title(4)}.md`).toContain('Body of errand 4. Typed in four.');
  await expectFile(vault, `Errands/${title(5)}.md`).toContain('Body of errand 5. Typed in five.');
  const four = await vault.read(`Errands/${title(4)}.md`);
  const five = await vault.read(`Errands/${title(5)}.md`);
  expect(four.split('Typed in four.')).toHaveLength(2);
  expect(four).not.toContain('Typed in five.');
  expect(five).not.toContain('Typed in four.');
});

test('a link to a heading of the peeked note itself opens the peeked note, not the pane’s', async ({
  page,
}) => {
  await openVault(page);
  await sidebarSection(page, 'userSpace')
    .getByRole('treeitem', { name: 'Plan', exact: true })
    .click();
  const plan = page.getByRole('article', { name: 'Plan' });
  await expect(plan).toBeVisible();
  await plan.locator('[data-wikilink="Errand 002"]').click();
  const dialog = page.getByRole('dialog', { name: title(2) });
  await expect(dialog.getByText('Body of errand 2.')).toBeVisible();

  // `[[#Goals]]` in Errand 002 means Errand 002's own "Goals" heading.
  await dialog.locator('[data-heading]').first().click();

  await expect(peek(page)).toHaveCount(0);
  await expect(page.getByRole('article', { name: title(2) })).toBeVisible();
});

test('a date typed in the peek is written before ⌘↵ opens the note in a tab', async ({ page }) => {
  const vault = await openVault(page);
  await openTaskTable(page);
  await rowName(page, 3).click();
  const dialog = page.getByRole('dialog', { name: title(3) });
  await expect(dialog.getByText('Body of errand 3.')).toBeVisible();
  const date = dialog.locator('.props__date-input').first();
  await date.focus();
  await date.fill('2027-03-15');

  // ⌘↵ from the date field: the peek's "open in a tab", as it is from any field.
  await chord(page, 'Enter');
  await expect(peek(page)).toHaveCount(0);

  await expectFile(vault, `Errands/${title(3)}.md`).toContain('due: 2027-03-15');
});

test('Esc in a date field puts the date back and leaves the peek up', async ({ page }) => {
  await openVault(page);
  await openTaskTable(page);
  await rowName(page, 3).click();
  const dialog = page.getByRole('dialog', { name: title(3) });
  await expect(dialog.getByText('Body of errand 3.')).toBeVisible();
  const date = dialog.locator('.props__date-input').first();
  await date.focus();
  await date.fill('2027-03-15');

  await page.keyboard.press('Escape');

  // One Esc closes the top layer only — here the field's own draft (the PR's
  // "a field putting its value back" keeps the peek open).
  await expect(dialog).toBeVisible();
});

test('a note captured with ⇧⌘N while peeking does not open unseen in the pane under the peek', async ({
  page,
}) => {
  await openVault(page);
  await openTaskTable(page);
  await rowName(page, 1).click();
  await expect(page.getByRole('dialog', { name: title(1) })).toBeVisible();

  await chord(page, 'n', { shift: true });
  const field = page.getByRole('textbox', { name: 'What needs doing' });
  await field.fill('Buy stamps');
  await field.press('Enter');
  await page.keyboard.press('Escape');

  // Either the peek held the shortcut (as it holds ⌘N), or the capture is
  // shown; what must not happen is the pane under the peek being navigated
  // away from the table without the user seeing it.
  await expect(page.locator('.peek')).toBeVisible();
  await expect(page.locator('.table__count', { hasText: `${TASKS} tasks` })).toBeVisible();
});

test('⌘K “Archive this note” over the peek archives the peeked note, not the pane’s', async ({
  page,
}) => {
  const vault = await openVault(page);
  await sidebarSection(page, 'userSpace')
    .getByRole('treeitem', { name: 'Plan', exact: true })
    .click();
  const plan = page.getByRole('article', { name: 'Plan' });
  await expect(plan).toBeVisible();
  await plan.locator('[data-wikilink="Errand 002"]').click();
  await expect(page.getByRole('dialog', { name: title(2) })).toBeVisible();

  await chord(page, 'k');
  await page.getByRole('searchbox', { name: 'Search the vault' }).fill('Archive this note');
  await page
    .getByRole('dialog', { name: 'Search notes' })
    .getByRole('option', { name: /Archive this note/ })
    .click();

  // "This note" is the one on screen: the peeked Errand 002.
  const errandArchived = async () =>
    !(await vault.exists(`Errands/${title(2)}.md`)) ||
    /archiv/i.test(await vault.read(`Errands/${title(2)}.md`));
  await expect.poll(errandArchived).toBe(true);
  expect(await vault.exists('Plan.md')).toBe(true);
  expect(await vault.read('Plan.md')).not.toMatch(/archiv/i);
});

test('typing in the page, then peeking the same note and typing there, keeps both without a conflict', async ({
  page,
}) => {
  const vault = await openVault(page, '# Plan\n\nFirst line.\n\nSee [[Plan]] here.\n');
  await sidebarSection(page, 'userSpace')
    .getByRole('treeitem', { name: 'Plan', exact: true })
    .click();
  const plan = page.getByRole('article', { name: 'Plan' });
  await caretAtLineEnd(plan.getByText('First line.'));
  await page.keyboard.type(' From the page.');
  // Straight on, inside the page's autosave delay: peek the note itself.
  await plan.locator('[data-wikilink="Plan"]').click();
  const dialog = page.getByRole('dialog', { name: 'Plan' });
  await caretAtLineEnd(dialog.getByText('See'));
  await page.keyboard.type(' From the peek.');

  await expectFile(vault, 'Plan.md').toContain('From the peek.');
  expect(await vault.read('Plan.md')).toContain('From the page.');
  await expect(page.getByText(/changed on disk|conflict/i)).toHaveCount(0);
});
