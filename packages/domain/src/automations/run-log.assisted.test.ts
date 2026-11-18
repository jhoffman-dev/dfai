import { describe, expect, it } from 'vitest';
import { createVaultPath } from '../vault/vault-path.ts';
import { assistActivityReport } from '../inbox/assist-activity.ts';
import {
  logEntrySummary,
  newLogText,
  parseAssistLog,
  parseRunLog,
  type LogEntry,
} from './run-log.ts';

/**
 * #909: what Inbox assist's applies and undos write in its run log, read back
 * as written, and the Activity line each says.
 */

const ITEM = createVaultPath('Inbox/Call “Mara” → now.md');
const FILED = createVaultPath('Notes/2026/Call “Mara” → now.md');
const ARCHIVED = createVaultPath('Archive/Inbox/Renew.md');
const PERSON = createVaultPath('People/Tobias Fenn.md');

const applied: LogEntry = {
  kind: 'run',
  at: '2026-11-17T09:00:00',
  trigger: 'hand',
  done: [
    { kind: 'assisted', from: ITEM, to: FILED, digest: '0a1b2c3d' },
    { kind: 'assisted', from: createVaultPath('Inbox/Renew.md'), to: ARCHIVED, digest: 'ffff0000' },
    { kind: 'created', path: PERSON, digest: '12345678' },
  ],
  left: [],
  capped: false,
};
const undone: LogEntry = {
  kind: 'undo',
  at: '2026-11-17T09:05:00',
  of: '2026-11-17T09:00:00',
  done: [
    { kind: 'unassisted', from: FILED, to: ITEM },
    { kind: 'trashed', path: PERSON },
  ],
  left: [],
};

describe('the run log, for Inbox assist', () => {
  it('reads back what it wrote, a path with quotes and an arrow in it included', () => {
    const text = newLogText('Inbox assist', [applied, undone]);
    expect(text).toContain(
      '- assisted `"Inbox/Call “Mara” → now.md"` → `"Notes/2026/Call “Mara” → now.md"` at `"0a1b2c3d"`',
    );
    expect(parseRunLog(text)).toEqual([applied, undone]);
  });

  it('drops an assisted line whose digest is no text', () => {
    const text = newLogText('Inbox assist', [applied]).replace('`"0a1b2c3d"`', '`12`');
    const [read] = parseRunLog(text);
    expect(read).toMatchObject({ kind: 'run' });
    expect((read as Extract<LogEntry, { kind: 'run' }>).done).toHaveLength(2);
  });

  it('sums an apply and an undo up in words', () => {
    expect(logEntrySummary(applied)).toBe(
      'Clarified 1 Inbox item. Archived 1 duplicate. Made 1 note.',
    );
    expect(logEntrySummary(undone)).toBe('Took back 1 Inbox item. Trashed 1 note.');
  });
});

describe('assistActivityReport', () => {
  it('says one line for an apply, about the note where it is now', () => {
    const report = assistActivityReport({
      title: 'Call Mara',
      path: FILED,
      happened: { doing: 'apply', entry: applied, logged: true },
    });
    expect(report).toEqual({
      level: 'info',
      kind: 'automation',
      message:
        'Inbox assist applied “Call Mara”: Clarified 1 Inbox item. Archived 1 duplicate. Made 1 note.',
      subject: { kind: 'note', path: FILED },
    });
  });

  it('warns when the log could not be written, and when nothing was done', () => {
    const unlogged = assistActivityReport({
      title: 'Call Mara',
      path: ITEM,
      happened: { doing: 'undo', entry: undone, logged: false },
    });
    expect(unlogged).toMatchObject({
      level: 'warning',
      message: expect.stringMatching(/^Inbox assist undid .*Its log could not be written\.$/u),
    });
    const refused = assistActivityReport({
      title: 'Call Mara',
      path: ITEM,
      happened: { doing: 'undo', problem: 'it was changed since, so it was left as it is.' },
    });
    expect(refused).toMatchObject({
      level: 'warning',
      message:
        'Inbox assist could not undo “Call Mara”: it was changed since, so it was left as it is.',
    });
  });
});

describe('the run log, for what an Inbox assist row is about to do (#911)', () => {
  it('reads back each intent as written, and says it', () => {
    const row = '2026-11-17T09:00:00 Inbox/Renew.md 1.1';
    const marks = [
      {
        kind: 'step' as const,
        at: '2026-11-17T09:00:00',
        row,
        done: [],
        about: { doing: 'create' as const, path: PERSON },
      },
      {
        kind: 'step' as const,
        at: '2026-11-17T09:00:00',
        row,
        done: [],
        about: { doing: 'relink' as const, path: createVaultPath('Notes/Week.md') },
      },
      {
        kind: 'step' as const,
        at: '2026-11-17T09:00:00',
        row,
        done: [],
        about: { doing: 'move' as const, path: ITEM, to: FILED },
      },
    ];
    const text = newLogText('Inbox assist', marks);
    expect(text).toContain(`- about to move \`"${ITEM}"\` → \`"${FILED}"\``);
    expect(parseAssistLog(text)).toEqual(marks);
    expect(parseRunLog(text)).toEqual([]);
    expect(marks.map(logEntrySummary)).toEqual([
      'About to create Tobias Fenn.',
      'About to relink Week.',
      'About to move Call “Mara” → now.',
    ]);
  });
});
