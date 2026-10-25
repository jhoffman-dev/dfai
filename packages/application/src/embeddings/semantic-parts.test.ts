import { describe, expect, it } from 'vitest';
import { blockChunks, createWikiLinkResolver, type EditorDocument } from '@dfai/domain';
import { fakeEmbedder, memoryEmbeddingCache } from '../testing/fake-embeddings.ts';
import { embedPassages } from './embed-passages.ts';
import { EmbeddingError, type CachedBlock, type EmbeddingPort } from './ports.ts';
import { createSemanticBlocks, MixedVectorsError } from './semantic-blocks.ts';
import { createSemanticEngine } from './semantic-engine.ts';
import { semanticSearch } from './semantic-search.ts';

const vector = (...values: number[]) => Float32Array.from(values);
const block = (path: string, ordinal: number, values: number[] | null): CachedBlock => ({
  path,
  ordinal,
  digest: `${path}:${ordinal}`,
  anchor: null,
  heading: null,
  vector: values === null ? null : vector(...values),
});
const IDLE = { done: 0, total: 0, failure: null };
const doc = (...words: string[]): EditorDocument => ({
  type: 'doc',
  content: words.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
});

describe('createSemanticBlocks', () => {
  const cached = {
    notes: [
      { path: 'b.md', digest: '2', title: 'B' },
      { path: 'B.md', digest: '3', title: 'Big B' },
      { path: 'a.md', digest: '1', title: 'A' },
    ],
    blocks: [
      block('b.md', 0, [1, 0]),
      block('a.md', 0, null),
      block('a.md', 1, [0, 1]),
      block('B.md', 0, [1, 1]),
    ],
  };

  it('ranks only blocks with vectors, in code-unit path order then the note’s', () => {
    const held = createSemanticBlocks(cached);
    expect(held.rankable().blocks.map((each) => each.path)).toEqual(['B.md', 'a.md', 'b.md']);
    expect(held.digests()).toEqual(
      new Map([
        ['b.md', '2'],
        ['B.md', '3'],
        ['a.md', '1'],
      ]),
    );
  });

  it('reuses its ranking until a note changes, and forgets a note it never held at no cost', () => {
    const held = createSemanticBlocks(cached);
    const first = held.rankable();
    held.remove('nowhere.md');
    expect(held.rankable()).toBe(first);
    held.remove('a.md');
    expect(held.rankable()).not.toBe(first);
    expect(held.note('a.md')).toBeUndefined();
    const before = held.rankable();
    held.put({ path: 'c.md', digest: '9', title: 'C', blocks: [block('c.md', 0, [1, 0])] });
    expect(held.rankable()).not.toBe(before);
    expect(held.digests().get('c.md')).toBe('9');
  });

  it('still knows the vector of a passage whose last block was forgotten, for a note that moves', () => {
    const held = createSemanticBlocks(cached);
    held.remove('b.md');
    expect(held.vectorOf('b.md:0')).toEqual(vector(1, 0));
    expect(held.vectorOf('a.md:0')).toBeNull();
    expect(held.vectorOf('nowhere')).toBeUndefined();
  });

  it('marks the Archive’s blocks once, with the ranking', () => {
    const held = createSemanticBlocks({
      notes: [
        { path: 'Archive/old.md', digest: '1', title: 'Old' },
        { path: 'Notes/new.md', digest: '2', title: 'New' },
      ],
      blocks: [block('Archive/old.md', 0, [1, 0]), block('Notes/new.md', 0, [0, 1])],
    });
    expect(held.rankable().archived).toEqual([true, false]);
  });

  it('refuses vectors of different lengths, held together or put together', () => {
    expect(() =>
      createSemanticBlocks({
        notes: [{ path: 'a.md', digest: '1', title: 'A' }],
        blocks: [block('a.md', 0, [1, 0]), block('a.md', 1, [1, 0, 0])],
      }),
    ).toThrow(MixedVectorsError);
    const held = createSemanticBlocks(cached);
    expect(() =>
      held.put({ path: 'c.md', digest: '9', title: 'C', blocks: [block('c.md', 0, [1, 0, 0])] }),
    ).toThrow(MixedVectorsError);
    expect(held.note('c.md')).toBeUndefined();
  });

  it('holds a note with no blocks', () => {
    const held = createSemanticBlocks({
      notes: [{ path: 'e.md', digest: '1', title: 'E' }],
      blocks: [],
    });
    expect(held.note('e.md')?.blocks).toEqual([]);
  });
});

describe('embedPassages', () => {
  const chunks = () => blockChunks({ title: 'T', doc: doc('one', 'two') });

  it('refuses an answer with a vector short', async () => {
    const short: EmbeddingPort = { embed: async () => [vector(1)] };
    await expect(
      embedPassages({ notes: [{ chunks: chunks() }], known: new Map(), embedder: short }),
    ).rejects.toThrow('2 passages were sent and 1 vectors came back');
  });

  it('refuses a refusal that names a text it was not sent', async () => {
    const confused: EmbeddingPort = {
      embed: async () => {
        throw new EmbeddingError('no', { textIndex: 9, reason: 'too-long' });
      },
    };
    await expect(
      embedPassages({ notes: [{ chunks: chunks() }], known: new Map(), embedder: confused }),
    ).rejects.toThrow('the model refused text 9 of 2');
  });

  it('sends a passage two notes share once', async () => {
    const embedder = fakeEmbedder();
    const known = new Map<string, Float32Array | null>();
    await embedPassages({ notes: [{ chunks: chunks() }, { chunks: chunks() }], known, embedder });
    expect(embedder.passages()).toEqual(['T\none', 'T\ntwo']);
    expect(known.size).toBe(2);
  });

  it('passes on a failure that is not a refusal', async () => {
    const broken: EmbeddingPort = {
      embed: async () => {
        throw new Error('the host stopped');
      },
    };
    await expect(
      embedPassages({ notes: [{ chunks: chunks() }], known: new Map(), embedder: broken }),
    ).rejects.toThrow('the host stopped');
  });
});

describe('semanticSearch', () => {
  const resolve = () => createWikiLinkResolver([]);

  it('shows a block’s path for a note that is not held, and drops a block the cache has no words for', async () => {
    const blocks = createSemanticBlocks({ notes: [], blocks: [] });
    blocks.put({ path: 'x.md', digest: '1', title: 'X', blocks: [block('x.md', 0, [1, 0])] });
    const stale = { ...blocks, note: () => undefined };
    const deps = (excerpt: string) => ({
      blocks: stale,
      embedder: { embed: async () => [vector(1, 0)] },
      cache: { excerpts: async () => [excerpt] },
      progress: () => IDLE,
      resolve,
    });
    const gone = await semanticSearch(deps(''), { query: 'q', limit: -5 });
    expect(gone.hits).toEqual([]);
    const found = await semanticSearch(deps('Words.'), { query: 'q' });
    expect(found.hits[0]).toMatchObject({ title: 'x.md', text: 'Words.', link: '[[x]]' });
  });

  it('finds nothing when the model answers a question with no vector', async () => {
    const answer = await semanticSearch(
      {
        blocks: createSemanticBlocks({ notes: [], blocks: [] }),
        embedder: { embed: async () => [] },
        cache: { excerpts: async () => [] },
        progress: () => IDLE,
        resolve,
      },
      { query: 'q' },
    );
    expect(answer.hits).toEqual([]);
  });
});

describe('createSemanticEngine', () => {
  it('tries to open the cache again on the next start when it would not open', async () => {
    const cache = memoryEmbeddingCache();
    let refuse = true;
    const opening = cache.open.bind(cache);
    cache.open = async (args) => {
      if (refuse) throw new Error('the cache could not be opened');
      return opening(args);
    };
    const engine = createSemanticEngine({
      vault: '/vault',
      fs: { readNotes: async () => [] },
      markdown: {} as never,
      index: { manifest: async () => [] },
      embedder: fakeEmbedder(),
      cache,
      idle: { idle: async () => undefined },
      optIn: { isOn: () => true, turnOn: () => undefined },
    });
    await expect(engine.start()).rejects.toThrow('could not be opened');
    refuse = false;
    await engine.start();
    expect(cache.generation()).not.toBeNull();
  });
});
