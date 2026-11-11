import { readFileSync } from 'node:fs';
import { utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from './fixtures.ts';
import { createVault, emitVaultChanged, expectFile, installHost, type FakeVault } from './host.ts';

/**
 * Phase 25 (U-24): James's first automation — archive done tasks after 30
 * days — made from its preset, dry-run, run, and undone, with every step in
 * its log. Every claim about a note reads the disk.
 */

const TASK_TYPE = [
  '---',
  'name: task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [backlog, doing, done]',
  '---',
  '',
].join('\n');

const task = (status: string) =>
  ['---', 'type: task', `status: ${status}`, '---', '', ''].join('\n');

const shipped = (path: string) =>
  readFileSync(new URL(`../vault/${path}`, import.meta.url), 'utf8');

const RULE = '.atlas/automations/Archive done tasks after 30 days.md';
const LOG = '.atlas/automations/log/Archive done tasks after 30 days.md';
const DAY_MS = 86_400_000;

async function openTaskVault(page: Page, rules: Record<string, string> = {}): Promise<FakeVault> {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/automations');
  for (const [path, text] of Object.entries(rules)) await vault.write(path, text);
  await vault.mkdir('Tasks');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  const old = new Date(Date.now() - 40 * DAY_MS);
  for (const [name, status, dated] of [
    ['Old done', 'done', old],
    ['Also done', 'done', old],
    ['Fresh done', 'done', null],
    ['Old doing', 'doing', old],
  ] as const) {
    await vault.write(`Tasks/${name}.md`, task(status));
    if (dated !== null) await utimes(join(vault.root, `Tasks/${name}.md`), dated, dated);
  }
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return vault;
}

test('the "archive done tasks after 30 days" automation: made, dry-run, run and undone', async ({
  page,
}) => {
  const vault = await openTaskVault(page);
  await page.getByRole('button', { name: 'Automations', exact: true }).click();
  const screen = page.getByRole('article', { name: 'Automations' });
  await expect(screen.getByText(/No automations yet/)).toBeVisible();

  // Made from its preset: the editor opens on it, and saving writes the rule.
  await page.getByRole('button', { name: 'Archive done tasks after 30 days' }).click();
  const editor = screen.getByRole('region', { name: 'Automation' });
  await expect(editor.getByRole('textbox', { name: 'Name' })).toHaveValue(
    'Archive done tasks after 30 days',
  );
  await editor.getByRole('button', { name: 'Create automation' }).click();
  await expectFile(vault, RULE).toMatch(
    /^---\natlas: automation\nname: Archive done tasks after 30 days\nenabled: true\nwhen: daily at 03:00\nwhich: FROM task WHERE status = done\nolderThanDays: 30\ndo: archive\nid: Archive done tasks after 30 days\n---\n/,
  );
  await expectFile(vault, LOG).toContain('· Turned on');

  // Listed, on, with its next run; opened, its log says it was turned on.
  const list = screen.getByRole('list', { name: 'All automations' });
  await expect(list.getByRole('switch', { name: /Run Archive done tasks/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(list.getByText('Archive · Every day at 03:00')).toBeVisible();
  await list.getByRole('button', { name: 'Archive done tasks after 30 days', exact: true }).click();
  const log = editor.getByRole('region', { name: 'Run log' });
  await expect(log.getByText(/· Turned on$/)).toBeVisible();

  // The dry run lists exactly the two old done tasks, and moves nothing.
  await editor.getByRole('button', { name: 'Dry run' }).click();
  const dryRun = editor.getByRole('region', { name: 'Dry run' });
  await expect(dryRun.getByText('Would archive 2 notes.')).toBeVisible();
  const would = dryRun.getByRole('list', { name: 'Notes it would take' });
  await expect(would.getByRole('button')).toHaveText(['Also done', 'Old done'], {
    useInnerText: true,
  });
  expect(await vault.exists('Tasks/Old done.md')).toBe(true);

  // Run now archives them, and the log says so line by line.
  await editor.getByRole('button', { name: 'Run now' }).click();
  await expect.poll(() => vault.exists('Archive/Tasks/Old done.md')).toBe(true);
  await expect.poll(() => vault.exists('Archive/Tasks/Also done.md')).toBe(true);
  expect(await vault.exists('Tasks/Fresh done.md')).toBe(true);
  expect(await vault.exists('Tasks/Old doing.md')).toBe(true);
  await expect(log.getByText(/· Ran by hand$/)).toBeVisible();
  // The dry run from before the run no longer says what would happen.
  await expect(dryRun).toHaveCount(0);
  await expect(log.getByText('Archived 2 notes.')).toBeVisible();
  await expect(log.getByText('Archived Old done (Tasks/Old done.md)')).toBeVisible();
  await expectFile(vault, LOG).toContain(
    '- archived `"Tasks/Old done.md"` → `"Archive/Tasks/Old done.md"`',
  );

  // Undo puts both back where they were, and the log shows the run and the undo.
  await editor.getByRole('button', { name: 'Undo last run' }).click();
  await expect.poll(() => vault.exists('Tasks/Old done.md')).toBe(true);
  await expect.poll(() => vault.exists('Tasks/Also done.md')).toBe(true);
  expect(await vault.exists('Archive/Tasks/Old done.md')).toBe(false);
  await expectFile(vault, 'Tasks/Old done.md').toBe(task('done'));
  await expect(log.getByText(/· Undid the run of /)).toBeVisible();
  await expect(log.getByText('Put back 2 notes.')).toBeVisible();
  await expect(log.getByText(/· Ran by hand$/)).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Undo last run' })).toBeDisabled();
});

test('a rule that runs when DFAI opens runs once, on opening, and logs it', async ({ page }) => {
  const sweep = [
    '---',
    'atlas: automation',
    'name: Sweep',
    'enabled: true',
    'when: on app open',
    'which: FROM task WHERE status = done',
    'olderThanDays: 30',
    'do: archive',
    '---',
    '',
    'Clears the board each morning.',
    '',
  ].join('\n');
  const vault = await openTaskVault(page, { '.atlas/automations/Sweep.md': sweep });

  await expect.poll(() => vault.exists('Archive/Tasks/Old done.md')).toBe(true);
  await expect.poll(() => vault.exists('Archive/Tasks/Also done.md')).toBe(true);
  expect(await vault.exists('Tasks/Fresh done.md')).toBe(true);
  await expectFile(vault, '.atlas/automations/log/Sweep.md').toContain('· Ran when DFAI opened');

  // Once: opening the page, and the index settling after the run, start no other.
  await page.getByRole('button', { name: 'Automations', exact: true }).click();
  const list = page.getByRole('list', { name: 'All automations' });
  await expect(list.getByText(/Archived 2 notes\./)).toBeVisible();
  // A rule is one of the table view's 34px hairline rows (UI v2 slice 13b).
  await expect
    .poll(async () => (await list.getByRole('listitem').first().boundingBox())?.height)
    .toBe(34);
  const logText = await vault.read('.atlas/automations/log/Sweep.md');
  expect(logText.match(/· Ran when DFAI opened/g)).toHaveLength(1);
  // A rule written without an id is given the one its log is under (A25-01); nothing else changes.
  await expectFile(vault, '.atlas/automations/Sweep.md').toBe(
    sweep.replace('do: archive\n---', 'do: archive\nid: Sweep\n---'),
  );
});

test('a rule a note sets off archives a new standup once the meeting import lets it in, and only that one (P29-01, #92)', async ({
  page,
}) => {
  const VALID = readFileSync(
    new URL(
      '../packages/domain/src/meetings/fixtures/valid/gemini-platform-sync.md',
      import.meta.url,
    ),
    'utf8',
  );
  /** A meeting that follows the contract (ADR-0027), its own by its id. */
  const meeting = (kind: string, id: string) =>
    VALID.replace(/^kind: .*$/m, `kind: ${kind}`).replace(
      /^external_id: .*$/m,
      `external_id: 'gemini-${id}'`,
    );
  /** As the import leaves a meeting it let in. */
  const imported = (text: string) =>
    text.replace(/^(atlas_import: .*\n)/m, '$1atlas_import_outcome: imported\n');
  const fileStandups = [
    '---',
    'atlas: automation',
    'name: File standups',
    'id: File standups',
    'enabled: true',
    'when: a meeting is created',
    'which: FROM meeting WHERE kind = Standup',
    'do: archive',
    '---',
    '',
  ].join('\n');
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/automations');
  await vault.mkdir('Inbox/Meetings');
  await vault.write('.atlas/types/meeting.md', shipped('.atlas/types/meeting.md'));
  await vault.write('.atlas/automations/File standups.md', fileStandups);
  // Let in by the import before: it arrived then, not now.
  const LAST_WEEK = 'Inbox/Meetings/Last week standup.md';
  await vault.write(LAST_WEEK, imported(meeting('Standup', 'aaaa0001')));
  // A week before the rule was saved, so opening does not catch it up as an
  // arrival the rule missed (ADR-0028): the index lists it, as the real one does.
  const ruleSaved = Date.UTC(2026, 9, 12) / 1000;
  await utimes(join(vault.root, '.atlas/automations/File standups.md'), ruleSaved, ruleSaved);
  const letInBefore = ruleSaved - 7 * 24 * 60 * 60;
  await utimes(join(vault.root, LAST_WEEK), letInBefore, letInBefore);
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();

  // Three meetings land where the import looks, as a pull brings them: the import stamps
  // each, and the rule hears a standup only once the import has let it in.
  const [STANDUP, KICKOFF, BROKEN] = ['Standup', 'Kickoff', 'Broken standup'].map(
    (name) => `Inbox/Meetings/${name}.md`,
  ) as [string, string, string];
  await vault.write(STANDUP, meeting('Standup', 'bbbb0002'));
  await vault.write(KICKOFF, meeting('Kickoff', 'cccc0003'));
  await vault.write(BROKEN, meeting('Standup', 'dddd0004').replace(/^date: .*\n/m, ''));
  await emitVaultChanged(page, [STANDUP, KICKOFF, BROKEN]);

  const archived = 'Archive/Inbox/Meetings/Standup.md';
  await expect.poll(() => vault.exists(archived)).toBe(true);
  await expectFile(vault, archived).toContain('atlas_import_outcome: imported');
  expect(await vault.exists(STANDUP)).toBe(false);
  await expectFile(vault, KICKOFF).toContain('atlas_import_outcome: imported');
  // Refused by the import, it never arrived, so it stays where it landed, saying why.
  await expectFile(vault, BROKEN).toContain('atlas_import_outcome: error');
  expect(await vault.exists(LAST_WEEK)).toBe(true);
  const log = '.atlas/automations/log/File standups.md';
  await expectFile(vault, log).toContain('· Ran when a note appeared or changed');
  await expectFile(vault, log).toContain('- triggered by `"Inbox/Meetings/Standup.md"` at');

  // Listed with its trigger, and run once: the archive it made sets nothing off again.
  await page.getByRole('button', { name: 'Automations', exact: true }).click();
  const list = page.getByRole('list', { name: 'All automations' });
  await expect(list.getByText('Archive · When a meeting is created')).toBeVisible();
  await expect(list.getByText(/Archived 1 note\./)).toBeVisible();
  expect((await vault.read(log)).match(/· Ran when a note appeared or changed/g)).toHaveLength(1);
  expect(await vault.exists(KICKOFF)).toBe(true);
  expect(await vault.exists(BROKEN)).toBe(true);
});

test('the "After a meeting" preset: its apply and model shown, written with its prompt (#179)', async ({
  page,
}) => {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.write('.atlas/types/meeting.md', shipped('.atlas/types/meeting.md'));
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await page.getByRole('button', { name: 'Automations', exact: true }).click();
  const screen = page.getByRole('article', { name: 'Automations' });

  await page.getByRole('button', { name: 'After a meeting' }).click();
  const editor = screen.getByRole('region', { name: 'Automation' });
  await expect(editor.getByRole('combobox', { name: 'What becomes a task' })).toHaveValue('mine');
  const model = editor.getByRole('textbox', { name: 'Model' });
  await expect(model).toHaveAttribute('placeholder', 'claude-sonnet-5-5');
  await model.fill('claude-opus-5-5');
  await editor.getByRole('button', { name: 'Create automation' }).click();

  const rule = '.atlas/automations/After a meeting.md';
  await expectFile(vault, rule).toContain('which: FROM meeting WHERE date >= @-14d\n');
  await expectFile(vault, rule).toContain('\napply: mine\nmodel: claude-opus-5-5\n');
  await expectFile(vault, '.atlas/prompts/after-a-meeting.md').toContain('## Who owns an item');
});

test('both meeting presets on: every meeting read twice is said, and the extraction turned off only on a click (#793)', async ({
  page,
}) => {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.write('.atlas/types/meeting.md', shipped('.atlas/types/meeting.md'));
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await page.getByRole('button', { name: 'Automations', exact: true }).click();
  const screen = page.getByRole('article', { name: 'Automations' });
  const extraction = 'Pull actions and decisions out of a new meeting';
  const warning = screen.getByRole('note', { name: 'Every meeting is read twice' });

  for (const preset of ['After a meeting', extraction]) {
    await page.getByRole('button', { name: preset, exact: true }).click();
    await screen
      .getByRole('region', { name: 'Automation' })
      .getByRole('button', { name: 'Create automation' })
      .click();
    await expect(screen.getByRole('list', { name: 'All automations' })).toContainText(preset);
  }

  await expect(warning).toContainText('Every meeting is read twice');
  const rule = `.atlas/automations/${extraction}.md`;
  await expectFile(vault, rule).toContain('\nenabled: true\n');
  await warning.getByRole('button', { name: `Turn off “${extraction}”` }).click();

  await expectFile(vault, rule).toContain('\nenabled: false\n');
  await expectFile(vault, '.atlas/automations/After a meeting.md').toContain('\nenabled: true\n');
  await expect(warning).toHaveCount(0);
});

test('the "Friday review" preset: weekly at 15:00, a note in Reviews from the weekly review (#40)', async ({
  page,
}) => {
  const vault = await createVault();
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await page.getByRole('button', { name: 'Automations', exact: true }).click();
  const screen = page.getByRole('article', { name: 'Automations' });

  await page.getByRole('button', { name: 'Friday review' }).click();
  const editor = screen.getByRole('region', { name: 'Automation' });
  await expect(editor.getByRole('radio', { name: 'Weekly' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(editor.getByRole('combobox', { name: 'Day of the week' })).toHaveValue('friday');
  await expect(editor.getByRole('textbox', { name: 'Folder' })).toHaveValue('Reviews');
  await expect(editor.getByRole('combobox', { name: 'What DFAI hands Claude' })).toHaveValue(
    'weekly-review',
  );
  await editor.getByRole('button', { name: 'Create automation' }).click();

  const rule = '.atlas/automations/Friday review.md';
  await expectFile(vault, rule).toContain('\nwhen: fridays at 15:00\n');
  await expectFile(vault, rule).toContain('\noutput: note\nfolder: Reviews\n');
  await expectFile(vault, rule).toContain('\ndata: weekly-review\n');
  await expectFile(vault, '.atlas/prompts/friday-review.md').toContain('## What the draft holds');
  // Listed with its schedule in words, and its next run on a Friday.
  const list = screen.getByRole('list', { name: 'All automations' });
  await expect(list.getByText(/Every Friday at 15:00/)).toBeVisible();
});
