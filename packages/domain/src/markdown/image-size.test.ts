import { describe, expect, it } from 'vitest';
import {
  MIN_IMAGE_WIDTH,
  readImageAlt,
  readImageMarkdown,
  resizedImageWidth,
  withImageSize,
  withImageSizeAdded,
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

  it.each([
    'a|b',
    'plain words',
    'chart|',
    'chart|12px',
    'chart|0',
    'chart|x300',
    'chart|300x',
    'chart|0400',
    'chart|400x0',
  ])('reads %j as words alone', (alt) => {
    expect(readImageAlt(alt)).toEqual({ alt, size: null });
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
  const OUTSIDE = { inCell: false };
  const wide = { width: 480, height: null };

  it('adds a width to an image that had none', () => {
    expect(withImageSize('![shot](a.png)', wide, OUTSIDE)).toBe('![shot|480](a.png)');
  });

  it('adds a width to an image with no alt text', () => {
    expect(withImageSize('![](a.png)', wide, OUTSIDE)).toBe('![|480](a.png)');
  });

  it('changes a width', () => {
    expect(withImageSize('![shot|300](a.png)', wide, OUTSIDE)).toBe('![shot|480](a.png)');
  });

  it('replaces a width and height with the width alone', () => {
    expect(withImageSize('![shot|400x300](a.png)', wide, OUTSIDE)).toBe('![shot|480](a.png)');
  });

  it('takes the size away', () => {
    expect(withImageSize('![shot|300](a.png)', null, OUTSIDE)).toBe('![shot](a.png)');
  });

  it('leaves every other byte alone: escapes, brackets, the destination and its title', () => {
    expect(withImageSize("![a \\] [b] c|300](<my pic.png> 'Q3')", wide, OUTSIDE)).toBe(
      "![a \\] [b] c|480](<my pic.png> 'Q3')",
    );
  });

  it('keeps a pipe in the words that is not a size', () => {
    expect(withImageSize('![in | out](a.png)', wide, OUTSIDE)).toBe('![in | out|480](a.png)');
  });

  it.each(['[link](a.png)', '![alt][ref]', '![unclosed', 'plain'])(
    'cannot size %j, which is not an inline image',
    (markdown) => {
      expect(withImageSize(markdown, wide, OUTSIDE)).toBeNull();
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

describe('withImageSize in a table cell', () => {
  const CELL = { inCell: true };

  it('writes the size’s pipe escaped, as the cell needs', () => {
    expect(withImageSize('![shot](a.png)', { width: 480, height: null }, CELL)).toBe(
      '![shot\\|480](a.png)',
    );
  });

  it('changes a size written escaped', () => {
    expect(withImageSize('![shot\\|300](a.png)', { width: 480, height: null }, CELL)).toBe(
      '![shot\\|480](a.png)',
    );
  });

  it('writes words that would read as a size once the size is gone as an entity', () => {
    expect(withImageSize('![a\\|2024\\|300](a.png)', null, CELL)).toBe('![a&#124;2024](a.png)');
  });
});

describe('withImageSize, keeping the words words', () => {
  const OUTSIDE = { inCell: false };
  const wide = { width: 480, height: null };

  it('leaves a pipe written escaped as a word, and adds the size after it', () => {
    expect(withImageSize('![Route 66\\|2024](a.png)', wide, OUTSIDE)).toBe(
      '![Route 66\\|2024|480](a.png)',
    );
  });

  it('adds the size after a code span holding a pipe', () => {
    expect(withImageSize('![`code|300`](a.png)', wide, OUTSIDE)).toBe('![`code|300`|480](a.png)');
  });

  it('escapes words that would read as a size once the size after them is gone', () => {
    expect(withImageSize('![a|2024|300](a.png)', null, OUTSIDE)).toBe('![a\\|2024](a.png)');
  });
});

describe('withImageSizeAdded', () => {
  const OUTSIDE = { inCell: false };

  it('escapes words that end like a size', () => {
    expect(withImageSizeAdded('![Route 66|2024](a.png)', null, OUTSIDE)).toBe(
      '![Route 66\\|2024](a.png)',
    );
  });

  it('writes them as an entity in a table cell, where `\\|` is the cell’s escape and `\\\\|` would end the cell', () => {
    expect(withImageSizeAdded('![a\\|2024](a.png)', null, { inCell: true })).toBe(
      '![a&#124;2024](a.png)',
    );
    expect(
      withImageSizeAdded('![a\\|2024](a.png)', { width: 80, height: null }, { inCell: true }),
    ).toBe('![a&#124;2024\\|80](a.png)');
  });

  it('adds the size after the words', () => {
    expect(withImageSizeAdded('![shot](a.png)', { width: 80, height: 60 }, OUTSIDE)).toBe(
      '![shot|80x60](a.png)',
    );
  });
});

describe('readImageMarkdown', () => {
  const OUTSIDE = { inCell: false };
  const read = (markdown: string, alt: string, inCell = false) =>
    readImageMarkdown({ markdown, alt, place: { inCell } });

  it('reads the size from an unescaped pipe', () => {
    expect(read('![shot|300](a.png)', 'shot|300')).toEqual({
      alt: 'shot',
      size: { width: 300, height: null },
    });
  });

  it.each([
    ['an escaped pipe', '![Route 66\\|2024](a.png)', 'Route 66|2024'],
    ['a code span', '![`code|300`](a.png)', 'code|300'],
    ['an entity', '![shot&#124;300](a.png)', 'shot|300'],
    ['a leading zero', '![shot|0400](a.png)', 'shot|0400'],
  ])('reads %s as words', (_label, markdown, alt) => {
    expect(read(markdown, alt)).toEqual({ alt, size: null });
  });

  it('reads a cell’s escaped pipe as the size’s, and a doubly escaped one as a word', () => {
    expect(read('![shot\\|300](a.png)', 'shot|300', true).size).toEqual({
      width: 300,
      height: null,
    });
    expect(read('![shot\\\\|300](a.png)', 'shot|300', true).size).toBeNull();
  });

  it('reads nothing from markdown that is not an image', () => {
    expect(readImageMarkdown({ markdown: 'plain|300', alt: 'plain|300', place: OUTSIDE })).toEqual({
      alt: 'plain|300',
      size: null,
    });
  });
});
