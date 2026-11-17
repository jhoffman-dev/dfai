import { describe, expect, it } from 'vitest';
import { NOTE_RUNS_PER_HOUR, noteRunsHold, type NoteRunsHold } from './automation-due.ts';
import {
  claudeStepBudget,
  DECLARED_STEP_ASKS_PER_HOUR,
  DECLARED_STEP_MODEL,
} from './claude-step-budget.ts';
import { noteRunsHoldIsFailing, noteRunsHoldMessage } from './note-runs-hold.ts';
import type { LogEntry } from './run-log.ts';

const NOW = '2026-10-14T12:00:00';
const DECLARED = claudeStepBudget({
  kind: 'claude',
  prompt: '.atlas/prompts/after-a-meeting.md',
  tools: [],
  output: { kind: 'proposals', schema: 'meeting-digest' },
  apply: 'mine',
});

/** One run, `minutesAgo` before NOW, that asked Claude `asks` times. */
const asked = (minutesAgo: number, asks: number): LogEntry => ({
  kind: 'run',
  at: `2026-10-14T11:${String(60 - minutesAgo).padStart(2, '0')}:00`,
  trigger: 'note',
  done: [],
  left: [],
  capped: false,
  claude: { model: DECLARED_STEP_MODEL, ms: 10, asks },
});

/** A run that failed before asking: it spends one of the rule's own runs. */
const failed = (minutesAgo: number, problem = 'The index could not be read.'): LogEntry => ({
  kind: 'failed',
  at: `2026-10-14T11:${String(60 - minutesAgo).padStart(2, '0')}:00`,
  trigger: 'note',
  problem,
});

/** A run that changed a note: it spends one of the rule's own runs, and did not fail. */
const changed = (minutesAgo: number): LogEntry => ({
  kind: 'run',
  at: `2026-10-14T11:${String(60 - minutesAgo).padStart(2, '0')}:00`,
  trigger: 'note',
  done: [{ kind: 'archived', from: 'A.md' as never, to: 'Archive/A.md' as never }],
  left: [],
  capped: false,
});

const failures = (minutesAgo: number) =>
  Array.from({ length: NOTE_RUNS_PER_HOUR }, () => failed(minutesAgo));

describe('noteRunsHold (#813): why a rule is held, as plain data', () => {
  it('is null while neither limit is spent', () => {
    const hold = noteRunsHold({
      rule: 'After a meeting',
      entries: [asked(50, 10)],
      now: NOW,
      budget: DECLARED,
      sharers: [{ name: 'Board digest', entries: [asked(40, 19)] }],
    });
    expect(hold).toBeNull();
  });

  it('lists every rule that spent the shared asks, which is its own, and whether each is on', () => {
    const hold = noteRunsHold({
      rule: 'After a meeting',
      entries: [asked(50, 18)],
      now: NOW,
      budget: DECLARED,
      sharers: [
        { name: 'Board digest', entries: [asked(40, 12)] },
        { name: 'Quiet rule', entries: [] },
      ],
    });
    expect(hold).toEqual({
      rule: 'After a meeting',
      until: '2026-10-14T12:10:00',
      runs: null,
      sharedAsks: {
        most: DECLARED_STEP_ASKS_PER_HOUR,
        asked: 30,
        by: [
          { name: 'After a meeting', asks: 18, own: true, enabled: true },
          { name: 'Board digest', asks: 12, own: false, enabled: true },
        ],
      },
      failures: null,
    });
  });

  it('keeps a sharer that is off, as off, and one with its own name, as another rule', () => {
    const hold = noteRunsHold({
      rule: 'After a meeting',
      entries: [asked(50, 5)],
      now: NOW,
      budget: DECLARED,
      sharers: [
        { name: 'After a meeting', entries: [asked(40, 15)] },
        { name: 'Board digest', entries: [asked(30, 10)], enabled: false },
      ],
    });
    expect(hold?.sharedAsks?.by).toEqual([
      { name: 'After a meeting', asks: 5, own: true, enabled: true },
      { name: 'After a meeting', asks: 15, own: false, enabled: true },
      { name: 'Board digest', asks: 10, own: false, enabled: false },
    ]);
  });

  it('says its own runs, and how many of them failed and why, when only its runs are spent', () => {
    const entries = [
      ...Array.from({ length: 17 }, () => changed(50)),
      failed(45, 'The index could not be read.'),
      failed(40, 'Claude could not be reached.'),
      failed(42, 'Older.'),
    ];
    const hold = noteRunsHold({ rule: 'Mark new meetings', entries, now: NOW });
    expect(hold).toEqual({
      rule: 'Mark new meetings',
      until: '2026-10-14T12:10:00',
      runs: { most: NOTE_RUNS_PER_HOUR, spent: NOTE_RUNS_PER_HOUR, countsAsks: true },
      sharedAsks: null,
      failures: { failed: 3, ran: 20, latest: 'Claude could not be reached.' },
    });
  });

  it('counts a declared step’s runs apart from its asks', () => {
    const hold = noteRunsHold({
      rule: 'After a meeting',
      entries: [...failures(50), asked(30, 4)],
      now: NOW,
      budget: DECLARED,
    });
    expect(hold?.runs).toEqual({
      most: NOTE_RUNS_PER_HOUR,
      spent: NOTE_RUNS_PER_HOUR,
      countsAsks: false,
    });
    expect(hold?.sharedAsks).toBeNull();
    // Only the runs that spent the limit holding it are counted: the ask spent the other one.
    expect(hold?.failures).toEqual({ failed: 20, ran: 20, latest: 'The index could not be read.' });
  });

  it('says both limits when both are spent, and waits for the later one', () => {
    const hold = noteRunsHold({
      rule: 'After a meeting',
      entries: [...Array.from({ length: NOTE_RUNS_PER_HOUR }, () => changed(50)), asked(20, 20)],
      now: NOW,
      budget: DECLARED,
      sharers: [{ name: 'Board digest', entries: [asked(30, 10)] }],
    });
    expect(hold?.until).toBe('2026-10-14T12:30:00');
    expect(hold?.runs?.spent).toBe(NOTE_RUNS_PER_HOUR);
    expect(hold?.sharedAsks?.asked).toBe(30);
    expect(hold?.failures).toBeNull();
  });
});

describe('noteRunsHoldIsFailing (#813): any failed run that spent the limit makes it failing', () => {
  const base: NoteRunsHold = {
    rule: 'Mark new meetings',
    until: '2026-10-14T12:10:00',
    runs: { most: 20, spent: 20, countsAsks: true },
    sharedAsks: null,
    failures: null,
  };
  it('is waiting with no failures, and failing with one or more', () => {
    expect(noteRunsHoldIsFailing(base)).toBe(false);
    expect(
      noteRunsHoldIsFailing({ ...base, failures: { failed: 1, ran: 20, latest: 'No.' } }),
    ).toBe(true);
    expect(
      noteRunsHoldIsFailing({ ...base, failures: { failed: 20, ran: 20, latest: 'No.' } }),
    ).toBe(true);
  });
});

describe('noteRunsHoldMessage (#813): what a held rule says, in plain words', () => {
  const SHARED: NoteRunsHold = {
    rule: 'After a meeting',
    until: '2026-10-14T14:32:00',
    runs: null,
    sharedAsks: {
      most: 30,
      asked: 30,
      by: [
        { name: 'After a meeting', asks: 18, own: true, enabled: true },
        { name: 'Board digest', asks: 12, own: false, enabled: true },
      ],
    },
    failures: null,
  };
  const ALONE: NoteRunsHold = {
    ...SHARED,
    sharedAsks: {
      most: 30,
      asked: 30,
      by: [{ name: 'After a meeting', asks: 30, own: true, enabled: true }],
    },
  };
  const RUNS: NoteRunsHold = {
    rule: 'Mark new meetings',
    until: '2026-10-14T09:10:00',
    runs: { most: 20, spent: 20, countsAsks: false },
    sharedAsks: null,
    failures: null,
  };

  it('its own asks: not broken, the counts, what an ask is, when it runs, nothing to do', () => {
    expect(noteRunsHoldMessage(ALONE)).toBe(
      'Not broken: it has asked Claude 30 times this hour, and 30 is its most ' +
        '(an ask is one question; a long meeting takes a few). ' +
        'It runs next at 14:32, on what arrived meanwhile; nothing to do.',
    );
  });

  it('shared asks: who spent them, and turning the other off as the one remedy', () => {
    expect(noteRunsHoldMessage(SHARED)).toBe(
      'Not broken: it shares one limit of 30 asks to Claude an hour with “Board digest” ' +
        '(this rule 18, “Board digest” 12; an ask is one question, and a long meeting takes a few). ' +
        'It runs next at 14:32, on what arrived meanwhile. ' +
        'To give it the whole 30, turn off “Board digest”.',
    );
  });

  it('a sharer that is off: counted, said to be off, and never offered to turn off', () => {
    const off: NoteRunsHold = {
      ...SHARED,
      sharedAsks: {
        most: 30,
        asked: 30,
        by: [
          { name: 'After a meeting', asks: 10, own: true, enabled: true },
          { name: 'Board digest', asks: 20, own: false, enabled: false },
        ],
      },
    };
    expect(noteRunsHoldMessage(off)).toBe(
      'Not broken: it shares one limit of 30 asks to Claude an hour with “Board digest” ' +
        '(this rule 10, “Board digest” 20 before it was turned off; ' +
        'an ask is one question, and a long meeting takes a few). ' +
        'It runs next at 14:32, on what arrived meanwhile; nothing to do.',
    );
  });

  it('a sharer with its own name is named as another rule', () => {
    const twin: NoteRunsHold = {
      ...SHARED,
      sharedAsks: {
        most: 30,
        asked: 30,
        by: [
          { name: 'After a meeting', asks: 5, own: true, enabled: true },
          { name: 'After a meeting', asks: 25, own: false, enabled: true },
        ],
      },
    };
    expect(noteRunsHoldMessage(twin)).toBe(
      'Not broken: it shares one limit of 30 asks to Claude an hour with another “After a meeting” ' +
        '(this rule 5, the other “After a meeting” 25; an ask is one question, and a long meeting takes a few). ' +
        'It runs next at 14:32, on what arrived meanwhile. ' +
        'To give it the whole 30, turn off the other “After a meeting”.',
    );
  });

  it('its own runs, and whether its asks count as runs', () => {
    expect(noteRunsHoldMessage(RUNS)).toBe(
      'Not broken: it has run 20 times this hour, and 20 is its most. ' +
        'It runs next at 09:10, on what arrived meanwhile; nothing to do.',
    );
    expect(noteRunsHoldMessage({ ...RUNS, runs: { most: 20, spent: 21, countsAsks: true } })).toBe(
      'Not broken: it has used 21 runs this hour, and 20 is its most ' +
        '(each question it asks Claude counts as a run). ' +
        'It runs next at 09:10, on what arrived meanwhile; nothing to do.',
    );
  });

  it('both limits', () => {
    expect(
      noteRunsHoldMessage({ ...SHARED, runs: { most: 20, spent: 20, countsAsks: false } }),
    ).toBe(
      'Not broken: it has reached two hourly limits. ' +
        'It has run 20 times this hour, and 20 is its most. ' +
        'It shares one limit of 30 asks to Claude an hour with “Board digest” ' +
        '(this rule 18, “Board digest” 12; an ask is one question, and a long meeting takes a few). ' +
        'It runs next at 14:32, on what arrived meanwhile. ' +
        'To give it the whole 30, turn off “Board digest”.',
    );
  });

  it('failing: every run failed — the count, the last reason in its own words, the retry time', () => {
    expect(
      noteRunsHoldMessage({
        ...RUNS,
        failures: { failed: 20, ran: 20, latest: 'Claude could not be reached.' },
      }),
    ).toBe(
      'It failed all 20 times it ran this hour. The last time: Claude could not be reached. ' +
        'It has used up its hourly limit, so it tries again at 09:10.',
    );
  });

  it('failing: some runs failed — both numbers', () => {
    expect(
      noteRunsHoldMessage({
        ...RUNS,
        failures: { failed: 3, ran: 20, latest: 'The index could not be read' },
      }),
    ).toBe(
      'It failed 3 of the 20 times it ran this hour. The last time: The index could not be read. ' +
        'It has used up its hourly limit, so it tries again at 09:10.',
    );
  });

  it('failing with both limits used up', () => {
    expect(
      noteRunsHoldMessage({
        ...SHARED,
        runs: { most: 20, spent: 20, countsAsks: false },
        failures: { failed: 1, ran: 21, latest: 'No.' },
      }),
    ).toBe(
      'It failed 1 of the 21 times it ran this hour. The last time: No. ' +
        'It has used up two hourly limits, so it tries again at 14:32.',
    );
  });

  it('says the minute it can run, never the minute before the hold ends', () => {
    expect(noteRunsHoldMessage({ ...RUNS, until: '2026-10-14T12:15:30' })).toContain(
      'It runs next at 12:16,',
    );
    expect(noteRunsHoldMessage({ ...RUNS, until: '2026-10-14T23:59:01' })).toContain(
      'It runs next at 00:00,',
    );
  });
});
