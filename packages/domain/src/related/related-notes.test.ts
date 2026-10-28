import { describe, expect, it } from 'vitest';
import type { VaultGraph } from '../graph/vault-graph.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import {
  isOfferedAsRelated,
  linkedEitherWay,
  noteCentroid,
  rankRelatedNotes,
  relatedLimit,
  RELATED_NOTES,
  type RelatableBlock,
  type RelatedExclusions,
} from './related-notes.ts';

const unit = (...values: number[]): Float32Array => {
  const length = Math.hypot(...values);
  return Float32Array.from(values.map((value) => value / length));
};

const block = (path: string, ...values: number[]): RelatableBlock => ({
  path,
  vector: unit(...values),
});

const nothingExcluded = (note: string): RelatedExclusions => ({
  note,
  linked: new Set(),
  dismissed: new Set(),
});

describe('relatedLimit', () => {
  it('falls back when not said or not a number, and holds between 1 and the most', () => {
    expect(relatedLimit(undefined)).toBe(RELATED_NOTES.fallback);
    expect(relatedLimit(Number.NaN)).toBe(RELATED_NOTES.fallback);
    expect(relatedLimit(Number.POSITIVE_INFINITY)).toBe(RELATED_NOTES.fallback);
    expect(relatedLimit(0)).toBe(1);
    expect(relatedLimit(-4)).toBe(1);
    expect(relatedLimit(3.9)).toBe(3);
    expect(relatedLimit(10_000)).toBe(RELATED_NOTES.max);
  });
});

describe('linkedEitherWay', () => {
  const edge = (source: string, target: string, kind: 'link' | 'relation' = 'link') => ({
    id: `${source}->${target}:${kind}`,
    source: createVaultPath(source),
    target: createVaultPath(target),
    kind,
    label: kind === 'relation' ? 'Project' : null,
  });
  const graph: VaultGraph = {
    nodes: [],
    edges: [
      edge('A.md', 'Out.md'),
      edge('In.md', 'A.md'),
      edge('A.md', 'Rel.md', 'relation'),
      edge('RelIn.md', 'A.md', 'relation'),
      edge('Archive/Old.md', 'A.md'),
      edge('Elsewhere.md', 'Out.md'),
    ],
  };

  it('holds every note joined to it by a link or a relation, either way', () => {
    expect([...linkedEitherWay(graph, 'A.md')].sort()).toEqual([
      'Archive/Old.md',
      'In.md',
      'Out.md',
      'Rel.md',
      'RelIn.md',
    ]);
  });

  it('holds nothing for a note nothing joins', () => {
    expect(linkedEitherWay(graph, 'Alone.md').size).toBe(0);
  });
});

describe('isOfferedAsRelated', () => {
  const excluded: RelatedExclusions = {
    note: 'Me.md',
    linked: new Set(['Linked.md']),
    dismissed: new Set(['Dismissed.md']),
  };

  it('offers an ordinary note of the person’s own', () => {
    expect(isOfferedAsRelated('Other.md', excluded)).toBe(true);
    expect(isOfferedAsRelated('Projects/Other.md', excluded)).toBe(true);
  });

  it.each([
    ['the note itself', 'Me.md'],
    ['a note already linked', 'Linked.md'],
    ['a dismissed note', 'Dismissed.md'],
    ['an archived note', 'Archive/Old.md'],
    ['a template', '.atlas/templates/Meeting.md'],
    ['a hidden note', '.hidden/Secret.md'],
  ])('never offers %s', (_, path) => {
    expect(isOfferedAsRelated(path, excluded)).toBe(false);
  });
});

describe('noteCentroid', () => {
  it('points where the blocks point on average, at unit length', () => {
    const centroid = noteCentroid([unit(1, 0), unit(0, 1)]);
    expect(centroid).not.toBeNull();
    expect(centroid![0]).toBeCloseTo(Math.SQRT1_2);
    expect(centroid![1]).toBeCloseTo(Math.SQRT1_2);
  });

  it('points nowhere for no vectors, vectors that cancel, or vectors of two lengths', () => {
    expect(noteCentroid([])).toBeNull();
    expect(noteCentroid([unit(1, 0), unit(-1, 0)])).toBeNull();
    expect(noteCentroid([unit(1, 0), unit(1, 0, 0)])).toBeNull();
    expect(noteCentroid([Float32Array.from([Number.NaN, 0])])).toBeNull();
  });
});

describe('rankRelatedNotes', () => {
  const blocks: RelatableBlock[] = [
    block('Me.md', 1, 0, 0),
    block('Me.md', 1, 0.2, 0),
    block('Close.md', 0, 0, 1),
    block('Close.md', 1, 0.1, 0),
    block('Middle.md', 1, 1, 0),
    block('Far.md', 0, 1, 0),
    block('Opposite.md', -1, 0, 0),
  ];

  it('offers the closest notes first, each scored by its closest block, once', () => {
    const ranked = rankRelatedNotes({ blocks, excluded: nothingExcluded('Me.md'), limit: 10 });
    expect(ranked.map((each) => each.path)).toEqual([
      'Close.md',
      'Middle.md',
      'Far.md',
      'Opposite.md',
    ]);
    expect(ranked[0]!.score).toBeGreaterThan(0.99);
    expect(ranked[3]!.score).toBeLessThan(0);
  });

  it('never offers the note itself, a linked one, a dismissed one, the Archive or a template', () => {
    const ranked = rankRelatedNotes({
      blocks: [
        ...blocks,
        block('Archive/Close too.md', 1, 0.1, 0),
        block('.atlas/templates/Close.md', 1, 0.1, 0),
      ],
      excluded: { note: 'Me.md', linked: new Set(['Close.md']), dismissed: new Set(['Far.md']) },
      limit: 10,
    });
    expect(ranked.map((each) => each.path)).toEqual(['Middle.md', 'Opposite.md']);
  });

  it('keeps only the limit', () => {
    const ranked = rankRelatedNotes({ blocks, excluded: nothingExcluded('Me.md'), limit: 2 });
    expect(ranked.map((each) => each.path)).toEqual(['Close.md', 'Middle.md']);
  });

  it('orders notes of the same score by path, whatever order their blocks came in', () => {
    const tied = [block('Me.md', 1, 0), block('Zed.md', 1, 1), block('Abe.md', 1, 1)];
    const ranked = rankRelatedNotes({ blocks: tied, excluded: nothingExcluded('Me.md'), limit: 5 });
    expect(ranked.map((each) => each.path)).toEqual(['Abe.md', 'Zed.md']);
  });

  it('offers nothing for a note with no blocks embedded yet', () => {
    expect(rankRelatedNotes({ blocks, excluded: nothingExcluded('New.md'), limit: 5 })).toEqual([]);
  });

  it('skips a block whose score is not a number or whose vector is another length', () => {
    const torn: RelatableBlock[] = [
      block('Me.md', 1, 0),
      { path: 'Torn.md', vector: Float32Array.from([Number.NaN, 0]) },
      block('Other model.md', 1, 0, 0),
      block('Fine.md', 1, 1),
    ];
    const ranked = rankRelatedNotes({ blocks: torn, excluded: nothingExcluded('Me.md'), limit: 5 });
    expect(ranked.map((each) => each.path)).toEqual(['Fine.md']);
  });
});
