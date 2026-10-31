/**
 * The Activity log as it is kept (U-28): one JSON object per line, oldest
 * first, appended to and never edited in place — and bounded, so a month of
 * failures cannot fill the disk.
 *
 * The bound is decided here; the host only appends and rewrites the bytes it
 * is handed (ADR-0005).
 */

import {
  ACTIVITY_KINDS,
  ACTIVITY_LEVELS,
  ACTIVITY_SUBJECT_KINDS,
  activityEvent,
  insideVault,
  type ActivityEvent,
  type ActivityKind,
  type ActivityLevel,
  type ActivitySubject,
  type ActivitySubjectKind,
} from './activity-event.ts';
import type { VaultPath } from '../vault/vault-path.ts';

const DAY_MS = 86_400_000;

/** How long a line is kept. */
export const ACTIVITY_MAX_AGE_MS = 30 * DAY_MS;

/** The most the file may hold, in bytes. */
export const ACTIVITY_MAX_BYTES = 5 * 1024 * 1024;

/**
 * What a file over the bound is cut back to. Below the bound, so the appends
 * that follow a trim do not each set off another rewrite of 5 MB.
 */
export const ACTIVITY_TRIM_TO_BYTES = 4 * 1024 * 1024;

/** A line of the file, newline included. */
export function activityLine(event: ActivityEvent): string {
  const { at, level, kind, message, subject, notes } = event;
  return `${JSON.stringify({ at, level, kind, message, subject, ...(notes !== undefined && { notes }) })}\n`;
}

/**
 * The lines of a file, oldest first. A line that is not an event — cut off by
 * a crash mid-append, or edited by hand — is skipped rather than losing the
 * rest; each one read is made safe again, since the file could have been
 * written by anything.
 */
export function parseActivityLog(text: string): ActivityEvent[] {
  return text.split('\n').flatMap((line) => {
    const event = parseLine(line);
    return event === null ? [] : [event];
  });
}

function parseLine(line: string): ActivityEvent | null {
  if (line.trim() === '') return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    // A torn or hand-edited line: skipping it is the point of one event per line.
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { at, level, kind, message, subject, notes } = value as Record<string, unknown>;
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  if (!isOneOf(ACTIVITY_LEVELS, level) || !isOneOf(ACTIVITY_KINDS, kind)) return null;
  if (typeof message !== 'string') return null;
  return activityEvent({
    at,
    level: level as ActivityLevel,
    kind: kind as ActivityKind,
    message,
    subject: parseSubject(subject),
    notes: parseNotes(notes),
  });
}

function parseSubject(value: unknown): ActivitySubject | null {
  if (typeof value !== 'object' || value === null) return null;
  const { kind, path } = value as Record<string, unknown>;
  if (!isOneOf(ACTIVITY_SUBJECT_KINDS, kind) || typeof path !== 'string') return null;
  const inside = insideVault(path);
  return inside === null ? null : { kind: kind as ActivitySubjectKind, path: inside };
}

/** The notes a line is about besides its subject: each a path inside the vault, the rest dropped. */
function parseNotes(value: unknown): VaultPath[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((note: unknown) =>
    typeof note === 'string' ? (insideVault(note) ?? []) : [],
  );
}

function isOneOf(options: readonly string[], value: unknown): boolean {
  return typeof value === 'string' && options.includes(value);
}

/** Whether a file of this many bytes must be cut back. */
export function isOverActivityBound(bytes: number): boolean {
  return bytes > ACTIVITY_MAX_BYTES;
}

/** Whether any line is too old, or too far ahead, to keep: the file is then rewritten without it. */
export function hasExpiredActivity(events: readonly ActivityEvent[], now: number): boolean {
  return currentActivity(events, now).length < events.length;
}

/**
 * The lines not expired. A line more than a month ahead of the clock was
 * dated by a clock since corrected, and goes. The rest are aged against the
 * newest of them, or the clock if it is earlier — so a clock that jumps ahead
 * never empties the log, and a month-old line still goes once newer ones come.
 */
function currentActivity(events: readonly ActivityEvent[], now: number): ActivityEvent[] {
  const plausible = events.filter((event) => event.at - now <= ACTIVITY_MAX_AGE_MS);
  const newest = plausible.reduce((latest, event) => Math.max(latest, event.at), -Infinity);
  const reference = Math.min(now, newest);
  return plausible.filter((event) => reference - event.at <= ACTIVITY_MAX_AGE_MS);
}

/**
 * The lines to keep, oldest first: none expired (see {@link currentActivity}),
 * and — when the file is over its bound — the newest that fit in
 * {@link ACTIVITY_TRIM_TO_BYTES}. The oldest always go first.
 */
export function boundActivity(events: readonly ActivityEvent[], now: number): ActivityEvent[] {
  const recent = currentActivity(events, now);
  const lines = recent.map(activityLine);
  const total = lines.reduce((sum, line) => sum + utf8Length(line), 0);
  if (!isOverActivityBound(total)) return recent;
  let size = total;
  let first = 0;
  while (first < lines.length && size > ACTIVITY_TRIM_TO_BYTES) {
    size -= utf8Length(lines[first] ?? '');
    first += 1;
  }
  return recent.slice(first);
}

/** The whole file for these lines. */
export function activityText(events: readonly ActivityEvent[]): string {
  return events.map(activityLine).join('');
}

/** How many bytes a string takes as UTF-8, which is what the file's bound counts. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}
