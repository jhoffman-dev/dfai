import { describe, expect, it } from 'vitest';
import { createVaultPath } from '../vault/vault-path.ts';
import {
  assistAppliedWords,
  APPLIABLE_ASSIST_KINDS,
  assistApplyKinds,
  assistApplyStep,
  assistNotAppliable,
  assistNotAppliedYet,
  assistStepKeys,
  assistStepPaths,
} from './assist-apply.ts';
import type { AssistRow } from './assist-plan.ts';
import { EVERY_ASSIST_KIND } from '../testing/every-assist-kind.ts';

/** #909: what each planned row comes to when applied, and the fields it must find empty. */

const PATH = createVaultPath('Inbox/Call Mara.md');
const LARKSPUR = {
  path: createVaultPath('Projects/Larkspur Payroll.md'),
  title: 'Larkspur Payroll',
};
const MARA = { path: createVaultPath('People/Mara Quill.md'), title: 'Mara Quill' };
const KEPT = { path: createVaultPath('Tasks/Call Mara.md'), title: 'Call Mara' };

const row = (step: AssistRow['step'], people: AssistRow['people'] = []): AssistRow => ({
  path: PATH,
  title: 'Call Mara',
  step,
  why: null,
  people,
});
const task = (extra: Partial<Extract<AssistRow['step'], { kind: 'task' }>> = {}) =>
  row(
    {
      kind: 'task',
      makeTask: true,
      project: LARKSPUR,
      due: '2026-12-01',
      waitingOn: null,
      ...extra,
    },
    [
      { kind: 'link', person: MARA },
      { kind: 'add', name: 'Tobias Fenn', email: 'tobias@example.org' },
    ],
  );

describe('assistApplyStep', () => {
  it('makes a task of a task row, filling what the plan found empty, and its people', () => {
    expect(assistApplyStep(task())).toEqual({
      path: PATH,
      title: 'Call Mara',
      fill: { makeTask: true, project: LARKSPUR, due: '2026-12-01' },
      links: [MARA],
      adds: [{ name: 'Tobias Fenn', email: 'tobias@example.org' }],
      duplicateOf: null,
    });
  });

  it('files a note row under its project', () => {
    expect(assistApplyStep(row({ kind: 'file', project: LARKSPUR }))).toMatchObject({
      fill: { makeTask: false, project: LARKSPUR, due: null },
      duplicateOf: null,
    });
  });

  it('archives a duplicate row and fills nothing', () => {
    const step = assistApplyStep(row({ kind: 'duplicate', of: KEPT, newerHolds: [] }));
    expect(step).toMatchObject({ fill: null, links: [], adds: [], duplicateOf: KEPT });
  });

  it('applies no question, no item left, and no task that waits on someone', () => {
    const rows = [
      row({ kind: 'ask', question: 'Which one?' }),
      row({ kind: 'leave', because: 'Nowhere clear to file it.' }),
      task({ waitingOn: MARA }),
    ];
    for (const each of rows) {
      expect(assistApplyStep(each)).toBeNull();
      expect(assistNotAppliable(each)).not.toBeNull();
    }
    expect(assistNotAppliable(task())).toBeNull();
  });
});

describe('assistStepKeys', () => {
  it('names every key a task row writes', () => {
    expect(assistStepKeys(assistApplyStep(task())!)).toEqual([
      'type',
      'status',
      'project',
      'due',
      'people',
    ]);
  });

  it('names only what is filled', () => {
    const plain = task({ makeTask: false, project: null });
    const step = { ...assistApplyStep(plain)!, links: [], adds: [] };
    expect(assistStepKeys(step)).toEqual(['due']);
  });

  it('names the duplicate stamp for a duplicate', () => {
    const step = assistApplyStep(row({ kind: 'duplicate', of: KEPT, newerHolds: [] }))!;
    expect(assistStepKeys(step)).toEqual(['atlas_duplicate_of']);
  });
});

describe('assistStepPaths', () => {
  it('names the item, its project, its people and the kept task', () => {
    expect(assistStepPaths(assistApplyStep(task())!)).toEqual([PATH, LARKSPUR.path, MARA.path]);
    const duplicate = assistApplyStep(row({ kind: 'duplicate', of: KEPT, newerHolds: [] }))!;
    expect(assistStepPaths(duplicate)).toEqual([PATH, KEPT.path]);
  });
});

describe('assistAppliedWords', () => {
  it('says what a task row did', () => {
    expect(assistAppliedWords(assistApplyStep(task())!)).toBe(
      'Made it a task under Larkspur Payroll, due 2026-12-01. Linked Mara Quill. Added Tobias Fenn.',
    );
  });

  it('says what a filing, a due date alone and a duplicate did', () => {
    expect(assistAppliedWords(assistApplyStep(row({ kind: 'file', project: LARKSPUR }))!)).toBe(
      'Filed it under Larkspur Payroll.',
    );
    const due = assistApplyStep(
      row({ kind: 'task', makeTask: false, project: null, due: '2026-12-01', waitingOn: null }),
    )!;
    expect(assistAppliedWords(due)).toBe('Set it due 2026-12-01.');
    expect(
      assistAppliedWords(assistApplyStep(row({ kind: 'duplicate', of: KEPT, newerHolds: [] }))!),
    ).toBe('Archived as a duplicate of Call Mara.');
  });
});

describe('which kinds Apply writes now (#911 round 4, #925)', () => {
  const kinds = (each: AssistRow) => assistApplyKinds(assistApplyStep(each)!);

  it('names what each row does: in place, or a move', () => {
    expect(kinds(task())).toEqual(['task', 'due', 'file', 'link-person', 'add-person']);
    expect(kinds(task({ project: null, due: null }))).toEqual([
      'task',
      'link-person',
      'add-person',
    ]);
    expect(kinds(row({ kind: 'file', project: LARKSPUR }))).toEqual(['file']);
    expect(kinds(row({ kind: 'duplicate', of: KEPT, newerHolds: [] }))).toEqual(['duplicate']);
  });

  it('applies the in-place kinds, and shows a row that moves the note without Apply, saying why', () => {
    expect([...APPLIABLE_ASSIST_KINDS].sort()).toEqual([
      'add-person',
      'due',
      'link-person',
      'task',
    ]);
    // An Inbox task that stays where it is.
    expect(assistNotAppliedYet(assistApplyStep(task({ project: null }))!)).toBeNull();
    // One that would be filed under its project, a note filed, a duplicate archived: preview only.
    expect(assistNotAppliedYet(assistApplyStep(task())!)).toBe(
      'Filing is not applied automatically yet.',
    );
    expect(assistNotAppliedYet(assistApplyStep(row({ kind: 'file', project: LARKSPUR }))!)).toBe(
      'Filing is not applied automatically yet.',
    );
    expect(
      assistNotAppliedYet(assistApplyStep(row({ kind: 'duplicate', of: KEPT, newerHolds: [] }))!),
    ).toBe('Archiving a duplicate is not applied automatically yet.');
  });

  it('applies every kind when handed them all', () => {
    for (const each of [
      task(),
      row({ kind: 'file', project: LARKSPUR }),
      row({ kind: 'duplicate', of: KEPT, newerHolds: [] }),
    ]) {
      expect(assistNotAppliedYet(assistApplyStep(each)!, EVERY_ASSIST_KIND)).toBeNull();
    }
  });
});
