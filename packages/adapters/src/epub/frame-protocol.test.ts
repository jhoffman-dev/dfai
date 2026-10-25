import { describe, expect, it } from 'vitest';
import { MOST_KEY, MOST_PATH, readFrameMessage } from './frame-protocol.ts';

/*
 * What the reader takes from a chapter's frame (#505, ADR-0045): only the
 * protocol's messages, each in its shape and within its limits. Anything
 * else — markup, a selection outside the chapter, a path past any book's,
 * a value of the wrong kind — is dropped.
 */

const LENGTH = 100;
const RECT = { left: 10, top: 20, width: 30, height: 12 };

describe('what the reader takes from the frame', () => {
  it('takes each message of the protocol as it is', () => {
    expect(readFrameMessage({ kind: 'ready' }, LENGTH)).toEqual({ kind: 'ready' });
    expect(readFrameMessage({ kind: 'shown', extra: '<b>x</b>' }, LENGTH)).toEqual({
      kind: 'shown',
    });
    expect(
      readFrameMessage(
        { kind: 'selection', cause: 'end', selection: { start: 4, end: 9, rect: RECT } },
        LENGTH,
      ),
    ).toEqual({ kind: 'selection', cause: 'end', selection: { start: 4, end: 9, rect: RECT } });
    expect(
      readFrameMessage({ kind: 'selection', cause: 'scroll', selection: null }, LENGTH),
    ).toEqual({ kind: 'selection', cause: 'scroll', selection: null });
    expect(
      readFrameMessage({ kind: 'link', path: 'OEBPS/calm.xhtml', fragment: 'calm' }, LENGTH),
    ).toEqual({ kind: 'link', path: 'OEBPS/calm.xhtml', fragment: 'calm' });
    expect(
      readFrameMessage(
        { kind: 'key', key: 'f', meta: true, ctrl: false, shift: false, alt: false },
        LENGTH,
      ),
    ).toEqual({ kind: 'key', key: 'f', meta: true, ctrl: false, shift: false, alt: false });
  });

  it('drops anything that is not a message of the protocol', () => {
    for (const data of [
      null,
      undefined,
      'ready',
      42,
      ['ready'],
      {},
      { kind: 'html', html: '<img src=x onerror=alert(1)>' },
      { kind: 'chapter', nodes: [] },
      { kind: 'READY' },
    ]) {
      expect(readFrameMessage(data, LENGTH), JSON.stringify(data)).toBeNull();
    }
  });

  it('drops a selection that is not a stretch of this chapter, or whose box is not a box', () => {
    const selection = (value: unknown, cause: unknown = 'end') =>
      readFrameMessage({ kind: 'selection', cause, selection: value }, LENGTH);
    for (const bad of [
      { start: -1, end: 4, rect: RECT },
      { start: 4, end: LENGTH + 1, rect: RECT },
      { start: 9, end: 4, rect: RECT },
      { start: 4, end: 4, rect: RECT },
      { start: 1.5, end: 4, rect: RECT },
      { start: '1', end: 4, rect: RECT },
      { start: 1, end: 4 },
      { start: 1, end: 4, rect: { ...RECT, left: Number.NaN } },
      { start: 1, end: 4, rect: { ...RECT, top: Number.POSITIVE_INFINITY } },
      { start: 1, end: 4, rect: { ...RECT, width: 1e12 } },
      { start: 1, end: 4, rect: { ...RECT, height: '12' } },
      'everything',
    ]) {
      expect(selection(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(selection({ start: 0, end: LENGTH, rect: RECT })).not.toBeNull();
    expect(selection(null, 'click')).toBeNull();
  });

  it("drops a link that names no path, or one past any book's", () => {
    const link = (path: unknown, fragment: unknown = null) =>
      readFrameMessage({ kind: 'link', path, fragment }, LENGTH);
    expect(link('')).toBeNull();
    expect(link(7)).toBeNull();
    expect(link('a'.repeat(MOST_PATH + 1))).toBeNull();
    expect(link('OEBPS/a.xhtml', 'f'.repeat(MOST_PATH + 1))).toBeNull();
    expect(link('OEBPS/a.xhtml', 3)).toBeNull();
    expect(link('a'.repeat(MOST_PATH))).toEqual({
      kind: 'link',
      path: 'a'.repeat(MOST_PATH),
      fragment: null,
    });
  });

  it('drops a key that is not a key', () => {
    const key = (fields: Record<string, unknown>) =>
      readFrameMessage(
        { kind: 'key', key: 'a', meta: false, ctrl: false, shift: false, alt: false, ...fields },
        LENGTH,
      );
    expect(key({ key: '' })).toBeNull();
    expect(key({ key: 'k'.repeat(MOST_KEY + 1) })).toBeNull();
    expect(key({ meta: 'yes' })).toBeNull();
    expect(key({ alt: undefined })).toBeNull();
    expect(key({ key: 'Escape' })).not.toBeNull();
  });
});
