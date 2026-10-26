/**
 * Attack on PR #592 (#587): the morning brief counted on the plan zone, as a
 * seeded property. The scheduler is played as `morning-brief-zone.test.ts`
 * plays it — `ruleClockOf`, `dueTrigger`, `outputPeriod`, `briefDayOf`,
 * `periodRecorded` — over random Mac zones (and a trip mid-run), random plan
 * zones first kept mid-run (upgrade day: the log before is on the Mac's
 * clock) and maybe moved once, a random tick, and the Mac asleep for random
 * spans. Fictional rule and data only.
 */
import { describe, expect, it } from 'vitest';
import { wallTimeIn } from '../google-calendar/plan-zone.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import { dueTrigger, ruleClockOf } from './automation-due.ts';
import type { AutomationRule } from './automation-rule.ts';
import { briefDayOf } from './morning-brief.ts';
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

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ITEM = 'gcal:ev-larkspur-sync';

const ZONES = [
  'Pacific/Kiritimati',
  'Pacific/Pago_Pago',
  'Pacific/Chatham',
  'Asia/Kathmandu',
  'Australia/Lord_Howe',
  'America/St_Johns',
  'America/Chicago',
  'America/Los_Angeles',
  'Pacific/Honolulu',
  'Europe/London',
  'Asia/Tokyo',
];

/** Around a DST change somewhere, or the year's end (UTC midnights). */
const STARTS = [
  '2026-03-07T00:00:00Z',
  '2026-03-28T00:00:00Z',
  '2026-04-04T00:00:00Z',
  '2026-09-26T00:00:00Z',
  '2026-10-03T00:00:00Z',
  '2026-10-24T00:00:00Z',
  '2026-10-31T00:00:00Z',
  '2026-12-30T00:00:00Z',
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface Trip {
  readonly start: number;
  readonly end: number;
  readonly every: number;
  /** The Mac's zone, and the instant it travels to `macLater`. */
  readonly mac: string;
  readonly macLater: string;
  readonly macMovesAt: number;
  /** The plan zone, first kept at `keptAt`; moved to `planLater` at `planMovesAt`. */
  readonly plan: string;
  readonly planLater: string;
  readonly keptAt: number;
  readonly planMovesAt: number;
  /** Spans the Mac is asleep: no tick inside one; a tick on waking. */
  readonly asleep: readonly { from: number; to: number }[];
}

const tripCache = new Map<string, Trip>();

function tripOf(seed: number, { planMoves }: { planMoves: boolean }): Trip {
  const key = `${seed}:${planMoves}`;
  const known = tripCache.get(key);
  if (known !== undefined) return known;
  const trip = makeTrip(seed, { planMoves });
  tripCache.set(key, trip);
  return trip;
}

function makeTrip(seed: number, { planMoves }: { planMoves: boolean }): Trip {
  const rng = mulberry32(seed);
  const pick = <T>(list: readonly T[]) => list[Math.floor(rng() * list.length)]!;
  const start = Date.parse(pick(STARTS)) - 2 * 24 * HOUR;
  const end = start + 7 * 24 * HOUR;
  const at = (fromHours: number, spanHours: number) =>
    start + Math.floor((fromHours + rng() * spanHours) * 60) * MINUTE;
  const asleep = Array.from({ length: Math.floor(rng() * 4) }, () => {
    const from = at(0, 7 * 24);
    return { from, to: from + Math.floor(rng() * 20 * 60) * MINUTE };
  });
  const plan = pick(ZONES);
  return {
    start,
    end,
    every: 1 + Math.floor(rng() * 15),
    mac: pick(ZONES),
    macLater: pick(ZONES),
    macMovesAt: at(24, 5 * 24),
    plan,
    planLater: planMoves ? pick(ZONES) : plan,
    keptAt: at(12, 48),
    planMovesAt: planMoves ? at(72, 24) : end + HOUR,
    asleep,
  };
}

interface Brief {
  readonly day: string;
  readonly instant: number;
  /** The clock the run was counted on, at that instant. */
  readonly at: string;
}

interface Played {
  readonly briefs: Brief[];
  readonly ticks: number[];
}

const awake = (trip: Trip, instant: number) =>
  !trip.asleep.some(({ from, to }) => instant >= from && instant < to);

function ticksOf(trip: Trip): number[] {
  const ticks = new Set<number>();
  for (let instant = trip.start; instant <= trip.end; instant += trip.every * MINUTE) {
    if (awake(trip, instant)) ticks.add(instant);
  }
  for (const { to } of trip.asleep) if (to <= trip.end) ticks.add(to);
  return [...ticks].filter((instant) => awake(trip, instant)).sort((a, b) => a - b);
}

const macAt = (trip: Trip, instant: number) =>
  instant >= trip.macMovesAt ? trip.macLater : trip.mac;
const planAt = (trip: Trip, instant: number) =>
  instant < trip.keptAt ? null : instant >= trip.planMovesAt ? trip.planLater : trip.plan;

const playedCache = new Map<Trip, Played>();

function play(trip: Trip): Played {
  const cached = playedCache.get(trip);
  if (cached !== undefined) return cached;
  const played = playOnce(trip);
  playedCache.set(trip, played);
  return played;
}

function playOnce(trip: Trip): Played {
  const log: LogEntry[] = [];
  const briefs: Brief[] = [];
  const ticks = ticksOf(trip);
  const watching = wallTimeIn(trip.mac, trip.start);
  for (const instant of ticks) {
    const plan = planAt(trip, instant);
    const clock = ruleClockOf({
      rule: BRIEF,
      now: wallTimeIn(macAt(trip, instant), instant),
      watchingSince: watching,
      planNow: plan === null ? null : wallTimeIn(plan, instant),
    });
    if (dueTrigger({ rule: BRIEF, log, ...clock, opening: false }) === null) continue;
    const slot = outputPeriod({ schedule: BRIEF.when, at: clock.now })!.slot;
    const period = { slot, item: ITEM };
    const day = briefDayOf({ slot, now: clock.now });
    const made =
      day !== null &&
      !periodRecorded({ entries: log, period, schedule: BRIEF.when, now: clock.now });
    log.push({
      kind: 'run',
      at: clock.now,
      trigger: 'schedule',
      done: made ? [{ kind: 'created', path: createVaultPath(`Inbox/Briefs/${day}/b.md`) }] : [],
      left: [],
      capped: false,
      period,
    });
    if (made) briefs.push({ day, instant, at: clock.now });
  }
  return { briefs, ticks };
}

/** Plan days the plan zone was kept and the same all day, and the Mac awake on past 07:00. */
function owedDays(trip: Trip, ticks: readonly number[]): Set<string> {
  const owed = new Set<string>();
  for (const instant of ticks) {
    const plan = planAt(trip, instant);
    if (plan === null) continue;
    const wall = wallTimeIn(plan, instant);
    if (wall.slice(11) < '07:00:00') continue;
    const day = wall.slice(0, 10);
    // The whole plan day, and the evening before, on this one zone, kept.
    const dayStart = instant - (localMs(wall) - localMs(`${day}T00:00:00`)) - 6 * HOUR;
    if (planAt(trip, dayStart) !== plan) continue;
    if (dayStart < trip.start) continue;
    owed.add(day);
  }
  return owed;
}

const localMs = (wall: string) => Date.parse(`${wall}Z`);

const SEEDS = Array.from({ length: 40 }, (_, index) => 592_000 + index);

const describeTrip = (seed: number, trip: Trip) =>
  `seed ${seed}: Mac ${trip.mac}→${trip.macLater} at ${new Date(trip.macMovesAt).toISOString()}, ` +
  `plan ${trip.plan} kept ${new Date(trip.keptAt).toISOString()}` +
  (trip.planLater !== trip.plan
    ? ` → ${trip.planLater} at ${new Date(trip.planMovesAt).toISOString()}`
    : '') +
  `, tick ${trip.every} min, asleep ${trip.asleep.length}`;

// Each case plays seeded weeks through the scheduler: seconds of work, past Vitest's default 5 s under load.
describe('attack #592: the brief over random zones, trips, ticks and sleeps (seeded)', () => {
  it('briefs no calendar day twice', () => {
    const failures: string[] = [];
    for (const seed of SEEDS) {
      for (const planMoves of [false, true]) {
        const trip = tripOf(seed, { planMoves });
        const seen = new Map<string, number>();
        for (const { day } of play(trip).briefs) seen.set(day, (seen.get(day) ?? 0) + 1);
        const twice = [...seen].filter(([, count]) => count > 1).map(([day]) => day);
        if (twice.length > 0) failures.push(`${describeTrip(seed, trip)}: twice ${twice}`);
      }
    }
    expect(failures.slice(0, 5)).toEqual([]);
  }, 60_000);

  it('briefs, on a kept zone, only the plan zone’s own day, at or after its 07:00', () => {
    const failures: string[] = [];
    for (const seed of SEEDS) {
      for (const planMoves of [false, true]) {
        const trip = tripOf(seed, { planMoves });
        for (const brief of play(trip).briefs) {
          const plan = planAt(trip, brief.instant);
          if (plan === null) continue;
          const wall = wallTimeIn(plan, brief.instant);
          if (wall.slice(0, 10) !== brief.day || wall.slice(11) < '07:00:00') {
            failures.push(`${describeTrip(seed, trip)}: briefed ${brief.day} at plan ${wall}`);
          }
        }
      }
    }
    expect(failures.slice(0, 5)).toEqual([]);
  }, 60_000);

  it('skips no calendar day the Mac was awake past 07:00 on, the zone kept and settled (zone kept once)', () => {
    const failures: string[] = [];
    for (const seed of SEEDS) {
      const trip = tripOf(seed, { planMoves: false });
      const { briefs, ticks } = play(trip);
      const briefed = new Set(briefs.map(({ day }) => day));
      const skipped = [...owedDays(trip, ticks)].filter((day) => !briefed.has(day));
      if (skipped.length > 0) failures.push(`${describeTrip(seed, trip)}: skipped ${skipped}`);
    }
    expect(failures.slice(0, 5)).toEqual([]);
  }, 60_000);

  it('skips no calendar day the Mac was awake past 07:00 on, after the kept zone moved', () => {
    const failures: string[] = [];
    for (const seed of SEEDS) {
      const trip = tripOf(seed, { planMoves: true });
      const { briefs, ticks } = play(trip);
      const briefed = new Set(briefs.map(({ day }) => day));
      const skipped = [...owedDays(trip, ticks)].filter((day) => !briefed.has(day));
      if (skipped.length > 0) failures.push(`${describeTrip(seed, trip)}: skipped ${skipped}`);
    }
    expect(failures.slice(0, 5)).toEqual([]);
  }, 60_000);
});
