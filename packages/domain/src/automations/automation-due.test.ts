import { describe, expect, it } from 'vitest';
import { createVaultPath } from '../vault/vault-path.ts';
import {
  dueTrigger,
  nextRunOf,
  NOTE_RUNS_PER_HOUR,
  noteRunsHeldUntil,
  noteRunsHold,
} from './automation-due.ts';
import { noteRunsHoldMessage } from './note-runs-hold.ts';
import type { AutomationRule } from './automation-rule.ts';
import type { LogEntry } from './run-log.ts';

const RULE: AutomationRule = {
  id: 'Tidy',
  path: createVaultPath('.atlas/automations/Tidy.md'),
  name: 'Tidy',
  enabled: true,
  when: { kind: 'daily', at: '03:00' },
  which: 'FROM task',
  olderThanDays: null,
  action: { kind: 'archive' },
};

const ranAt = (at: string): LogEntry => ({
  kind: 'run',
  at,
  trigger: 'schedule',
  done: [],
  left: [],
  capped: false,
});

const WATCHING = '2026-09-27T09:00:00';

describe('dueTrigger', () => {
  it('runs a scheduled rule once its time has come since its last run', () => {
    const log = [ranAt('2026-09-27T03:00:00')];
    const at = (now: string) =>
      dueTrigger({ rule: RULE, log, now, watchingSince: WATCHING, opening: false });
    expect(at('2026-09-28T02:59:00')).toBeNull();
    expect(at('2026-09-28T03:00:00')).toBe('schedule');
  });

  it('catches up a missed run when the vault opens, then not again', () => {
    const missed = [ranAt('2026-09-20T03:00:00')];
    const opened = '2026-09-27T09:00:00';
    expect(
      dueTrigger({ rule: RULE, log: missed, now: opened, watchingSince: opened, opening: true }),
    ).toBe('schedule');
    const caughtUp = [...missed, ranAt(opened)];
    expect(
      dueTrigger({
        rule: RULE,
        log: caughtUp,
        now: '2026-09-27T09:05:00',
        watchingSince: opened,
        opening: false,
      }),
    ).toBeNull();
  });

  it('counts a rule never run from when it was turned on, or else from when DFAI began watching', () => {
    const turnedOn: LogEntry[] = [{ kind: 'turnedOn', at: '2026-09-26T14:00:00' }];
    const now = '2026-09-27T09:00:00';
    expect(dueTrigger({ rule: RULE, log: turnedOn, now, watchingSince: now, opening: true })).toBe(
      'schedule',
    );
    expect(dueTrigger({ rule: RULE, log: [], now, watchingSince: now, opening: true })).toBeNull();
  });

  it('runs an on-opening rule only on opening', () => {
    const rule = { ...RULE, when: { kind: 'open' } } as AutomationRule;
    const clock = { rule, log: [], now: '2026-09-27T12:00:00', watchingSince: WATCHING };
    expect(dueTrigger({ ...clock, opening: true })).toBe('open');
    expect(dueTrigger({ ...clock, opening: false })).toBeNull();
  });

  it('never runs a rule that is off, or one run by hand', () => {
    const long = { log: [], now: '2027-01-01T00:00:00', watchingSince: '2026-01-01T00:00:00' };
    expect(dueTrigger({ rule: { ...RULE, enabled: false }, ...long, opening: true })).toBeNull();
    const manual = { ...RULE, when: { kind: 'manual' } } as AutomationRule;
    expect(dueTrigger({ rule: manual, ...long, opening: true })).toBeNull();
  });
});

describe('a rule a note sets off', () => {
  const NOTE_RULE: AutomationRule = {
    ...RULE,
    when: { kind: 'note', type: 'meeting', on: ['created'] },
    which: 'FROM meeting',
  };
  const NOW = '2026-10-08T12:00:00';
  const ARCHIVED = { kind: 'archived', from: 'A.md', to: 'Archive/A.md' } as never;
  const noteRun = (at: string, kind: 'run' | 'failed' = 'run'): LogEntry =>
    kind === 'run'
      ? { kind, at, trigger: 'note', done: [ARCHIVED], left: [], capped: false }
      : { kind, at, trigger: 'note', problem: 'No.' };
  const minutes = (from: number, count: number) =>
    Array.from({ length: count }, (_, at) =>
      noteRun(`2026-10-08T11:${String(from + at).padStart(2, '0')}:00`),
    );

  it('is never run by the clock, on opening or after any time, and has no next run', () => {
    const long = { log: [], now: '2027-01-01T00:00:00', watchingSince: '2026-01-01T00:00:00' };
    expect(dueTrigger({ rule: NOTE_RULE, ...long, opening: true })).toBeNull();
    expect(dueTrigger({ rule: NOTE_RULE, ...long, opening: false })).toBeNull();
    expect(nextRunOf({ rule: NOTE_RULE, ...long })).toBeNull();
  });

  it('is held, once it has run as often in the last hour as one may, until the hour allows one more', () => {
    expect(noteRunsHeldUntil(minutes(10, NOTE_RUNS_PER_HOUR), NOW)).toBe('2026-10-08T12:10:00');
    expect(noteRunsHeldUntil(minutes(10, NOTE_RUNS_PER_HOUR - 1), NOW)).toBeNull();
    expect(noteRunsHeldUntil(minutes(5, NOTE_RUNS_PER_HOUR + 1), NOW)).toBe('2026-10-08T12:06:00');
  });

  it('counts runs whose query did not read, so a broken rule is held too', () => {
    const failing = Array.from({ length: NOTE_RUNS_PER_HOUR }, () =>
      noteRun('2026-10-08T11:30:00', 'failed'),
    );
    expect(noteRunsHeldUntil(failing, NOW)).toBe('2026-10-08T12:30:00');
  });

  it('counts a run that asked Claude whatever it came back with, on any trigger, and a failed ask', () => {
    const asked = { model: 'claude-test', ms: 900, asks: 1 };
    const nothing = (trigger: 'note' | 'hand' | 'schedule') =>
      ({ ...noteRun('2026-10-08T11:30:00'), trigger, done: [], claude: asked }) as LogEntry;
    const failedAsk = {
      kind: 'failed',
      at: '2026-10-08T11:30:00',
      trigger: 'hand',
      problem: 'The connection dropped.',
      claude: asked,
    } as LogEntry;
    const counted = (entry: LogEntry) =>
      noteRunsHeldUntil(
        Array.from({ length: NOTE_RUNS_PER_HOUR }, () => entry),
        NOW,
      );
    expect(counted(nothing('note'))).toBe('2026-10-08T12:30:00');
    expect(counted(nothing('hand'))).toBe('2026-10-08T12:30:00');
    expect(counted(nothing('schedule'))).toBe('2026-10-08T12:30:00');
    expect(counted(failedAsk)).toBe('2026-10-08T12:30:00');
    // A failure that never asked is another trigger's, and is not this rule's cost.
    expect(counted({ ...failedAsk, claude: undefined } as unknown as LogEntry)).toBeNull();
  });

  it('counts the asks a Claude step made, not its runs: ten asks of one run are ten', () => {
    const run = (asks: number | undefined) =>
      ({
        ...noteRun('2026-10-08T11:30:00'),
        trigger: 'hand',
        done: [],
        claude: { model: 'claude-test', ms: 900, ...(asks !== undefined && { asks }) },
      }) as LogEntry;

    expect(noteRunsHeldUntil([run(10), run(10)], NOW)).toBe('2026-10-08T12:30:00');
    expect(noteRunsHeldUntil([run(10), run(9)], NOW)).toBeNull();
  });

  it('does not count a Claude run that never asked (a prompt that would not read, a provider not ready)', () => {
    const neverAsked = Array.from(
      { length: NOTE_RUNS_PER_HOUR * 2 },
      () =>
        ({
          kind: 'failed',
          at: '2026-10-08T11:30:00',
          trigger: 'note',
          problem: 'Its prompt could not be read.',
          claude: { model: 'claude-test', ms: 3 },
        }) as LogEntry,
    );

    expect(noteRunsHeldUntil(neverAsked, NOW)).toBeNull();
  });

  it('does not count a run that changed nothing', () => {
    const idle = minutes(10, NOTE_RUNS_PER_HOUR).map(
      (entry) => ({ ...entry, done: [] }) as LogEntry,
    );
    expect(noteRunsHeldUntil(idle, NOW)).toBeNull();
  });

  it('counts only note runs inside the hour, not other runs, nor ones an hour old or ahead', () => {
    const many = (at: string) => Array.from({ length: NOTE_RUNS_PER_HOUR }, () => noteRun(at));
    const scheduled = Array.from({ length: NOTE_RUNS_PER_HOUR }, () => ({
      ...ranAt('2026-10-08T11:30:00'),
      done: [ARCHIVED],
    }));
    const outside = [...many('2026-10-08T11:00:00'), ...many('2026-10-08T12:00:01'), ...scheduled];
    expect(noteRunsHeldUntil(outside, NOW)).toBeNull();
    expect(noteRunsHeldUntil(many('2026-10-08T11:00:01'), NOW)).toBe('2026-10-08T12:00:01');
  });

  it('says it is waiting, not broken: its own runs, and when it runs on what it heard meanwhile', () => {
    const hold = noteRunsHold({ rule: 'Tidy', entries: minutes(10, NOTE_RUNS_PER_HOUR), now: NOW });
    expect(hold === null ? null : noteRunsHoldMessage(hold)).toBe(
      'Waiting, not broken: it has reached an hourly limit. ' +
        `It may run ${NOTE_RUNS_PER_HOUR} times an hour, each question it asks Claude counted as a run, ` +
        `and it has used ${NOTE_RUNS_PER_HOUR} in the last hour. ` +
        'It runs next at 12:10, on what changed meanwhile. ' +
        'Nothing needs fixing: it catches up by itself.',
    );
  });
});

describe('nextRunOf', () => {
  it('is the next time after the last run, and none for a rule that is off', () => {
    const log = [ranAt('2026-09-27T03:00:00')];
    expect(
      nextRunOf({ rule: RULE, log, watchingSince: WATCHING, now: '2026-09-27T12:00:00' }),
    ).toBe('2026-09-28T03:00:00');
    expect(
      nextRunOf({
        rule: { ...RULE, enabled: false },
        log,
        watchingSince: WATCHING,
        now: '2026-09-27T12:00:00',
      }),
    ).toBeNull();
  });
});
