import { describe, expect, it } from 'vitest';
import {
  MIN_IMAGE_WIDTH,
  readImageAlt,
  resizedImageWidth,
  withImageSize,
  writeImageAlt,
} from './image-size.ts';

describe('readImageAlt', () => {
  it('reads a width after the last pipe', () => {
    expect(readImageAlt('diagram|300')).toEqual({
      alt: 'diagram',
      size: { width: 300, height: null },
    });
  });

  it('reads a width and a height', () => {
    expect(readImageAlt('diagram|400x300')).toEqual({
      alt: 'diagram',
      size: { width: 400, height: 300 },
    });
  });

  it('reads a size with no words before it', () => {
    expect(readImageAlt('|250')).toEqual({ alt: '', size: { width: 250, height: null } });
  });

  it('keeps every pipe but the size’s in the words', () => {
    expect(readImageAlt('in | out|120')).toEqual({
      alt: 'in | out',
      size: { width: 120, height: null },
    });
  });

  it.each(['a|b', 'plain words', 'chart|', 'chart|12px', 'chart|0', 'chart|x300', 'chart|300x'])(
    'reads %j as words alone',
    (alt) => {
      expect(readImageAlt(alt)).toEqual({ alt, size: null });
    },
  );

  it('reads a zero height as no height', () => {
    expect(readImageAlt('a|300x0').size).toEqual({ width: 300, height: null });
  });
});

describe('writeImageAlt', () => {
  it.each([
    ['diagram', { width: 300, height: null }, 'diagram|300'],
    ['diagram', { width: 400, height: 300 }, 'diagram|400x300'],
    ['', { width: 80, height: null }, '|80'],
    ['a|b', null, 'a|b'],
  ] as const)('writes %j at %j as %j', (alt, size, written) => {
    expect(writeImageAlt(alt, size)).toBe(written);
  });

  it.each(['diagram|300', 'diagram|400x300', 'in | out|120', '|250', 'a|b'])(
    'reads %j back as it was written',
    (alt) => {
      const read = readImageAlt(alt);
      expect(writeImageAlt(read.alt, read.size)).toBe(alt);
    },
  );
});

describe('withImageSize', () => {
  const wide = { width: 480, height: null };

  it('adds a width to an image that had none', () => {
    expect(withImageSize('![shot](a.png)', wide)).toBe('![shot|480](a.png)');
  });

  it('adds a width to an image with no alt text', () => {
    expect(withImageSize('![](a.png)', wide)).toBe('![|480](a.png)');
  });

  it('changes a width', () => {
    expect(withImageSize('![shot|300](a.png)', wide)).toBe('![shot|480](a.png)');
  });

  it('replaces a width and height with the width alone', () => {
    expect(withImageSize('![shot|400x300](a.png)', wide)).toBe('![shot|480](a.png)');
  });

  it('takes the size away', () => {
    expect(withImageSize('![shot|300](a.png)', null)).toBe('![shot](a.png)');
  });

  it('leaves every other byte alone: escapes, brackets, the destination and its title', () => {
    expect(withImageSize("![a \\] [b] c|300](<my pic.png> 'Q3')", wide)).toBe(
      "![a \\] [b] c|480](<my pic.png> 'Q3')",
    );
  });

  it('keeps a pipe in the words that is not a size', () => {
    expect(withImageSize('![in | out](a.png)', wide)).toBe('![in | out|480](a.png)');
  });

  it.each(['[link](a.png)', '![alt][ref]', '![unclosed', 'plain'])(
    'cannot size %j, which is not an inline image',
    (markdown) => {
      expect(withImageSize(markdown, wide)).toBeNull();
    },
  );
});

describe('resizedImageWidth', () => {
  it('rounds to whole pixels', () => {
    expect(resizedImageWidth({ width: 300.6, column: 700 })).toBe(301);
  });

  it('is never narrower than the minimum', () => {
    expect(resizedImageWidth({ width: 10, column: 700 })).toBe(MIN_IMAGE_WIDTH);
  });

  it('is never wider than the column', () => {
    expect(resizedImageWidth({ width: 1200, column: 700.4 })).toBe(700);
  });

  it('keeps the minimum in a column narrower than it', () => {
    expect(resizedImageWidth({ width: 40, column: 30 })).toBe(MIN_IMAGE_WIDTH);
  });
});
