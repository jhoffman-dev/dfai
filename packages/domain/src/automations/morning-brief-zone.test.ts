/**
 * The morning brief on the calendar's clock (#587): its day and its 07:00 are
 * the plan zone's, whatever zone the Mac is in. The scheduler is played out
 * over days of instants, as its minute tick would see them, with the
 * brief's own rules: when it is due, the slot it writes for, the day it
 * briefs, and its key, the slot's day, which a second run finds recorded.
 */
import { describe, expect, it } from 'vitest';
import { wallTimeIn } from '../google-calendar/plan-zone.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import { dueTrigger, ruleClockOf } from './automation-due.ts';
import type { AutomationRule } from './automation-rule.ts';
import { briefDayOf, keepsCalendarClock } from './morning-brief.ts';
import { outputPeriod, periodRecorded } from './output-period.ts';
import type { LogEntry } from './run-log.ts';

const BRIEF: AutomationRule = {
  id: 'Morning brief',
  path: createVaultPath('.atlas/automations/Morning brief.md'),
  name: 'Morning brief',
  enabled: true,
  when: { kind: 'daily', at: '07:00' },
  which: '',
  olderThanDays: null,
  action: {
    kind: 'claude',
    prompt: '.atlas/prompts/morning-brief.md',
    tools: [],
    output: { kind: 'note', folder: 'Inbox/Briefs' },
    data: 'meeting-briefs',
  },
};

const TIDY: AutomationRule = { ...BRIEF, id: 'Tidy', action: { kind: 'archive' } };

const MINUTE = 60_000;
const ITEM = 'gcal:ev-larkspur-sync';

interface Played {
  /** The days briefed, each with the plan zone's wall clock it was briefed at. */
  readonly briefed: { day: string; at: string }[];
}

/**
 * Plays the scheduler from `from` to `to`, a tick every `every` minutes. The
 * plan zone is kept from `keptFrom` on (from the start, unless said).
 */
function play({
  rule = BRIEF,
  mac,
  plan,
  from,
  to,
  every = 15,
  keptFrom = from,
}: {
  rule?: AutomationRule;
  mac: string;
  plan: string;
  from: string;
  to: string;
  every?: number;
  keptFrom?: string;
}): Played {
  const log: LogEntry[] = [];
  const briefed: Played['briefed'] = [];
  const start = Date.parse(from);
  const watching = wallTimeIn(mac, start);
  for (let instant = start; instant <= Date.parse(to); instant += every * MINUTE) {
    const kept = instant >= Date.parse(keptFrom);
    const clock = ruleClockOf({
      rule,
      now: wallTimeIn(mac, instant),
      watchingSince: watching,
      planNow: kept ? wallTimeIn(plan, instant) : null,
    });
    const due = dueTrigger({ rule, log, ...clock, opening: false });
    if (due === null) continue;
    const slot = outputPeriod({ schedule: rule.when, at: clock.now })!.slot;
    const period = { slot, item: ITEM };
    const day = briefDayOf({ slot, now: clock.now });
    const made =
      day !== null &&
      !periodRecorded({ entries: log, period, schedule: rule.when, now: clock.now });
    log.push({
      kind: 'run',
      at: clock.now,
      trigger: 'schedule',
      done: made ? [{ kind: 'created', path: createVaultPath(`Inbox/Briefs/${day}/b.md`) }] : [],
      left: [],
      capped: false,
      period,
    });
    if (made) briefed.push({ day, at: wallTimeIn(plan, instant) });
  }
  return { briefed };
}

const days = ({ briefed }: Played) => briefed.map(({ day }) => day);

describe('the morning brief keeps the calendar’s clock', () => {
  it('is the one rule that does', () => {
    expect(keepsCalendarClock(BRIEF)).toBe(true);
    expect(keepsCalendarClock(TIDY)).toBe(false);
    const review = { ...BRIEF, action: { ...BRIEF.action, data: 'weekly-review' as const } };
    expect(keepsCalendarClock(review)).toBe(false);
  });

  it('leaves every other rule on the Mac’s clock', () => {
    const asked = {
      now: '2026-10-26T05:00:00',
      watchingSince: '2026-10-26T04:00:00',
      planNow: '2026-10-26T07:00:00',
    };
    expect(ruleClockOf({ rule: TIDY, ...asked })).toEqual({
      now: asked.now,
      watchingSince: asked.watchingSince,
    });
  });

  it('counts the brief on the plan zone’s clock, moving when watching began by the same gap', () => {
    expect(
      ruleClockOf({
        rule: BRIEF,
        now: '2026-10-26T05:00:00',
        watchingSince: '2026-10-26T04:00:00',
        planNow: '2026-10-26T07:00:00',
      }),
    ).toEqual({ now: '2026-10-26T07:00:00', watchingSince: '2026-10-26T06:00:00' });
  });

  it('stays on the Mac’s clock while the vault keeps no zone', () => {
    const asked = { now: '2026-10-26T05:00:00', watchingSince: '2026-10-26T04:00:00' };
    expect(ruleClockOf({ rule: BRIEF, ...asked, planNow: null })).toEqual(asked);
  });
});

describe('a Mac in another zone briefs the calendar’s day, once, at 07:00 on its clock', () => {
  // The review's case: the Mac in Los Angeles, the calendar in Chicago.
  it('briefs each Chicago day at 07:00 Chicago time from a Mac in Los Angeles', () => {
    const played = play({
      mac: 'America/Los_Angeles',
      plan: 'America/Chicago',
      from: '2026-10-20T00:00:00Z',
      to: '2026-10-24T00:00:00Z',
    });
    expect(played.briefed).toEqual([
      { day: '2026-10-20', at: '2026-10-20T07:00:00' },
      { day: '2026-10-21', at: '2026-10-21T07:00:00' },
      { day: '2026-10-22', at: '2026-10-22T07:00:00' },
      { day: '2026-10-23', at: '2026-10-23T07:00:00' },
    ]);
  });

  it('would brief at 09:00 Chicago time on the Mac’s clock, which is what the kept zone changes', () => {
    const played = play({
      mac: 'America/Los_Angeles',
      plan: 'America/Chicago',
      from: '2026-10-20T00:00:00Z',
      to: '2026-10-21T00:00:00Z',
      keptFrom: '2026-10-30T00:00:00Z',
    });
    expect(played.briefed).toEqual([{ day: '2026-10-20', at: '2026-10-20T09:00:00' }]);
  });

  // The Mac's day is a day ahead of the calendar's from 07:00: its own clock would brief tomorrow.
  it('briefs Honolulu’s day from a Mac on Kiritimati, a whole day ahead', () => {
    const played = play({
      mac: 'Pacific/Kiritimati',
      plan: 'Pacific/Honolulu',
      from: '2026-10-20T10:00:00Z',
      to: '2026-10-23T10:00:00Z',
    });
    // At Honolulu's 07:00 the Mac's clock reads 07:00 the next day.
    expect(played.briefed).toEqual([
      { day: '2026-10-20', at: '2026-10-20T07:00:00' },
      { day: '2026-10-21', at: '2026-10-21T07:00:00' },
      { day: '2026-10-22', at: '2026-10-22T07:00:00' },
    ]);
  });

  it('briefs Kiritimati’s day from a Mac in Honolulu, a whole day behind', () => {
    const played = play({
      mac: 'Pacific/Honolulu',
      plan: 'Pacific/Kiritimati',
      from: '2026-10-20T10:00:00Z',
      to: '2026-10-23T10:00:00Z',
    });
    expect(days(played)).toEqual(['2026-10-21', '2026-10-22', '2026-10-23']);
    expect(played.briefed.every(({ at }) => at.endsWith('T07:00:00'))).toBe(true);
  });

  it('briefs each day once when the tick is every minute', () => {
    const played = play({
      mac: 'Asia/Tokyo',
      plan: 'America/Chicago',
      from: '2026-10-20T00:00:00Z',
      to: '2026-10-22T00:00:00Z',
      every: 1,
    });
    expect(days(played)).toEqual(['2026-10-20', '2026-10-21']);
  });
});

describe('the brief across clock changes', () => {
  // London went back on 2026-10-25, Chicago on 2026-11-01: for a week they are five hours apart.
  it('briefs every Chicago day at 07:00 through both falls back, from a Mac in London', () => {
    const played = play({
      mac: 'Europe/London',
      plan: 'America/Chicago',
      from: '2026-10-23T00:00:00Z',
      to: '2026-11-04T00:00:00Z',
    });
    expect(days(played)).toEqual([
      '2026-10-23',
      '2026-10-24',
      '2026-10-25',
      '2026-10-26',
      '2026-10-27',
      '2026-10-28',
      '2026-10-29',
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
    ]);
    expect(played.briefed.every(({ at }) => at.endsWith('T07:00:00'))).toBe(true);
  });

  it('briefs every Chicago day once through the spring change, when an hour is skipped', () => {
    const played = play({
      mac: 'Europe/London',
      plan: 'America/Chicago',
      from: '2027-03-12T00:00:00Z',
      to: '2027-03-17T00:00:00Z',
    });
    expect(days(played)).toEqual([
      '2027-03-12',
      '2027-03-13',
      '2027-03-14',
      '2027-03-15',
      '2027-03-16',
    ]);
    expect(played.briefed.every(({ at }) => at.endsWith('T07:00:00'))).toBe(true);
  });
});

describe('the zone kept for the first time, mid-trip', () => {
  // London's 07:00 briefed the day on the Mac's clock; the zone is kept that morning.
  it('does not brief that day twice once the brief moves to Chicago’s clock', () => {
    const played = play({
      mac: 'Europe/London',
      plan: 'America/Chicago',
      from: '2026-10-20T00:00:00Z',
      to: '2026-10-23T00:00:00Z',
      keptFrom: '2026-10-21T09:00:00Z',
    });
    expect(days(played)).toEqual(['2026-10-20', '2026-10-21', '2026-10-22']);
  });

  // Los Angeles's 07:00 comes after Chicago's: the day is briefed at Chicago's, then not again.
  it('neither skips nor repeats a day when the Mac’s clock was behind', () => {
    const played = play({
      mac: 'America/Los_Angeles',
      plan: 'America/Chicago',
      from: '2026-10-20T00:00:00Z',
      to: '2026-10-23T00:00:00Z',
      keptFrom: '2026-10-21T10:00:00Z',
    });
    expect(days(played)).toEqual(['2026-10-20', '2026-10-21', '2026-10-22']);
  });
});
