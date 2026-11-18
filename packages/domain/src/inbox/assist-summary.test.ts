import { describe, expect, it } from 'vitest';
import { createVaultPath } from '../vault/vault-path.ts';
import { localTimeMs } from '../automations/schedule.ts';
import { assistAllowance, assistAllowanceWords } from './assist-allowance.ts';
import type { AssistRow, AssistStep } from './assist-plan.ts';
import {
  assistMoreWords,
  assistPeopleWords,
  assistReason,
  assistStepWords,
  assistSummary,
  assistTone,
} from './assist-summary.ts';

/** #900: the sentence at the top of a plan, each row's words, and the allowance's. */

const PAYROLL = {
  path: createVaultPath('Projects/Larkspur Payroll.md'),
  title: 'Larkspur Payroll',
};
const MARA = { path: createVaultPath('People/Mara Quill.md'), title: 'Mara Quill' };
const TASK: AssistStep = {
  kind: 'task',
  makeTask: true,
  project: PAYROLL,
  due: null,
  waitingOn: null,
};
const FILE: AssistStep = { kind: 'file', project: PAYROLL };
const ASK: AssistStep = { kind: 'ask', question: 'Which one: “Larkspur Payroll” or “Hiring”?' };
const LEAVE: AssistStep = { kind: 'leave', because: 'Changed in the last 10 minutes.' };

const row = (step: AssistStep, why: string | null = 'It asks for a call.'): AssistRow => ({
  path: createVaultPath('Inbox/Call Mara Quill.md'),
  title: 'Call Mara Quill',
  step,
  why,
  people: [],
});
const rows = (...steps: AssistStep[]) => steps.map((step) => row(step));

describe('assistSummary', () => {
  it('says the epic’s example exactly', () => {
    const plan = rows(
      ...Array<AssistStep>(5).fill(TASK),
      ...Array<AssistStep>(4).fill(FILE),
      ASK,
      ASK,
      LEAVE,
      LEAVE,
      LEAVE,
    );
    expect(assistSummary(plan)).toBe('14 items: would act on 9, 2 questions, would leave 3');
  });

  it('says none plainly', () => {
    expect(assistSummary([])).toBe('Nothing to suggest: no items to look at.');
  });

  it('says one in the singular, and leaves out parts with none', () => {
    expect(assistSummary(rows(TASK))).toBe('1 item: would act on 1');
    expect(assistSummary(rows(ASK))).toBe('1 item: 1 question');
    expect(assistSummary(rows(LEAVE))).toBe('1 item: would leave 1');
    expect(assistSummary(rows(ASK, LEAVE))).toBe('2 items: 1 question, would leave 1');
  });
});

describe('a row’s words', () => {
  it('says what would be done', () => {
    expect(assistStepWords(TASK)).toBe('Make it a task under Larkspur Payroll');
    expect(
      assistStepWords({
        kind: 'task',
        makeTask: false,
        project: null,
        due: '2026-11-20',
        waitingOn: MARA,
      }),
    ).toBe('Keep it a task, due 2026-11-20, waiting on Mara Quill');
    expect(assistStepWords(FILE)).toBe('File under Larkspur Payroll');
    expect(assistStepWords(ASK)).toBe('Ask you');
    expect(assistStepWords(LEAVE)).toBe('Leave it');
  });

  it('gives the question, why it is left, or Claude’s why as the reason', () => {
    expect(assistReason(row(ASK))).toBe('Which one: “Larkspur Payroll” or “Hiring”?');
    expect(assistReason(row(LEAVE))).toBe('Changed in the last 10 minutes.');
    expect(assistReason(row(TASK))).toBe('It asks for a call.');
    expect(assistReason(row(TASK, null))).toBe('');
  });

  it('tones each step', () => {
    expect([TASK, FILE, ASK, LEAVE].map(assistTone)).toEqual(['file', 'file', 'ask', 'leave']);
  });
});

describe('the items not looked at', () => {
  it('says none, one and many', () => {
    expect(assistMoreWords(0)).toBeNull();
    expect(assistMoreWords(1)).toBe('1 more item was not looked at: one ask looks at 10.');
    expect(assistMoreWords(3)).toBe('3 more items were not looked at: one ask looks at 10.');
  });
});

describe('the ask allowance', () => {
  const now = localTimeMs('2026-11-17T14:00:00')!;
  const minutesAgo = (minutes: number) => now - minutes * 60_000;

  it('lets an ask through while the hour has asks left, counting the logged and the previewed together', () => {
    const logged = Array.from({ length: 20 }, (_, n) => minutesAgo(50 - n));
    const previewed = Array.from({ length: 9 }, (_, n) => minutesAgo(10 - n));
    expect(assistAllowance({ logged, previewed, now })).toEqual({ ok: true });
  });

  it('refuses the thirty-first, until the oldest of the last thirty is an hour old', () => {
    const logged = Array.from({ length: 20 }, (_, n) => minutesAgo(50 - n));
    const previewed = Array.from({ length: 10 }, (_, n) => minutesAgo(10 - n));
    const held = assistAllowance({ logged, previewed, now });
    expect(held).toEqual({ ok: false, until: '2026-11-17T14:10:00' });
  });

  it('counts nothing older than an hour', () => {
    const logged = Array.from({ length: 40 }, () => minutesAgo(61));
    expect(assistAllowance({ logged, previewed: [], now })).toEqual({ ok: true });
  });

  it('says so as a held rule does: not broken, when, nothing to do', () => {
    expect(assistAllowanceWords('2026-11-17T14:10:00')).toBe(
      'Not broken: Claude has been asked 30 or more times this hour, counting “After a meeting”, and Suggest stops at 30. It can ask again at 14:10; nothing to do.',
    );
  });
});

describe('the ask allowance when the clock goes back (#903)', () => {
  it('counts an ask recorded later than now as made now', () => {
    const now = localTimeMs('2026-11-01T01:09:00')!;
    const later = Array.from({ length: 30 }, () => localTimeMs('2026-11-01T01:30:00')!);
    expect(assistAllowance({ logged: [], previewed: later, now })).toEqual({
      ok: false,
      until: '2026-11-01T02:09:00',
    });
  });
});

describe('duplicates and people in the sentence and the rows (#906)', () => {
  const RENEW = {
    path: createVaultPath('Tasks/Renew.md'),
    title: 'Renew Larkspur Payroll contract',
  };
  const DUPLICATE: AssistStep = { kind: 'duplicate', of: RENEW, newerHolds: [] };
  const LINK = { kind: 'link', person: MARA } as const;
  const ADD = { kind: 'add', name: 'Tobias Fenn', email: 'tobias@example.org' } as const;
  const withPeople = (step: AssistStep, people: AssistRow['people']): AssistRow => ({
    ...row(step),
    people,
  });

  it('counts people linked and added, and duplicates, in the issue’s order', () => {
    const plan = [
      withPeople(TASK, [LINK, ADD]),
      withPeople(TASK, [LINK]),
      withPeople(FILE, [LINK]),
      ...rows(TASK, TASK, TASK, DUPLICATE, ASK, ASK),
    ];
    expect(assistSummary(plan)).toBe(
      '9 items: would act on 6, link 3 people, add 1 person, 1 duplicate, 2 questions',
    );
  });

  it('says one person, two people added and two duplicates, and leaves out parts with none', () => {
    expect(assistSummary([withPeople(TASK, [LINK])])).toBe('1 item: would act on 1, link 1 person');
    expect(assistSummary([withPeople(TASK, [ADD, { ...ADD, name: 'Wren Calloway' }])])).toBe(
      '1 item: would act on 1, add 2 people',
    );
    expect(assistSummary(rows(DUPLICATE, DUPLICATE, LEAVE))).toBe(
      '3 items: 2 duplicates, would leave 1',
    );
  });

  it('says a duplicate, and each person, in a line of its own', () => {
    expect(assistStepWords(DUPLICATE)).toBe(
      'Looks like a duplicate of Renew Larkspur Payroll contract',
    );
    expect(assistTone(DUPLICATE)).toBe('duplicate');
    expect(assistStepWords({ ...DUPLICATE, newerHolds: ['notes'] })).toBe(
      'Looks like a duplicate of Renew Larkspur Payroll contract; this copy also has notes',
    );
    expect(assistStepWords({ ...DUPLICATE, newerHolds: ['due', 'people', 'notes'] })).toBe(
      'Looks like a duplicate of Renew Larkspur Payroll contract; this copy also has a due date, people and notes',
    );
    expect(assistPeopleWords(withPeople(TASK, [LINK, ADD]))).toEqual([
      'Links Mara Quill',
      'Would add Tobias Fenn',
    ]);
    expect(assistPeopleWords(row(TASK))).toEqual([]);
  });
});
