/**
 * The center peek, wired to the app (slice 6b, #302): a row's name or a
 * wikilink clicked opens the note over the view; its body edits and saves
 * like a page; ↑ ↓ step through the rows in the view's own order — rows the
 * virtualised table has not drawn too — and Esc hands the focus back to the
 * row. ⌘↵ opens the note in a tab, ⌘⇧↵ in a split, and expand on the page.
 */
import { readdir } from 'node:fs/promises';
import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, sidebarSection, type FakeVault } from './host.ts';
import { caretAtLineEnd } from './caret.ts';

const TASKS = 150;
const TASK_TYPE = ['---', 'name: task', 'label: Task', '---', ''].join('\n');
const title = (at: number) => `Errand ${String(at).padStart(3, '0')}`;
const errand = (at: number) =>
  ['---', 'type: task', '---', '', `# ${title(at)}`, '', `Body of errand ${at}.`, ''].join('\n');

async function openVault(page: Page): Promise<FakeVault> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.mkdir('Errands');
  for (let at = 1; at <= TASKS; at += 1) await vault.write(`Errands/${title(at)}.md`, errand(at));
  await vault.write('Plan.md', '# Plan\n\nFirst see [[Errand 002]] today.\n');
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

test('a row opens the peek over the table, and Esc hands the focus back to it', async ({
  page,
}) => {
  await openVault(page);
  await openTaskTable(page);
  const name = rowName(page, 3);
  await name.click();

  const dialog = page.getByRole('dialog', { name: title(3) });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.peek__where')).toHaveText(`3 of ${TASKS} in Task table`);
  await expect(dialog.getByText('Body of errand 3.')).toBeVisible();
  // The table is still under it, where it was: the peek opened nothing in the pane.
  await expect(page.locator('.table__count', { hasText: `${TASKS} tasks` })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(peek(page)).toHaveCount(0);
  await expect(name).toBeFocused();
});

test('an edit in the peek reaches the file once it closes', async ({ page }) => {
  const vault = await openVault(page);
  await openTaskTable(page);
  await rowName(page, 4).click();
  const dialog = page.getByRole('dialog', { name: title(4) });
  await caretAtLineEnd(dialog.getByText('Body of errand 4.'));
  await page.keyboard.type(' Typed in the peek.');
  await page.keyboard.press('Escape');

  await expect(peek(page)).toHaveCount(0);
  await expectFile(vault, `Errands/${title(4)}.md`).toContain(
    'Body of errand 4. Typed in the peek.',
  );
});

test('↓ steps through the rows in the view’s order, to rows the table has not drawn', async ({
  page,
}) => {
  await openVault(page);
  await openTaskTable(page);
  await rowName(page, 1).click();
  await expect(page.getByRole('dialog', { name: title(1) })).toBeVisible();

  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('dialog', { name: title(2) })).toBeVisible();
  await expect(peek(page).locator('.peek__where')).toHaveText(`2 of ${TASKS} in Task table`);

  for (let step = 2; step < 60; step += 1) await page.keyboard.press('ArrowDown');
  const far = page.getByRole('dialog', { name: title(60) });
  await expect(far).toBeVisible();
  await expect(far.getByText('Body of errand 60.')).toBeVisible();
  // Guard: the row stepped to is one the virtualised table has not drawn.
  await expect(rowName(page, 60)).toHaveCount(0);

  await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('dialog', { name: title(59) })).toBeVisible();
});

test('⌘↵ opens the peeked note in a tab, and ⌘⇧↵ in a split', async ({ page }) => {
  await openVault(page);
  await openTaskTable(page);
  await rowName(page, 5).click();
  await expect(page.getByRole('dialog', { name: title(5) })).toBeVisible();

  await chord(page, 'Enter');
  await expect(peek(page)).toHaveCount(0);
  const tabs = page.getByRole('tablist', { name: 'Pane 1 tabs' });
  await expect(tabs.getByRole('tab', { name: title(5), selected: true })).toBeVisible();
  await expect(page.getByRole('article', { name: title(5) })).toBeVisible();

  await tabs.getByRole('tab', { name: 'Task' }).click();
  await rowName(page, 6).click();
  await expect(page.getByRole('dialog', { name: title(6) })).toBeVisible();
  await chord(page, 'Enter', { shift: true });
  await expect(peek(page)).toHaveCount(0);
  const second = page.getByRole('region', { name: 'Pane 2' });
  await expect(second.getByRole('article', { name: title(6) })).toBeVisible();
});

test('expand opens the peeked note as the page, in place of the table', async ({ page }) => {
  await openVault(page);
  await openTaskTable(page);
  await rowName(page, 7).click();
  await page
    .getByRole('dialog', { name: title(7) })
    .getByRole('button', { name: 'Open as full page' })
    .click();
  await expect(peek(page)).toHaveCount(0);
  await expect(page.getByRole('article', { name: title(7) })).toBeVisible();
  await expect(page.locator('.table__count')).toHaveCount(0);
});

test('a wikilink clicked peeks the note it names, leaving the page where it is', async ({
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
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Body of errand 2.')).toBeVisible();
  // Opened from no list: nothing to step through.
  await expect(dialog.locator('.peek__where')).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(peek(page)).toHaveCount(0);
  await expect(plan).toBeVisible();
});

test('⌘K opens over the peek; Esc closes it alone, and a result picked shows in the peek', async ({
  page,
}) => {
  await openVault(page);
  await openTaskTable(page);
  await rowName(page, 1).click();
  await expect(page.getByRole('dialog', { name: title(1) })).toBeVisible();

  await chord(page, 'k');
  const search = page.getByRole('dialog', { name: 'Search notes' });
  await expect(search).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(search).toHaveCount(0);
  await expect(page.locator('.peek')).toBeVisible();

  await chord(page, 'k');
  await page.getByRole('searchbox', { name: 'Search the vault' }).fill('Plan');
  await page.getByRole('option', { name: /Plan/ }).first().click();
  await expect(search).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Plan' })).toBeVisible();
  await expect(page.locator('.peek__where')).toHaveCount(0);
});

test('a note-making shortcut does nothing while a note is peeked', async ({ page }) => {
  const vault = await openVault(page);
  const notes = async () => (await readdir(vault.root, { recursive: true })).length;
  await openTaskTable(page);
  await rowName(page, 1).click();
  await expect(page.getByRole('dialog', { name: title(1) })).toBeVisible();
  const before = await notes();
  await chord(page, 'n');
  await expect(page.getByRole('dialog', { name: title(1) })).toBeVisible();

  // Control, and time for a note the press above made to have landed: with
  // the peek closed, the same press makes one.
  await page.keyboard.press('Escape');
  await expect(peek(page)).toHaveCount(0);
  await chord(page, 'n');
  await expect.poll(notes).toBe(before + 1);
});

const CHORE_TYPE = [
  '---',
  'name: chore',
  'label: Chore',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [backlog, doing]',
  '---',
  '',
].join('\n');
const BOARD = ['---', 'atlas: view', 'type: chore', 'layout: board', 'groupBy: status', '---', ''];

test('a board’s card peeks, and ↓ steps column by column, as the board shows them', async ({
  page,
}) => {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/views');
  await vault.write('.atlas/types/chore.md', CHORE_TYPE);
  await vault.write('.atlas/views/Chores.md', BOARD.join('\n'));
  const chores = { Sweep: 'doing', Dust: 'backlog', Mop: 'doing' };
  for (const [name, status] of Object.entries(chores)) {
    await vault.write(`${name}.md`, `---\ntype: chore\nstatus: ${status}\n---\n\n# ${name}\n`);
  }
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await sidebarSection(page, 'views')
    .getByRole('button', { name: /^Chores/ })
    .click();

  await page.getByRole('region', { name: 'Backlog' }).getByRole('button', { name: 'Dust' }).click();
  const first = page.getByRole('dialog', { name: 'Dust' });
  await expect(first).toBeVisible();
  await expect(first.locator('.peek__where')).toHaveText('1 of 3 in Chores');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('dialog', { name: /^(Sweep|Mop)$/ })).toBeVisible();
  await expect(peek(page).locator('.peek__where')).toHaveText('2 of 3 in Chores');
});

/** Opens row `at`'s peek and types `typed` at the end of its body. */
async function typeInPeek(page: Page, at: number, typed: string) {
  await rowName(page, at).click();
  const dialog = page.getByRole('dialog', { name: title(at) });
  await caretAtLineEnd(dialog.getByText(`Body of errand ${at}.`));
  await page.keyboard.type(typed);
}

/** The file holds `typed` exactly once, read once it has landed. */
async function holdsOnce(vault: FakeVault, at: number, typed: string) {
  await expectFile(vault, `Errands/${title(at)}.md`).toContain(typed);
  expect((await vault.read(`Errands/${title(at)}.md`)).split(typed)).toHaveLength(2);
}

test.describe('what is typed in the peek lands in its own note, once (review of PR #428)', () => {
  test('stepping on with the Next row button', async ({ page }) => {
    const vault = await openVault(page);
    await openTaskTable(page);
    await typeInPeek(page, 4, ' Typed before the step.');
    await peek(page).getByRole('button', { name: 'Next row' }).click();
    await expect(page.getByRole('dialog', { name: title(5) })).toBeVisible();
    await holdsOnce(vault, 4, ' Typed before the step.');
    expect(await vault.read(`Errands/${title(5)}.md`)).not.toContain('Typed before the step.');
  });

  for (const [how, leave] of [
    [
      'expand',
      (page: Page) => peek(page).getByRole('button', { name: 'Open as full page' }).click(),
    ],
    // From the header: in the text, ⌘↵ and ⌘⇧↵ are the editor's own (Q6).
    [
      'a new tab',
      (page: Page) => peek(page).getByRole('button', { name: 'Open in new tab' }).click(),
    ],
    ['a split', (page: Page) => peek(page).getByRole('button', { name: 'Open in split' }).click()],
    [
      '⌘↵ from the header',
      async (page: Page) => {
        await peek(page).getByRole('button', { name: 'Next row' }).focus();
        await chord(page, 'Enter');
      },
    ],
  ] as const) {
    test(`leaving with ${how}, and the page that opens shows it`, async ({ page }) => {
      const vault = await openVault(page);
      await openTaskTable(page);
      await typeInPeek(page, 6, ` Typed before ${how}.`);
      await leave(page);
      await expect(peek(page)).toHaveCount(0);
      await holdsOnce(vault, 6, ` Typed before ${how}.`);
      await expect(page.getByText(`Body of errand 6. Typed before ${how}.`)).toBeVisible();
    });
  }

  test('renaming the peeked note from its title: the peek follows it, the typing goes with it', async ({
    page,
  }) => {
    const vault = await openVault(page);
    await openTaskTable(page);
    await typeInPeek(page, 8, ' Typed before the rename.');
    await peek(page)
      .getByRole('button', { name: title(8), exact: true })
      .click();
    const name = page.getByRole('textbox', { name: 'Note name' });
    await name.fill('Errand renamed');
    await name.press('Enter');

    await expect(page.getByRole('dialog', { name: 'Errand renamed' })).toBeVisible();
    await expect.poll(() => vault.exists(`Errands/${title(8)}.md`)).toBe(false);
    await page.keyboard.press('Escape');
    await expect(peek(page)).toHaveCount(0);
    await expectFile(vault, 'Errands/Errand renamed.md').toContain('Typed before the rename.');
    expect(
      (await vault.read('Errands/Errand renamed.md')).split('Typed before the rename.'),
    ).toHaveLength(2);
    expect(await vault.exists(`Errands/${title(8)}.md`)).toBe(false);
  });
});
