import { rm } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { expect, test, type Page } from './fixtures.ts';
import {
  createVault,
  emitVaultChanged,
  expectFile,
  installHost,
  sidebarSection,
  type FakeHost,
  type FakeVault,
} from './host.ts';
import { toastSaying } from './toasts.ts';

/*
 * Attack on PR #356 (pages are tabs): each page kind now owns its hooks in
 * its tab, so what used to be one window-wide Inbox, Today and type page is
 * now one per tab. These probe what that split can lose: a write in flight
 * when its tab goes, the same page in two places, and a page restored onto
 * something that is gone.
 */

const GTD_TASK_TYPE = [
  '---',
  'name: task',
  'label: Task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [inbox, backlog, next-action, in-progress, waiting, someday, longterm, archive]',
  '    done: archive',
  '  completed: date',
  '  defer: date',
  '  due: date',
  '---',
  '',
  '# Task',
  '',
].join('\n');

const note = (frontmatter: string[], body: string) =>
  ['---', ...frontmatter, '---', '', body, ''].join('\n');

const CELLO = 'Inbox/Learn the cello.md';

const PROPOSAL = [
  '---',
  'type: proposal',
  'kind: task',
  'state: open',
  'confidence: high',
  'made_by: after-meeting · run 1',
  'payload:',
  '  title: Call Mara Quill back',
  '  properties:',
  '    status: next-action',
  '---',
  '',
  'She asked on the call.',
  '',
].join('\n');

async function gtdVault(): Promise<FakeVault> {
  const vault = await createVault();
  for (const folder of ['.atlas/types', 'Tasks', 'Inbox']) await vault.mkdir(folder);
  await vault.write('.atlas/types/task.md', GTD_TASK_TYPE);
  await vault.write(
    '.atlas/types/person.md',
    '---\nname: person\nlabel: Person\nproperties:\n  email: text\n---\n',
  );
  await vault.write(
    '.atlas/types/book.md',
    '---\nname: book\nlabel: Book\nproperties:\n  author: text\n---\n',
  );
  await vault.write('alpha.md', '# Alpha\n\nThe first note.\n');
  await vault.write('People Ada Brightwater.md', note(['type: person'], 'A neighbour.'));
  await vault.write('Marrow Tide.md', note(['type: book', 'author: Ilse Varno'], 'A novel.'));
  await vault.write(CELLO, note(['type: task', 'status: inbox'], 'One day.'));
  await vault.write('Inbox/Chase the quote.md', note(['type: task', 'status: inbox'], 'Soon.'));
  await vault.write(
    'Tasks/Draft the plan.md',
    note(['type: task', 'status: in-progress'], 'Under way.'),
  );
  return vault;
}

async function open(page: Page, vault: FakeVault): Promise<FakeHost> {
  const host = await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible({ timeout: 20_000 });
  return host;
}

const nameOf = (vault: FakeVault) => vault.root.split(sep).at(-1) ?? '';
const goTo = (page: Page) => page.getByRole('list', { name: 'Go to' });
const sidebarInbox = (page: Page) => goTo(page).getByRole('button', { name: /^Inbox/ });
const pane = (page: Page, which: 1 | 2) => page.getByRole('region', { name: `Pane ${which}` });
const tabsOf = (page: Page, which: 1 | 2) =>
  page.getByRole('tablist', { name: `Pane ${which} tabs` }).getByRole('tab');
const inboxIn = (page: Page, which: 1 | 2) =>
  pane(page, which).getByRole('article', { name: 'Inbox' });
const rowIn = (page: Page, which: 1 | 2, title: string) =>
  inboxIn(page, which)
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name: title, exact: true }) });

async function openInbox(page: Page, which: 1 | 2 = 1) {
  await sidebarInbox(page).click();
  await expect(inboxIn(page, which).getByRole('table')).toBeVisible();
}

/** Decides the cello row as Someday, in the given pane's Inbox. */
async function decideCello(page: Page, which: 1 | 2 = 1) {
  await inboxIn(page, which)
    .getByRole('combobox', { name: 'Status of Learn the cello' })
    .selectOption({ label: 'Someday' });
  await rowIn(page, which, 'Learn the cello')
    .getByRole('button', { name: 'Save', exact: true })
    .press('Enter');
}

/** The number the sidebar's Inbox row shows. */
async function sidebarCount(page: Page): Promise<number | null> {
  const text = (await sidebarInbox(page).textContent()) ?? '';
  const digits = /(\d+)\s*$/.exec(text);
  return digits === null ? null : Number(digits[1]);
}

async function switchTo(page: Page, host: FakeHost, from: FakeVault, to: FakeVault) {
  host.offer(to);
  await page.getByRole('button', { name: nameOf(from), exact: true }).click();
  await page.getByRole('menuitem', { name: 'Open another folder…' }).click();
}

test.describe('writes in flight when their tab goes', () => {
  test('a row decided, then tabbed away from and back to, stays off the Inbox while its write is held', async ({
    page,
  }) => {
    const vault = await gtdVault();
    const host = await open(page, vault);
    await openInbox(page);
    const release = host.holdWrites(CELLO);
    await decideCello(page);
    await expect(rowIn(page, 1, 'Learn the cello')).toHaveCount(0);
    await expect.poll(() => host.writesTo(CELLO)).toBeGreaterThan(0);

    // Another tab, then back to the Inbox's: the write is still in flight.
    await page.keyboard.press('Meta+t');
    await expect(tabsOf(page, 1)).toHaveCount(2);
    await tabsOf(page, 1).first().click();
    await expect(inboxIn(page, 1).getByRole('table')).toBeVisible();
    await expect(rowIn(page, 1, 'Chase the quote')).toBeVisible();

    // The row was decided: offering it again invites a second write on a note already moving.
    await expect(rowIn(page, 1, 'Learn the cello')).toHaveCount(0);
    release();
    await expectFile(vault, CELLO).toContain('status: someday');
  });

  test('a row decided then its tab closed (⌘W) is written exactly once, and leaves the sidebar count', async ({
    page,
  }) => {
    const vault = await gtdVault();
    const host = await open(page, vault);
    await openInbox(page);
    await expect.poll(() => sidebarCount(page)).toBe(2);
    const release = host.holdWrites(CELLO);
    await decideCello(page);
    await expect.poll(() => host.writesTo(CELLO)).toBeGreaterThan(0);
    const asked = host.writesTo(CELLO);

    await page.keyboard.press('Meta+w');
    await expect(tabsOf(page, 1)).toHaveText(['New tab']);
    release();

    await expectFile(vault, CELLO).toContain('status: someday');
    await expect.poll(() => sidebarCount(page)).toBe(1);
    expect(host.writesTo(CELLO)).toBe(asked);
  });

  test('a row decided, its tab closed, then the vault switched: the switch waits and the write lands in its own vault', async ({
    page,
  }) => {
    const a = await gtdVault();
    const b = await createVault();
    await b.write('elsewhere.md', '# Elsewhere\n');
    const host = await open(page, a);
    await openInbox(page);
    const release = host.holdWrites(CELLO);
    await decideCello(page);
    await expect.poll(() => host.writesTo(CELLO)).toBeGreaterThan(0);
    await page.keyboard.press('Meta+w');

    await switchTo(page, host, a, b);
    release();

    await expect(page.getByRole('button', { name: nameOf(b), exact: true })).toBeVisible();
    await expectFile(a, CELLO).toContain('status: someday');
    expect(await b.read('elsewhere.md')).toBe('# Elsewhere\n');
  });

  test('a tick on Today, then a tab switch before it lands: written once, and the task stays off Today', async ({
    page,
  }) => {
    const vault = await gtdVault();
    const host = await open(page, vault);
    await goTo(page).getByRole('button', { name: 'Today' }).click();
    const today = pane(page, 1).getByRole('article', { name: 'Today' });
    await expect(today.getByText('Draft the plan')).toBeVisible();
    const release = host.holdWrites('Tasks/Draft the plan.md');
    await today.getByRole('checkbox', { name: 'Mark Draft the plan done' }).click();
    await expect.poll(() => host.writesTo('Tasks/Draft the plan.md')).toBeGreaterThan(0);
    const asked = host.writesTo('Tasks/Draft the plan.md');

    await page.keyboard.press('Meta+t');
    await tabsOf(page, 1).first().click();
    await expect(today).toBeVisible();
    // Ticked: drawn back as still to do invites a second tick while the first is in flight.
    await expect(today.getByRole('checkbox', { name: 'Mark Draft the plan done' })).toHaveCount(0);
    release();
    await expectFile(vault, 'Tasks/Draft the plan.md').toContain('status: archive');
    expect(host.writesTo('Tasks/Draft the plan.md')).toBe(asked);
  });
});

test.describe('the same page in two places', () => {
  test('the Inbox in both panes: a row decided in one leaves the other while its write is held', async ({
    page,
  }) => {
    const vault = await gtdVault();
    const host = await open(page, vault);
    await openInbox(page, 1);
    await page.keyboard.press('Meta+Shift+Backslash');
    await expect(pane(page, 2)).toBeVisible();
    await openInbox(page, 2);
    await expect(rowIn(page, 2, 'Learn the cello')).toBeVisible();

    const release = host.holdWrites(CELLO);
    await decideCello(page, 1);
    await expect(rowIn(page, 1, 'Learn the cello')).toHaveCount(0);
    await expect.poll(() => host.writesTo(CELLO)).toBeGreaterThan(0);

    // Still offered in pane 2 means it can be decided twice, on a note already being moved.
    await expect(rowIn(page, 2, 'Learn the cello')).toHaveCount(0);
    release();
    await expectFile(vault, CELLO).toContain('status: someday');
  });

  test('the Inbox in both panes: a row decided in one is written once, and both panes say so with nothing failed', async ({
    page,
  }) => {
    const vault = await gtdVault();
    const host = await open(page, vault);
    await openInbox(page, 1);
    await page.keyboard.press('Meta+Shift+Backslash');
    await expect(pane(page, 2)).toBeVisible();
    await openInbox(page, 2);
    await expect(rowIn(page, 2, 'Learn the cello')).toBeVisible();
    const release = host.holdWrites(CELLO);
    await decideCello(page, 1);
    await expect.poll(() => host.writesTo(CELLO)).toBeGreaterThan(0);
    const asked = host.writesTo(CELLO);

    // Pane 2 no longer offers the row (the test above), so it cannot be decided
    // twice: the one decision is the window's, and so is what it leaves to say.
    await expect(rowIn(page, 2, 'Learn the cello')).toHaveCount(0);
    release();
    await expectFile(vault, CELLO).toContain('status: someday');
    expect(host.writesTo(CELLO)).toBe(asked);
    // Said once, by the window, over both panes (#320).
    await expect(toastSaying(page, 'Clarified “Learn the cello”')).toHaveCount(1);
    // Nothing was written over or refused: no pane says the note "changed since it was read".
    await expect(page.getByRole('alert').filter({ hasText: /changed since/ })).toHaveCount(0);
  });

  test('Today in both panes: a tick in one takes the task off the other', async ({ page }) => {
    const vault = await gtdVault();
    await open(page, vault);
    await goTo(page).getByRole('button', { name: 'Today' }).click();
    await expect(pane(page, 1).getByRole('article', { name: 'Today' })).toBeVisible();
    await page.keyboard.press('Meta+Shift+Backslash');
    await expect(pane(page, 2)).toBeVisible();
    await goTo(page).getByRole('button', { name: 'Today' }).click();
    const second = pane(page, 2).getByRole('article', { name: 'Today' });
    const first = pane(page, 1).getByRole('article', { name: 'Today' });
    await expect(second.getByText('Draft the plan')).toBeVisible();
    await expect(first.getByText('Draft the plan')).toBeVisible();

    await second.getByRole('checkbox', { name: 'Mark Draft the plan done' }).click();
    await expectFile(vault, 'Tasks/Draft the plan.md').toContain('status: archive');
    await expect(first.getByRole('checkbox', { name: 'Mark Draft the plan done' })).toHaveCount(0);
  });

  test("two type pages in a split: editing one type leaves the other pane's table on its notes", async ({
    page,
  }) => {
    await open(page, await gtdVault());
    await sidebarSection(page, 'types')
      .getByRole('button', { name: /^Person, / })
      .click();
    await expect(pane(page, 1).getByRole('article', { name: 'Person' })).toBeVisible();
    await page.keyboard.press('Meta+Shift+Backslash');
    await expect(pane(page, 2)).toBeVisible();
    await sidebarSection(page, 'types')
      .getByRole('button', { name: /^Book, / })
      .click();
    const book = pane(page, 2).getByRole('article', { name: 'Book' });
    await expect(book.getByRole('table')).toBeVisible();

    await pane(page, 1).getByRole('button', { name: 'Edit type' }).click();
    await expect(pane(page, 1).getByRole('button', { name: 'Edit type' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // The aside edits Person, the type of the pane being worked in.
    const aside = page.getByRole('complementary', { name: 'Right sidebar' });
    await expect(aside.getByRole('textbox', { name: 'Name of this type' })).toHaveValue('Person');

    // Book was not asked to be edited: its button is not pressed, and its pane still shows its notes.
    await expect(pane(page, 2).getByRole('button', { name: 'Edit type' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await expect(book.getByRole('table')).toBeVisible();
  });
});

test.describe('restore and what is gone', () => {
  test('a type page whose type is deleted keeps its frame: Back still leads out', async ({
    page,
  }) => {
    const vault = await gtdVault();
    await open(page, vault);
    await sidebarSection(page, 'userSpace')
      .getByRole('treeitem', { name: 'alpha', exact: true })
      .click();
    await expect(pane(page, 1).getByRole('article', { name: 'alpha' })).toBeVisible();
    await sidebarSection(page, 'types')
      .getByRole('button', { name: /^Book, / })
      .click();
    await expect(pane(page, 1).getByRole('article', { name: 'Book' })).toBeVisible();

    await rm(join(vault.root, '.atlas/types/book.md'));
    await emitVaultChanged(page, ['.atlas/types/book.md']);
    await expect(pane(page, 1).getByRole('article', { name: 'Book' })).toHaveCount(0);

    // The page is gone; its tab's way back is not.
    await expect(pane(page, 1).getByRole('button', { name: 'Back', exact: true })).toBeVisible();
  });

  test('a restored Inbox tab shows its rows after a reload', async ({ page }) => {
    const vault = await gtdVault();
    await open(page, vault);
    await openInbox(page);
    await page.reload();
    await expect(page.getByText(/notes indexed/)).toBeVisible({ timeout: 20_000 });
    await expect(rowIn(page, 1, 'Learn the cello')).toBeVisible();
    await expect(rowIn(page, 1, 'Chase the quote')).toBeVisible();
  });
});

test.describe("the sidebar's Inbox count", () => {
  test('rises when a file is dropped into Inbox/ from outside, with no Inbox page open', async ({
    page,
  }) => {
    const vault = await gtdVault();
    await open(page, vault);
    await expect.poll(() => sidebarCount(page)).toBe(2);
    await vault.write('Inbox/Fix the gate.md', note(['type: task', 'status: inbox'], 'Hinge.'));
    await emitVaultChanged(page, ['Inbox/Fix the gate.md']);
    await expect.poll(() => sidebarCount(page)).toBe(3);
  });

  test('rises when a proposal arrives from outside, with no Inbox page open', async ({ page }) => {
    const vault = await gtdVault();
    await vault.mkdir('Inbox/Proposals');
    await open(page, vault);
    await expect.poll(() => sidebarCount(page)).toBe(2);
    await vault.write('Inbox/Proposals/Call Mara Quill.md', PROPOSAL);
    await emitVaultChanged(page, ['Inbox/Proposals/Call Mara Quill.md']);
    await expect.poll(() => sidebarCount(page)).toBe(3);
  });
});

test.describe('offers', () => {
  test('a dismissed Inbox offer stays dismissed after its tab is closed and the Inbox opened again', async ({
    page,
  }) => {
    const vault = await createVault();
    await vault.mkdir('Inbox');
    await vault.write('Inbox/Loose idea.md', '# Loose idea\n\nSomething to file.\n');
    await open(page, vault);
    await sidebarInbox(page).click();
    const offer = inboxIn(page, 1).getByRole('complementary', {
      name: 'Set your types up for the Inbox',
    });
    await expect(offer).toBeVisible();
    await offer.getByRole('button', { name: 'Not now' }).click();
    await expect(offer).toHaveCount(0);

    await page.keyboard.press('Meta+w');
    await expect(tabsOf(page, 1)).toHaveText(['New tab']);
    await sidebarInbox(page).click();
    await expect(inboxIn(page, 1)).toBeVisible();
    await expect(inboxIn(page, 1).getByText('Loose idea')).toBeVisible();
    await expect(offer).toHaveCount(0);
  });
});

test.describe("the chat's context", () => {
  test('a note focused, with the query page open in the other pane: the chat opens on the note', async ({
    page,
  }) => {
    const vault = await createVault();
    await vault.write('Plan.md', '# Plan\n\nOriginal paragraph.\n');
    await open(page, vault);
    await sidebarSection(page, 'userSpace')
      .getByRole('treeitem', { name: 'Plan', exact: true })
      .click();
    await expect(pane(page, 1).getByRole('article', { name: 'Plan' })).toBeVisible();
    await page.keyboard.press('Meta+Shift+Backslash');
    await expect(pane(page, 2)).toBeVisible();
    // The split focused pane 2: the new query lands there.
    await page.getByRole('button', { name: 'New in Views' }).click();
    await page.getByRole('menuitem', { name: 'New query' }).click();
    await expect(pane(page, 2).getByRole('article', { name: 'Query' })).toBeVisible();

    // Back to the note in pane 1, and the chat from there.
    await pane(page, 1).getByText('Original paragraph.').click();
    await pane(page, 1).getByRole('button', { name: 'Claude' }).click();
    const chat = page.getByRole('complementary', { name: 'Claude' });
    await expect(chat).toBeVisible();
    await expect(chat.getByRole('button', { name: 'Remove Plan from the chat' })).toBeVisible();
  });
});
