import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, type FakeVault } from './host.ts';
import { suggestion } from './link-suggest.ts';
import { toastSaying } from './toasts.ts';

/**
 * #307 (UI v2 slice 11a): one-key triage on the Inbox — a letter on a
 * focused row writes its status at once, P files it from the project picker,
 * keys sleep inside a field, Undo takes a key's write back — and proposals
 * that disagree asked as one "pick one" question. Every claim about a file
 * reads the disk.
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

const MEETING_TYPE = [
  '---',
  'name: meeting',
  'label: Meeting',
  'properties:',
  '  people:',
  '    kind: relation',
  '    target: person',
  '    many: true',
  '  owner:',
  '    kind: relation',
  '    target: person',
  '---',
  '',
].join('\n');

const PERSON_TYPE = ['---', 'name: person', 'label: Person', '---', '', '# Person', ''].join('\n');

const note = (frontmatter: string[], body: string) =>
  ['---', ...frontmatter, '---', '', body, ''].join('\n');

const STANDUP = 'Inbox/Meetings/2026-10-16 Platform Standup.md';

/** Three links for one mention in one block: the same kind, source and slot, three values. */
const maraLink = (link: string, property = 'owner') =>
  [
    '---',
    'type: proposal',
    'kind: link',
    'state: open',
    'confidence: low',
    'source: "[[2026-10-16 Platform Standup#^t0002]]"',
    'made_by: after-meeting · run 1',
    'payload:',
    `  note: ${STANDUP}`,
    `  property: ${property}`,
    `  link: "${link}"`,
    '---',
    '',
    'Mara spoke at 00:09.',
    '',
  ].join('\n');

// A fixed day, set on the page's clock, so the folder a task is filed into does not move with the real one.
const NOW = new Date(2026, 9, 14, 12);
const TODAY = NOW.toLocaleDateString('en-CA');
const FILED_CALL = `Tasks/${TODAY.slice(0, 4)}/${TODAY.slice(5, 7)}/Call the bank.md`;

async function triageVault(): Promise<FakeVault> {
  const vault = await createVault();
  for (const folder of ['.atlas/types', 'Projects', 'People', 'Tasks', 'Inbox/Meetings']) {
    await vault.mkdir(folder);
  }
  await vault.write('.atlas/types/task.md', GTD_TASK_TYPE);
  await vault.write('.atlas/types/meeting.md', MEETING_TYPE);
  await vault.write('.atlas/types/person.md', PERSON_TYPE);
  await vault.write('Projects/Atlas.md', note(['type: project'], 'The app.'));
  await vault.write('Projects/Alpha.md', note(['type: project'], 'The first.'));
  await vault.write('People/Mara Quill.md', note(['type: person'], 'A neighbour.'));
  await vault.write('People/Mara Quill (Larkspur).md', note(['type: person'], 'At Larkspur.'));
  await vault.write('People/Tobias Fenn.md', note(['type: person'], 'A friend.'));
  await vault.write('Inbox/Call the bank.md', note(['type: task', 'status: inbox'], 'The loan.'));
  await vault.write('Inbox/Chase the quote.md', note(['type: task', 'status: inbox'], 'Larkspur.'));
  await vault.write('Inbox/Learn the cello.md', note(['type: task', 'status: inbox'], 'One day.'));
  return vault;
}

async function withConflict(vault: FakeVault): Promise<void> {
  await vault.mkdir('Inbox/Proposals');
  await vault.write(STANDUP, note(['type: meeting'], 'Who brings what. ^t0002'));
  await vault.write('Inbox/Proposals/Mara 1.md', maraLink('[[Mara Quill]]'));
  await vault.write('Inbox/Proposals/Mara 2.md', maraLink('[[Mara Quill (Larkspur)]]'));
  await vault.write('Inbox/Proposals/Mara 3.md', maraLink('[[Tobias Fenn]]'));
}

async function open(page: Page, vault: FakeVault) {
  await page.clock.setFixedTime(NOW);
  const host = await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible({ timeout: 20_000 });
  await page
    .getByRole('list', { name: 'Go to' })
    .getByRole('button', { name: /^Inbox/ })
    .click();
  await expect(inboxPage(page).getByRole('table')).toBeVisible();
  return host;
}

const inboxPage = (page: Page) => page.getByRole('article', { name: 'Inbox' });

/**
 * Every offer the triage vault makes is on the Inbox. One read after the page
 * stops holding its rows for them lands above the list, and the list is held
 * still by scrolling (#130): the offers already shown move up under a click.
 */
async function everyTriageOfferShown(page: Page) {
  const inbox = inboxPage(page);
  await expect(
    inbox.getByRole('complementary', { name: 'Set your types up for the Inbox' }),
  ).toBeVisible();
  for (const offer of ['Move tasks to GTD statuses', 'Process meetings when they arrive']) {
    await expect(inbox.getByRole('region', { name: offer })).toBeVisible();
  }
}
const row = (page: Page, title: string) =>
  inboxPage(page)
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name: title, exact: true }) });

/** The task rows in the order the page lists them, by title. */
async function listedTasks(page: Page): Promise<string[]> {
  const inbox = inboxPage(page);
  const tasks = inbox
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name: 'Save', exact: true }) });
  await expect(tasks).toHaveCount(3);
  return tasks.locator('.table__title').allTextContents();
}

test('a letter on a focused row writes its status at once, the next row takes the focus, and Undo takes it back', async ({
  page,
}) => {
  const vault = await triageVault();
  await open(page, vault);
  const [first = '', second = ''] = await listedTasks(page);

  await row(page, first).focus();
  await expect(row(page, first).getByRole('button', { name: 'Next, key N' })).toBeVisible();
  await page.keyboard.press('n');
  await expectFile(vault, `Inbox/${first}.md`).toContain('status: next-action');
  await expect(row(page, first)).toHaveCount(0);
  await expect(row(page, second)).toBeFocused();

  await page.keyboard.press('w');
  await expectFile(vault, `Inbox/${second}.md`).toContain('status: waiting');
  await expect(row(page, second)).toHaveCount(0);

  await toastSaying(page, `Clarified “${second}”.`).getByRole('button', { name: 'Undo' }).click();
  await expectFile(vault, `Inbox/${second}.md`).toContain('status: inbox');
  await expect(row(page, second)).toBeVisible();
});

test('a letter typed in one of the row’s fields is a letter, not a triage key', async ({
  page,
}) => {
  const vault = await triageVault();
  await open(page, vault);
  const [first = ''] = await listedTasks(page);

  const status = inboxPage(page).getByRole('combobox', { name: `Status of ${first}` });
  await status.focus();
  await page.keyboard.press('n');
  await page.keyboard.press('d');
  await expect(row(page, first)).toBeVisible();

  // The same row, with the row itself focused, is live: so the keys above wrote nothing.
  await row(page, first).focus();
  await page.keyboard.press('s');
  await expectFile(vault, `Inbox/${first}.md`).toContain('status: someday');
  expect(await vault.read(`Inbox/${first}.md`)).not.toContain('next-action');
  expect(await vault.exists('Archive')).toBe(false);
});

test('P opens the project picker; typing narrows it, and Enter files the task with its status as it was', async ({
  page,
}) => {
  const vault = await triageVault();
  await open(page, vault);

  await row(page, 'Call the bank').focus();
  await page.keyboard.press('p');
  const picker = inboxPage(page).getByRole('combobox', { name: 'File Call the bank under' });
  await expect(picker).toBeFocused();
  // Typing only narrows the suggestions (#465): the next test proves it writes nothing.
  await page.keyboard.type('atl');
  await expect(suggestion(picker, 'Atlas')).toHaveAttribute('aria-selected', 'true');
  await picker.press('Enter');
  await expectFile(vault, FILED_CALL).toContain('[[Atlas]]');
  expect(await vault.read(FILED_CALL)).toContain('status: inbox');
  expect(await vault.exists('Inbox/Call the bank.md')).toBe(false);
});

test('typing into the P picker files nothing until Enter, and Escape drops what was typed', async ({
  page,
}) => {
  const vault = await triageVault();
  const host = await open(page, vault);

  await row(page, 'Call the bank').focus();
  await page.keyboard.press('p');
  const picker = inboxPage(page).getByRole('combobox', { name: 'File Call the bank under' });
  await expect(picker).toBeFocused();
  // Typing on the picker narrows its suggestions; none is a pick.
  await page.keyboard.type('al');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(row(page, 'Call the bank')).toBeFocused();
  await expect(picker).toHaveValue('');

  // A later, explicit key lands on the same row and note: had typing filed it, the row would be gone.
  await page.keyboard.press('n');
  await expectFile(vault, 'Inbox/Call the bank.md').toContain('status: next-action');
  expect(await vault.read('Inbox/Call the bank.md')).not.toContain('Alpha');
  expect(host.writesTo('Inbox/Call the bank.md')).toBe(1);
});

test('proposals for a relation that holds many are two rows, not a question', async ({ page }) => {
  const vault = await triageVault();
  await vault.mkdir('Inbox/Proposals');
  await vault.write(STANDUP, note(['type: meeting'], 'Who brings what. ^t0002'));
  await vault.write('Inbox/Proposals/Mara 1.md', maraLink('[[Mara Quill]]', 'people'));
  await vault.write('Inbox/Proposals/Tobias.md', maraLink('[[Tobias Fenn]]', 'people'));
  await open(page, vault);
  const inbox = inboxPage(page);

  await expect(inbox.getByRole('region', { name: /^Pick one: / })).toHaveCount(0);
  await expect(inbox.getByRole('region', { name: /^Link: / })).toHaveCount(2);
});

test('proposals that disagree are one question: Accept choice accepts the one picked and rejects the rest', async ({
  page,
}) => {
  const vault = await triageVault();
  await withConflict(vault);
  await open(page, vault);
  const inbox = inboxPage(page);

  const question = inbox.getByRole('region', {
    name: 'Pick one: Which link for owner of 2026-10-16 Platform Standup?',
  });
  await expect(question).toBeVisible();
  await expect(
    question.getByText('3 proposals disagree. Pick one; the others are rejected.'),
  ).toBeVisible();
  await expect(inbox.getByRole('region', { name: /^Link: / })).toHaveCount(0);
  const accept = question.getByRole('button', { name: 'Accept choice' });
  await expect(accept).toBeDisabled();

  await question.getByRole('radio', { name: '[[Mara Quill (Larkspur)]]' }).check();
  await accept.click();

  await expectFile(vault, 'Archive/Inbox/Proposals/Mara 2.md').toContain('state: accepted');
  await expectFile(vault, 'Archive/Inbox/Proposals/Mara 1.md').toContain('state: rejected');
  await expectFile(vault, 'Archive/Inbox/Proposals/Mara 3.md').toContain('state: rejected');
  await expectFile(vault, STANDUP).toContain('[[Mara Quill (Larkspur)]]');
  expect(await vault.read(STANDUP)).not.toContain('[[Tobias Fenn]]');
  await expect(question).toHaveCount(0);
});

test('Reject all files every proposal of the question as rejected, writing nothing to the note', async ({
  page,
}) => {
  const vault = await triageVault();
  await withConflict(vault);
  await open(page, vault);
  const question = inboxPage(page).getByRole('region', { name: /^Pick one: / });
  await expect(question).toBeVisible();

  await question.getByRole('button', { name: 'Reject all' }).click();
  for (const name of ['Mara 1', 'Mara 2', 'Mara 3']) {
    await expectFile(vault, `Archive/Inbox/Proposals/${name}.md`).toContain('state: rejected');
  }
  expect(await vault.read(STANDUP)).not.toContain('owner');
  await expect(question).toHaveCount(0);
});

/** The triage vault with five tasks to clarify, two more than `triageVault`'s three. */
async function fiveTaskVault(): Promise<FakeVault> {
  const vault = await triageVault();
  await vault.write('Inbox/Renew the passport.md', note(['type: task', 'status: inbox'], 'June.'));
  await vault.write('Inbox/Fix the gate.md', note(['type: task', 'status: inbox'], 'It sticks.'));
  return vault;
}

/** The titles of the task rows, top to bottom, once all `count` are listed. */
async function taskRows(page: Page, count: number): Promise<string[]> {
  const tasks = inboxPage(page)
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name: 'Save', exact: true }) });
  await expect(tasks).toHaveCount(count);
  return tasks.locator('.table__title').allTextContents();
}

test('five rows by key alone: each row leaves and the next has the focus before its write is done, every file says its key, and Undo takes the last back (#308)', async ({
  page,
}) => {
  const vault = await fiveTaskVault();
  const host = await open(page, vault);
  const titles = await taskRows(page, 5);
  const keys = ['n', 'w', 's', 'd', 'n'];
  const written = ['next-action', 'waiting', 'someday', 'archive', 'next-action'];
  // The first write is held on the disk: the rows after it must not wait for it.
  const release = host.holdWrites(`Inbox/${titles[0]}.md`);

  await row(page, titles[0] ?? '').focus();
  for (const [at, key] of keys.entries()) {
    await page.keyboard.press(key);
    await expect(row(page, titles[at] ?? '')).toHaveCount(0);
    const next = titles[at + 1];
    if (next !== undefined) await expect(row(page, next)).toBeFocused();
  }
  // Nothing has reached the disk behind the held write: the rows left on the keys alone.
  expect(await vault.read(`Inbox/${titles[1]}.md`)).toContain('status: inbox');

  release();
  for (const [at, title] of titles.entries()) {
    await expectFile(vault, `Inbox/${title}.md`).toContain(`status: ${written[at]}`);
  }
  // A key writes its status and nothing else: no project it was not given.
  for (const title of titles) {
    expect(await vault.read(`Inbox/${title}.md`)).not.toContain('project:');
  }

  const last = titles[4] ?? '';
  await toastSaying(page, `Clarified “${last}”.`).getByRole('button', { name: 'Undo' }).click();
  await expectFile(vault, `Inbox/${last}.md`).toContain('status: inbox');
  await expect(row(page, last)).toBeVisible();
});

test('a key refused on the disk brings its row back saying why, and the rows after it are still written (#308)', async ({
  page,
}) => {
  const vault = await fiveTaskVault();
  const host = await open(page, vault);
  const [first = '', second = ''] = await taskRows(page, 5);
  const refuse = host.holdWrites(`Inbox/${first}.md`);

  await row(page, first).focus();
  await page.keyboard.press('n');
  await expect(row(page, second)).toBeFocused();
  await page.keyboard.press('s');
  // The write has reached the host and is held there, not still on its way.
  await expect.poll(() => host.writesTo(`Inbox/${first}.md`)).toBeGreaterThan(0);
  refuse({ fail: 'The disk is full.' });

  await expect(row(page, first)).toBeVisible();
  await expect(row(page, first)).toContainText(/The disk is full/);
  expect(await vault.read(`Inbox/${first}.md`)).toContain('status: inbox');
  await expectFile(vault, `Inbox/${second}.md`).toContain('status: someday');
});

test('“Not now” puts the types offer away for the session: back on the Inbox from another page, it stays away (#308)', async ({
  page,
}) => {
  const vault = await triageVault();
  await open(page, vault);
  const offer = inboxPage(page).getByRole('complementary', {
    name: 'Set your types up for the Inbox',
  });
  await expect(offer).toBeVisible();
  await everyTriageOfferShown(page);
  await offer.getByRole('button', { name: 'Not now' }).click();
  await expect(offer).toHaveCount(0);

  await page
    .getByRole('list', { name: 'Go to' })
    .getByRole('button', { name: /^Today/ })
    .click();
  await expect(inboxPage(page)).toHaveCount(0);
  await page
    .getByRole('list', { name: 'Go to' })
    .getByRole('button', { name: /^Inbox/ })
    .click();
  await expect(
    inboxPage(page).getByRole('button', { name: 'Call the bank', exact: true }),
  ).toBeVisible();
  await expect(offer).toHaveCount(0);
  // Put away, not answered: no type was written for it.
  expect(await vault.exists('.atlas/types/project.md')).toBe(false);
});
