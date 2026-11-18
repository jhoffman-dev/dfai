import { describe, expect, it } from 'vitest';
import {
  ASSIST_TITLED_QUERY_MARK,
  createVaultPath,
  inboxItem,
  ASSIST_TASKS_QUERY_MARK,
  type InboxItem,
} from '@dfai/domain';
import { fakeModel, type ScriptedRound } from '../testing/fake-model.ts';
import { fakeIndexPort, fakeMarkdown, fakeVaultFs } from '../testing/fake-ports.ts';
import { previewInboxAssist, type InboxAssistPorts } from './preview-inbox-assist.ts';

/**
 * #906: on the press, Suggest reads the open tasks and the people's
 * addresses, lists each item's possible duplicates for Claude, and plans a
 * duplicate or a person only where the rules and Claude agree. It writes
 * nothing, and opening the Inbox reads none of it.
 */

const NOW = Date.UTC(2026, 10, 17, 9, 0, 0);
const RENEW_ITEM = inboxItem({
  path: createVaultPath('Inbox/Renew Larkspur Payroll contract.md'),
  title: 'Renew Larkspur Payroll contract',
  type: null,
});
const LUNCH_ITEM = inboxItem({
  path: createVaultPath('Inbox/Lunch with Tobias Fenn.md'),
  title: 'Lunch with Tobias Fenn',
  type: null,
});
const RENEW_TASK = 'Tasks/Renew the Larkspur Payroll contract.md';
const MARA = 'People/Mara Quill.md';
const TEXTS: Record<string, string> = {
  [RENEW_ITEM.path]: 'Renew it before December.\n',
  [LUNCH_ITEM.path]: 'Lunch with Tobias Fenn <tobias@example.org> and Mara Quill.\n',
};

const entry = (item: InboxItem, extra: Record<string, unknown> = {}) => ({
  item: item.path,
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
const answer = (...entries: unknown[]): ScriptedRound => [
  { type: 'text', text: JSON.stringify({ items: entries }) },
];

const OFF_LIST =
  'Claude suggested a task or person that isn’t in your vault. Check this one by hand.';

const table = (columns: string[], rows: unknown[][]) => ({ columns, rows, truncated: false });

function setUp(round: ScriptedRound, { titled = [] as string[] } = {}) {
  const model = fakeModel([round]);
  const queries: string[] = [];
  const ports: InboxAssistPorts = {
    recordAsk: () => undefined,
    provider: () => ({ ...model, status: async () => ({ ready: true }) }),
    deadline: () => new AbortController().signal,
    clock: { now: () => NOW, today: () => '2026-11-17', localNow: () => '2026-11-17T09:00:00' },
    fs: fakeVaultFs({
      readNotes: async (paths) =>
        paths.map((path) => ({
          path,
          text: TEXTS[path] ?? '',
          modified: NOW - 3_600_000,
          size: 1,
        })),
    }),
    markdown: fakeMarkdown(),
    index: fakeIndexPort({
      notesOfType: async (type) => (type === 'person' ? [{ path: MARA, title: 'Mara Quill' }] : []),
      query: async (sql) => {
        queries.push(sql.slice(0, 80));
        if (sql.includes(ASSIST_TASKS_QUERY_MARK)) {
          return table(
            ['path', 'title', 'status', 'project'],
            [
              [RENEW_TASK, 'Renew the Larkspur Payroll contract', 'next-action', null],
              ['Tasks/Done.md', 'Renew Larkspur Payroll contract', 'archive', null],
            ],
          );
        }
        if (sql.includes(ASSIST_TITLED_QUERY_MARK)) {
          return table(
            ['title'],
            titled.map((title) => [title]),
          );
        }
        if (sql.includes('meeting links: directory')) {
          return table(
            ['path', 'title', 'type', 'key', 'value'],
            [[MARA, 'Mara Quill', 'person', 'email', 'mara.quill@example.com']],
          );
        }
        return table([], []);
      },
    }) as InboxAssistPorts['index'],
    unsaved: () => false,
  };
  return { ports, model, queries };
}

const preview = async (round: ScriptedRound, options: { titled?: string[] } = {}) => {
  const set = setUp(round, options);
  const outcome = await previewInboxAssist(set.ports, {
    items: [RENEW_ITEM, LUNCH_ITEM],
    previewed: [],
  });
  if (outcome.kind !== 'plan') throw new Error(`no plan: ${outcome.message}`);
  return { ...set, outcome };
};

describe('previewInboxAssist: duplicates and people (#906)', () => {
  it('hands Claude each item’s possible duplicates, never a finished task', async () => {
    const { model } = await preview(answer(entry(RENEW_ITEM), entry(LUNCH_ITEM)));
    const system = model.requests[0]!.system;
    expect(system).toContain('<vault_data about="Possible duplicates">');
    expect(system).toContain(`- for ${RENEW_ITEM.path}: ${RENEW_TASK}`);
    expect(system).not.toContain('Tasks/Done.md');
    expect(system).toContain(`- ${MARA}`);
  });

  it('plans the duplicate, the link and the new person where the rules and Claude agree', async () => {
    const { outcome } = await preview(
      answer(
        entry(RENEW_ITEM, { duplicateOf: RENEW_TASK }),
        entry(LUNCH_ITEM, {
          people: [
            { name: 'Tobias Fenn', email: 'tobias@example.org', person: null },
            { name: 'Mara Quill', email: null, person: MARA },
          ],
        }),
      ),
    );
    expect(outcome.rows.map((row) => row.step.kind)).toEqual(['duplicate', 'task']);
    expect(outcome.rows[0]!.step).toMatchObject({
      of: { title: 'Renew the Larkspur Payroll contract' },
    });
    expect(outcome.rows[1]!.people).toEqual([
      { kind: 'add', name: 'Tobias Fenn', email: 'tobias@example.org' },
      { kind: 'link', person: { path: MARA, title: 'Mara Quill' } },
    ]);
    expect(outcome.summary).toBe(
      '2 items: would act on 1, link 1 person, add 1 person, 1 duplicate',
    );
  });

  it('asks where they disagree: Claude says none of a same title; a near person', async () => {
    const { outcome } = await preview(
      answer(
        entry(RENEW_ITEM),
        entry(LUNCH_ITEM, { people: [{ name: 'Mara', email: null, person: null }] }),
      ),
    );
    expect(outcome.rows.map((row) => row.step)).toEqual([
      { kind: 'ask', question: 'Is this the same as Renew the Larkspur Payroll contract?' },
      { kind: 'ask', question: 'Is this Mara Quill?' },
    ]);
    expect(outcome.summary).toBe('2 items: 2 questions');
  });

  it('makes a pick outside the shortlist that item’s question, and plans the other', async () => {
    const { outcome } = await preview(
      answer(
        entry(RENEW_ITEM, { duplicateOf: '../../secret.md' }),
        entry(LUNCH_ITEM, {
          people: [{ name: 'Mara Quill', email: null, person: 'People/Wren.md' }],
        }),
      ),
    );
    expect(outcome.rows.map((row) => row.step)).toEqual([
      { kind: 'ask', question: OFF_LIST },
      { kind: 'ask', question: OFF_LIST },
    ]);
  });

  it('plans the filing alone when Claude names nobody and the rule found no same title', async () => {
    const { outcome } = await preview(
      answer(entry(RENEW_ITEM, { duplicateOf: null }), entry(LUNCH_ITEM)),
    );
    expect(outcome.rows[1]).toMatchObject({ step: { kind: 'task' }, people: [] });
  });

  it('reads the tasks and the people’s addresses in one statement each, and no titles with no one to add', async () => {
    const { queries } = await preview(answer(entry(RENEW_ITEM), entry(LUNCH_ITEM)));
    expect(queries.filter((sql) => sql.includes(ASSIST_TASKS_QUERY_MARK))).toHaveLength(1);
    expect(queries.filter((sql) => sql.includes('meeting links: directory'))).toHaveLength(1);
    expect(queries.filter((sql) => sql.includes(ASSIST_TITLED_QUERY_MARK))).toHaveLength(0);
  });

  it('reads once whether a new person’s name is a note’s title already, and asks if it is', async () => {
    const tobias = { name: 'Tobias Fenn', email: 'tobias@example.org', person: null };
    const { queries, outcome } = await preview(
      answer(entry(RENEW_ITEM), entry(LUNCH_ITEM, { people: [tobias] })),
      { titled: ['Tobias Fenn'] },
    );
    expect(queries.filter((sql) => sql.includes(ASSIST_TITLED_QUERY_MARK))).toHaveLength(1);
    expect(outcome.rows[1]!.step).toEqual({
      kind: 'ask',
      question: 'A note is called Tobias Fenn already. Is this them?',
    });
  });
});
