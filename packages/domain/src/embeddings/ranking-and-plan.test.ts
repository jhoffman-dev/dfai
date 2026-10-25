import { describe, expect, it } from 'vitest';
import { createVaultPath, type VaultPath } from '../vault/vault-path.ts';
import { createWikiLinkResolver } from '../markdown/resolve-wikilink.ts';
import { blockLink } from './block-link.ts';
import { cosine, topByCosine, VectorLengthError } from './cosine-ranking.ts';
import { embeddingWork, isEmbeddableNote } from './embedding-plan.ts';
import { passageDigest } from './passage-digest.ts';

const unit = (...values: number[]): Float32Array => {
  const length = Math.hypot(...values);
  return Float32Array.from(values.map((value) => value / length));
};

describe('cosine', () => {
  it('is 1 for the same direction, 0 at right angles and -1 opposite', () => {
    expect(cosine(unit(1, 0), unit(3, 0))).toBeCloseTo(1);
    expect(cosine(unit(1, 0), unit(0, 1))).toBeCloseTo(0);
    expect(cosine(unit(1, 0), unit(-1, 0))).toBeCloseTo(-1);
    expect(cosine(unit(1, 1), unit(1, 0))).toBeCloseTo(Math.SQRT1_2);
  });

  it('sums every number, whatever the length is modulo four', () => {
    for (const length of [1, 2, 3, 4, 5, 7, 8, 9]) {
      const ones = Float32Array.from({ length }, (_, at) => at + 1);
      const expected = Array.from(ones).reduce((sum, value) => sum + value * value, 0);
      expect(cosine(ones, ones)).toBe(expected);
    }
  });

  it('refuses vectors of different lengths: they are from different models', () => {
    expect(() => cosine(unit(1, 0), unit(1, 0, 0))).toThrow(VectorLengthError);
  });
});

describe('topByCosine', () => {
  const vectors = [unit(0, 1), unit(1, 0), unit(1, 1), unit(-1, 0), unit(1, 0.1)];

  it('ranks the vectors most like the query first, keeping only the limit', () => {
    const ranked = topByCosine({ query: unit(1, 0), vectors, limit: 3 });
    expect(ranked.map((hit) => hit.at)).toEqual([1, 4, 2]);
    expect(ranked[0]?.score).toBeCloseTo(1);
    expect(ranked[2]?.score).toBeCloseTo(Math.SQRT1_2);
  });

  it('keeps the order given between equal scores, so the same cache ranks the same way', () => {
    const same = [unit(1, 0), unit(0, 1), unit(1, 0), unit(1, 0)];
    expect(
      topByCosine({ query: unit(1, 0), vectors: same, limit: 2 }).map((hit) => hit.at),
    ).toEqual([0, 2]);
    expect(
      topByCosine({ query: unit(1, 0), vectors: same, limit: 4 }).map((hit) => hit.at),
    ).toEqual([0, 2, 3, 1]);
  });

  it('does not compare the vectors it is told to leave out', () => {
    const asked: number[] = [];
    const ranked = topByCosine({
      query: unit(1, 0),
      vectors,
      limit: 5,
      include: (at) => {
        asked.push(at);
        return at !== 1;
      },
    });
    expect(ranked.map((hit) => hit.at)).toEqual([4, 2, 0, 3]);
    expect(asked).toEqual([0, 1, 2, 3, 4]);
  });

  it('finds nothing for a limit of 0 or less, or no vectors', () => {
    expect(topByCosine({ query: unit(1, 0), vectors, limit: 0 })).toEqual([]);
    expect(topByCosine({ query: unit(1, 0), vectors, limit: -1 })).toEqual([]);
    expect(topByCosine({ query: unit(1, 0), vectors: [], limit: 3 })).toEqual([]);
  });

  it('agrees with sorting every score, over many vectors', () => {
    // A fixed lattice rather than random numbers: the same on every run.
    const many = Array.from({ length: 200 }, (_, at) =>
      unit(Math.cos(at * 0.7), Math.sin(at * 1.3), 0.5),
    );
    const query = unit(0.2, 0.9, 0.1);
    const expected = many
      .map((vector, at) => ({ at, score: cosine(query, vector) }))
      .sort((left, right) => right.score - left.score || left.at - right.at)
      .slice(0, 10)
      .map((hit) => hit.at);
    expect(topByCosine({ query, vectors: many, limit: 10 }).map((hit) => hit.at)).toEqual(expected);
  });
});

describe('embeddingWork', () => {
  const versions = (entries: Record<string, string>) => new Map(Object.entries(entries));

  it('embeds a note the cache has not seen, or has seen at another digest, in path order', () => {
    const work = embeddingWork({
      vault: versions({ 'b.md': '2', 'a.md': '1', 'c.md': '3' }),
      cached: versions({ 'b.md': 'old', 'c.md': '3' }),
    });
    expect(work).toEqual({ embed: ['a.md', 'b.md'], forget: [] });
  });

  it('forgets a note the vault no longer has', () => {
    const work = embeddingWork({
      vault: versions({ 'a.md': '1' }),
      cached: versions({ 'a.md': '1', 'gone.md': '9', 'Archive/x.md': '1' }),
    });
    expect(work).toEqual({ embed: [], forget: ['Archive/x.md', 'gone.md'] });
  });

  it('never embeds DFAI’s own notes or a hidden folder’s, and forgets any the cache holds', () => {
    const work = embeddingWork({
      vault: versions({
        '.atlas/Templates/Task.md': '1',
        '.atlas/proposals/p.md': '1',
        '.obsidian/x.md': '1',
        'Archive/Old.md': '1',
      }),
      cached: versions({ '.atlas/Templates/Task.md': '1' }),
    });
    expect(work).toEqual({ embed: ['Archive/Old.md'], forget: ['.atlas/Templates/Task.md'] });
  });

  it('has nothing to do when the cache holds the vault as it is', () => {
    const same = versions({ 'a.md': '1' });
    expect(embeddingWork({ vault: same, cached: new Map(same) })).toEqual({
      embed: [],
      forget: [],
    });
  });

  it('orders by code unit, not locale', () => {
    const work = embeddingWork({
      vault: versions({ 'b.md': '1', 'B.md': '1', 'á.md': '1' }),
      cached: new Map(),
    });
    expect(work.embed).toEqual(['B.md', 'b.md', 'á.md']);
  });
});

describe('isEmbeddableNote', () => {
  it('embeds the user’s notes and the Archive, not templates', () => {
    expect(isEmbeddableNote('Projects/Plan.md')).toBe(true);
    expect(isEmbeddableNote('Archive/Plan.md')).toBe(true);
    expect(isEmbeddableNote('.atlas/Templates/Task.md')).toBe(false);
  });
});

describe('blockLink', () => {
  const notes: VaultPath[] = ['Meetings/Standup.md', 'Work/Plan.md', 'Home/Plan.md'].map(
    createVaultPath,
  );
  const resolve = createWikiLinkResolver(notes);
  const link = (path: string, anchor: string | null, heading: string | null) =>
    blockLink({ path: createVaultPath(path), anchor, heading, resolve });

  it('links a block with an id by its id', () => {
    expect(link('Meetings/Standup.md', 'k3x9a1', 'Payroll')).toBe('[[Standup#^k3x9a1]]');
  });

  it('links a block without one by the heading it sits under', () => {
    expect(link('Meetings/Standup.md', null, 'Payroll')).toBe('[[Standup#Payroll]]');
  });

  it('links the note alone when there is neither, or the heading could not be linked', () => {
    expect(link('Meetings/Standup.md', null, null)).toBe('[[Standup]]');
    expect(link('Meetings/Standup.md', null, 'Q3 | Q4')).toBe('[[Standup]]');
    expect(link('Meetings/Standup.md', null, 'C# notes')).toBe('[[Standup]]');
  });

  it('writes the path where the name alone would open another note', () => {
    expect(link('Work/Plan.md', null, null)).toBe('[[Work/Plan]]');
  });
});

describe('passageDigest', () => {
  it('is 16 hex characters, the same for the same text', () => {
    expect(passageDigest('Pay moves to Friday.')).toMatch(/^[0-9a-f]{16}$/);
    expect(passageDigest('Pay moves to Friday.')).toBe(passageDigest('Pay moves to Friday.'));
  });

  it('differs for texts one character apart, and for the empty text', () => {
    expect(passageDigest('abc')).not.toBe(passageDigest('abd'));
    expect(passageDigest('ab')).not.toBe(passageDigest('ba'));
    expect(passageDigest('')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('gives 20,000 distinct short passages 20,000 distinct digests', () => {
    const seen = new Set<string>();
    for (let at = 0; at < 20_000; at += 1) seen.add(passageDigest(`Block ${at} of the vault`));
    expect(seen.size).toBe(20_000);
  });
});
