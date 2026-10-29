import { describe, expect, it } from 'vitest';
import { dominantEnding, matchLines, withOriginalEndings } from './line-endings.ts';

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

/** The text as the frontmatter writer edits it: every CRLF made LF, a lone CR left as it is. */
const asEdited = (text: string) => text.replace(/\r\n/g, '\n');

describe('withOriginalEndings, every byte kept (review of #620)', () => {
  it('keeps a line holding a lone CR, CR and all, in a mixed block', () => {
    const original = 'a: 1\rx\nb: 2\r\nc: 3\n';
    expect(restore(original, 'a: 1\rx\nb: 2\nc: 5\n')).toBe('a: 1\rx\nb: 2\r\nc: 5\n');
  });

  it('keeps the extra CR of a line ending CR CR LF', () => {
    const original = 'a: 1\r\r\nb: 2\nc: 3\r\n';
    expect(restore(original, 'a: 1\r\nb: 2\nc: 4\n')).toBe('a: 1\r\r\nb: 2\nc: 4\r\n');
  });

  it('keeps a lone CR inside a quoted value and inside a comment', () => {
    const original = 'a: "1\rx"\n# c\rd\r\nb: 2\r\nc: 3\n';
    expect(restore(original, 'a: "1\rx"\n# c\rd\nb: 2\nc: 5\n')).toBe(
      'a: "1\rx"\n# c\rd\r\nb: 2\r\nc: 5\n',
    );
  });
});

describe('which line a changed line replaced (review of #620)', () => {
  it('pairs a changed key with its own line, not one removed beside it', () => {
    // { a: null, b: 9 }: b replaced `b: 2` and keeps its LF.
    expect(restore('a: 1\r\nb: 2\nc: 3\r\n', 'b: 9\nc: 3\n')).toBe('b: 9\nc: 3\r\n');
  });

  it('gives new lines in a gap of another size the ending most lines have', () => {
    const original = 'k0: 0\r\nk1:\n  - y1\nk3: 30\r\nk4: 40\nk5: 50\r\nk6: 60\r\n';
    const edited = 'k0: 0\nk1:\n  - y1\nk4:\n  - p\n  - q\nk5: 50\nk6: 60\n';
    expect(restore(original, edited)).toBe(
      'k0: 0\r\nk1:\n  - y1\nk4:\n  - p\r\n  - q\r\nk5: 50\r\nk6: 60\r\n',
    );
  });

  it('keeps a moved line’s own ending', () => {
    expect(restore('\n# note 1\r\nk: 1\r\n', '# note 1\n\nk: 1\nnew1: n1\n')).toBe(
      '# note 1\r\n\nk: 1\r\nnew1: n1\r\n',
    );
  });
});

describe('matchLines, at 10,000 lines (review of #620)', () => {
  it('compares only the lines between the common head and tail', () => {
    const lines = Array.from({ length: 10_000 }, (_, at) => `k${at}: ${at}`);
    const edited = [...lines];
    edited[5_000] = 'k5000: changed';

    const { matched, cells } = matchLines(lines, edited);

    expect(cells).toBe(1);
    expect(matched.filter((at) => at === -1)).toHaveLength(1);
  });

  it('gives up matching, rather than build a table of a hundred million cells', () => {
    const before = Array.from({ length: 10_000 }, (_, at) => `a${at}`);
    const after = Array.from({ length: 10_000 }, (_, at) => `b${at}`);

    expect(matchLines(before, after).cells).toBe(0);
  });
});

/** mulberry32, so every run draws the same blocks. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = ['a: 1', 'b', '"q', 'x"', '# c', ' ', '', '\r', '\r\n', '\n', '\r\r\n', '- i'];

describe('withOriginalEndings, as a property', () => {
  it('gives back any text unchanged when the edit changed nothing, lone CRs and all', () => {
    const random = seeded(620);
    const broken: string[] = [];
    for (let draw = 0; draw < 3000; draw += 1) {
      let text = '';
      const count = Math.floor(random() * 16);
      for (let at = 0; at < count; at += 1) {
        text += PIECES[Math.floor(random() * PIECES.length)] ?? '';
      }
      const fallback = random() < 0.5 ? '\n' : '\r\n';
      if (restore(text, asEdited(text), fallback) !== text) broken.push(JSON.stringify(text));
    }
    expect(broken.slice(0, 5)).toEqual([]);
  });
});
