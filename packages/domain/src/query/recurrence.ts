import { singleTextOf } from '../gtd/gtd-status.ts';

/**
 * When a repeating task comes round again.
 *
 * Deliberately small and literal: the forms people actually write in a note,
 * computed from the date the task was due rather than the date it was finished,
 * so a series does not drift every time it is completed late.
 */
export interface Recurrence {
  readonly unit: 'day' | 'week' | 'month' | 'year';
  readonly every: number;
}

const PATTERNS: readonly (readonly [RegExp, Recurrence['unit']])[] = [
  [/^(?:daily|every ?day)$/i, 'day'],
  [/^(?:weekly|every ?week)$/i, 'week'],
  [/^(?:monthly|every ?month)$/i, 'month'],
  [/^(?:yearly|annually|every ?year)$/i, 'year'],
];

const EVERY_N = /^every\s+(\d+)\s+(day|week|month|year)s?$/i;

/**
 * A recurrence as written, read by the one-value rule the index reads it by
 * (`singleTextOf`): `[every week]` and `["", every week]` repeat weekly; a
 * list of two rules is no rule.
 */
export function parseRecurrence(value: unknown): Recurrence | null {
  const text = singleTextOf(value)?.trim() ?? '';
  if (text === '') return null;

  for (const [pattern, unit] of PATTERNS) {
    if (pattern.test(text)) return { unit, every: 1 };
  }

  const every = EVERY_N.exec(text);
  if (every === null) return null;

  const count = Number(every[1]);
  if (!Number.isFinite(count) || count < 1) return null;
  return { unit: (every[2] ?? 'day').toLowerCase() as Recurrence['unit'], every: count };
}

/**
 * The next date in the series.
 *
 * Counted from the date given, not from today, so finishing a weekly task three
 * days late still puts the next one a week after it was due. A month that has no
 * such day — the 31st of a 30-day month — lands on the last day of that month
 * rather than spilling into the next.
 */
export function nextOccurrence(from: string, recurrence: Recurrence): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(from.trim());
  if (match === null) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const base = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(base.getTime())) return null;

  switch (recurrence.unit) {
    case 'day':
      base.setUTCDate(base.getUTCDate() + recurrence.every);
      break;
    case 'week':
      base.setUTCDate(base.getUTCDate() + recurrence.every * 7);
      break;
    case 'month':
      return addMonths(year, month, day, recurrence.every);
    case 'year':
      return addMonths(year, month, day, recurrence.every * 12);
  }

  return writtenDate(base);
}

/**
 * A date as `2026-09-20`, or null past 9999-12-31, where `toISOString` writes
 * an expanded year (`+010000-01-01`) that no date field can read back.
 */
function writtenDate(at: Date): string | null {
  if (Number.isNaN(at.getTime())) return null;
  const written = at.toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(written) ? written : null;
}

function addMonths(year: number, month: number, day: number, months: number): string | null {
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return writtenDate(target);
}
