import { sep } from 'node:path';
import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, type FakeHost, type FakeVault } from './host.ts';
import { toastSaying } from './toasts.ts';
import { pickSuggestion } from './link-suggest.ts';

/**
 * #112: GTD's clarify step on the Inbox page. One Inbox — the folder, and
 * every task still at Inbox wherever it lives — and a task decided on its
 * row: status, project, who it waits on, written by Done in one save.
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
  '  waiting_on:',
  '    kind: relation',
  '    target: person',
  '  project:',
  '    kind: relation',
  '    target: [project, area]',
  '  defer: date',
  '  due: date',
  '  completed: date',
  '---',
  '',
  '# Task',
  '',
].join('\n');

const PERSON_TYPE = ['---', 'name: person', 'label: Person', '---', '', '# Person', ''].join('\n');

const note = (frontmatter: string[], body: string) =>
  ['---', ...frontmatter, '---', '', body, ''].join('\n');

/** Written as a person would, so a save that rewrote more than it changed would show. */
const CALL = [
  '---',
  'type: task',
  '# captured on the train',
  'status: inbox',
  '---',
  '',
  'About the  *loan*.',
  '',
  '- [ ] find the letter',
  '',
].join('\n');

/**
 * Where an Inbox task filed under a project lands: its type's home for today,
 * linked to the project, never the project's folder (#214).
 */
const TODAY = new Date().toLocaleDateString('en-CA');
const [YEAR, MONTH] = [TODAY.slice(0, 4), TODAY.slice(5, 7)];
const FILED_CALL = `Tasks/${YEAR}/${MONTH}/Call the bank.md`;

async function gtdVault(): Promise<FakeVault> {
  const vault = await createVault();
  for (const folder of ['.atlas/types', 'Projects', 'People', 'Tasks', 'Inbox/Meetings']) {
    await vault.mkdir(folder);
  }
  await vault.write('.atlas/types/task.md', GTD_TASK_TYPE);
  await vault.write('.atlas/types/person.md', PERSON_TYPE);
  await vault.write('Projects/DFAI.md', note(['type: project'], 'The app.'));
  await vault.write('People/Mara Quill.md', note(['type: person'], 'A neighbour.'));
  await vault.write('Inbox/Call the bank.md', CALL);
  await vault.write(
    'Inbox/Chase the quote.md',
    note(['type: task', 'status: inbox'], 'Larkspur Payroll.'),
  );
  await vault.write('Inbox/Learn the cello.md', note(['type: task', 'status: inbox'], 'One day.'));
  // As an import from another tool leaves a task: at Inbox, outside the Inbox folder.
  await vault.write(
    'Tasks/Renew the passport.md',
    note(['type: task', 'status: inbox'], 'Expires in May.'),
  );
  await vault.write(
    'Tasks/Already moving.md',
    note(['type: task', 'status: in-progress'], 'Under way.'),
  );
  await vault.write(
    'Inbox/Meetings/2026-10-01 Seed swap.md',
    note(['type: meeting'], 'Who brings what.'),
  );
  return vault;
}

async function open(page: Page, vault: FakeVault): Promise<FakeHost> {
  const host = await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  // Longer than the default: the index of a fresh vault is slow to finish on a loaded machine.
  await expect(page.getByText(/notes indexed/)).toBeVisible({ timeout: 20_000 });
  return host;
}

/* Done is pressed with Return throughout, as a row is meant to be worked. */
const sidebarInbox = (page: Page) =>
  page.getByRole('list', { name: 'Go to' }).getByRole('button', { name: /^Inbox/ });
const inboxPage = (page: Page) => page.getByRole('article', { name: 'Inbox' });
const row = (page: Page, title: string) =>
  inboxPage(page)
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name: title, exact: true }) });

async function openInbox(page: Page) {
  await sidebarInbox(page).click();
  await expect(inboxPage(page).getByRole('table')).toBeVisible();
}

test('one Inbox: the folder and every task still at Inbox, counted the same in the sidebar', async ({
  page,
}) => {
  await open(page, await gtdVault());
  await openInbox(page);
  const inbox = inboxPage(page);

  await expect(row(page, 'Renew the passport')).toBeVisible();
  await expect(row(page, 'Call the bank')).toBeVisible();
  await expect(row(page, '2026-10-01 Seed swap')).toBeVisible();
  // A task already given a status is nobody's to clarify.
  await expect(inbox.getByRole('row')).toHaveCount(6);
  await expect(row(page, 'Already moving')).toHaveCount(0);
  await expect(page.getByText(/^5 to process/)).toBeVisible();
  await expect(sidebarInbox(page)).toContainText('5');
});

test('a task is clarified to Next Action with a project: one Done sets the status and files it', async ({
  page,
}) => {
  const vault = await gtdVault();
  await open(page, vault);
  await openInbox(page);
  const inbox = inboxPage(page);

  await inbox
    .getByRole('combobox', { name: 'Status of Call the bank' })
    .selectOption({ label: 'Next Action' });
  await pickSuggestion(inbox.getByRole('combobox', { name: 'File Call the bank under' }), 'DFAI');
  // Nothing is written until Done.
  expect(await vault.read('Inbox/Call the bank.md')).toBe(CALL);
  await row(page, 'Call the bank')
    .getByRole('button', { name: 'Save', exact: true })
    .press('Enter');

  // The link is stamped once the note has landed: waited for, not read once.
  await expectFile(vault, FILED_CALL).toContain('[[DFAI]]');
  const filed = await vault.read(FILED_CALL);
  expect(filed).toContain('status: next-action');
  expect(filed).toMatch(/^project: "?\[\[DFAI\]\]"?$/m);
  // Every other byte is as it was written: the comment, the spacing, the checklist.
  expect(filed.replace(/^project: .*\n/m, '')).toBe(
    CALL.replace('status: inbox', 'status: next-action'),
  );
  expect(await vault.exists('Inbox/Call the bank.md')).toBe(false);
  expect(await vault.exists('Projects/DFAI/Call the bank.md')).toBe(false);
  await expect(row(page, 'Call the bank')).toHaveCount(0);
  await expect(row(page, 'Chase the quote')).toBeVisible();
  await expect(sidebarInbox(page)).toContainText('4');
});

test('Waiting offers who on the same row, needs no one, and writes both together when picked (#202)', async ({
  page,
}) => {
  const vault = await gtdVault();
  await open(page, vault);
  await openInbox(page);
  const inbox = inboxPage(page);

  await expect(inbox.getByRole('combobox', { name: 'Who Chase the quote waits on' })).toHaveCount(
    0,
  );
  await inbox
    .getByRole('combobox', { name: 'Status of Chase the quote' })
    .selectOption({ label: 'Waiting' });
  const who = inbox.getByRole('combobox', { name: 'Who Chase the quote waits on' });
  await expect(who).toBeVisible();

  await pickSuggestion(who, 'Mara Quill');
  await row(page, 'Chase the quote')
    .getByRole('button', { name: 'Save', exact: true })
    .press('Enter');

  await expectFile(vault, 'Inbox/Chase the quote.md').toContain('status: waiting');
  expect(await vault.read('Inbox/Chase the quote.md')).toMatch(
    /^waiting_on: "?\[\[Mara Quill\]\]"?$/m,
  );
  await expect(row(page, 'Chase the quote')).toHaveCount(0);

  // No one picked: Done writes Waiting alone, and nothing asks who.
  await inbox
    .getByRole('combobox', { name: 'Status of Learn the cello' })
    .selectOption({ label: 'Waiting' });
  await expect(inbox.getByRole('combobox', { name: 'Who Learn the cello waits on' })).toBeVisible();
  await row(page, 'Learn the cello')
    .getByRole('button', { name: 'Save', exact: true })
    .press('Enter');

  await expectFile(vault, 'Inbox/Learn the cello.md').toContain('status: waiting');
  expect(await vault.read('Inbox/Learn the cello.md')).not.toContain('waiting_on');
  await expect(row(page, 'Learn the cello')).toHaveCount(0);
});

test('a status alone, with no project, takes a task off the list and leaves its file where it is', async ({
  page,
}) => {
  const vault = await gtdVault();
  await open(page, vault);
  await openInbox(page);
  const inbox = inboxPage(page);

  await inbox
    .getByRole('combobox', { name: 'Status of Learn the cello' })
    .selectOption({ label: 'Someday' });
  await row(page, 'Learn the cello')
    .getByRole('button', { name: 'Save', exact: true })
    .press('Enter');

  await expectFile(vault, 'Inbox/Learn the cello.md').toContain('status: someday');
  expect(await vault.read('Inbox/Learn the cello.md')).not.toContain('project:');
  await expect(row(page, 'Learn the cello')).toHaveCount(0);
  await expect(row(page, 'Call the bank')).toBeVisible();
});

test('a task at Inbox outside the Inbox folder is clarified where it lives, linked to its project', async ({
  page,
}) => {
  const vault = await gtdVault();
  await open(page, vault);
  await openInbox(page);
  const inbox = inboxPage(page);
  await expect(row(page, 'Renew the passport')).toContainText('Task');

  await inbox
    .getByRole('combobox', { name: 'Status of Renew the passport' })
    .selectOption({ label: 'Backlog' });
  await pickSuggestion(
    inbox.getByRole('combobox', { name: 'File Renew the passport under' }),
    'DFAI',
  );
  await inbox.getByLabel('Renew the passport is due').fill('2027-04-01');
  await row(page, 'Renew the passport')
    .getByRole('button', { name: 'Save', exact: true })
    .press('Enter');

  await expectFile(vault, 'Tasks/Renew the passport.md').toContain('status: backlog');
  const clarified = await vault.read('Tasks/Renew the passport.md');
  expect(clarified).toMatch(/^project: "?\[\[DFAI\]\]"?$/m);
  expect(clarified).toMatch(/^due: "?2027-04-01"?$/m);
  expect(await vault.exists('Projects/DFAI/Renew the passport.md')).toBe(false);
  await expect(row(page, 'Renew the passport')).toHaveCount(0);
});

test('Undo takes the last clarification back: the file returns, saying what it said', async ({
  page,
}) => {
  const vault = await gtdVault();
  await open(page, vault);
  await openInbox(page);
  const inbox = inboxPage(page);

  await inbox
    .getByRole('combobox', { name: 'Status of Call the bank' })
    .selectOption({ label: 'Waiting' });
  await pickSuggestion(
    inbox.getByRole('combobox', { name: 'Who Call the bank waits on' }),
    'Mara Quill',
  );
  await pickSuggestion(inbox.getByRole('combobox', { name: 'File Call the bank under' }), 'DFAI');
  await row(page, 'Call the bank')
    .getByRole('button', { name: 'Save', exact: true })
    .press('Enter');
  await expectFile(vault, FILED_CALL).toContain('[[DFAI]]');
  expect(await vault.read(FILED_CALL)).toContain('status: waiting');
  expect(await vault.exists('Projects/DFAI/Call the bank.md')).toBe(false);
  await expect(row(page, 'Call the bank')).toHaveCount(0);

  const said = toastSaying(page, 'Clarified “Call the bank”.');
  await said.getByRole('button', { name: 'Undo' }).click();

  await expectFile(vault, 'Inbox/Call the bank.md').toBe(CALL);
  expect(await vault.exists(FILED_CALL)).toBe(false);
  expect(await vault.exists('Projects/DFAI/Call the bank.md')).toBe(false);
  await expect(row(page, 'Call the bank')).toBeVisible();
  // Its Undo spent, the toast has gone, and the page draws no undo of its own.
  await expect(said).toHaveCount(0);
  await expect(inbox.getByRole('button', { name: 'Undo' })).toHaveCount(0);
});

test('once a row is done the next row has the focus, and Tab walks its controls', async ({
  page,
}) => {
  await open(page, await gtdVault());
  await openInbox(page);
  const inbox = inboxPage(page);
  // The first task as the page orders them, and whatever row is under it.
  const tasks = inbox
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name: 'Save', exact: true }) });
  await expect(tasks).toHaveCount(4);
  const first = (await tasks.first().locator('.table__title').textContent()) ?? '';
  const listed = await inbox.locator('tbody .table__title').allTextContents();
  const second = listed[listed.indexOf(first) + 1] ?? '';
  expect(second).not.toBe('');

  await inbox
    .getByRole('combobox', { name: `Status of ${first}` })
    .selectOption({ label: 'Backlog' });
  await row(page, first).getByRole('button', { name: 'Save', exact: true }).press('Enter');

  await expect(row(page, first)).toHaveCount(0);
  await expect(row(page, second)).toBeFocused();
  // Tab goes into that row, not back to the top of the page. (Which control is
  // first is WebKit's choice: without full keyboard access it passes over buttons.)
  await page.keyboard.press('Tab');
  await expect(row(page, second).locator(':focus')).toHaveCount(1);
  await expect(row(page, second)).not.toBeFocused();
});

/** #55: another vault's rows are never shown, or acted on, after a switch. */
test('after a vault switch the Inbox lists the new vault only, and clarifies into it', async ({
  page,
}) => {
  const a = await gtdVault();
  const b = await gtdVault();
  await b.write('Inbox/Order seeds.md', note(['type: task', 'status: inbox'], 'Before March.'));
  // Same path in both, so a write through the wrong vault would land somewhere real.
  const aCall = await a.read('Inbox/Call the bank.md');
  await b.write('Inbox/Call the bank.md', note(['type: task', 'status: inbox'], 'B’s own call.'));
  const host = await open(page, a);
  await openInbox(page);
  await expect(row(page, 'Call the bank')).toBeVisible();
  await expect(row(page, 'Order seeds')).toHaveCount(0);

  const nameOf = (vault: FakeVault) => vault.root.split(sep).at(-1) ?? '';
  host.offer(b);
  await page.getByRole('button', { name: nameOf(a), exact: true }).click();
  await page.getByRole('menuitem', { name: 'Open another folder…' }).click();
  await expect(page.getByRole('button', { name: nameOf(b), exact: true })).toBeVisible();
  await openInbox(page);

  await expect(row(page, 'Order seeds')).toBeVisible();
  await expect(page.getByText(/^6 to process/)).toBeVisible();
  const inbox = inboxPage(page);
  await inbox
    .getByRole('combobox', { name: 'Status of Call the bank' })
    .selectOption({ label: 'Backlog' });
  await row(page, 'Call the bank')
    .getByRole('button', { name: 'Save', exact: true })
    .press('Enter');

  await expectFile(b, 'Inbox/Call the bank.md').toContain('status: backlog');
  expect(await b.read('Inbox/Call the bank.md')).toContain('B’s own call.');
  expect(await a.read('Inbox/Call the bank.md')).toBe(aCall);
});

test('a decided row leaves the Inbox before its write lands (#260)', async ({ page }) => {
  const vault = await gtdVault();
  const host = await open(page, vault);
  await openInbox(page);
  const inbox = inboxPage(page);
  const release = host.holdWrites('Inbox/Learn the cello.md');

  await inbox
    .getByRole('combobox', { name: 'Status of Learn the cello' })
    .selectOption({ label: 'Someday' });
  await row(page, 'Learn the cello')
    .getByRole('button', { name: 'Save', exact: true })
    .press('Enter');

  // Gone while its file still says Inbox: the page did not wait for the write.
  await expect(row(page, 'Learn the cello')).toHaveCount(0);
  await expect(row(page, 'Call the bank')).toBeVisible();
  expect(await vault.read('Inbox/Learn the cello.md')).not.toContain('status: someday');

  // The write has reached the host and is held there, not still on its way.
  await expect.poll(() => host.writesTo('Inbox/Learn the cello.md')).toBeGreaterThan(0);
  release();
  await expectFile(vault, 'Inbox/Learn the cello.md').toContain('status: someday');
  await expect(row(page, 'Learn the cello')).toHaveCount(0);
});

test('a decided row whose write fails comes back to the Inbox, saying why (#260)', async ({
  page,
}) => {
  const vault = await gtdVault();
  const host = await open(page, vault);
  await openInbox(page);
  const inbox = inboxPage(page);
  const before = await vault.read('Inbox/Learn the cello.md');
  const release = host.holdWrites('Inbox/Learn the cello.md');

  await inbox
    .getByRole('combobox', { name: 'Status of Learn the cello' })
    .selectOption({ label: 'Someday' });
  await row(page, 'Learn the cello')
    .getByRole('button', { name: 'Save', exact: true })
    .press('Enter');
  await expect(row(page, 'Learn the cello')).toHaveCount(0);

  // The write has reached the host and is held there, not still on its way.
  await expect.poll(() => host.writesTo('Inbox/Learn the cello.md')).toBeGreaterThan(0);
  release({ fail: 'The disk is full.' });

  await expect(row(page, 'Learn the cello')).toBeVisible();
  await expect(row(page, 'Learn the cello')).toContainText(/The disk is full/);
  expect(await vault.read('Inbox/Learn the cello.md')).toBe(before);
});
