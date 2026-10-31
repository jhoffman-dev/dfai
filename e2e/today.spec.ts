import { utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from './fixtures.ts';
import {
  createVault,
  emitVaultChanged,
  expectFile,
  installHost,
  type FakeHost,
  type FakeVault,
} from './host.ts';
import { toastSaying } from './toasts.ts';

/**
 * #111: the Today page. On a fixed clock, a vault's tasks land in exactly the
 * sections they belong to, with their counts; a tick, a defer and a move each
 * change the page without a reload; and Waiting needs nobody to wait on (#202).
 */

/** 2026-10-13, midday where the test runs. */
const NOW = new Date(2026, 9, 13, 12, 0, 0);
const DAY = 86_400_000;

const note = (frontmatter: string[], body: string) =>
  ['---', ...frontmatter, '---', '', body, ''].join('\n');
const task = (frontmatter: string[]) => note(['type: task', ...frontmatter], 'A task.');

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
  '  contexts:',
  '    kind: multi-select',
  '  completed: date',
  '  defer: date',
  '  due: date',
  '---',
  '',
  '# Task',
  '',
].join('\n');

const PROJECT_TYPE = [
  '---',
  'name: project',
  'label: Project',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [planned, active, paused, done]',
  '    done: done',
  '---',
  '',
  '# Project',
  '',
].join('\n');

/** Each note, and how many days before now it last changed. */
const NOTES: Record<string, { text: string; daysAgo: number }> = {
  'People/Mara Quill.md': { text: note(['type: person'], 'At Larkspur Payroll.'), daysAgo: 1 },
  'Projects/DFAI.md': { text: note(['type: project', 'status: active'], 'The app.'), daysAgo: 1 },
  'Projects/Garden.md': {
    text: note(['type: project', 'status: active'], 'Beds and seeds.'),
    daysAgo: 1,
  },
  'Projects/Shed.md': { text: note(['type: project', 'status: active'], 'Later.'), daysAgo: 1 },
  'Tasks/Renew the licence.md': {
    text: task(['status: backlog', 'due: 2026-10-10']),
    daysAgo: 1,
  },
  'Tasks/Send the figures.md': {
    text: task(['status: next-action', 'due: 2026-10-13', 'project: "[[DFAI]]"']),
    daysAgo: 1,
  },
  'Tasks/Book the venue.md': {
    text: task(['status: someday', 'defer: 2026-10-13']),
    daysAgo: 1,
  },
  'Tasks/Clear the shed.md': {
    text: task(['status: backlog', 'defer: 2026-10-09']),
    daysAgo: 6,
  },
  'Tasks/Draft the plan.md': {
    text: task(['status: in-progress', 'project: "[[DFAI]]"']),
    daysAgo: 1,
  },
  'Tasks/Ship the page.md': {
    text: task(['status: next-action', 'project: "[[DFAI]]"', 'contexts: ["@desk"]']),
    daysAgo: 1,
  },
  'Tasks/Sow the beans.md': {
    text: task(['status: next-action', 'project: "[[Garden]]"']),
    daysAgo: 1,
  },
  'Tasks/Call the bank.md': { text: task(['status: next-action']), daysAgo: 1 },
  'Tasks/Not until Friday.md': {
    text: task(['status: next-action', 'defer: 2026-10-16']),
    daysAgo: 1,
  },
  'Tasks/Quote from Larkspur.md': {
    text: task(['status: waiting', 'waiting_on: "[[Mara Quill]]"']),
    daysAgo: 4,
  },
  'Tasks/Done long ago.md': {
    text: task(['status: archive', 'due: 2026-10-13']),
    daysAgo: 30,
  },
  'Inbox/Idea.md': { text: note(['type: task', 'status: inbox'], 'Card.'), daysAgo: 0 },
};

async function openTodayVault(page: Page, options?: { echoWrites: boolean }): Promise<FakeVault> {
  return (await openTodayVaultOn(page, options)).vault;
}

async function openTodayVaultOn(
  page: Page,
  { echoWrites }: { echoWrites: boolean } = { echoWrites: false },
): Promise<{ vault: FakeVault; host: FakeHost }> {
  const vault = await createVault();
  for (const folder of ['.atlas/types', 'People', 'Projects', 'Tasks', 'Inbox']) {
    await vault.mkdir(folder);
  }
  await vault.write('.atlas/types/task.md', GTD_TASK_TYPE);
  await vault.write('.atlas/types/project.md', PROJECT_TYPE);
  await vault.write('.atlas/types/person.md', '---\nname: person\nlabel: Person\n---\n');
  for (const [path, { text, daysAgo }] of Object.entries(NOTES)) {
    await vault.write(path, text);
    const when = new Date(NOW.getTime() - daysAgo * DAY);
    await utimes(join(vault.root, path), when, when);
  }
  const host = await installHost(page, vault, { echoWrites });
  await page.clock.setFixedTime(NOW);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return { vault, host };
}

const today = (page: Page) => page.getByRole('article', { name: 'Today' });
const section = (page: Page, name: string) =>
  today(page).getByRole('region', { name, exact: true });
const itemsIn = (page: Page, name: string) => section(page, name).locator('.table__title');
const countOf = (page: Page, name: string) =>
  section(page, name).locator('.review__heading .review__count');

async function openToday(page: Page) {
  await page.getByRole('list', { name: 'Go to' }).getByRole('button', { name: 'Today' }).click();
  await expect(today(page)).toBeVisible();
}

test('Today puts each task in its section, with counts, with no view named Today', async ({
  page,
}) => {
  await openTodayVault(page);
  await openToday(page);

  await expect(itemsIn(page, 'Overdue')).toHaveText(['Renew the licence']);
  await expect(itemsIn(page, 'Due today')).toHaveText(['Send the figures']);
  // Put off until today, and put off until a day that passed unseen.
  await expect(itemsIn(page, 'Back from deferral')).toHaveText([
    'Book the venue',
    'Clear the shed',
  ]);
  await expect(itemsIn(page, 'In progress')).toHaveText(['Draft the plan']);
  await expect(itemsIn(page, 'Next actions')).toHaveText([
    'Ship the page',
    'Sow the beans',
    'Call the bank',
  ]);
  await expect(itemsIn(page, 'Waiting')).toHaveText(['Quote from Larkspur']);
  for (const [name, count] of [
    ['Overdue', '1'],
    ['Due today', '1'],
    ['Back from deferral', '2'],
    ['In progress', '1'],
    ['Next actions', '3'],
    ['Waiting', '1'],
  ] as const) {
    await expect(countOf(page, name)).toHaveText(count);
  }

  const next = section(page, 'Next actions');
  await expect(next.getByRole('group').locator('.today__group-name')).toContainText([
    'DFAI',
    'Garden',
    'No project',
  ]);
  await expect(next.getByRole('group', { name: 'DFAI' })).toContainText('@desk');
  const waiting = section(page, 'Waiting');
  await expect(waiting.getByRole('group', { name: 'Mara Quill' })).toContainText(
    '4 days since last change',
  );
  await expect(waiting).toContainText('counted from each task’s last change');

  const elsewhere = today(page).getByRole('navigation', { name: 'Elsewhere' });
  await expect(elsewhere.getByRole('button', { name: /^Inbox 1/ })).toBeVisible();
  // DFAI and Garden have something next or under way; Shed has neither.
  await expect(elsewhere.getByRole('button', { name: /^Stalled projects 1/ })).toBeVisible();
});

test('ticking a task finishes it and takes it off the page, and Undo brings it back', async ({
  page,
}) => {
  const vault = await openTodayVault(page);
  await openToday(page);
  await expect(itemsIn(page, 'In progress')).toHaveText(['Draft the plan']);

  // A click, not `check()`: the box is never left ticked — the row leaves instead.
  await section(page, 'In progress')
    .getByRole('checkbox', { name: 'Mark Draft the plan done' })
    .click();

  await expect(section(page, 'In progress').getByText('Nothing is under way.')).toBeVisible();
  await expect(countOf(page, 'In progress')).toHaveText('0');
  await expectFile(vault, 'Tasks/Draft the plan.md').toContain('status: archive');
  await expectFile(vault, 'Tasks/Draft the plan.md').toContain('completed: 2026-10-13');

  await toastSaying(page, 'Finished “Draft the plan”.')
    .getByRole('button', { name: 'Undo' })
    .click();

  await expect(itemsIn(page, 'In progress')).toHaveText(['Draft the plan']);
  await expectFile(vault, 'Tasks/Draft the plan.md').toContain('status: in-progress');
  await expectFile(vault, 'Tasks/Draft the plan.md').not.toContain('completed');
});

test('deferring a task a day takes it off the page until tomorrow', async ({ page }) => {
  const vault = await openTodayVault(page);
  await openToday(page);
  await expect(itemsIn(page, 'Overdue')).toHaveText(['Renew the licence']);

  await section(page, 'Overdue')
    .getByRole('button', { name: 'Defer Renew the licence 1 day' })
    .click();

  await expect(section(page, 'Overdue').getByText('Nothing is late.')).toBeVisible();
  await expectFile(vault, 'Tasks/Renew the licence.md').toContain('defer: 2026-10-14');
  // Focus follows the work: the row that was under it.
  await expect(
    today(page).getByRole('checkbox', { name: 'Mark Send the figures done' }),
  ).toBeFocused();
});

test('moving a task to Waiting asks for nobody, and moves it (#202)', async ({ page }) => {
  const vault = await openTodayVault(page);
  await openToday(page);
  const next = section(page, 'Next actions');

  await next.getByRole('button', { name: 'Move Call the bank to…' }).click();
  await page.getByRole('menu', { name: 'Move Call the bank to' }).getByText('Waiting').click();

  await expectFile(vault, 'Tasks/Call the bank.md').toContain('status: waiting');
  expect(await vault.read('Tasks/Call the bank.md')).not.toContain('waiting_on');
  await expect(itemsIn(page, 'Next actions')).toHaveText(['Ship the page', 'Sow the beans']);
  await expect(itemsIn(page, 'Waiting')).toContainText(['Call the bank']);
  await expect(today(page).getByRole('alert')).toHaveCount(0);
});

test('a saved view titled Today does not make a second sidebar row', async ({ page }) => {
  const vault = await createVault();
  for (const folder of ['.atlas/types', '.atlas/views', 'Tasks']) await vault.mkdir(folder);
  await vault.write('.atlas/types/task.md', GTD_TASK_TYPE);
  await vault.write('Tasks/Call the bank.md', task(['status: next-action']));
  await vault.write('.atlas/views/Today.md', note(['atlas: view', 'type: task'], ''));
  await installHost(page, vault);
  await page.clock.setFixedTime(NOW);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();

  const rows = page.getByRole('list', { name: 'Go to' }).getByRole('button', { name: 'Today' });
  await expect(rows).toHaveCount(1);
  await rows.click();
  await expect(today(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open the “Today” view' })).toBeVisible();
});

test('⌘K opens Today', async ({ page }) => {
  await openTodayVault(page);
  await page.keyboard.down('ControlOrMeta');
  await page.keyboard.press('k');
  await page.keyboard.up('ControlOrMeta');
  const palette = page.getByRole('dialog', { name: 'Search notes' });
  await page.getByRole('searchbox', { name: 'Search the vault' }).fill('Today');
  await palette.getByRole('option', { name: 'Today', exact: true }).click();
  await expect(today(page)).toBeVisible();
});

/** Another program adds a note, and the watcher tells; resolves once the index holds it. */
async function addFromOutside(page: Page, vault: FakeVault, name: string) {
  const status = page.getByText(/^\d+ notes indexed/);
  const indexed = Number(/^(\d+)/.exec((await status.textContent()) ?? '')?.[1]);
  await vault.write(`Inbox/${name}.md`, note(['type: task', 'status: inbox'], name));
  await emitVaultChanged(page, [`Inbox/${name}.md`]);
  await expect(page.getByText(new RegExp(`^${indexed + 1} notes indexed`))).toBeVisible();
}

/**
 * Ticks a task, then has another program add a note, and counts the index's
 * walks of the vault in between. The added note's refresh is the last asked,
 * so once the index holds it every refresh before it has run.
 */
async function walksForATick(page: Page, { echoWrites }: { echoWrites: boolean }) {
  const { vault, host } = await openTodayVaultOn(page, { echoWrites });
  await openToday(page);
  // The app writes the Block type into a GTD vault as it opens (P31-01), and
  // the first new note sets off more than any after it: both before counting.
  await expectFile(vault, '.atlas/types/block.md').toContain('block');
  if (echoWrites) await expect.poll(() => host.echoesSent()).toBeGreaterThan(0);
  await addFromOutside(page, vault, 'Warm up');
  const before = host.callsTo('list_notes');
  const echoesBefore = await host.echoesSent();
  await section(page, 'In progress')
    .getByRole('checkbox', { name: 'Mark Draft the plan done' })
    .click();
  await expectFile(vault, 'Tasks/Draft the plan.md').toContain('status: archive');
  // With the echo on, the watcher's report of the tick has been sent before the outside note.
  if (echoWrites) await expect.poll(() => host.echoesSent()).toBeGreaterThan(echoesBefore);
  await addFromOutside(page, vault, 'From outside');
  return host.callsTo('list_notes') - before;
}

test('the watcher’s echo of a tick is not refreshed for again, and a change from outside still is (#254)', async ({
  browser,
}) => {
  const [quiet, echoing] = await Promise.all([browser.newPage(), browser.newPage()]);
  try {
    const withoutEcho = await walksForATick(quiet, { echoWrites: false });
    const withEcho = await walksForATick(echoing, { echoWrites: true });
    // The outside note was refreshed for either way, or the status would not have moved.
    expect(withoutEcho).toBeGreaterThan(0);
    // The app refreshed for its tick; the report of it costs nothing more.
    expect(withEcho).toBe(withoutEcho);
  } finally {
    await Promise.all([quiet.close(), echoing.close()]);
  }
});

test('a tick takes the row off the page before its write lands (#260)', async ({ page }) => {
  const { vault, host } = await openTodayVaultOn(page);
  await openToday(page);
  await expect(itemsIn(page, 'In progress')).toHaveText(['Draft the plan']);
  const release = host.holdWrites('Tasks/Draft the plan.md');

  await section(page, 'In progress')
    .getByRole('checkbox', { name: 'Mark Draft the plan done' })
    .click();

  // Gone while the file still says it is under way: the page did not wait for the write.
  await expect(section(page, 'In progress').getByText('Nothing is under way.')).toBeVisible();
  await expect(countOf(page, 'In progress')).toHaveText('0');
  expect(await vault.read('Tasks/Draft the plan.md')).toContain('status: in-progress');

  // The write has reached the host and is held there, not still on its way.
  await expect.poll(() => host.writesTo('Tasks/Draft the plan.md')).toBeGreaterThan(0);
  release();
  await expectFile(vault, 'Tasks/Draft the plan.md').toContain('status: archive');
  await expect(
    toastSaying(page, 'Finished “Draft the plan”.').getByRole('button', { name: 'Undo' }),
  ).toBeVisible();
  await expect(section(page, 'In progress').getByText('Nothing is under way.')).toBeVisible();
});

test('a move draws the row in its new section before its write lands (#260)', async ({ page }) => {
  const { vault, host } = await openTodayVaultOn(page);
  await openToday(page);
  const release = host.holdWrites('Tasks/Call the bank.md');

  await section(page, 'Next actions')
    .getByRole('button', { name: 'Move Call the bank to…' })
    .click();
  await page
    .getByRole('menu', { name: 'Move Call the bank to' })
    .getByText('In Progress', { exact: true })
    .click();

  await expect(itemsIn(page, 'In progress')).toHaveText(['Call the bank', 'Draft the plan']);
  await expect(itemsIn(page, 'Next actions')).toHaveText(['Ship the page', 'Sow the beans']);
  expect(await vault.read('Tasks/Call the bank.md')).toContain('status: next-action');

  // The write has reached the host and is held there, not still on its way.
  await expect.poll(() => host.writesTo('Tasks/Call the bank.md')).toBeGreaterThan(0);
  release();
  await expectFile(vault, 'Tasks/Call the bank.md').toContain('status: in-progress');
  await expect(itemsIn(page, 'In progress')).toHaveText(['Call the bank', 'Draft the plan']);
});

test('a tick whose write fails puts the row back, saying why (#260)', async ({ page }) => {
  const { vault, host } = await openTodayVaultOn(page);
  await openToday(page);
  const release = host.holdWrites('Tasks/Draft the plan.md');

  await section(page, 'In progress')
    .getByRole('checkbox', { name: 'Mark Draft the plan done' })
    .click();
  await expect(section(page, 'In progress').getByText('Nothing is under way.')).toBeVisible();

  // The write has reached the host and is held there, not still on its way.
  await expect.poll(() => host.writesTo('Tasks/Draft the plan.md')).toBeGreaterThan(0);
  release({ fail: 'The disk is full.' });

  await expect(itemsIn(page, 'In progress')).toHaveText(['Draft the plan']);
  await expect(today(page).getByText(/The disk is full/)).toBeVisible();
  await expect(
    section(page, 'In progress').getByRole('checkbox', { name: 'Mark Draft the plan done' }),
  ).toBeEnabled();
  expect(await vault.read('Tasks/Draft the plan.md')).toContain('status: in-progress');
});
