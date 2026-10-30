import { describe, expect, it } from 'vitest';
import type { TodaySectionId } from '@dfai/domain';
import { fakeIndexPort, fakeMarkdown, fakeVaultFs } from '../testing/fake-ports.ts';
import { jsonLinesNote, proposalVault } from '../testing/proposal-vault.ts';
import { atlasQueryIndex } from '../testing/query-index.ts';
import { listInbox } from '../inbox/list-inbox.ts';
import { readWeeklyReview } from '../review/read-weekly-review.ts';
import { readToday, type TodayReport } from './read-today.ts';

/** A vault with nothing proposed: no Inbox/Proposals folder to read. */
const NO_PROPOSALS = { fs: fakeVaultFs(), markdown: fakeMarkdown() };

/** #111: the Today page read from a vault's index, on a fixed clock. */
const NOW = Date.UTC(2026, 9, 13, 15);
const DAY = 86_400_000;
const CLOCK = { today: () => '2026-10-13', now: () => NOW };

const note = (frontmatter: readonly string[]) => ['---', ...frontmatter, '---', ''].join('\n');
const task = (...frontmatter: string[]) => note(['type: task', ...frontmatter]);

const FILES = {
  'Projects/DFAI.md': note(['type: project', 'status: active']),
  'Projects/Garden.md': note(['type: project', 'status: active']),
  'Projects/Shed.md': note(['type: project', 'status: active']),
  'People/Mara Quill.md': note(['type: person']),
  'Tasks/Renew the licence.md': task('status: backlog', 'due: 2026-10-10'),
  'Tasks/Send the figures.md': task('status: next-action', 'due: 2026-10-13'),
  'Tasks/Book the venue.md': task('status: someday', 'defer: 2026-10-13'),
  'Tasks/Draft the plan.md': task('status: in-progress', 'project: "[[DFAI]]"'),
  'Tasks/Ship the page.md': task('status: next-action', 'project: "[[DFAI]]"', 'contexts: desk'),
  'Tasks/Sow the beans.md': task('status: next-action', 'project: "[[Garden]]"'),
  'Tasks/Call the bank.md': task('status: next-action'),
  'Tasks/Not yet.md': task('status: next-action', 'defer: 2026-10-14'),
  'Tasks/Quote from Larkspur.md': task('status: waiting', 'waiting_on: [[Mara Quill]]'),
  'Tasks/Done.md': task('status: archive', 'due: 2026-10-13'),
  'Inbox/Idea.md': 'A thought.\n',
};

const MODIFIED = { 'Tasks/Quote from Larkspur.md': NOW - 4 * DAY - 1000 };

const read = (clock = CLOCK) =>
  readToday({
    index: fakeIndexPort({
      query: atlasQueryIndex({ markdown: fakeMarkdown(), files: FILES, modified: MODIFIED }),
    }),
    ...NO_PROPOSALS,
    clock,
  });

const sectionOf = (report: TodayReport, id: TodaySectionId) => {
  const found = report.sections.find((section) => section.id === id);
  if (found === undefined) throw new Error(`no section ${id}`);
  return found;
};
const titles = (report: TodayReport, id: TodaySectionId) =>
  sectionOf(report, id).groups.flatMap((group) => group.tasks.map((item) => item.title));

describe('readToday', () => {
  it('puts each of the vault’s tasks in its section, on the clock’s day', async () => {
    const report = await read();

    expect(report.today).toBe('2026-10-13');
    expect(titles(report, 'overdue')).toEqual(['Renew the licence']);
    expect(titles(report, 'dueToday')).toEqual(['Send the figures']);
    expect(titles(report, 'backToday')).toEqual(['Book the venue']);
    expect(titles(report, 'inProgress')).toEqual(['Draft the plan']);
    expect(titles(report, 'waiting')).toEqual(['Quote from Larkspur']);
    expect(report.sections.map((section) => section.count)).toEqual([0, 0, 1, 1, 1, 1, 3, 1]);
    expect(report.truncated).toBe(false);
  });

  it('groups next actions under their projects’ titles, and carries contexts', async () => {
    const next = sectionOf(await read(), 'nextActions');
    expect(
      next.groups.map((group) => [group.label, group.tasks.map((item) => item.title)]),
    ).toEqual([
      ['DFAI', ['Ship the page']],
      ['Garden', ['Sow the beans']],
      [null, ['Call the bank']],
    ]);
    expect(next.groups[0]?.project).toBe('Projects/DFAI.md');
    expect(next.groups[0]?.tasks[0]?.contexts).toEqual(['desk']);
  });

  it('says who a task waits on, and for how many days by its file’s last change', async () => {
    const [group] = sectionOf(await read(), 'waiting').groups;
    expect(group?.label).toBe('Mara Quill');
    expect(group?.tasks[0]?.waitingDays).toBe(4);
  });

  it('counts the Inbox as the sidebar does, and the stalled projects as the review does', async () => {
    const proposed = proposalVault({
      'Inbox/Proposals/Send the file.md': jsonLinesNote({
        type: 'proposal',
        kind: 'task',
        state: 'open',
        payload: { title: 'Send Mara the file' },
      }),
    });
    const report = await readToday({
      index: fakeIndexPort({
        query: atlasQueryIndex({ markdown: fakeMarkdown(), files: FILES, modified: MODIFIED }),
      }),
      fs: proposed.ports.fs,
      markdown: proposed.ports.markdown,
      clock: CLOCK,
    });
    expect(report.inbox).toEqual({ count: 2, toFile: 1, toAnswer: 1, more: false });
    // DFAI and Garden have a next action or work under way; Shed has neither.
    expect(report.stalledProjects).toBe(1);
  });

  it('turns over with the clock: tomorrow the deferred task is back and today’s is late', async () => {
    const tomorrow = { today: () => '2026-10-14', now: () => NOW + DAY };
    const report = await read(tomorrow);
    expect(titles(report, 'overdue')).toEqual(['Renew the licence', 'Send the figures']);
    // Back today, and the Someday task whose day passed with nothing else to list it.
    expect(titles(report, 'backToday')).toEqual(['Not yet', 'Book the venue']);
    expect(titles(report, 'dueToday')).toEqual([]);
  });

  it('reads every task in one statement, whatever the sections', async () => {
    const statements: string[] = [];
    const query = atlasQueryIndex({ markdown: fakeMarkdown(), files: FILES });
    await readToday({
      index: fakeIndexPort({
        query: (sql, parameters) => {
          statements.push(sql);
          return query(sql, parameters);
        },
      }),
      ...NO_PROPOSALS,
      clock: CLOCK,
    });
    expect(statements.filter((sql) => sql.includes('weekly review: tasks'))).toHaveLength(1);
  });

  it('says when the index held tasks back', async () => {
    const query = atlasQueryIndex({ markdown: fakeMarkdown(), files: FILES });
    const heldBack = fakeIndexPort({
      query: async (sql, parameters) => ({
        ...(await query(sql, parameters)),
        truncated: sql.includes('weekly review: tasks'),
      }),
    });
    expect((await readToday({ index: heldBack, ...NO_PROPOSALS, clock: CLOCK })).truncated).toBe(
      true,
    );
  });

  it('passes on what the index could not answer', async () => {
    const failing = fakeIndexPort({
      query: () => Promise.reject(new Error('the index is closed')),
    });
    await expect(readToday({ index: failing, ...NO_PROPOSALS, clock: CLOCK })).rejects.toThrow(
      'the index is closed',
    );
  });
});

/** #112: one Inbox — the Today page's Inbox link counts what the Inbox page lists. */
describe('readToday — the Inbox count is the Inbox page’s', () => {
  const files = {
    'Inbox/Captured.md': task('status: inbox'),
    'Inbox/Decided.md': task('status: next-action'),
    'Inbox/Idea.md': 'A thought.\n',
    'Tasks/Imported.md': task('status: inbox'),
    'Tasks/No status.md': task(),
    'Tasks/Nor this one.md': task(),
    'Tasks/Moving.md': task('status: in-progress'),
  };
  const index = () =>
    fakeIndexPort({ query: atlasQueryIndex({ markdown: fakeMarkdown(), files }) });

  it.each([
    ['tasks start in the Inbox', true, 5],
    ['the vault is on statuses of its own', false, 4],
  ])('counts what the page lists, as the weekly review does: %s', async (_name, rule, listed) => {
    const page = await listInbox({ index: index(), tasksStartInInbox: rule });
    const reads = { index: index(), ...NO_PROPOSALS, clock: CLOCK, tasksStartInInbox: rule };
    const today = await readToday(reads);
    const review = await readWeeklyReview(reads);

    expect(page.items).toHaveLength(listed);
    expect(today.inbox.toFile).toBe(page.items.length);
    expect(review.inbox.toFile).toBe(page.items.length);
  });

  it('lists different notes, and a different number of them, under the two rules', async () => {
    const paths = async (rule: boolean) =>
      (await listInbox({ index: index(), tasksStartInInbox: rule })).items
        .map((item) => item.path as string)
        .sort();
    expect(await paths(true)).toEqual([
      'Inbox/Captured.md',
      'Inbox/Idea.md',
      'Tasks/Imported.md',
      'Tasks/No status.md',
      'Tasks/Nor this one.md',
    ]);
    expect(await paths(false)).toEqual([
      'Inbox/Captured.md',
      'Inbox/Decided.md',
      'Inbox/Idea.md',
      'Tasks/Imported.md',
    ]);
  });
});

describe('readToday, choosing for today (#108 fix round)', () => {
  const FILES_CHOSEN = { 'Tasks/Paint.md': task('status: next-action', 'focus: 2026-10-13') };
  const index = () =>
    fakeIndexPort({ query: atlasQueryIndex({ markdown: fakeMarkdown(), files: FILES_CHOSEN }) });

  it('chooses in a vault with no Task type of its own, as the built-in type does', async () => {
    const report = await readToday({ index: index(), ...NO_PROPOSALS, clock: CLOCK });
    expect(report.choosing).toBe(true);
    expect(titles(report, 'chosen')).toEqual(['Paint']);
  });

  it('lists nothing as chosen when the caller says the vault does not choose', async () => {
    const report = await readToday({
      index: index(),
      ...NO_PROPOSALS,
      clock: CLOCK,
      choosing: false,
    });
    expect(report.choosing).toBe(false);
    expect(titles(report, 'chosen')).toEqual([]);
    expect(titles(report, 'nextActions')).toEqual(['Paint']);
  });
});
