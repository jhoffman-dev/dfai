/**
 * Attack on PR #637 (#182): the pending rule and the reach it reads off a
 * rule's `which`. Over seeded meeting shapes and seeded `which` strings, the
 * rule is judged against an oracle that knows what the rule's query takes —
 * a day-only `date` condition evaluated day by day, as the compiled SQL
 * compares `substr(date, 1, 10)` — and what the ledger has finished with.
 * Fictional names only.
 */
import { describe, expect, it } from 'vitest';
import { movingDate } from '../automations/automation-query.ts';
import { addDays } from '../timeline/timeline.ts';
import { SUMMARY_DIGEST_KEY } from './meeting-summary-block.ts';
import {
  meetingReachFrom,
  postProcessingFactsOf,
  postProcessingPending,
  SUMMARY_PENDING_DAYS,
  type PostProcessingLedger,
} from './post-processing-pending.ts';

function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const pick = <T>(rng: Rng, from: readonly T[]): T => from[Math.floor(rng() * from.length)]!;
const TODAY = '2026-10-29';

/** A `date` condition the oracle can evaluate on one day, with the `which` text it prints as. */
type DateCondition =
  | { kind: 'cmp'; op: '>=' | '>' | '<=' | '<' | '='; value: string; text: string }
  | { kind: 'and' | 'or'; operands: DateCondition[] }
  | { kind: 'not'; operand: DateCondition };

const RELATIVE = [
  '@today',
  '@yesterday',
  '@weekAgo',
  '@-1d',
  '@-3d',
  '@-7d',
  '@-10d',
  '@-14d',
  '@-20d',
  '@-1w',
  '@-2w',
];
const FIXED = ['2026-10-01', '2026-10-20', '2026-10-25', '2026-10-28', '2026-11-02'];

function dayNamed(value: string): string {
  return value.startsWith('@') ? (movingDate(value.slice(1), TODAY) ?? TODAY) : value;
}

function condition(rng: Rng, depth: number, lowerOnly: boolean): DateCondition {
  const leaf = depth <= 0 || rng() < 0.45;
  if (leaf) {
    const op = lowerOnly
      ? pick(rng, ['>=', '>'] as const)
      : pick(rng, ['>=', '>', '<=', '<', '='] as const);
    const value = rng() < 0.7 ? pick(rng, RELATIVE) : pick(rng, FIXED);
    const written = value.startsWith('@') ? value : rng() < 0.5 ? `"${value}"` : value;
    return { kind: 'cmp', op, value, text: `date ${op} ${written}` };
  }
  if (lowerOnly) {
    const count = 2 + Math.floor(rng() * 2);
    return {
      kind: 'and',
      operands: Array.from({ length: count }, () => condition(rng, depth - 1, true)),
    };
  }
  const shape = pick(rng, ['and', 'or', 'not'] as const);
  if (shape === 'not') return { kind: 'not', operand: condition(rng, depth - 1, false) };
  const count = 2 + Math.floor(rng() * 2);
  return {
    kind: shape,
    operands: Array.from({ length: count }, () => condition(rng, depth - 1, false)),
  };
}

function printed(where: DateCondition): string {
  switch (where.kind) {
    case 'cmp':
      return where.text;
    case 'not':
      return `NOT (${printed(where.operand)})`;
    default:
      return `(${where.operands.map(printed).join(where.kind === 'and' ? ' AND ' : ' OR ')})`;
  }
}

/** Whether the rule's query takes a meeting dated `day`, as its SQL compares the day. */
function takes(where: DateCondition, day: string): boolean {
  switch (where.kind) {
    case 'cmp': {
      const bound = dayNamed(where.value);
      if (where.op === '>=') return day >= bound;
      if (where.op === '>') return day > bound;
      if (where.op === '<=') return day <= bound;
      if (where.op === '<') return day < bound;
      return day === bound;
    }
    case 'not':
      return !takes(where.operand, day);
    case 'and':
      return where.operands.every((operand) => takes(operand, day));
    case 'or':
      return where.operands.some((operand) => takes(operand, day));
  }
}

const FLOOR = addDays(TODAY, -SUMMARY_PENDING_DAYS)!;
/** The days a meeting can be pending on: the 14-day floor up to today. */
const DAYS = Array.from({ length: SUMMARY_PENDING_DAYS + 1 }, (_, back) => addDays(TODAY, -back)!);

const JUNK = [
  '',
  ' ',
  'junk ((',
  'FROM',
  'FROM meeting WHERE',
  'FROM meeting WHERE date >=',
  'FROM meeting WHERE date >= @nonsense',
  'FROM meeting WHERE date >= "next tuesday"',
  'FROM meeting WHERE date >= @-99999999d',
  'FROM meeting WHERE date > 9999-12-31',
  'FROM meeting WHERE date >= "2026-02-30"',
  'FROM meeting WHERE date >= "2026-10-25T00:00"',
  'FROM meeting WHERE date >= NaN',
  'FROM meeting WHERE date >= -0',
  'FROM meeting WHERE dáte >= @-3d',
  'FROM meeting WHERE date >= @-7d AND (',
  'FROM meeting WHERE meeting.date >= @-3d',
];

describe('meetingReachFrom over seeded `which` strings (attack on PR #637)', () => {
  it('never reaches further back than 14 days, and never throws, whatever the `which`', () => {
    const rng = seeded(637);
    const whiches = [
      ...JUNK,
      ...Array.from(
        { length: 400 },
        () => `FROM meeting WHERE ${printed(condition(rng, 3, false))}`,
      ),
    ];
    for (const which of whiches) {
      const from = meetingReachFrom(which, TODAY);
      expect(from, which).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(from >= FLOOR, which).toBe(true);
    }
  });

  it('reads the bound of AND-joined lower bounds exactly: the earliest day the rule still takes', () => {
    const rng = seeded(6371);
    for (let round = 0; round < 300; round += 1) {
      const where = condition(rng, 2, true);
      const which = `FROM meeting WHERE ${printed(where)}`;
      const firstTaken = [...DAYS].reverse().find((day) => takes(where, day)) ?? null;
      const from = meetingReachFrom(which, TODAY);
      if (firstTaken === null) {
        // Nothing within the 14 days is taken: no day up to today may be pending.
        expect(from > TODAY, which).toBe(true);
      } else {
        expect(from, which).toBe(firstTaken);
      }
    }
  });

  it('counts no day as pending that the rule’s `which` never takes, whatever its nesting', () => {
    const rng = seeded(6372);
    const overReach: string[] = [];
    for (let round = 0; round < 300; round += 1) {
      const where = condition(rng, 3, false);
      const which = `FROM meeting WHERE ${printed(where)}`;
      const from = meetingReachFrom(which, TODAY);
      const wrong = DAYS.find((day) => day >= from && !takes(where, day));
      if (wrong !== undefined)
        overReach.push(`${which} → from ${from}, but ${wrong} is never taken`);
    }
    expect(overReach.slice(0, 3)).toEqual([]);
  });
});

/** A meeting note's shape, as it may sit in the vault after import and the person's edits. */
interface Shape {
  path: string;
  importOutcome: 'imported' | 'duplicate' | 'error' | null;
  date: unknown;
  hasTurns: boolean;
  summaryTrace: 'none' | 'block' | 'fenced-marker' | 'unclosed' | 'digest-only';
  answered: 'never' | 'answered' | 'answered-stored' | 'stored-only' | 'stale-other-path';
}

const TRANSCRIPT = '## Transcript\n\n**Mara Quill** [~00:00:00] Morning, Tobias. ^t0001\n';
const KEY = 'meeting:gemini:gemini-1a2b:transcript:abcd';

function bodyOf(shape: Shape): string {
  const parts = ['# Larkspur weekly', ''];
  if (shape.summaryTrace === 'block') {
    parts.push(
      '<!-- atlas:summary v1 -->',
      '> [!summary] Summary (Claude, 2026-10-28)',
      '> Go-live moves a week.',
      '<!-- /atlas:summary -->',
      '',
    );
  } else if (shape.summaryTrace === 'fenced-marker') {
    parts.push('```', '<!-- atlas:summary v1 -->', '```', '');
  } else if (shape.summaryTrace === 'unclosed') {
    parts.push('<!-- atlas:summary v1 -->', '> [!summary] Summary (Claude, 2026-10-28)', '');
  }
  parts.push(shape.hasTurns ? TRANSCRIPT : '## Transcript\n\n');
  return parts.join('\n');
}

const DATES: readonly unknown[] = [
  null,
  undefined,
  '2026-10-29',
  '2026-10-28',
  '2026-10-15',
  '2026-10-14',
  '2026-09-01',
  '2026-11-05',
  '',
  'yesterday',
  '10/28/2026',
  20261028,
  Number.NaN,
  true,
  { day: '2026-10-28' },
];

function shapeOf(rng: Rng): Shape {
  return {
    path: pick(rng, [
      'Inbox/Meetings/2026-10-28 Larkspur weekly.md',
      'Meetings/2026/10/2026-10-28 Larkspur weekly.md',
      'Archive/Meetings/2026-10-28 Larkspur weekly.md',
      'archive/Meetings/2026-10-28 Larkspur weekly.md',
      'Meetings/Renamed – Café sync.md',
    ]),
    importOutcome: pick(rng, [
      'imported',
      'imported',
      'imported',
      'duplicate',
      'error',
      null,
    ] as const),
    date: pick(rng, DATES),
    hasTurns: rng() < 0.75,
    summaryTrace: pick(rng, [
      'none',
      'none',
      'none',
      'block',
      'fenced-marker',
      'unclosed',
      'digest-only',
    ] as const),
    answered: pick(rng, [
      'never',
      'answered',
      'answered-stored',
      'stored-only',
      'stale-other-path',
    ] as const),
  };
}

function ledgerFor(shape: Shape, from: string): PostProcessingLedger {
  const answered = new Set<string>();
  const stored = new Set<string>();
  if (shape.answered === 'answered' || shape.answered === 'answered-stored')
    answered.add(shape.path);
  if (shape.answered === 'answered-stored' || shape.answered === 'stored-only') stored.add(KEY);
  // A ledger entry left by the meeting's old path, from before it was renamed or moved.
  if (shape.answered === 'stale-other-path') answered.add('Meetings/Old name.md');
  return { summarising: true, from, answered, stored };
}

/** The oracle: what "pending" means, said from the note's shape and the rule's day-only reach. */
function expectedPending(shape: Shape, from: string): boolean {
  if (shape.summaryTrace !== 'none') return false;
  if (shape.path.toLowerCase().startsWith('archive/')) return false;
  if (shape.importOutcome !== 'imported' || !shape.hasTurns) return false;
  if (typeof shape.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(shape.date)) return false;
  if (shape.date < from) return false;
  return shape.answered !== 'answered';
}

describe('postProcessingPending over seeded meeting shapes (attack on PR #637)', () => {
  it('agrees with the oracle for every shape, date and ledger state', () => {
    const rng = seeded(1820);
    const from = meetingReachFrom('FROM meeting WHERE date >= @-14d', TODAY);
    for (let round = 0; round < 1500; round += 1) {
      const shape = shapeOf(rng);
      const properties: Record<string, unknown> = { type: 'meeting' };
      if (shape.date !== undefined) properties['date'] = shape.date;
      if (shape.summaryTrace === 'digest-only') properties[SUMMARY_DIGEST_KEY] = 'sha256:00';
      const facts = postProcessingFactsOf({ body: bodyOf(shape), properties, key: KEY });
      const got = postProcessingPending({
        path: shape.path,
        importOutcome: shape.importOutcome,
        facts,
        ledger: ledgerFor(shape, from),
      });
      expect(got, JSON.stringify(shape)).toBe(expectedPending(shape, from));
    }
  });

  it('is never pending with no rule that writes summaries, whatever the meeting', () => {
    const rng = seeded(1821);
    for (let round = 0; round < 300; round += 1) {
      const shape = shapeOf(rng);
      const facts = postProcessingFactsOf({
        body: bodyOf(shape),
        properties: { date: shape.date },
        key: KEY,
      });
      const ledger = { ...ledgerFor(shape, FLOOR), summarising: false };
      expect(
        postProcessingPending({
          path: shape.path,
          importOutcome: shape.importOutcome,
          facts,
          ledger,
        }),
      ).toBe(false);
    }
  });
});

describe('postProcessingPending: a `date` the rule takes in a form the facts do not read (attack on PR #637)', () => {
  const ledger: PostProcessingLedger = {
    summarising: true,
    from: FLOOR,
    answered: new Set(),
    stored: new Set(),
  };
  const judged = (date: unknown) =>
    postProcessingPending({
      path: 'Meetings/2026-10-28 Larkspur weekly.md',
      importOutcome: 'imported',
      facts: postProcessingFactsOf({
        body: `# Larkspur weekly\n\n${TRANSCRIPT}`,
        properties: { date },
        key: KEY,
      }),
      ledger,
    });

  it('is pending for a meeting whose date was edited to a time with a zone, which the rule still takes by its day', () => {
    // The rule compares `substr(date, 1, 10)`: 2026-10-28 is in reach, and its summary still comes.
    expect(judged('2026-10-28T10:00:00-04:00')).toBe(true);
  });
});
