/**
 * Attacks on a refused API write's reason in the Activity log (#814, PR #816).
 * Each proved a bug the PR left, as an `it.fails`, until it was fixed.
 */

import { describe, expect, it } from 'vitest';
import { createVaultPath } from '../vault/vault-path.ts';
import { apiWriteReport, MAX_REFUSAL_REASON } from './activity-reports.ts';
import { activityEvent, MAX_ACTIVITY_DETAIL, safeActivityText } from './activity-event.ts';
import { activityLine, parseActivityLog } from './activity-file.ts';

const ROUTE = 'POST /v1/meetings/assistant/proposals';
const NOTE = createVaultPath('Meetings/Garden club sync.md');

/** The line kept for a refusal with this reason: the report made safe, as the recorder does. */
const keptLine = (reason: string) =>
  activityEvent({
    ...apiWriteReport({ route: ROUTE, notePath: NOTE, refusal: 'conflict', reason }),
    at: 0,
  });

/** Filler so the text after it starts `at` characters into the reason. */
const padTo = (at: number) =>
  `${'Claude could not draft it: the step failed '.padEnd(at - 1, '.')} `;

/** Whether any character of the text is one of these code points, or in one of these ranges. */
const hasCodePoint = (text: string, ranges: readonly (readonly [number, number])[]) =>
  [...text].some((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return ranges.some(([from, to]) => code >= from && code <= to);
  });
const LINE_BREAKS = [
  [0x85, 0x85],
  [0x1c, 0x1f],
] as const;
const CONTROLS = [
  [0x00, 0x1f],
  [0x7f, 0x7f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
] as const;

const isLoneSurrogate = (text: string) =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);

describe('a refusal reason cut on its line keeps no part of a secret', () => {
  // The line is cut to MAX_REFUSAL_REASON *before* it is made safe, so a
  // secret straddling the cut is shortened below the length its pattern needs.
  const CUT = MAX_REFUSAL_REASON - 1;

  it('strikes a Bearer token the cut leaves 7 characters of', () => {
    const token = 'Zq8xLm2Vn4Rt6Yp0Wk3Hs5Jd7Fb9Gc1A';
    const reason = `${padTo(CUT - 'Bearer '.length - 7)}Bearer ${token} was refused`;
    const { message, detail } = keptLine(reason);
    expect(detail).not.toContain(token.slice(0, 7)); // the detail, cleaned first, is safe
    expect(message).not.toContain(token.slice(0, 7));
  });

  it('strikes a random 40-character token the cut leaves 31 characters of', () => {
    const token = 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5bC7d';
    const reason = `${padTo(CUT - 31)}${token} rejected`;
    const { message, detail } = keptLine(reason);
    expect(detail).not.toContain(token.slice(0, 31));
    expect(message).not.toContain(token.slice(0, 20));
  });

  it('strikes a GitHub token the cut leaves its prefix and 15 characters of', () => {
    const token = 'ghp_R2d2C3poL8kW9mQ4vX7nB1zT6yH5jF0sA3eU';
    const reason = `${padTo(CUT - 19)}${token} is not allowed`;
    expect(keptLine(reason).message).not.toContain(token.slice(0, 19));
  });

  it('strikes a lower-case hex key the cut leaves 23 characters of', () => {
    const key = '9f8e7d6c5b4a39281706f5e4d3c2b1a0ffeeddcc';
    const reason = `${padTo(CUT - 23)}${key} expired`;
    expect(keptLine(reason).message).not.toContain(key.slice(0, 23));
  });
});

describe('a refusal reason cut on its line keeps no part of a chat note’s name', () => {
  it('strikes the chat’s title the cut would leave the first words of', () => {
    const title = 'Should Tobias Fenn chair the garden club this spring';
    const chat = createVaultPath(`Chats/${title}.md`);
    const reason = `${padTo(MAX_REFUSAL_REASON - 1 - 20)}${title} changed since you read it`;
    const report = apiWriteReport({ route: ROUTE, notePath: chat, refusal: 'conflict', reason });
    const { message, detail } = activityEvent({ ...report, at: 0 });
    expect(detail).toContain('a chat note changed since you read it');
    expect(message).not.toContain(title.slice(0, 20));
  });
});

describe('a refusal reason cut on its line, or in its detail, keeps whole characters', () => {
  it('does not split a surrogate pair at the line cut', () => {
    const reason = `${'a'.repeat(MAX_REFUSAL_REASON - 2)}🌱🌱🌱 and more`;
    expect(isLoneSurrogate(keptLine(reason).message)).toBe(false);
  });

  it('does not split a surrogate pair at the detail cut', () => {
    const reason = `${'a'.repeat(MAX_ACTIVITY_DETAIL - 2)}🌱🌱🌱 and more`;
    expect(isLoneSurrogate(keptLine(reason).detail ?? '')).toBe(false);
  });
});

describe('a refusal reason is kept on one line, as plain text', () => {
  // `\s` misses NEL and the C0 separators, which other readers break lines on.
  it('turns NEL, the record separator and other line breaks into spaces', () => {
    const reason = 'first part\u0085second\u001Ethird\u001Cfourth';
    const { message, detail } = keptLine(reason);
    expect(hasCodePoint(message, LINE_BREAKS)).toBe(false);
    expect(hasCodePoint(detail ?? '', LINE_BREAKS)).toBe(false);
  });

  it('keeps no control or bidi-override character a caller sent', () => {
    // A note path the caller named is echoed raw in `${path} already exists`.
    const reason = 'Notes/\u202Edm.txt\u202C\u001B[31m\u0000 already exists';
    const { message, detail } = keptLine(reason);
    expect(hasCodePoint(message, CONTROLS)).toBe(false);
    expect(hasCodePoint(detail ?? '', CONTROLS)).toBe(false);
  });
});

describe('a refusal detail survives the activity file', () => {
  it('reads back as it was written, delimiters and all', () => {
    const reason =
      '"}\n{"at":1,"level":"error","kind":"api","message":"forged"}\r\n---\nstatus: done\n';
    const line = keptLine(reason);
    const [read] = parseActivityLog(activityLine(line));
    expect(parseActivityLog(activityLine(line))).toHaveLength(1);
    expect(read).toEqual(line);
  });
});

describe('a refusal reason keeps no secret an invisible character splits', () => {
  // Each is drawn as nothing, so one inside a key hides it from what strikes secrets.
  const HIDDEN = [
    0x00ad, 0x034f, 0x115f, 0x1160, 0x180e, 0x3164, 0xfe00, 0xfe07, 0xfe0f, 0xfeff, 0xe0000,
    0xe0041, 0xe007f,
  ];
  const TAIL = 'Rt6yUi4oPa2sDf0gHjKl';

  it.each(HIDDEN.map((code) => [code.toString(16).toUpperCase().padStart(4, '0'), code]))(
    'strikes a key split by U+%s, and keeps no part of it',
    (_name, code) => {
      const hidden = String.fromCodePoint(code);
      const { message, detail } = keptLine(`the key sk-ant-api03-Qw8e${hidden}${TAIL} was refused`);
      for (const text of [message, detail ?? '']) {
        expect(text).toContain('the key <secret> was refused');
        expect(text).not.toContain(TAIL);
        expect(text).not.toContain(hidden);
      }
    },
  );

  it('removes a byte-order mark, rather than reading it as a space', () => {
    expect(keptLine('ready\uFEFFnow').detail).toBe('readynow');
  });
});

describe('a refusal reason is not swallowed by an unterminated terminal title', () => {
  it('keeps the words after an OSC that never ends', () => {
    const { message, detail } = keptLine('\u001B]0;title and the real reason');
    expect(detail).toContain('and the real reason');
    expect(message).toContain('and the real reason');
    expect(hasCodePoint(detail ?? '', CONTROLS)).toBe(false);
  });
});

describe('a cut never leaves part of what stands in for a path, secret or chat note', () => {
  it.each([
    ['Saved to /Users/tobias/Vault/Notes/plan.md today', 12, 'Saved to…'],
    ['key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA used', 8, 'key…'],
    ['Asked Chats/Plan the garden beds.md again', 10, 'Asked…'],
    ['Asked Chats/Plan the garden beds.md again', 8, 'Asked…'],
  ])('cuts %j to %i before its placeholder', (raw, max, cut) => {
    expect(safeActivityText(raw, { max })).toBe(cut);
  });

  it('keeps a placeholder the cut falls just after', () => {
    expect(safeActivityText('Saved to /Users/tobias/Vault/Notes/plan.md today', { max: 16 })).toBe(
      'Saved to <path>…',
    );
  });
});
