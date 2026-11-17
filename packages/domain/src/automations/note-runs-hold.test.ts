import { describe, expect, it } from 'vitest';
import { NOTE_RUNS_PER_HOUR, noteRunsHold, type NoteRunsHold } from './automation-due.ts';
import {
  claudeStepBudget,
  DECLARED_STEP_ASKS_PER_HOUR,
  DECLARED_STEP_MODEL,
} from './claude-step-budget.ts';
import { noteRunsHoldMessage } from './note-runs-hold.ts';
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
const failed = (minutesAgo: number): LogEntry => ({
  kind: 'failed',
  at: `2026-10-14T11:${String(60 - minutesAgo).padStart(2, '0')}:00`,
  trigger: 'note',
  problem: 'The index could not be read.',
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

  it('names every rule that spent the shared asks, with how many, when two used them up', () => {
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
          { name: 'After a meeting', asks: 18 },
          { name: 'Board digest', asks: 12 },
        ],
      },
    });
  });

  it('says its own runs, and not the shared asks, when only its runs are spent', () => {
    const hold = noteRunsHold({
      rule: 'Mark new meetings',
      entries: failures(50),
      now: NOW,
    });
    expect(hold).toEqual({
      rule: 'Mark new meetings',
      until: '2026-10-14T12:10:00',
      runs: { most: NOTE_RUNS_PER_HOUR, spent: NOTE_RUNS_PER_HOUR, countsAsks: true },
      sharedAsks: null,
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
  });

  it('says both limits when both are spent, and waits for the later one', () => {
    const hold = noteRunsHold({
      rule: 'After a meeting',
      entries: [...failures(50), asked(20, 20)],
      now: NOW,
      budget: DECLARED,
      sharers: [{ name: 'Board digest', entries: [asked(30, 10)] }],
    });
    expect(hold).toEqual({
      rule: 'After a meeting',
      until: '2026-10-14T12:40:00',
      runs: { most: NOTE_RUNS_PER_HOUR, spent: NOTE_RUNS_PER_HOUR, countsAsks: false },
      sharedAsks: {
        most: DECLARED_STEP_ASKS_PER_HOUR,
        asked: 30,
        by: [
          { name: 'After a meeting', asks: 20 },
          { name: 'Board digest', asks: 10 },
        ],
      },
    });
  });
});

describe('noteRunsHoldMessage (#813): what a held rule says, in plain words', () => {
  const SHARED: NoteRunsHold = {
    rule: 'After a meeting',
    until: '2026-10-14T12:10:00',
    runs: null,
    sharedAsks: {
      most: 30,
      asked: 30,
      by: [
        { name: 'After a meeting', asks: 18 },
        { name: 'Board digest', asks: 12 },
      ],
    },
  };
  const ALONE: NoteRunsHold = {
    ...SHARED,
    sharedAsks: { most: 30, asked: 31, by: [{ name: 'After a meeting', asks: 31 }] },
  };
  const RUNS: NoteRunsHold = {
    rule: 'Mark new meetings',
    until: '2026-10-14T12:10:00',
    runs: { most: 20, spent: 20, countsAsks: false },
    sharedAsks: null,
  };

  it('says the shared asks are used up, by which rules, when it runs, and what to do', () => {
    expect(noteRunsHoldMessage(SHARED)).toBe(
      'Waiting, not broken: it has reached an hourly limit. ' +
        'It shares one limit with “Board digest”: together they may ask Claude 30 times an hour. ' +
        'An ask is one question to Claude about one note, or about one part of a long note. ' +
        'In the last hour they asked 30 times: “After a meeting” 18, “Board digest” 12. ' +
        'It runs next at 12:10, on what changed meanwhile. ' +
        'Nothing needs fixing: wait, or turn off “Board digest” to leave the limit to this rule.',
    );
  });

  it('says the asks it spent alone, without naming a rule that shares them', () => {
    expect(noteRunsHoldMessage(ALONE)).toBe(
      'Waiting, not broken: it has reached an hourly limit. ' +
        'It may ask Claude 30 times an hour, and it has asked 31 times in the last hour. ' +
        'An ask is one question to Claude about one note, or about one part of a long note. ' +
        'It runs next at 12:10, on what changed meanwhile. ' +
        'Nothing needs fixing: it catches up by itself.',
    );
  });

  it('says its own runs, and whether its asks count as runs', () => {
    expect(noteRunsHoldMessage(RUNS)).toBe(
      'Waiting, not broken: it has reached an hourly limit. ' +
        'It may run 20 times an hour, and it has run 20 times in the last hour. ' +
        'It runs next at 12:10, on what changed meanwhile. ' +
        'Nothing needs fixing: it catches up by itself.',
    );
    expect(
      noteRunsHoldMessage({ ...RUNS, runs: { most: 20, spent: 21, countsAsks: true } }),
    ).toBe(
      'Waiting, not broken: it has reached an hourly limit. ' +
        'It may run 20 times an hour, each question it asks Claude counted as a run, ' +
        'and it has used 21 in the last hour. ' +
        'It runs next at 12:10, on what changed meanwhile. ' +
        'Nothing needs fixing: it catches up by itself.',
    );
  });

  it('says both limits when both are reached', () => {
    expect(
      noteRunsHoldMessage({ ...SHARED, runs: { most: 20, spent: 20, countsAsks: false } }),
    ).toBe(
      'Waiting, not broken: it has reached two hourly limits. ' +
        'It may run 20 times an hour, and it has run 20 times in the last hour. ' +
        'It shares one limit with “Board digest”: together they may ask Claude 30 times an hour. ' +
        'An ask is one question to Claude about one note, or about one part of a long note. ' +
        'In the last hour they asked 30 times: “After a meeting” 18, “Board digest” 12. ' +
        'It runs next at 12:10, on what changed meanwhile. ' +
        'Nothing needs fixing: wait, or turn off “Board digest” to leave the limit to this rule.',
    );
  });

  it('with both meeting presets on, says the other reads every meeting too and can be turned off', () => {
    const extraction = 'Pull actions and decisions out of a new meeting';
    expect(noteRunsHoldMessage(ALONE, { alsoReading: [extraction] })).toBe(
      'Waiting, not broken: it has reached an hourly limit. ' +
        'It may ask Claude 30 times an hour, and it has asked 31 times in the last hour. ' +
        'An ask is one question to Claude about one note, or about one part of a long note. ' +
        'It runs next at 12:10, on what changed meanwhile. ' +
        'Nothing needs fixing: it catches up by itself. ' +
        `“${extraction}” reads every meeting too, so Claude is asked about each one twice. ` +
        'You can turn it off: this rule already pulls out the action items.',
    );
  });

  it('names a rule once when it both shares the limit and reads every meeting too', () => {
    const message = noteRunsHoldMessage(SHARED, { alsoReading: ['Board digest'] });
    expect(message.match(/turn off “Board digest”/g)).toHaveLength(1);
    expect(message).not.toContain('reads every meeting too');
  });
});
