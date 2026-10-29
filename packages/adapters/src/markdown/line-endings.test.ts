import { describe, expect, it } from 'vitest';
import { dominantEnding, withOriginalEndings } from './line-endings.ts';

const restore = (original: string, edited: string, fallback = '\n') =>
  withOriginalEndings({ original, edited, fallback });

describe('withOriginalEndings', () => {
  it('leaves text whose lines all end in LF as it is', () => {
    expect(restore('a: 1\nb: 2\n', 'a: 1\nb: 3\n')).toBe('a: 1\nb: 3\n');
  });

  it('gives every line CRLF when the original’s all had it', () => {
    expect(restore('a: 1\r\nb: 2\r\n', 'a: 1\nb: 3\nc: 4\n')).toBe('a: 1\r\nb: 3\r\nc: 4\r\n');
  });

  it('gives an empty original’s lines the fallback', () => {
    expect(restore('', 'a: 1\n', '\r\n')).toBe('a: 1\r\n');
    expect(restore('', 'a: 1\n')).toBe('a: 1\n');
  });

  it('keeps each unchanged line’s own ending in a mixed block', () => {
    expect(restore('a: 1\r\nb: 2\nc: 3\r\n', 'a: 1\nb: 9\nc: 3\n')).toBe('a: 1\r\nb: 9\nc: 3\r\n');
  });

  it('gives a changed line the ending of the line it replaced', () => {
    expect(restore('a: 1\nb: 2\r\nc: 3\n', 'a: 1\nb: 9\nc: 3\n')).toBe('a: 1\nb: 9\r\nc: 3\n');
  });

  it('gives a new line the ending most lines had', () => {
    const original = 'a: 1\r\nb: 2\r\nc: 3\n';
    expect(restore(original, 'a: 1\nb: 2\nc: 3\nd: 4\n')).toBe('a: 1\r\nb: 2\r\nc: 3\nd: 4\r\n');
  });

  it('drops a removed line’s ending with it', () => {
    expect(restore('a: 1\r\nb: 2\nc: 3\r\n', 'a: 1\nc: 3\n')).toBe('a: 1\r\nc: 3\r\n');
  });

  it('keeps a last line that has no ending without one', () => {
    expect(restore('a: 1\r\nb: 2\n', 'a: 1\nb: 3')).toBe('a: 1\r\nb: 3');
  });
});

describe('dominantEnding', () => {
  it('is the more common ending, or the fallback on a tie', () => {
    expect(dominantEnding([{ ending: '\r\n' }, { ending: '\r\n' }, { ending: '\n' }], '\n')).toBe(
      '\r\n',
    );
    expect(dominantEnding([{ ending: '\r\n' }, { ending: '\n' }], '\n')).toBe('\n');
    expect(dominantEnding([], '\r\n')).toBe('\r\n');
  });
});
