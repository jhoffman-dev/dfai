/**
 * Adversarial tests for #813 (PR #891): the hold said as data and as
 * sentences must agree with what the scheduler decides, and must never call
 * a broken rule "not broken". Seeded, with a fixed clock.
 */
import { describe, expect, it } from 'vitest';
import {
  NOTE_RUNS_PER_HOUR,
  noteRunsHeldUntil,
  noteRunsHold,
  type NamedLog,
} from './automation-due.ts';
import {
  claudeStepBudget,
  DECLARED_STEP_ASKS_PER_HOUR,
  DECLARED_STEP_MODEL,
  SHARED_STEP_BUDGET,
} from './claude-step-budget.ts';
import { noteRunsHoldMessage } from './note-runs-hold.ts';
import type { LogEntry } from './run-log.ts';
import { localTimeMs, localTimeOf } from './schedule.ts';

const DECLARED = claudeStepBudget({
  kind: 'claude',
  prompt: '.atlas/prompts/after-a-meeting.md',
  tools: [],
  output: { kind: 'proposals', schema: 'meeting-digest' },
  apply: 'mine',
});

/** mulberry32: a small seeded RNG, so each case is the same on every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const at = (now: string, secondsAgo: number) => localTimeOf(localTimeMs(now)! - secondsAgo * 1000);

const askRun = (when: string, asks: number): LogEntry => ({
  kind: 'run',
  at: when,
  trigger: 'note',
  done: [],
  left: [],
  capped: false,
  claude: { model: DECLARED_STEP_MODEL, ms: 10, asks },
});

const changedRun = (when: string): LogEntry => ({
  kind: 'run',
  at: when,
  trigger: 'note',
  done: [{ kind: 'set', path: 'Notes/a.md', key: 'status', from: null, to: 'done' }],
  left: [],
  capped: false,
});

const failedRun = (when: string, problem = 'The index could not be read.'): LogEntry => ({
  kind: 'failed',
  at: when,
  trigger: 'note',
  problem,
});

/**
 * A seeded log over the two hours up to `now`: asks, note runs that changed a
 * note, and failures — some exactly an hour old, some in the same second.
 * `ahead` puts some entries after `now`, as a clock set back (sleep, wake) does.
 */
function history(rand: () => number, now: string, { ahead = false } = {}): LogEntry[] {
  const count = Math.floor(rand() * 40);
  const pinned = [3600, 3599, 3601, 1800, 1800, 0];
  return Array.from({ length: count }, () => {
    const secondsAgo =
      rand() < 0.25
        ? pinned[Math.floor(rand() * pinned.length)]!
        : ahead && rand() < 0.3
          ? -Math.floor(rand() * 3600) - 1
          : Math.floor(rand() * 7200);
    const when = at(now, secondsAgo);
    const kind = rand();
    if (kind < 0.55) return askRun(when, 1 + Math.floor(rand() * 10));
    if (kind < 0.85) return changedRun(when);
    return failedRun(when);
  });
}

const NOW = '2026-10-14T12:00:00';
const NAMES = ['After a meeting', 'After a client call', 'Board digest', 'Weekly review'];

function seededCase(seed: number, now = NOW, ahead = false) {
  const rand = seeded(seed);
  const budget = rand() < 0.7 ? DECLARED : SHARED_STEP_BUDGET;
  const ruleCount = 1 + Math.floor(rand() * 4);
  const logs: NamedLog[] = Array.from({ length: ruleCount }, (_, index) => ({
    name: NAMES[index]!,
    entries: history(rand, now, { ahead }),
  }));
  const [own, ...sharers] = logs as [NamedLog, ...NamedLog[]];
  return { budget, own, sharers: budget === DECLARED ? sharers : [] };
}

const SEEDS = Array.from({ length: 600 }, (_, index) => index + 1);
const MIDNIGHT = '2026-10-15T00:20:00';

describe('noteRunsHold agrees with the scheduler’s noteRunsHeldUntil (#813, seeded)', () => {
  it.each([NOW, MIDNIGHT])(
    'over 600 seeded histories at %s: held in both or neither, with the same until',
    (now) => {
      const disagreements: string[] = [];
      for (const seed of SEEDS) {
        const { budget, own, sharers } = seededCase(seed, now);
        const allowance = [...own.entries, ...sharers.flatMap((log) => log.entries)];
        const until = noteRunsHeldUntil(own.entries, now, budget, allowance);
        const hold = noteRunsHold({ rule: own.name, entries: own.entries, now, budget, sharers });
        if ((hold?.until ?? null) !== until) disagreements.push(`seed ${seed}`);
      }
      expect(disagreements).toEqual([]);
    },
  );

  it('over 600 seeded histories: until is after now, held a second before it and free at it', () => {
    const wrong: string[] = [];
    for (const seed of SEEDS) {
      const { budget, own, sharers } = seededCase(seed);
      const allowance = [...own.entries, ...sharers.flatMap((log) => log.entries)];
      const hold = noteRunsHold({
        rule: own.name,
        entries: own.entries,
        now: NOW,
        budget,
        sharers,
      });
      if (hold === null) continue;
      if (hold.until <= NOW) wrong.push(`seed ${seed}: until ${hold.until} not after now`);
      const before = at(hold.until, 1);
      if (before >= NOW && noteRunsHeldUntil(own.entries, before, budget, allowance) === null) {
        wrong.push(`seed ${seed}: free a second before ${hold.until}`);
      }
      if (noteRunsHeldUntil(own.entries, hold.until, budget, allowance) !== null) {
        wrong.push(`seed ${seed}: still held at ${hold.until}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('over 600 seeded histories: the shared asks by rule sum to asked, and list no rule with none', () => {
    const wrong: string[] = [];
    for (const seed of SEEDS) {
      const { budget, own, sharers } = seededCase(seed);
      const hold = noteRunsHold({
        rule: own.name,
        entries: own.entries,
        now: NOW,
        budget,
        sharers,
      });
      const shared = hold?.sharedAsks;
      if (shared === null || shared === undefined) continue;
      const sum = shared.by.reduce((total, { asks }) => total + asks, 0);
      if (sum !== shared.asked)
        wrong.push(`seed ${seed}: by sums to ${sum}, asked ${shared.asked}`);
      if (shared.by.some(({ asks }) => asks <= 0)) wrong.push(`seed ${seed}: a rule with no asks`);
      if (shared.asked < shared.most) wrong.push(`seed ${seed}: held under the most`);
    }
    expect(wrong).toEqual([]);
  });

  it('after the clock is set back (sleep and wake), the rule is free at the until it was told', () => {
    // Entries dated after `now` are not counted now, but are counted by the
    // time `until` comes: the time the message promises is not when it runs.
    const wrong: string[] = [];
    for (const seed of SEEDS) {
      const { budget, own, sharers } = seededCase(seed, NOW, true);
      const allowance = [...own.entries, ...sharers.flatMap((log) => log.entries)];
      const hold = noteRunsHold({
        rule: own.name,
        entries: own.entries,
        now: NOW,
        budget,
        sharers,
      });
      if (hold === null) continue;
      if (noteRunsHeldUntil(own.entries, hold.until, budget, allowance) !== null) {
        wrong.push(`seed ${seed}: told ${hold.until}, still held then`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe('noteRunsHoldMessage tells the truth (#813)', () => {
  it('never says a rule whose every run in the hour failed is "not broken" or needs no fixing', () => {
    const entries = Array.from({ length: NOTE_RUNS_PER_HOUR }, (_, index) =>
      failedRun(at(NOW, 3000 - index * 60), 'Claude could not be reached.'),
    );
    const hold = noteRunsHold({ rule: 'Tag meetings', entries, now: NOW });
    expect(hold).not.toBeNull();

    const message = noteRunsHoldMessage(hold!);

    expect(message).not.toContain('not broken');
    expect(message).not.toContain('Nothing needs fixing');
  });

  it('does not say it runs at a minute before the hold ends', () => {
    // The hold ends at 12:15:30; the scheduler holds it until then, so it
    // cannot run "at 12:15".
    const entries = Array.from({ length: DECLARED_STEP_ASKS_PER_HOUR }, () =>
      askRun('2026-10-14T11:15:30', 1),
    );
    const hold = noteRunsHold({ rule: 'After a meeting', entries, now: NOW, budget: DECLARED });
    expect(hold?.until).toBe('2026-10-14T12:15:30');

    const said = /runs next at (\d\d:\d\d)/.exec(noteRunsHoldMessage(hold!))?.[1];

    expect(`2026-10-14T${said}:59` >= hold!.until && `2026-10-14T${said}:00` >= hold!.until).toBe(
      true,
    );
  });

  it('names a sharer that has the held rule’s name as another rule, and offers to turn it off', () => {
    // Names are not unique (meetings-read-twice.ts says so): two declared
    // rules both called "After a meeting", the other one spent 25 asks.
    const hold = noteRunsHold({
      rule: 'After a meeting',
      entries: [askRun(at(NOW, 600), 5)],
      now: NOW,
      budget: DECLARED,
      sharers: [{ name: 'After a meeting', entries: [askRun(at(NOW, 1200), 25)] }],
    });
    expect(hold?.sharedAsks?.asked).toBe(30);

    const message = noteRunsHoldMessage(hold!);

    expect(message).toContain('shares one limit');
    expect(message).toContain('turn off');
  });

  it('says both limits, and the later until, when both are spent', () => {
    const entries = [
      ...Array.from({ length: NOTE_RUNS_PER_HOUR }, () => failedRun(at(NOW, 3000))),
      askRun(at(NOW, 1200), DECLARED_STEP_ASKS_PER_HOUR),
    ];
    const hold = noteRunsHold({ rule: 'After a meeting', entries, now: NOW, budget: DECLARED });

    expect(hold?.runs).not.toBeNull();
    expect(hold?.sharedAsks).not.toBeNull();
    expect(hold?.until).toBe(at(NOW, 1200 - 3600));
    expect(noteRunsHoldMessage(hold!)).toContain('two hourly limits');
  });
});
