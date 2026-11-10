import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, type FakeVault } from './host.ts';
import { suggestion } from './link-suggest.ts';

/**
 * #823: a link picked on an Inbox row while the Inbox list re-reads under it
 * lands, and Save writes it. Here the re-read is the meeting import's stamp,
 * held until the person has the suggestions open.
 */

const TASK_TYPE = [
  '---',
  'name: task',
  'label: Task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [inbox, next-action, waiting, someday, archive]',
  '    done: archive',
  '  waiting_on:',
  '    kind: relation',
  '    target: person',
  '  project:',
  '    kind: relation',
  '    target: [project, area]',
  '---',
  '',
  '# Task',
  '',
].join('\n');

const PERSON_TYPE = ['---', 'name: person', 'label: Person', '---', '', '# Person', ''].join('\n');

const note = (frontmatter: string[], body: string) =>
  ['---', ...frontmatter, '---', '', body, ''].join('\n');

const MEETING = 'Inbox/Meetings/2026-10-01 Seed swap.md';
const TASK = 'Inbox/Chase the quote.md';
/** Where a task filed under a project lands: its type's home for today (#214). */
const TODAY = new Date().toLocaleDateString('en-CA');
const FILED = `Tasks/${TODAY.slice(0, 4)}/${TODAY.slice(5, 7)}/Chase the quote.md`;

async function vaultWithAMeeting(): Promise<FakeVault> {
  const vault = await createVault();
  for (const folder of ['.atlas/types', 'Projects', 'People', 'Tasks', 'Inbox/Meetings']) {
    await vault.mkdir(folder);
  }
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write('.atlas/types/person.md', PERSON_TYPE);
  await vault.write('Projects/Garden.md', note(['type: project'], 'The beds.'));
  await vault.write('People/Mara Quill.md', note(['type: person'], 'A neighbour.'));
  await vault.write(TASK, note(['type: task', 'status: inbox'], 'Larkspur Payroll.'));
  // Not a meeting the import can read: it stamps it, and the Inbox re-reads.
  await vault.write(MEETING, note(['type: meeting'], 'Who brings what.'));
  return vault;
}

const inboxPage = (page: Page) => page.getByRole('article', { name: 'Inbox' });
const row = (page: Page, title: string) =>
  inboxPage(page)
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name: title, exact: true }) });

/** Opens the vault with the meeting's stamp held, then the Inbox. */
async function openWithTheStampHeld(page: Page, vault: FakeVault) {
  const host = await installHost(page, vault);
  const release = host.holdWrites(MEETING);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible({ timeout: 20_000 });
  await page
    .getByRole('list', { name: 'Go to' })
    .getByRole('button', { name: /^Inbox/ })
    .click();
  await expect(inboxPage(page).getByRole('table')).toBeVisible();
  return release;
}

/** Releases the stamp and waits for the Inbox to have re-read it. */
async function landTheStamp(page: Page, release: () => void) {
  release();
  await expect(row(page, '2026-10-01 Seed swap')).toContainText('Not imported');
}

test('a person picked while the Inbox re-reads is written by Save (#823)', async ({ page }) => {
  const vault = await vaultWithAMeeting();
  const release = await openWithTheStampHeld(page, vault);
  const inbox = inboxPage(page);

  await inbox
    .getByRole('combobox', { name: 'Status of Chase the quote' })
    .selectOption({ label: 'Waiting' });
  const who = inbox.getByRole('combobox', { name: 'Who Chase the quote waits on' });
  await who.click();
  await who.fill('Mar');
  await expect(suggestion(who, 'Mara Quill')).toBeVisible();

  await landTheStamp(page, release);
  // The row's edit lived through the re-read.
  await expect(who).toHaveValue('Mar');
  await suggestion(who, 'Mara Quill').click();
  await expect(who).toHaveValue('Mara Quill');
  await row(page, 'Chase the quote').getByRole('button', { name: 'Save', exact: true }).click();

  await expectFile(vault, TASK).toContain('status: waiting');
  expect(await vault.read(TASK)).toMatch(/^waiting_on: "?\[\[Mara Quill\]\]"?$/m);
});

test('a project picked while the Inbox re-reads is written by Save (#823)', async ({ page }) => {
  const vault = await vaultWithAMeeting();
  const release = await openWithTheStampHeld(page, vault);
  const inbox = inboxPage(page);

  await inbox
    .getByRole('combobox', { name: 'Status of Chase the quote' })
    .selectOption({ label: 'Next Action' });
  const under = inbox.getByRole('combobox', { name: 'File Chase the quote under' });
  await under.click();
  await under.fill('Gar');
  await expect(suggestion(under, 'Garden')).toBeVisible();

  await landTheStamp(page, release);
  await expect(under).toHaveValue('Gar');
  await suggestion(under, 'Garden').click();
  await expect(under).toHaveValue('Garden');
  await row(page, 'Chase the quote').getByRole('button', { name: 'Save', exact: true }).click();

  await expect(row(page, 'Chase the quote')).toHaveCount(0);
  await expectFile(vault, FILED).toMatch(/^project: "?\[\[Garden\]\]"?$/m);
});

test('Save refuses a person typed but never picked, and writes nothing (#823)', async ({
  page,
}) => {
  const vault = await vaultWithAMeeting();
  const release = await openWithTheStampHeld(page, vault);
  await landTheStamp(page, release);
  const inbox = inboxPage(page);

  await inbox
    .getByRole('combobox', { name: 'Status of Chase the quote' })
    .selectOption({ label: 'Waiting' });
  const who = inbox.getByRole('combobox', { name: 'Who Chase the quote waits on' });
  await who.click();
  await who.fill('Mar');
  await row(page, 'Chase the quote').getByRole('button', { name: 'Save', exact: true }).click();

  await expect(row(page, 'Chase the quote').getByRole('alert')).toHaveText(
    '“Mar” is typed but not picked. Pick it from the list, or clear it.',
  );
  await expect(who).toHaveValue('Mar');
  expect(await vault.read(TASK)).toContain('status: inbox');
});
