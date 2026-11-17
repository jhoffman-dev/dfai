import { describe, expect, it } from 'vitest';
import { createVaultPath } from '../vault/vault-path.ts';
import { readAssistAnswer } from './assist-answer.ts';
import { assistAllowance } from './assist-allowance.ts';
import { localTimeMs } from '../automations/schedule.ts';

/**
 * Adversarial second pass on #903 (#900): the hourly allowance with times
 * ahead of the clock or exactly an hour old, and the character refusal
 * meeting real vault names.
 */

const NOW = localTimeMs('2026-11-17T09:00:00')!;
const HOUR = 3_600_000;
const thirty = (at: number) => Array.from({ length: 30 }, () => at);

describe('attack2-903: a stored time ahead of the clock', () => {
  it('holds Suggest no longer than the time it says it can ask again', () => {
    // A clock that ran a day fast for a while, then was put right. The store hands the
    // allowance such times as now, and keeps them so (#903 round 3: assist-asks-store),
    // so they age out an hour later; a pure rule given the same future times at two
    // moments could not both hold and then free them.
    const ahead = thirty(NOW + 24 * HOUR);
    const first = assistAllowance({ logged: [], previewed: ahead, now: NOW });
    expect(first.ok).toBe(false);
    if (first.ok) return;
    const promised = localTimeMs(first.until)!;
    expect(promised).toBe(NOW + HOUR);
    const asStored = thirty(NOW);
    expect(assistAllowance({ logged: [], previewed: asStored, now: promised + 1_000 }).ok).toBe(
      true,
    );
  });
});

describe('attack2-903: allowance edges (expected to pass)', () => {
  it('does not count asks exactly 60 minutes old', () => {
    expect(assistAllowance({ logged: [], previewed: thirty(NOW - HOUR), now: NOW }).ok).toBe(true);
  });

  it('counts 30 asks 59:59 old', () => {
    expect(
      assistAllowance({ logged: [], previewed: thirty(NOW - HOUR + 1_000), now: NOW }).ok,
    ).toBe(false);
  });
});

describe('attack2-903: real vault names with joiners or right-to-left script (pinned)', () => {
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
  const read = (one: Record<string, unknown>) =>
    readAssistAnswer(JSON.stringify({ items: [entry(CALL, one), entry(ARTICLE)] }), [
      CALL,
      ARTICLE,
    ]);

  it('reads a project whose real name holds an emoji joined by ZWJ (#903 round 3: the plan checks it)', () => {
    const outcome = read({ projects: ['Projects/\u{1F9D1}\u200D\u{1F4BB} Launch.md'] });
    expect(outcome.ok).toBe(true);
  });

  it('reads a person whose real name holds a zero-width non-joiner', () => {
    // Persian names are commonly written with U+200C.
    // #903 round 3: read, and checked against the vault by the plan.
    expect(read({ waitingOn: 'People/می‌را.md' }).ok).toBe(true);
  });

  it('accepts a right-to-left name with no format characters', () => {
    expect(read({ projects: ['Projects/פרויקט.md'] }).ok).toBe(true);
  });
});
