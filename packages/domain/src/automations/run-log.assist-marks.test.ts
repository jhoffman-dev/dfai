import { describe, expect, it } from 'vitest';
import { createVaultPath } from '../vault/vault-path.ts';
import {
  appendEntryToLog,
  isAssistMark,
  openAssistRows,
  parseAssistLog,
  type LogEntry,
  type LoggedEntry,
} from './run-log.ts';

/**
 * #911, round 3: which Inbox assist rows the log leaves open — begun, or begun
 * again by an undo, and not closed — and that trimming a long log never drops
 * an open row's marks, which are what a crash left to read.
 */

const ITEM = createVaultPath('Inbox/Call Mara.md');
const at = (second: number) => `2026-11-17T09:00:${String(second).padStart(2, '0')}`;
const begun = (row: string, second = 0): LoggedEntry => ({
  kind: 'begun',
  at: at(second),
  row,
  path: ITEM,
  digest: '0a1b2c3d',
  plan: 'Made it a task.',
});
const step = (row: string, second = 1): LoggedEntry => ({
  kind: 'step',
  at: at(second),
  row,
  done: [],
  about: { doing: 'write', path: ITEM },
});
const ran = (row: string, second = 2): LogEntry => ({
  kind: 'run',
  at: at(second),
  trigger: 'hand',
  done: [],
  left: [],
  capped: false,
  row,
});

describe('openAssistRows', () => {
  it('leaves open a row begun and not closed, and a row an undo began again', () => {
    const entries: LoggedEntry[] = [
      begun('a'),
      step('a'),
      ran('a'),
      begun('b'),
      step('b'),
      begun('a', 3),
      step('a', 4),
      begun('c'),
      ran('c'),
    ];
    expect([...openAssistRows(entries)].sort()).toEqual(['a', 'b']);
  });

  it('closes a row put aside by hand, and one an undo finished', () => {
    const entries: LoggedEntry[] = [
      begun('a'),
      { kind: 'dismissed', at: at(5), row: 'a' },
      begun('b'),
      { kind: 'undo', at: at(6), of: at(0), done: [], left: [], row: 'b' },
    ];
    expect(openAssistRows(entries)).toEqual(new Set());
    expect(entries.filter(isAssistMark).map((entry) => entry.kind)).toEqual([
      'begun',
      'dismissed',
      'begun',
    ]);
  });
});

describe('a log trimmed past its length', () => {
  it('never drops an open row’s marks, however many closed entries follow', () => {
    let text: string | null = null;
    for (const entry of [begun('open'), step('open')]) {
      text = appendEntryToLog({ text, ruleName: 'Inbox assist', entry, now: 0 }).text;
    }
    for (let second = 0; second < 30; second += 1) {
      const entry = ran(`closed-${second}`, second % 60);
      text = appendEntryToLog({ text, ruleName: 'Inbox assist', entry, now: 0, keep: 5 }).text;
    }
    const entries = parseAssistLog(text!);
    expect(
      entries.filter((entry) => 'row' in entry && entry.row === 'open').map((entry) => entry.kind),
    ).toEqual(['begun', 'step']);
    expect(openAssistRows(entries)).toEqual(new Set(['open']));
    // The closed runs were trimmed as before: only the open row's marks are kept beyond the length.
    expect(entries.filter((entry) => entry.kind === 'run').length).toBeLessThanOrEqual(5);
  });

  it('reads back every intent and a put-aside as written', () => {
    const marks: LoggedEntry[] = [
      ...(['write', 'relink', 'create', 'folder', 'trash'] as const).map((doing): LoggedEntry => ({
        kind: 'step',
        at: at(1),
        row: 'r',
        done: [],
        about: { doing, path: ITEM },
      })),
      { kind: 'dismissed', at: at(2), row: 'r' },
      // With what the note held and what the write leaves it, by digest (round 4).
      {
        kind: 'step',
        at: at(3),
        row: 'r',
        done: [],
        about: { doing: 'relink', path: ITEM, holding: '0a1b2c3d', leaving: '4e5f6a7b' },
      },
      {
        kind: 'step',
        at: at(3),
        row: 'r',
        done: [],
        about: { doing: 'create', path: ITEM, leaving: '4e5f6a7b' },
      },
    ];
    let text: string | null = null;
    for (const entry of marks)
      text = appendEntryToLog({ text, ruleName: 'Inbox assist', entry, now: 0 }).text;
    expect(parseAssistLog(text!)).toEqual(marks);
  });
});
