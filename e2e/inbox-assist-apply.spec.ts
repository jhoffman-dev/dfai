import { readFileSync } from 'node:fs';
import { utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from './fixtures.ts';
import { createVault, expectFile, installHost, type FakeVault } from './host.ts';

/**
 * #909, Inbox assist's rows applied by hand: Apply on one row and "Apply all
 * sure ones", each re-checked against the notes as they are at the press;
 * Undo on one row and "Undo all", each putting every byte back. A row whose
 * item was edited after the preview asks instead, and writes nothing. For
 * each press, the host is asked for exactly the writes that press needs.
 */

const shipped = (path: string) =>
  readFileSync(new URL(`../vault/${path}`, import.meta.url), 'utf8');

const CALL = 'Inbox/Call Mara Quill.md';
const LUNCH = 'Inbox/Lunch with Tobias Fenn.md';
const RENEW = 'Inbox/Renew Larkspur contract.md';
const JUNK = 'Inbox/Buy now.md';
const PROJECT = 'Projects/Larkspur Payroll.md';
const KEPT = 'Tasks/Renew Larkspur contract.md';
const TOBIAS = 'People/Tobias Fenn.md';
const NOTES: Record<string, string> = {
  [CALL]: 'Call Mara Quill <mara.quill@example.com> about the renewal by 2026-12-01.\n',
  [LUNCH]: 'Lunch with Tobias Fenn <tobias@example.org> on Friday.\n',
  [RENEW]: '',
  [JUNK]: 'Buy now!\n',
  [PROJECT]: '---\ntype: project\n---\n\n# Larkspur Payroll\n',
  [KEPT]: '---\ntype: task\nstatus: next-action\n---\n\nRenew it.\n',
  'People/Mara Quill.md': '---\ntype: person\nemail: mara.quill@example.com\n---\n',
};

const entry = (item: string, extra: Record<string, unknown>) => ({
  item,
  kind: 'task',
  projects: [],
  due: null,
  waitingOn: null,
  confidence: 'high',
  why: 'Something to do.',
  duplicateOf: null,
  people: [],
  ...extra,
});
const ANSWER = JSON.stringify({
  items: [
    entry(CALL, {
      projects: [PROJECT],
      due: '2026-12-01',
      people: [{ name: 'Mara Quill', email: null, person: 'People/Mara Quill.md' }],
    }),
    entry(LUNCH, { people: [{ name: 'Tobias Fenn', email: 'tobias@example.org', person: null }] }),
    entry(RENEW, { duplicateOf: KEPT }),
    entry(JUNK, { kind: 'junk' }),
  ],
});

/** The commands that only read: anything else the host is asked for is a write. */
const READS = new Set([
  'read_notes',
  'read_text_file',
  'list_notes',
  'list_files',
  'list_vault_files',
  'list_directory',
  'index_query',
  'index_notes_of_type',
  'index_manifest',
  'index_search',
  'model_process_start',
  'activity_read',
]);

/** The commands that write the vault. */
const VAULT_WRITES = new Set([
  'write_text_file',
  'create_note',
  'create_folder',
  'move_entry',
  'trash_entry',
  'write_binary_file',
]);

/** What follows a write without being one: the index catching up with the files, and Activity's own file, kept outside the vault. */
const FOLLOWS_A_WRITE = /^(index_|activity_)/u;

/**
 * The vault writes asked for since `before`, by command and how many times:
 * a folder made only by name, since how many a filing makes depends on which
 * of its home's folders exist yet. Any command that is neither a read, a
 * vault write nor what follows one fails the test.
 */
function writesSince(before: ReadonlyMap<string, number>, now: ReadonlyMap<string, number>) {
  const called = [...now].filter(
    ([command, count]) => count > (before.get(command) ?? 0) && !READS.has(command),
  );
  expect(
    called
      .map(([command]) => command)
      .filter((command) => !VAULT_WRITES.has(command) && !FOLLOWS_A_WRITE.test(command)),
  ).toEqual([]);
  return Object.fromEntries(
    called
      .filter(([command]) => VAULT_WRITES.has(command))
      .map(([command, count]) => [
        command,
        command === 'create_folder' ? 'some' : count - (before.get(command) ?? 0),
      ])
      .sort(([left], [right]) => String(left).localeCompare(String(right))),
  );
}

async function setUp(page: Parameters<Parameters<typeof test>[2]>[0]['page']) {
  await page.setViewportSize({ width: 1440, height: 900 });
  const vault = await createVault();
  for (const folder of ['.atlas/types', 'Inbox', 'Projects', 'People', 'Tasks']) {
    await vault.mkdir(folder);
  }
  for (const type of ['project', 'person']) {
    await vault.write(`.atlas/types/${type}.md`, shipped(`.atlas/types/${type}.md`));
  }
  for (const [path, text] of Object.entries(NOTES)) await vault.write(path, text);
  const anHourAgo = new Date(Date.now() - 60 * 60_000);
  for (const path of Object.keys(NOTES)) {
    await utimes(join(vault.root, path), anHourAgo, anHourAgo);
  }
  const host = await installHost(page, vault);
  host.claude.reply(ANSWER);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await page.getByRole('button', { name: /^Inbox/ }).click();
  const main = page.getByRole('main');
  await expect(main.getByRole('button', { name: 'Call Mara Quill', exact: true })).toBeVisible();
  await main.getByRole('button', { name: 'Suggest' }).click();
  const suggestions = main.getByRole('region', { name: 'Suggestions' });
  await expect(suggestions.getByRole('status')).toContainText(
    'Nothing is written until you apply it.',
  );
  return { vault, host, suggestions };
}

/** Every note as the vault was set up with it, read now. */
async function expectAsSetUp(vault: FakeVault) {
  for (const [path, text] of Object.entries(NOTES)) await expectFile(vault, path).toBe(text);
  expect(await vault.exists(TOBIAS)).toBe(false);
}

test('applies one row, then undoes it, each with exactly its writes', async ({ page }) => {
  const { vault, host, suggestions } = await setUp(page);
  const call = suggestions.getByRole('listitem', { name: 'Call Mara Quill' });
  const junk = suggestions.getByRole('listitem', { name: 'Buy now' });
  await expect(junk).toContainText('Question');
  await expect(junk.getByRole('button')).toHaveCount(0);

  const before = host.commandCounts();
  await call.getByRole('button', { name: 'Apply' }).click();
  await expect(call).toContainText(
    'Made it a task under Larkspur Payroll, due 2026-12-01. Linked Mara Quill.',
  );
  const undo = call.getByRole('button', { name: 'Undo' });
  await expect(undo).toBeFocused();
  await expect.poll(() => vault.exists(CALL)).toBe(false);
  // Its fields in one write; filed: a move, then its project linked where it lands; its people
  // linked in a third write; the log made, in its folder.
  await expect.poll(() => host.activityLog()).toContain('Inbox assist applied “Call Mara Quill”');
  expect(writesSince(before, host.commandCounts())).toEqual({
    create_folder: 'some',
    create_note: 1,
    move_entry: 1,
    write_text_file: 3,
  });

  const beforeUndo = host.commandCounts();
  await undo.press('Enter');
  await expect(call).toContainText('Put back as it was.');
  await expectAsSetUp(vault);
  // Moved back, its bytes written back, and one line added to the log.
  await expect.poll(() => host.activityLog()).toContain('Inbox assist undid “Call Mara Quill”');
  expect(writesSince(beforeUndo, host.commandCounts())).toEqual({
    move_entry: 1,
    write_text_file: 2,
  });
});

test('applies all sure rows, skipping the question, then undoes all, every byte back', async ({
  page,
}) => {
  const { vault, host, suggestions } = await setUp(page);
  const before = host.commandCounts();
  await suggestions.getByRole('button', { name: 'Apply all sure ones' }).click();
  const lunch = suggestions.getByRole('listitem', { name: 'Lunch with Tobias Fenn' });
  const renew = suggestions.getByRole('listitem', { name: 'Renew Larkspur contract' });
  await expect(lunch).toContainText('Added Tobias Fenn.');
  await expect(renew).toContainText('Archived as a duplicate of Renew Larkspur contract.');
  await expect(suggestions.getByRole('listitem', { name: 'Call Mara Quill' })).toContainText(
    'Linked Mara Quill.',
  );
  await expect.poll(() => vault.exists(TOBIAS)).toBe(true);
  await expectFile(vault, KEPT).toBe(NOTES[KEPT]);
  await expectFile(vault, JUNK).toBe(NOTES[JUNK]);
  // Call Mara: three writes and a move, as above. Tobias's item: made a task, then he is made and
  // linked. The duplicate: its stamp, then archived (a move and the Archive's stamp). The log: made
  // once, then added to twice.
  expect(writesSince(before, host.commandCounts())).toEqual({
    create_folder: 'some',
    create_note: 2,
    move_entry: 2,
    write_text_file: 9,
  });

  const beforeUndo = host.commandCounts();
  await suggestions.getByRole('button', { name: 'Undo all' }).click();
  await expect(renew).toContainText('Put back as it was.');
  await expect(lunch).toContainText('Put back as it was.');
  await expectAsSetUp(vault);
  expect(host.trashed()).toEqual([TOBIAS]);
  // Each item moved back or written back, Tobias put in the Trash, a log line each.
  expect(writesSince(beforeUndo, host.commandCounts())).toEqual({
    move_entry: 2,
    trash_entry: 1,
    write_text_file: 6,
  });
});

test('asks instead, and writes nothing, when the item was edited after the preview', async ({
  page,
}) => {
  const { vault, host, suggestions } = await setUp(page);
  const edited = `${NOTES[CALL]!}Bring the letter.\n`;
  await vault.write(CALL, edited);
  const anHourAgo = new Date(Date.now() - 60 * 60_000);
  await utimes(join(vault.root, CALL), anHourAgo, anHourAgo);
  const before = host.commandCounts();
  const call = suggestions.getByRole('listitem', { name: 'Call Mara Quill' });
  await call.getByRole('button', { name: 'Apply' }).click();
  await expect(call).toContainText('It changed since the preview. Suggest again to see it.');
  await expect(call.getByRole('button')).toHaveCount(0);
  await expectFile(vault, CALL).toBe(edited);
  expect(writesSince(before, host.commandCounts())).toEqual({});
});
