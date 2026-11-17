import { describe, expect, it } from 'vitest';
import { createVaultPath } from '../vault/vault-path.ts';
import { readAssistAnswer } from './assist-answer.ts';
import { assistAllowance } from './assist-allowance.ts';
import { localTimeMs } from '../automations/schedule.ts';

/**
 * Adversarial pass on #903 (#900): answers that must be refused whole, and
 * the hourly allowance across a wall-clock change.
 */

const CALL = createVaultPath('Inbox/Call Mara Quill.md');
const ARTICLE = createVaultPath('Inbox/Payroll article.md');

const entry = (item: string, extra: Record<string, unknown> = {}) => ({
  item,
  kind: 'task',
  projects: [],
  due: null,
  waitingOn: null,
  confidence: 'high',
  why: 'It asks for a call.',
  ...extra,
});
const read = (entries: unknown[], asked = [CALL]) =>
  readAssistAnswer(JSON.stringify({ items: entries }), asked);

describe('attack-903: why is one line of plain text', () => {
  it.each([
    ['a right-to-left override', 'Fine ‮.knuj si sihT'],
    ['a line separator', 'First line Second line'],
    ['a paragraph separator', 'First Second'],
    ['a next-line control', 'First\u0085Second'],
    ['a NUL', 'Looks\u0000fine'],
    ['a zero-width space', 'Looks​fine'],
    ['a vertical tab', 'First\u000BSecond'],
  ])('a why holding %s is never shown (#903 round 3: one item, not the batch)', (name, why) => {
    const outcome = read([entry(CALL, { why })]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value[0]!.why).toBeNull();
    // A zero-width space hides only the reason; the others make the item a question.
    expect(outcome.value[0]!.unshowable).toBe(name !== 'a zero-width space');
  });
});

describe('attack-903: held shapes (expected to pass)', () => {
  it('refuses a __proto__ key in an entry', () => {
    const text = JSON.stringify({ items: [entry(CALL)] }).replace(
      '"why"',
      '"__proto__":{"confidence":"high"},"why"',
    );
    expect(readAssistAnswer(text, [CALL]).ok).toBe(false);
  });

  it('refuses an entry for an item twice with different content', () => {
    expect(read([entry(CALL), entry(CALL, { kind: 'junk' })]).ok).toBe(false);
  });

  it('refuses an item it was not asked about, by case or a trailing space', () => {
    expect(read([entry('inbox/call mara quill.md')]).ok).toBe(false);
    expect(read([entry(`${CALL} `)]).ok).toBe(false);
  });

  it('refuses an answer that leaves one asked item out', () => {
    expect(read([entry(CALL)], [CALL, ARTICLE]).ok).toBe(false);
  });

  it('refuses numbers and nulls where a string is needed, and a project object', () => {
    expect(read([entry(CALL, { due: 20261118 })]).ok).toBe(false);
    expect(read([entry(CALL, { why: null })]).ok).toBe(false);
    expect(read([entry(CALL, { projects: [{ path: 'Areas/Hiring.md' }] })]).ok).toBe(false);
  });

  it.each(['0000-01-01', '2026-02-29', '2026-11-17T09:00', '2026-11-17Z', ' 2026-11-17'])(
    'refuses the due %j',
    (due) => {
      expect(read([entry(CALL, { due })]).ok).toBe(false);
    },
  );

  it('refuses a why of ten megabytes before parsing it', () => {
    expect(read([entry(CALL, { why: 'x'.repeat(10_000_000) })]).ok).toBe(false);
  });
});

describe('attack-903: the hourly allowance across the autumn clock change', () => {
  it('still holds 30 asks made in the hour the clock repeats', () => {
    // US clocks fall back at 02:00 on 2026-11-01: 01:00–01:59 happens twice.
    // Thirty asks in the first 01:10–01:39, then, 30 real minutes after the last,
    // the clock reads 01:09 in the repeated hour.
    const logged = Array.from({ length: 30 }, (_, n) =>
      localTimeMs(`2026-11-01T01:${String(10 + n).padStart(2, '0')}:00`)!,
    );
    const now = localTimeMs('2026-11-01T01:09:00')!;
    expect(assistAllowance({ logged, previewed: [], now }).ok).toBe(false);
  });
});
