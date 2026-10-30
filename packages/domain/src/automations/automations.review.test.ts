/**
 * A25-01's review findings on Phase 25's domain: a rule file and its log are
 * text anyone could have written or synced, so each rule here is about what
 * that text may and may not make DFAI do. Pure; the clock is a fixed string.
 */
import { describe, expect, it } from 'vitest';
import { parseAtlasQuery } from '../query-language/parse.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import { backoffMinutes, nextRunOf, unavailableBackoffMinutes } from './automation-due.ts';
import { automationQuery } from './automation-query.ts';
import {
  automationIdFor,
  parseAutomationRule,
  setKeyProblem,
  wouldChange,
  type AutomationRule,
} from './automation-rule.ts';
import {
  appendLogEntry,
  futureMarkOf,
  lastScheduleMark,
  logEntrySummary,
  logPathFor,
  MAX_LOG_BYTES,
  parseRunLog,
  type LogEntry,
} from './run-log.ts';
import { loggedActionProblem, unarchiveProblem } from './undo-check.ts';

const p = createVaultPath;
const PATH = p('.atlas/automations/Tidy.md');
const FILE = {
  atlas: 'automation',
  name: 'Tidy',
  enabled: true,
  when: 'daily at 03:00',
  which: 'FROM task WHERE status = done',
  do: 'archive',
};

const RULE: AutomationRule = {
  id: 'Tidy',
  path: PATH,
  name: 'Tidy',
  enabled: true,
  when: { kind: 'daily', at: '03:00' },
  which: 'FROM task',
  olderThanDays: null,
  action: { kind: 'archive' },
};

const ARCHIVE = { kind: 'archive' } as const;
const FLAG = { kind: 'set', values: { flagged: true } } as const;

/** The instant the clock gives when a test appends. */
const NOW = Date.UTC(2026, 8, 27, 3);

describe('enabled, as a sync tool or a hand edit writes it', () => {
  it.each(['yes', 'true', 1, 'on'])(
    'lists enabled: %j as broken, saying what to write',
    (value) => {
      const read = parseAutomationRule(PATH, { ...FILE, enabled: value });
      expect('broken' in read && read.broken.problem).toMatch(/enabled: true or false/);
    },
  );

  it('still reads true and false, and a rule that does not say as off', () => {
    const on = parseAutomationRule(PATH, FILE);
    const off = parseAutomationRule(PATH, { ...FILE, enabled: false });
    const unsaid = parseAutomationRule(PATH, { ...FILE, enabled: undefined });
    expect('rule' in on && on.rule.enabled).toBe(true);
    expect('rule' in off && off.rule.enabled).toBe(false);
    expect('rule' in unsaid && unsaid.rule.enabled).toBe(false);
  });
});

describe('a rule’s stable id', () => {
  it('reads the id the file gives, and names the log after it', () => {
    const read = parseAutomationRule(PATH, { ...FILE, id: 'tidy-7' });
    expect('rule' in read && read.rule.id).toBe('tidy-7');
    expect('rule' in read && read.idWritten).toBe(true);
    expect(logPathFor('tidy-7')).toBe('.atlas/automations/log/tidy-7.md');
  });

  it('gives a rule without one the name its log was already kept under', () => {
    const read = parseAutomationRule(p('.atlas/automations/Tidy up.md'), FILE);
    expect('rule' in read && read.rule.id).toBe('Tidy up');
    expect('rule' in read && read.idWritten).toBe(false);
  });

  it('reads a number an id was written as as its digits', () => {
    const read = parseAutomationRule(PATH, { ...FILE, id: 7 });
    expect('rule' in read && read.rule.id).toBe('7');
  });

  it.each(['../../Diary', 'a/b', '.hidden', '', 'a:b', '  '])(
    'lists a rule whose id could name a file elsewhere (%j) as broken',
    (id) => {
      const read = parseAutomationRule(PATH, { ...FILE, id });
      expect('broken' in read).toBe(true);
    },
  );

  it('gives a new rule an id no log is kept under yet, whatever its case', () => {
    expect(automationIdFor('Tidy', [])).toBe('Tidy');
    expect(automationIdFor('Tidy', ['tidy'])).toBe('Tidy 2');
    expect(automationIdFor('Tidy', ['Tidy', 'Tidy 2'])).toBe('Tidy 3');
  });

  it('counts an id taken in the other Unicode form as taken, as the disk does', () => {
    const nfd = 'Cafe\u0301';
    expect(automationIdFor('Caf\u00e9', [nfd])).toBe('Caf\u00e9 2');
  });
});

describe('keys a set rule may name', () => {
  it.each(['__proto__', 'constructor', 'prototype'])('refuses %j', (key) => {
    expect(setKeyProblem(key)).not.toBeNull();
  });
});

describe('wouldChange: what a run leaves out before it counts to the cap', () => {
  it('is false for a note that already holds every value the rule sets', () => {
    expect(wouldChange(FLAG, { flagged: true, other: 1 })).toBe(false);
    expect(
      wouldChange({ kind: 'set', values: { a: 1, b: 'x' } }, { a: 1, b: 'x', flagged: false }),
    ).toBe(false);
  });

  it('is true when any value differs, is missing, or holds another type', () => {
    expect(wouldChange(FLAG, {})).toBe(true);
    expect(wouldChange(FLAG, { flagged: 'true' })).toBe(true);
    expect(wouldChange({ kind: 'set', values: { a: 1, b: 'x' } }, { a: 1, b: 'y' })).toBe(true);
  });

  it('is true for every note an archive rule matched: the plan decides which it refuses', () => {
    expect(wouldChange(ARCHIVE, { archived: '2026-01-01' })).toBe(true);
  });
});

describe('automationQuery: the window a run plans over', () => {
  const pinned = (text: string, action = ARCHIVE as AutomationRule['action']) =>
    automationQuery({
      query: parseAtlasQuery(text),
      today: '2026-09-27',
      olderThanDays: null,
      action,
    });

  it('leaves archived notes out of an archive rule’s query, even when it says INCLUDE ARCHIVED', () => {
    expect(pinned('FROM task INCLUDE ARCHIVED').includeArchived).toBe(false);
    expect(pinned('FROM task INCLUDE ARCHIVED', FLAG).includeArchived).toBe(true);
  });

  it('asks for more than one run may do, so no-ops can be left out before the cap', () => {
    expect(pinned('FROM task').limit).toBeGreaterThan(501);
    expect(pinned('FROM task LIMIT 20').limit).toBe(20);
  });
});

describe('the log’s entries', () => {
  const set = (note: string, key: string) => ({
    kind: 'set' as const,
    path: p(`Tasks/${note}.md`),
    key,
    before: { absent: true } as const,
    after: { value: true },
  });

  it('says a capped run stopped at the notes it changed, not the keys', () => {
    const entry: LogEntry = {
      kind: 'run',
      at: '2026-09-27T03:00:00',
      trigger: 'schedule',
      done: [set('A', 'a'), set('A', 'b'), set('B', 'a'), set('B', 'b')],
      left: [],
      capped: true,
    };
    expect(logEntrySummary(entry)).toContain('Stopped at 2,');
  });

  it('keeps a section a person wrote when the oldest entries go', () => {
    const run = (second: number): LogEntry => ({
      kind: 'run',
      at: `2026-09-27T03:00:0${second}`,
      trigger: 'hand',
      done: [],
      left: [],
      capped: false,
    });
    let text = appendLogEntry({ text: null, ruleName: 'Tidy', entry: run(1), now: NOW });
    text += '\n## My notes\n\nWhy this rule exists.\n';
    text = appendLogEntry({ text, ruleName: 'Tidy', entry: run(2), now: NOW, keep: 2 });
    text = appendLogEntry({ text, ruleName: 'Tidy', entry: run(3), now: NOW, keep: 2 });
    expect(text).toContain('## My notes\n\nWhy this rule exists.');
    expect(parseRunLog(text).map((entry) => entry.at)).toEqual([
      '2026-09-27T03:00:02',
      '2026-09-27T03:00:03',
    ]);
  });

  // Slow by design: 60 appends rewrite a log at its 256 KB cap; over 5 s on a loaded machine.
  it('keeps the log under its size in bytes, however long each entry is', () => {
    const busy = (minute: number): LogEntry => ({
      kind: 'run',
      at: `2026-09-27T03:${String(minute).padStart(2, '0')}:00`,
      trigger: 'hand',
      done: Array.from({ length: 200 }, (_, n) => set(`Note ${n} ${'x'.repeat(40)}`, 'flagged')),
      left: [],
      capped: false,
    });
    let text: string | null = null;
    for (let minute = 0; minute < 60; minute += 1) {
      text = appendLogEntry({ text, ruleName: 'Tidy', entry: busy(minute), now: NOW });
    }
    expect(new TextEncoder().encode(text!).length).toBeLessThanOrEqual(MAX_LOG_BYTES);
    expect(parseRunLog(text!).at(-1)?.at).toBe('2026-09-27T03:59:00');
  }, 60_000);

  it('writes a first-seen mark, which the schedule counts from', () => {
    const seen: LogEntry = { kind: 'seen', at: '2026-09-27T09:00:00' };
    const text = appendLogEntry({ text: null, ruleName: 'Tidy', entry: seen, now: NOW });
    expect(parseRunLog(text)).toEqual([seen]);
    expect(lastScheduleMark([seen], '2026-09-28T09:00:00')).toBe('2026-09-27T09:00:00');
  });
});

describe('marks later than now', () => {
  const ahead: LogEntry = { kind: 'turnedOn', at: '2026-10-27T03:00:00' };

  it('are not counted from, and are named so the page can say so', () => {
    expect(lastScheduleMark([ahead], '2026-09-29T03:00:00')).toBeNull();
    expect(futureMarkOf([ahead], '2026-09-29T03:00:00')).toBe('2026-10-27T03:00:00');
    expect(futureMarkOf([ahead], '2026-10-28T03:00:00')).toBeNull();
  });

  it('do not push the next run a month out', () => {
    const next = nextRunOf({
      rule: RULE,
      log: [ahead],
      watchingSince: '2026-09-29T02:00:00',
      now: '2026-09-29T02:30:00',
    });
    expect(next).toBe('2026-09-29T03:00:00');
  });
});

describe('backoffMinutes: how long a failing rule waits before it is tried again', () => {
  it('doubles with each failure in a row, up to six hours', () => {
    expect([1, 2, 3, 4, 10, 40].map(backoffMinutes)).toEqual([1, 2, 4, 8, 360, 360]);
  });

  it('waits a quarter of an hour at most while Claude cannot be reached (#637 review)', () => {
    expect([1, 2, 3, 4, 5, 10].map(unavailableBackoffMinutes)).toEqual([1, 2, 4, 8, 15, 15]);
  });
});

describe('loggedActionProblem: whether a log line is something this rule could have done', () => {
  const setLine = (key: string, before: unknown, after: unknown = true) => ({
    kind: 'set' as const,
    path: p('Tasks/A.md'),
    key,
    before: before === undefined ? ({ absent: true } as const) : { value: before },
    after: { value: after },
  });
  const archived = (from: string, to: string) => ({
    kind: 'archived' as const,
    from: p(from),
    to: p(to),
  });

  it('lets an archive rule undo a move into the Archive, and nothing else', () => {
    expect(loggedActionProblem(ARCHIVE, archived('Tasks/A.md', 'Archive/Tasks/A.md'))).toBeNull();
    expect(loggedActionProblem(ARCHIVE, setLine('flagged', undefined))).not.toBeNull();
    expect(
      loggedActionProblem(ARCHIVE, archived('Tasks/A.md', 'Elsewhere/Tasks/A.md')),
    ).not.toBeNull();
    expect(
      loggedActionProblem(ARCHIVE, archived('.atlas/views/Board.md', 'Archive/Board.md')),
    ).not.toBeNull();
  });

  it('lets a set rule undo only its own keys, to plain values', () => {
    expect(loggedActionProblem(FLAG, setLine('flagged', undefined))).toBeNull();
    expect(loggedActionProblem(FLAG, setLine('flagged', null))).toBeNull();
    expect(loggedActionProblem(FLAG, setLine('flagged', ['a', 1]))).toBeNull();
    expect(loggedActionProblem(FLAG, setLine('status', 'doing'))).not.toBeNull();
    expect(loggedActionProblem(FLAG, setLine('flagged', { nested: 'map' }))).not.toBeNull();
    expect(loggedActionProblem(FLAG, setLine('flagged', false, { x: 1 }))).not.toBeNull();
    expect(loggedActionProblem(FLAG, archived('Tasks/A.md', 'Archive/Tasks/A.md'))).not.toBeNull();
  });

  it('refuses a key no rule may set, even one a rule file lists', () => {
    const values = { type: 'x', flagged: true } as Record<string, true | string>;
    expect(loggedActionProblem({ kind: 'set', values }, setLine('type', 'note'))).not.toBeNull();
  });

  it('refuses a line naming one of DFAI’s own files', () => {
    const line = { ...setLine('flagged', undefined), path: p('.atlas/views/Board.md') };
    expect(loggedActionProblem(FLAG, line)).not.toBeNull();
  });
});

describe('unarchiveProblem: whether the note in the Archive is the one this run put there', () => {
  const from = p('Tasks/A.md');
  const runAt = '2026-09-27T03:00:00';

  it('is null when the note’s stamp is the run’s day and where it came from', () => {
    const properties = { archived: '2026-09-27', archivedFrom: 'Tasks/A.md' };
    expect(unarchiveProblem({ runAt, from, properties })).toBeNull();
  });

  it('names a note archived on another day, or from somewhere else, or not stamped', () => {
    expect(
      unarchiveProblem({ runAt, from, properties: { archived: '2026-01-05', archivedFrom: from } }),
    ).not.toBeNull();
    expect(
      unarchiveProblem({
        runAt,
        from,
        properties: { archived: '2026-09-27', archivedFrom: 'Private/A.md' },
      }),
    ).not.toBeNull();
    expect(unarchiveProblem({ runAt, from, properties: {} })).not.toBeNull();
  });
});
