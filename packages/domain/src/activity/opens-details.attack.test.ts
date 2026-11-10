import { describe, expect, it } from 'vitest';
import { MAX_ACTIVITY_DETAIL, activityEvent } from './activity-event.ts';
import { activityLine, parseActivityLog } from './activity-file.ts';

/** #815, attacked: a line's `detail` at its edges. Each `it.fails` is a bug. */

const AT = Date.UTC(2026, 8, 28, 9, 30);
const line = (detail: string) =>
  activityEvent({
    at: AT,
    level: 'error',
    kind: 'app',
    message: 'Could not save.',
    subject: null,
    detail,
  });

describe('a line’s detail at its edges', () => {
  it.fails('never cuts a detail in the middle of a character', () => {
    const detail = `${'a'.repeat(MAX_ACTIVITY_DETAIL - 2)}🌱 and more past the end`;
    // A high surrogate left without its low one is half a character.
    expect(line(detail).detail ?? '').not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it('keeps a detail the same through save, load and save', () => {
    for (const detail of [
      'x'.repeat(5000),
      'שלום עולם ‮ reversed ⁦ text',
      '👩‍👩‍👧‍👦'.repeat(200),
      'line one\nline two\ttabbed',
      `${'word '.repeat(199)}tail  `,
    ]) {
      const first = line(detail);
      const [back] = parseActivityLog(activityLine(first));
      expect(back).toEqual(first);
      expect(back === undefined ? '' : activityLine(back)).toBe(activityLine(first));
      expect((first.detail ?? '').length).toBeLessThanOrEqual(MAX_ACTIVITY_DETAIL);
    }
  });

  it('keeps no secret and no absolute path in a detail', () => {
    const kept =
      line(
        'Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 at /Users/rowan/Vault/Plans/Beans.md',
      ).detail ?? '';
    expect(kept).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(kept).not.toContain('/Users/rowan');
  });

  it('drops a detail that is not a string, and an empty one', () => {
    const raw = (detail: unknown) =>
      `${JSON.stringify({ at: AT, level: 'error', kind: 'app', message: 'm', subject: null, detail })}\n`;
    for (const detail of [null, 5, {}, ['a'], '', '   \n ']) {
      expect(parseActivityLog(raw(detail))[0]).not.toHaveProperty('detail');
    }
  });
});
