import { describe, expect, it } from 'vitest';
import {
  createVaultPath,
  planAutomation,
  AUTOMATION_PRESETS,
  type AutomationRule,
  type LogEntry,
} from '@dfai/domain';
import { automationRows, dryRunView, logViews, shownTime } from './automation-rows.ts';

const p = createVaultPath;
const CLOCK = {
  watchingSince: '2026-09-27T09:00:00',
  now: '2026-09-27T09:00:00',
  pauses: new Map(),
};

const RULE: AutomationRule = {
  id: 'Tidy',
  path: p('.atlas/automations/Tidy.md'),
  name: 'Tidy',
  enabled: true,
  when: { kind: 'daily', at: '03:00' },
  which: 'FROM task',
  olderThanDays: 30,
  action: { kind: 'archive' },
};

const RUN: LogEntry = {
  kind: 'run',
  at: '2026-09-27T03:00:05',
  trigger: 'schedule',
  done: [{ kind: 'archived', from: p('Tasks/Old.md'), to: p('Archive/Tasks/Old.md') }],
  left: [{ path: p('Tasks/Busy.md'), reason: 'It is open in DFAI with unsaved typing.' }],
  capped: false,
};

describe('shownTime', () => {
  it('writes a wall-clock time as the page shows it', () => {
    expect(shownTime('2026-09-07T03:00:05')).toBe('7 Sep 2026, 03:00');
    expect(shownTime('2026-12-31T23:59:59', { seconds: true })).toBe('31 Dec 2026, 23:59:59');
  });
});

describe('automationRows', () => {
  it('says when a rule last ran and what it did, and when it runs next', () => {
    const [row] = automationRows(
      { automations: [{ rule: RULE, log: [RUN], idWritten: true }], broken: [] },
      CLOCK,
    );
    expect(row).toEqual({
      id: RULE.path,
      name: 'Tidy',
      enabled: true,
      schedule: 'Every day at 03:00',
      action: 'Archive',
      lastRun: '27 Sep 2026, 03:00 · Archived 1 note. Left 1 alone.',
      nextRun: '28 Sep 2026, 03:00',
      canUndo: true,
      problem: null,
      notice: null,
    });
  });

  it('lists a never-run rule, and a broken one with why', () => {
    const rows = automationRows(
      {
        automations: [{ rule: { ...RULE, enabled: false }, log: [], idWritten: true }],
        broken: [
          { path: p('.atlas/automations/Bad.md'), name: 'Bad', problem: 'Say when it runs.' },
        ],
      },
      CLOCK,
    );
    expect(
      rows.map((row) => [row.name, row.lastRun, row.nextRun, row.canUndo, row.problem]),
    ).toEqual([
      ['Tidy', null, null, false, null],
      ['Bad', null, null, false, 'This rule’s file cannot be read: Say when it runs.'],
    ]);
  });
});

describe('automationRows on the calendar’s clock (#587)', () => {
  const BRIEF: AutomationRule = {
    ...AUTOMATION_PRESETS.find((each) => each.name === 'Morning brief')!,
    id: 'Morning brief',
    path: p('.atlas/automations/Morning brief.md'),
  };
  const listing = {
    automations: [
      { rule: BRIEF, log: [], idWritten: true },
      { rule: RULE, log: [RUN], idWritten: true },
    ],
    broken: [],
  };
  // 09:00 on the Mac; 02:00 on the calendar's clock, before its 07:00.
  const ON_PLAN = { ...CLOCK, planNow: '2026-09-27T02:00:00', planClock: 'Chicago time' };

  it('says the brief’s next run is on the calendar’s clock, and no other rule’s', () => {
    const [brief, tidy] = automationRows(listing, ON_PLAN);
    expect(brief?.nextRun).toBe('27 Sep 2026, 07:00 Chicago time');
    expect(tidy?.nextRun).toBe('28 Sep 2026, 03:00');
  });

  it('says no clock when the calendar’s is the Mac’s', () => {
    const [brief] = automationRows(listing, { ...ON_PLAN, planClock: null });
    expect(brief?.nextRun).toBe('27 Sep 2026, 07:00');
  });
});

describe('logViews', () => {
  it('lists the log newest first, each thing done and each note left in words', () => {
    const undo: LogEntry = {
      kind: 'undo',
      at: '2026-09-27T09:00:00',
      of: RUN.at,
      done: [
        { kind: 'unarchived', from: p('Archive/Tasks/Old.md'), to: p('Tasks/Old.md') },
        {
          kind: 'restored',
          path: p('Tasks/B.md'),
          key: 'status',
          before: { value: 'done' },
          after: { absent: true },
        },
      ],
      left: [],
    };
    const [first, second] = logViews([RUN, undo]);
    expect(first?.heading).toBe('27 Sep 2026, 09:00:00 · Undid the run of 2026-09-27 03:00:05');
    expect(first?.lines.map((line) => line.text)).toEqual([
      'Put back Old (Tasks/Old.md)',
      'Restored status on B: "done" → nothing',
    ]);
    expect(second?.lines).toEqual([
      { kind: 'done', text: 'Archived Old (Tasks/Old.md)' },
      { kind: 'left', text: 'Left Busy: It is open in DFAI with unsaved typing.' },
    ]);
  });
});

describe('logViews of a Claude step (P29-03)', () => {
  it('names each proposal and note it made, and offers no undo', () => {
    const asked: LogEntry = {
      kind: 'run',
      at: '2026-10-11T09:00:00',
      trigger: 'hand',
      done: [
        { kind: 'proposed', path: createVaultPath('Inbox/Proposals/Send the file.md') },
        { kind: 'created', path: createVaultPath('Briefs/Brief.md') },
      ],
      left: [],
      capped: false,
      claude: { model: 'claude-opus-5-5', ms: 1200 },
    };
    const [view] = logViews([asked]);
    expect(view?.summary).toBe('Made 1 proposal. Made 1 note.');
    expect(view?.lines).toEqual([
      { kind: 'done', text: 'Proposed Send the file (Inbox/Proposals/Send the file.md)' },
      { kind: 'done', text: 'Made Brief (Briefs/Brief.md)' },
    ]);
  });
});

describe('dryRunView', () => {
  it('names each note the plan would take, and each it would leave', () => {
    const plan = planAutomation({
      action: { kind: 'archive' },
      matched: [p('Tasks/A.md'), p('Archive/B.md')],
    });
    expect(dryRunView(plan)).toEqual({
      kind: 'plan',
      summary: 'Would archive 1 note.',
      notes: [{ path: 'Tasks/A.md', title: 'A' }],
      passedOver: [{ title: 'B', reason: 'It is already archived.' }],
    });
  });
});
