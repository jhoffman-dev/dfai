import { describe, expect, it } from 'vitest';
import { createVaultPath } from '../vault/vault-path.ts';
import { activityEvent, MAX_ACTIVITY_NOTES, type ActivityEvent } from './activity-event.ts';
import {
  ACTIVITY_MAX_AGE_MS,
  ACTIVITY_MAX_BYTES,
  ACTIVITY_TRIM_TO_BYTES,
  activityLine,
  activityText,
  boundActivity,
  hasExpiredActivity,
  isOverActivityBound,
  parseActivityLog,
  utf8Length,
} from './activity-file.ts';

const NOW = Date.UTC(2026, 8, 28, 12);
const DAY = 86_400_000;

const line = (
  at: number,
  message = 'Ran',
  level: ActivityEvent['level'] = 'info',
): ActivityEvent => ({
  at,
  level,
  kind: 'automation',
  message,
  subject: { kind: 'rule', path: createVaultPath('.atlas/automations/Tidy.md') },
});

describe('the file', () => {
  it('writes one event per line and reads it back as it was', () => {
    const events = [line(NOW - 2000, 'first'), line(NOW - 1000, 'second', 'error')];
    const text = activityText(events);
    expect(text.split('\n')).toHaveLength(3);
    expect(text.endsWith('\n')).toBe(true);
    expect(parseActivityLog(text)).toEqual(events);
  });

  it('keeps a subjectless event as one', () => {
    const plain: ActivityEvent = { ...line(NOW), subject: null };
    expect(parseActivityLog(activityLine(plain))).toEqual([plain]);
  });

  it('skips a torn or foreign line and keeps the rest', () => {
    const text = [
      activityLine(line(NOW - 3000, 'kept one')).trimEnd(),
      '{"at": 17, "level": "inf', // cut off by a crash mid-append
      'not json at all',
      '[1, 2, 3]',
      'null',
      '{"at": "yesterday", "level": "info", "kind": "app", "message": "x", "subject": null}',
      '{"at": 1, "level": "loud", "kind": "app", "message": "x", "subject": null}',
      '{"at": 1, "level": "info", "kind": "mystery", "message": "x", "subject": null}',
      '{"at": 1, "level": "info", "kind": "app", "message": 42, "subject": null}',
      '{"at": Infinity, "level": "info", "kind": "app", "message": "x", "subject": null}',
      activityLine(line(NOW - 1000, 'kept two')).trimEnd(),
    ].join('\n');
    expect(parseActivityLog(text).map((event) => event.message)).toEqual(['kept one', 'kept two']);
  });

  it('keeps a line whose subject is unusable, without the subject', () => {
    const text = [
      '{"at": 1, "level": "info", "kind": "app", "message": "a", "subject": {"kind": "note", "path": "/etc/passwd"}}',
      '{"at": 2, "level": "info", "kind": "app", "message": "b", "subject": {"kind": "planet", "path": "a.md"}}',
      '{"at": 3, "level": "info", "kind": "app", "message": "c", "subject": {"kind": "note", "path": 7}}',
      '{"at": 4, "level": "info", "kind": "app", "message": "d", "subject": "a.md"}',
    ].join('\n');
    const read = parseActivityLog(text);
    expect(read.map((event) => event.message)).toEqual(['a', 'b', 'c', 'd']);
    expect(read.every((event) => event.subject === null)).toBe(true);
  });

  it('makes a hand-written line safe as it is read', () => {
    const text =
      '{"at": 1, "level": "error", "kind": "app", "message": "failed at /Users/j/Vault/a.md\\nwith Bearer abcdefghijkl", "subject": null}';
    const [read] = parseActivityLog(text);
    expect(read?.message).toBe('failed at <path> with Bearer <secret>');
  });

  it('reads an empty file as no events', () => {
    expect(parseActivityLog('')).toEqual([]);
    expect(parseActivityLog('\n\n')).toEqual([]);
  });
});

describe('the bound', () => {
  it('is over only past 5 MB', () => {
    expect(isOverActivityBound(ACTIVITY_MAX_BYTES)).toBe(false);
    expect(isOverActivityBound(ACTIVITY_MAX_BYTES + 1)).toBe(true);
  });

  it('keeps a line exactly 30 days old and drops one older', () => {
    const kept = line(NOW - ACTIVITY_MAX_AGE_MS, 'just in');
    const dropped = line(NOW - ACTIVITY_MAX_AGE_MS - 1, 'just out');
    // Age is measured from the newest line (A28-01); one dated now makes that the clock.
    const current = line(NOW, 'now');
    expect(boundActivity([dropped, kept, current], NOW)).toEqual([kept, current]);
    expect(hasExpiredActivity([dropped, kept, current], NOW)).toBe(true);
    expect(hasExpiredActivity([kept, current], NOW)).toBe(false);
  });

  it('leaves a file under its bound as it is', () => {
    const events = [line(NOW - 2 * DAY), line(NOW - DAY), line(NOW)];
    expect(boundActivity(events, NOW)).toEqual(events);
  });

  it('cuts a file over 5 MB back to 4 MB, dropping the oldest first', () => {
    const message = 'x'.repeat(250);
    const size = utf8Length(activityLine(line(NOW, message)));
    const count = Math.ceil(ACTIVITY_MAX_BYTES / size) + 10;
    const events = Array.from({ length: count }, (_, at) => line(NOW - count + at, message));
    const kept = boundActivity(events, NOW);
    const bytes = utf8Length(activityText(kept));
    expect(bytes).toBeLessThanOrEqual(ACTIVITY_TRIM_TO_BYTES);
    expect(bytes).toBeGreaterThan(ACTIVITY_TRIM_TO_BYTES - size);
    // The newest are kept, in order, with nothing missing between them.
    expect(kept.at(-1)).toEqual(events.at(-1));
    expect(kept).toEqual(events.slice(events.length - kept.length));
  });

  it('counts bytes as UTF-8', () => {
    expect(utf8Length('a')).toBe(1);
    expect(utf8Length('é')).toBe(2);
    expect(utf8Length('→')).toBe(3);
    expect(utf8Length('😀')).toBe(4);
  });
});

describe('the bound when the clock is wrong', () => {
  it('measures age against the newest line, so a clock run ahead keeps the log', () => {
    const events = [line(NOW - 2 * DAY), line(NOW)];
    const aYearOn = NOW + 365 * DAY;
    expect(boundActivity(events, aYearOn)).toEqual(events);
    expect(hasExpiredActivity(events, aYearOn)).toBe(false);
  });

  it('still drops a line a month older than the newest one', () => {
    const old = line(NOW - 40 * DAY, 'old');
    const newest = line(NOW - 5 * DAY, 'newest');
    expect(boundActivity([old, newest], NOW + 60 * DAY)).toEqual([newest]);
    expect(hasExpiredActivity([old, newest], NOW + 60 * DAY)).toBe(true);
  });

  it('drops a line dated more than a month ahead of the clock, and measures the rest by the clock', () => {
    const kept = line(NOW - DAY, 'kept');
    const soon = line(NOW + DAY, 'a day ahead');
    const farAhead = line(NOW + ACTIVITY_MAX_AGE_MS + 1, 'far ahead');
    expect(boundActivity([kept, soon, farAhead], NOW)).toEqual([kept, soon]);
    expect(hasExpiredActivity([kept, soon, farAhead], NOW)).toBe(true);
    expect(hasExpiredActivity([kept, soon], NOW)).toBe(false);
  });
});

describe('the notes a line is about besides its subject (#192)', () => {
  const MEETING = 'Inbox/Meetings/2026-10-06 Standup.md';
  const ran = (notes: readonly string[]) =>
    activityEvent({
      at: 1,
      level: 'info',
      kind: 'automation',
      message: 'After a meeting: Ran.',
      subject: null,
      notes: notes.map((note) => note as ReturnType<typeof createVaultPath>),
    });

  it('are kept in the file and read back', () => {
    const event = ran([MEETING]);
    expect(event.notes).toEqual([MEETING]);
    expect(parseActivityLog(activityLine(event))).toEqual([event]);
  });

  it('are left out of a line about none, as lines were before', () => {
    expect(activityLine(ran([]))).not.toContain('notes');
    expect(parseActivityLog(activityLine(ran([])))[0]).not.toHaveProperty('notes');
  });

  it('keep only paths inside the vault, no chat note, each once, at most twenty', () => {
    const many = Array.from({ length: MAX_ACTIVITY_NOTES + 5 }, (_, at) => `M${at}.md`);
    expect(
      ran(['/Users/someone/Vault/A.md', '../B.md', 'Chats/Private.md', MEETING, MEETING]).notes,
    ).toEqual([MEETING]);
    expect(ran(many).notes).toHaveLength(MAX_ACTIVITY_NOTES);
  });

  it('drop what a hand-edited file holds that is not a path', () => {
    const text = `${JSON.stringify({ at: 1, level: 'info', kind: 'app', message: 'M', subject: null, notes: [3, MEETING, null] })}\n`;
    expect(parseActivityLog(text)[0]?.notes).toEqual([MEETING]);
    const notList = `${JSON.stringify({ at: 1, level: 'info', kind: 'app', message: 'M', subject: null, notes: 'A.md' })}\n`;
    expect(parseActivityLog(notList)[0]).not.toHaveProperty('notes');
  });
});
