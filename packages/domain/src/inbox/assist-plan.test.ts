import { describe, expect, it } from 'vitest';
import { createVaultPath, type VaultPath } from '../vault/vault-path.ts';
import type { AssistItemAnswer } from './assist-answer.ts';
import { ASSIST_ACTION_FLOOR, ASSIST_GUESS_FLOOR, assistSureness } from './assist-confidence.ts';
import {
  ASSIST_ITEMS_PER_ASK,
  ASSIST_QUIET_MS,
  assistBatch,
  assistListedSkip,
  assistPlan,
  assistQuietSkip,
  type AssistFacts,
} from './assist-plan.ts';
import { inboxItem } from './inbox.ts';

/**
 * #900: the domain, never the model, turns an item and Claude's answer into
 * one planned action or one question.
 */

const PAYROLL = {
  path: createVaultPath('Projects/Larkspur Payroll.md'),
  title: 'Larkspur Payroll',
};
const HIRING = { path: createVaultPath('Areas/Hiring.md'), title: 'Hiring' };
const MARA = { path: createVaultPath('People/Mara Quill.md'), title: 'Mara Quill' };
const FACTS: AssistFacts = {
  today: '2026-11-17',
  filingTargets: [PAYROLL, HIRING],
  people: [MARA],
};

const note = (path = 'Inbox/Call Mara Quill.md', row: Record<string, unknown> = {}) =>
  inboxItem({ path: createVaultPath(path), title: 'Call Mara Quill', type: null, ...row });
const task = () => note('Inbox/Call Mara Quill.md', { type: 'task', status: 'inbox' });

const answer = (extra: Partial<AssistItemAnswer> = {}): AssistItemAnswer => ({
  item: createVaultPath('Inbox/Call Mara Quill.md'),
  kind: 'task',
  projects: [],
  due: null,
  waitingOn: null,
  confidence: 'high',
  why: 'It asks for a call.',
  ...extra,
});
const stepOf = (extra: Partial<AssistItemAnswer>, item = note()) =>
  assistPlan(item, answer(extra), FACTS).step;

describe('the floors', () => {
  it('acts only at high; medium asks with a guess; low asks blind', () => {
    expect(ASSIST_ACTION_FLOOR).toBe('high');
    expect(ASSIST_GUESS_FLOOR).toBe('medium');
    expect(assistSureness('high')).toBe('act');
    expect(assistSureness('medium')).toBe('ask-with-guess');
    expect(assistSureness('low')).toBe('ask-blind');
  });

  it('makes a sure task an action, and the same task at medium or low a question', () => {
    expect(stepOf({ projects: ['Projects/Larkspur Payroll.md'] })).toEqual({
      kind: 'task',
      makeTask: true,
      project: PAYROLL,
      due: null,
      waitingOn: null,
    });
    expect(stepOf({ confidence: 'medium' })).toEqual({
      kind: 'ask',
      question: 'Claude thinks this is a task, but is not sure.',
    });
    expect(stepOf({ confidence: 'low' })).toEqual({
      kind: 'ask',
      question: 'Claude could not tell what this is.',
    });
  });

  it('never plans a note below the floor either', () => {
    const step = stepOf({ kind: 'note', projects: ['Areas/Hiring.md'], confidence: 'medium' });
    expect(step).toEqual({
      kind: 'ask',
      question: 'Claude thinks this is a note, but is not sure.',
    });
  });
});

describe('every class', () => {
  it('task: makes a plain note a task, with its project, due and the person it waits on', () => {
    const step = stepOf({
      projects: ['Larkspur Payroll'],
      due: '2026-11-20',
      waitingOn: 'People/Mara Quill.md',
    });
    expect(step).toEqual({
      kind: 'task',
      makeTask: true,
      project: PAYROLL,
      due: '2026-11-20',
      waitingOn: MARA,
    });
  });

  it('task: keeps a task a task, and leaves one with nothing clear to add', () => {
    expect(stepOf({ due: '2026-11-17' }, task())).toMatchObject({
      kind: 'task',
      makeTask: false,
      due: '2026-11-17',
    });
    expect(stepOf({}, task())).toEqual({
      kind: 'leave',
      because: 'Already a task, with nothing clear to add.',
    });
  });

  it.each(['note', 'reference'] as const)(
    '%s: files it under its one project, or leaves it',
    (kind) => {
      expect(stepOf({ kind, projects: ['Areas/Hiring.md'] })).toEqual({
        kind: 'file',
        project: HIRING,
      });
      expect(stepOf({ kind })).toEqual({ kind: 'leave', because: 'Nowhere clear to file it.' });
    },
  );

  it('person and meeting: always a question, however sure', () => {
    expect(stepOf({ kind: 'person' })).toEqual({
      kind: 'ask',
      question: 'Claude thinks this is about a person. Add them to People?',
    });
    expect(stepOf({ kind: 'meeting' })).toEqual({
      kind: 'ask',
      question: 'Claude thinks this is a meeting. File it with your meetings?',
    });
  });

  it('junk: always a question, never archived, even with a real project', () => {
    expect(stepOf({ kind: 'junk', projects: ['Areas/Hiring.md'] })).toEqual({
      kind: 'ask',
      question: 'Claude thinks this is junk. Archive it?',
    });
  });

  it('carries the item and Claude’s why on the row', () => {
    const row = assistPlan(note(), answer(), FACTS);
    expect(row).toMatchObject({
      path: 'Inbox/Call Mara Quill.md',
      title: 'Call Mara Quill',
      why: 'It asks for a call.',
    });
  });
});

describe('what the vault holds', () => {
  it('asks when a project is not a real project or area here, however it is spelt', () => {
    for (const name of ['Projects/Made up.md', '../../.ssh/config', 'People/Mara Quill.md']) {
      expect(stepOf({ projects: [name] })).toEqual({
        kind: 'ask',
        question: `Claude named “${name}”, which is not a project or area here.`,
      });
    }
  });

  it('asks which one when two plausible projects are named', () => {
    expect(stepOf({ kind: 'note', projects: ['Projects/Larkspur Payroll.md', 'Hiring'] })).toEqual({
      kind: 'ask',
      question: 'Which one: “Larkspur Payroll” or “Hiring”?',
    });
  });

  it('takes one project named twice as one', () => {
    expect(
      stepOf({ kind: 'note', projects: ['Larkspur Payroll', 'Projects/Larkspur Payroll.md'] }),
    ).toEqual({
      kind: 'file',
      project: PAYROLL,
    });
  });

  it('asks when the person it waits on is not in People', () => {
    expect(stepOf({ waitingOn: 'Tobias Fenn' })).toEqual({
      kind: 'ask',
      question: 'Claude says it waits on “Tobias Fenn”, who is not in People.',
    });
  });

  it('asks when the due date has passed, and takes today', () => {
    expect(stepOf({ due: '2026-11-16' })).toEqual({
      kind: 'ask',
      question: 'Claude gave a due date that has passed (2026-11-16).',
    });
    expect(stepOf({ due: '2026-11-17' })).toMatchObject({ kind: 'task', due: '2026-11-17' });
  });
});

describe('what is asked about', () => {
  const at = (path: string, row: Record<string, unknown> = {}) => note(path, row);

  it('skips proposals, briefs, meetings and notes with typing not saved', () => {
    expect(assistListedSkip(at('Inbox/Proposals/Flag the cache.md'), false)).toBe(
      'A proposal: it is answered, not filed.',
    );
    expect(assistListedSkip(at('Inbox/x.md', { type: 'proposal' }), false)).toBe(
      'A proposal: it is answered, not filed.',
    );
    expect(assistListedSkip(at('Inbox/Briefs/2026-11-17/Payroll sync.md'), false)).toBe(
      'A brief: its rule files it.',
    );
    expect(assistListedSkip(at('Inbox/Meetings/Sync.md', { type: 'Meeting' }), false)).toBe(
      'A meeting: “After a meeting” handles it.',
    );
    expect(assistListedSkip(at('Inbox/Meetings/Sync.md', { importDeclared: true }), false)).toBe(
      'A meeting: “After a meeting” handles it.',
    );
    expect(assistListedSkip(at('Inbox/Call.md'), true)).toBe('It has typing not saved yet.');
    expect(assistListedSkip(at('Inbox/Call.md'), false)).toBeNull();
  });

  it('skips a note changed in the last 10 minutes, on a fixed clock', () => {
    const now = Date.UTC(2026, 10, 17, 9, 0, 0);
    expect(ASSIST_QUIET_MS).toBe(600_000);
    expect(assistQuietSkip({ modified: now - ASSIST_QUIET_MS + 1, now })).toBe(
      'Changed in the last 10 minutes.',
    );
    expect(assistQuietSkip({ modified: now - ASSIST_QUIET_MS, now })).toBeNull();
    expect(assistQuietSkip({ modified: now + 60_000, now })).toBe(
      'Changed in the last 10 minutes.',
    );
  });

  it('considers items in order up to the tenth it may ask about, skipped ones among them', () => {
    const items = Array.from({ length: 14 }, (_, n) => at(`Inbox/Item ${n}.md`));
    const unsaved = (path: VaultPath) => path === 'Inbox/Item 2.md';
    const batch = assistBatch(items, unsaved);
    expect(ASSIST_ITEMS_PER_ASK).toBe(10);
    expect(batch.considered).toHaveLength(11);
    expect(batch.considered.filter((each) => each.skip === null)).toHaveLength(10);
    expect(batch.considered[2]!.skip).toBe('It has typing not saved yet.');
    expect(batch.notConsidered).toBe(3);
  });

  it('considers them all when fewer than ten may be asked about', () => {
    const batch = assistBatch([at('Inbox/a.md'), at('Inbox/Proposals/b.md')], () => false);
    expect(batch.considered.map((each) => each.skip)).toEqual([
      null,
      'A proposal: it is answered, not filed.',
    ]);
    expect(batch.notConsidered).toBe(0);
  });
});

describe('never overwriting what the person set (#903)', () => {
  const TOBIAS = { path: createVaultPath('People/Tobias Fenn.md'), title: 'Tobias Fenn' };
  const facts: AssistFacts = { ...FACTS, people: [MARA, TOBIAS] };
  const filed = (row: Record<string, unknown> = {}) =>
    note('Inbox/Call Mara Quill.md', {
      type: 'task',
      status: 'inbox',
      project: PAYROLL.path,
      due: '2026-12-01',
      waitingOn: MARA.path,
      ...row,
    });
  const planned = (extra: Partial<AssistItemAnswer>, item = filed()) =>
    assistPlan(item, answer(extra), facts).step;

  it('asks, showing both, when the project differs', () => {
    expect(planned({ projects: ['Areas/Hiring.md'] })).toEqual({
      kind: 'ask',
      question: 'You filed this under Larkspur Payroll; Claude suggests Hiring.',
    });
  });

  it('asks, showing both, when the due differs', () => {
    expect(planned({ due: '2026-11-18' })).toEqual({
      kind: 'ask',
      question: 'You set it due 2026-12-01; Claude suggests 2026-11-18.',
    });
  });

  it('asks, showing both, when the person it waits on differs, linked or written', () => {
    expect(planned({ waitingOn: 'People/Tobias Fenn.md' })).toEqual({
      kind: 'ask',
      question: 'It waits on Mara Quill; Claude suggests Tobias Fenn.',
    });
    const written = filed({ waitingOn: null, waitingOnNames: 'Mara Quill' });
    expect(planned({ waitingOn: 'Tobias Fenn' }, written)).toEqual({
      kind: 'ask',
      question: 'It waits on Mara Quill; Claude suggests Tobias Fenn.',
    });
    expect(planned({ waitingOn: 'Mara Quill' }, written)).toEqual({
      kind: 'leave',
      because: 'Already a task, with nothing clear to add.',
    });
  });

  it('asks when a task is called a note or reference, rather than file it as one', () => {
    expect(planned({ kind: 'note', projects: ['Areas/Hiring.md'] })).toEqual({
      kind: 'ask',
      question: 'You made this a task; Claude thinks it is a note.',
    });
    expect(planned({ kind: 'reference' })).toEqual({
      kind: 'ask',
      question: 'You made this a task; Claude thinks it is reference.',
    });
  });

  it('leaves it when every suggestion agrees with what is set', () => {
    expect(
      planned({ projects: ['Larkspur Payroll'], due: '2026-12-01', waitingOn: 'Mara Quill' }),
    ).toEqual({ kind: 'leave', because: 'Already a task, with nothing clear to add.' });
  });

  it('fills in only what is missing, and plans nothing for what is set', () => {
    const bare = filed({ project: null, due: null, waitingOn: null });
    expect(
      planned({ projects: ['Areas/Hiring.md'], due: '2026-11-20', waitingOn: 'Mara Quill' }, bare),
    ).toEqual({
      kind: 'task',
      makeTask: false,
      project: HIRING,
      due: '2026-11-20',
      waitingOn: MARA,
    });
    const noDue = filed({ due: null });
    expect(planned({ projects: ['Larkspur Payroll'], due: '2026-11-20' }, noDue)).toEqual({
      kind: 'task',
      makeTask: false,
      project: null,
      due: '2026-11-20',
      waitingOn: null,
    });
  });
});

describe('the due horizon (#903)', () => {
  it('plans a due up to two years ahead, and asks about one further', () => {
    expect(stepOf({ due: '2028-11-17' })).toMatchObject({ kind: 'task', due: '2028-11-17' });
    for (const due of ['2028-11-18', '3026-11-17', '9999-12-31']) {
      expect(stepOf({ due })).toEqual({
        kind: 'ask',
        question: `Claude gave a due date more than two years away (${due}).`,
      });
    }
  });
});
