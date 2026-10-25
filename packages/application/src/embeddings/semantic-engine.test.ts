import { describe, expect, it } from 'vitest';
import { digestOf, MAX_CHUNK_CHARACTERS } from '@dfai/domain';
import { blockMarkdown } from '../testing/block-markdown.ts';
import { fakeEmbedder, memoryEmbeddingCache } from '../testing/fake-embeddings.ts';
import type { NoteChangeNews } from '../index/note-changes.ts';
import {
  createSemanticEngine,
  EMBEDDING_GENERATION,
  type SemanticOptIn,
} from './semantic-engine.ts';
import type { EmbeddingRefusalReason, IdlePort } from './ports.ts';

const VAULT = '/vault';

/** Notes on a pretend disk, by path; the index's manifest is read from it too. */
function disk(notes: Record<string, string>) {
  const files = new Map(Object.entries(notes));
  return {
    files,
    fs: {
      readNotes: async (paths: readonly string[]) =>
        paths.flatMap((path) => {
          const text = files.get(path);
          return text === undefined ? [] : [{ path, text, modified: 1, size: text.length }];
        }),
    },
    index: {
      manifest: async () =>
        [...files].map(([path, text]) => ({
          path,
          digest: digestOf(text),
          type: null,
          modified: 1,
          size: text.length,
        })),
    },
  };
}

function optIn(): SemanticOptIn & { on: Set<string> } {
  const on = new Set<string>();
  return { on, isOn: (vault) => on.has(vault), turnOn: (vault) => on.add(vault) };
}

function countingIdle(): IdlePort & { count: number } {
  const idle = {
    count: 0,
    idle: async () => {
      idle.count += 1;
    },
  };
  return idle;
}

function setUp(
  notes: Record<string, string>,
  {
    cache = memoryEmbeddingCache({ vault: VAULT }),
    embedder = fakeEmbedder(),
    idle = countingIdle(),
  }: {
    cache?: ReturnType<typeof memoryEmbeddingCache>;
    embedder?: ReturnType<typeof fakeEmbedder>;
    idle?: IdlePort & { count: number };
  } = {},
) {
  const vault = disk(notes);
  const chosen = optIn();
  const engine = createSemanticEngine({
    vault: VAULT,
    fs: vault.fs,
    markdown: blockMarkdown(),
    index: vault.index,
    embedder,
    cache,
    idle,
    optIn: chosen,
  });
  return { engine, vault, cache, embedder, idle, optIn: chosen };
}

const NOTES = {
  'Meetings/Standup.md': 'Mara Quill moves payday to Friday.\n\nThe printer is broken again.',
  'Home/Garden.md': 'Tobias Fenn keeps bees behind the shed.',
  'Archive/Old car.md': 'The old automobile was sold in May.',
};

const changed = (path: string, text: string): NoteChangeNews => ({
  vault: VAULT,
  changes: [{ kind: 'changed', path, type: null, digest: digestOf(text) }],
});

describe('semantic search', () => {
  it('finds a block by what it means, not its words, and links to it', async () => {
    const { engine } = setUp(NOTES);
    await engine.start();
    await engine.settled();
    const { hits } = await engine.search({ query: 'when are the wages paid?' });
    expect(hits[0]).toMatchObject({
      path: 'Meetings/Standup.md',
      title: 'Standup',
      text: 'Mara Quill moves payday to Friday.',
      heading: null,
      block: null,
      link: '[[Standup]]',
    });
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it('keeps the Archive out unless asked', async () => {
    const { engine } = setUp(NOTES);
    await engine.start();
    await engine.settled();
    const left = await engine.search({ query: 'vehicle', limit: 100 });
    expect(left.hits.map((hit) => hit.path)).not.toContain('Archive/Old car.md');
    expect(left.hits.length).toBeGreaterThan(0);
    const asked = await engine.search({ query: 'vehicle', includeArchived: true });
    expect(asked.hits[0]?.path).toBe('Archive/Old car.md');
  });

  it('links a block with an id by its id, and one without by its heading', async () => {
    const text = (value: string) => ({ type: 'text', text: value });
    const markdown = {
      ...blockMarkdown(),
      parseBody: () => ({
        blocks: [],
        doc: {
          type: 'doc' as const,
          content: [
            { type: 'heading', attrs: { level: 2 }, content: [text('Bees')] },
            { type: 'paragraph', attrs: { anchor: 'k3x9a1' }, content: [text('Pack the honey')] },
            { type: 'paragraph', content: [text('Label the honey jars')] },
          ],
        },
      }),
    };
    const vault = disk({ 'Home/Plans.md': 'parsed above' });
    const engine = createSemanticEngine({
      vault: VAULT,
      fs: vault.fs,
      markdown,
      index: vault.index,
      embedder: fakeEmbedder(),
      cache: memoryEmbeddingCache({ vault: VAULT }),
      idle: countingIdle(),
      optIn: optIn(),
    });
    await engine.start();
    await engine.settled();
    const { hits } = await engine.search({ query: 'pack honey' });
    expect(hits.map((hit) => [hit.link, hit.block, hit.heading])).toEqual([
      ['[[Plans#^k3x9a1]]', 'k3x9a1', 'Bees'],
      ['[[Plans#Bees]]', null, 'Bees'],
      ['[[Plans#Bees]]', null, 'Bees'],
    ]);
  });

  it('gives at most the limit, never more than 100, and nothing for an empty question', async () => {
    const many = Object.fromEntries(
      Array.from({ length: 120 }, (_, at) => [`n${at}.md`, `bees number ${at}`]),
    );
    const { engine, embedder } = setUp(many);
    await engine.start();
    await engine.settled();
    expect((await engine.search({ query: 'bees', limit: 3 })).hits).toHaveLength(3);
    expect((await engine.search({ query: 'bees', limit: 500 })).hits).toHaveLength(100);
    expect((await engine.search({ query: 'bees' })).hits).toHaveLength(20);
    const before = embedder.calls.length;
    expect((await engine.search({ query: '   ' })).hits).toEqual([]);
    expect(embedder.calls.length).toBe(before);
    // A limit that is not a sensible number is held to 1 to 100, 20 when it is not a number at all.
    expect((await engine.search({ query: 'bees', limit: 0 })).hits).toHaveLength(1);
    expect((await engine.search({ query: 'bees', limit: -4 })).hits).toHaveLength(1);
    expect((await engine.search({ query: 'bees', limit: Number.NaN })).hits).toHaveLength(20);
    expect((await engine.search({ query: 'bees', limit: Infinity })).hits).toHaveLength(20);
    expect((await engine.search({ query: 'bees', limit: 2.9 })).hits).toHaveLength(2);
  });

  it('asks the model about the question as a query, not a passage', async () => {
    const { engine, embedder } = setUp(NOTES);
    await engine.start();
    await engine.settled();
    await engine.search({ query: 'honey' });
    expect(embedder.calls.at(-1)).toEqual({ texts: ['honey'], purpose: 'query' });
  });

  it('finds nothing for a question the model cannot read, and passes on any other failure', async () => {
    let reason: EmbeddingRefusalReason | null = null;
    let failure: string | null = null;
    const embedder = fakeEmbedder({
      refuse: (text) => (text === 'q' ? reason : null),
      failWith: () => failure,
    });
    const { engine } = setUp(NOTES, { embedder });
    await engine.start();
    await engine.settled();
    reason = 'nothing-readable';
    expect((await engine.search({ query: 'q' })).hits).toEqual([]);
    reason = null;
    failure = 'the model could not be fetched';
    await expect(engine.search({ query: 'z' })).rejects.toThrow('could not be fetched');
  });

  it('halves a question the model finds too long until it reads what is left', async () => {
    const embedder = fakeEmbedder({ refuse: (text) => (text.length > 12 ? 'too-long' : null) });
    const { engine } = setUp(NOTES, { embedder });
    await engine.start();
    await engine.settled();
    await engine.search({ query: 'honey honey honey honey honey honey' });
    expect(embedder.calls.at(-1)?.texts[0]?.length).toBeLessThanOrEqual(12);
  });

  it('asks the model once for the same question searched again as the cache moves', async () => {
    const { engine, embedder } = setUp(NOTES);
    await engine.start();
    await engine.settled();
    await engine.search({ query: 'honey' });
    await engine.search({ query: 'honey' });
    expect(embedder.calls.filter((call) => call.purpose === 'query')).toHaveLength(1);
  });
});

describe('the build', () => {
  it('starts with the first search, not before, and remembers the vault was opted in', async () => {
    const { engine, cache, optIn: chosen } = setUp(NOTES);
    expect(cache.generation()).toBeNull();
    expect(engine.progress()).toEqual({ done: 0, total: 0, failure: null });
    await engine.search({ query: 'bees' });
    expect(cache.generation()).toBe(EMBEDDING_GENERATION);
    expect(chosen.on.has(VAULT)).toBe(true);
  });

  it('embeds every block of every note, and reads each note in an idle moment of its own', async () => {
    const { engine, embedder, idle } = setUp(NOTES);
    await engine.start();
    await engine.settled();
    expect(embedder.passages().sort()).toEqual([
      'Garden\nTobias Fenn keeps bees behind the shed.',
      'Old car\nThe old automobile was sold in May.',
      'Standup\nMara Quill moves payday to Friday.',
      'Standup\nThe printer is broken again.',
    ]);
    expect(idle.count).toBe(3);
    expect(engine.progress()).toEqual({ done: 0, total: 0, failure: null });
  });

  it('never embeds DFAI’s own notes', async () => {
    const { engine, embedder } = setUp({ '.atlas/Templates/Task.md': 'pay', 'A.md': 'bees' });
    await engine.start();
    await engine.settled();
    expect(embedder.passages()).toEqual(['A\nbees']);
  });

  it('re-embeds a changed block and not an unchanged one', async () => {
    const { engine, embedder, vault } = setUp(NOTES);
    await engine.start();
    await engine.settled();
    const before = embedder.passages().length;
    const text = 'Mara Quill moves payday to Friday.\n\nThe printer works now.';
    vault.files.set('Meetings/Standup.md', text);
    engine.hear(changed('Meetings/Standup.md', text));
    await engine.settled();
    expect(embedder.passages().slice(before)).toEqual(['Standup\nThe printer works now.']);
    expect((await engine.search({ query: 'printer works' })).hits[0]?.text).toBe(
      'The printer works now.',
    );
  });

  it('embeds nothing for a note heard at the digest it is already cached at', async () => {
    const { engine, embedder, vault } = setUp(NOTES);
    await engine.start();
    await engine.settled();
    const before = embedder.passages().length;
    engine.hear(changed('Home/Garden.md', vault.files.get('Home/Garden.md') as string));
    await engine.settled();
    expect(embedder.passages().length).toBe(before);
  });

  it('forgets a removed note, so it is no longer found', async () => {
    const { engine, vault } = setUp(NOTES);
    await engine.start();
    await engine.settled();
    vault.files.delete('Home/Garden.md');
    engine.hear({
      vault: VAULT,
      changes: [{ kind: 'removed', path: 'Home/Garden.md', type: null, digest: 'x' }],
    });
    await engine.settled();
    const { hits } = await engine.search({ query: 'honey', limit: 100 });
    expect(hits.map((hit) => hit.path)).not.toContain('Home/Garden.md');
  });

  it('ignores news from another vault, and news before it has started', async () => {
    const { engine, embedder, vault } = setUp(NOTES);
    engine.hear(changed('Home/Garden.md', 'x'));
    await engine.start();
    await engine.settled();
    const before = embedder.passages().length;
    vault.files.set('Home/Garden.md', 'new words');
    engine.hear({ ...changed('Home/Garden.md', 'new words'), vault: '/other' });
    await engine.settled();
    expect(embedder.passages().length).toBe(before);
  });

  it('gives the same answers after the cache is thrown away and built again', async () => {
    const first = setUp(NOTES);
    await first.engine.start();
    await first.engine.settled();
    const answered = await first.engine.search({ query: 'salary', includeArchived: true });
    await first.cache.clear();

    const again = setUp(NOTES, { cache: memoryEmbeddingCache({ vault: VAULT }) });
    await again.engine.start();
    await again.engine.settled();
    const rebuilt = await again.engine.search({ query: 'salary', includeArchived: true });
    expect(rebuilt.hits).toEqual(answered.hits);
    expect(again.cache.written.map((note) => note.blocks)).toEqual(
      first.cache.written.map((note) => note.blocks),
    );
  });

  it('resumes after a quit from the notes it had not reached, embedding nothing twice', async () => {
    const many = Object.fromEntries(
      Array.from({ length: 40 }, (_, at) => [`n${String(at).padStart(2, '0')}.md`, `words ${at}`]),
    );
    const cache = memoryEmbeddingCache({ vault: VAULT });
    const first = setUp(many, { cache });
    // The window closes after the first write's notes were read.
    let reads = 0;
    const quitting = setUp(many, {
      cache,
      embedder: first.embedder,
      idle: {
        count: 0,
        idle: async () => {
          reads += 1;
          if (reads === 17) quitting.engine.stop();
        },
      },
    });
    await quitting.engine.start();
    await quitting.engine.settled();
    const written = cache.written.length;
    expect(written).toBeGreaterThan(0);
    expect(written).toBeLessThan(40);

    const relaunched = setUp(many, { cache, embedder: first.embedder });
    await relaunched.engine.start();
    await relaunched.engine.settled();
    const sent = first.embedder.passages();
    expect(new Set(sent).size).toBe(sent.length);
    expect(sent).toHaveLength(40);
    expect(cache.written).toHaveLength(40);
  });

  it('stops on a write cut short, holding no note half way, and finishes on resume', async () => {
    const cache = memoryEmbeddingCache({ vault: VAULT });
    cache.failNextPut();
    const { engine } = setUp(NOTES, { cache });
    await engine.start();
    await engine.settled();
    expect(engine.progress()).toMatchObject({
      done: 0,
      total: 3,
      failure: 'the write was cut short',
    });
    expect(cache.written).toEqual([]);
    await engine.search({ query: 'bees' });
    await engine.settled();
    expect(engine.progress()).toEqual({ done: 0, total: 0, failure: null });
    expect(cache.written).toHaveLength(3);
  });

  it('says why when the model cannot be had, writes nothing, and tries again on the next search', async () => {
    let missing: string | null = 'the model could not be fetched: offline';
    const embedder = fakeEmbedder({ failWith: () => missing });
    const { engine, cache } = setUp(NOTES, { embedder });
    await engine.start();
    await engine.settled();
    expect(engine.progress().failure).toBe('the model could not be fetched: offline');
    expect(cache.written).toEqual([]);
    await expect(engine.search({ query: 'bees' })).rejects.toThrow('offline');
    missing = null;
    await engine.search({ query: 'bees' });
    await engine.settled();
    expect(cache.written).toHaveLength(3);
  });

  it('halves a block the model finds too long and embeds both halves', async () => {
    const long = 'alpha beta gamma delta';
    const embedder = fakeEmbedder({
      refuse: (text) => (text.endsWith(long) ? 'too-long' : null),
    });
    const { engine, cache } = setUp({ 'A.md': long }, { embedder });
    await engine.start();
    await engine.settled();
    expect(embedder.passages()).toEqual(['A\nalpha beta', 'A\ngamma delta']);
    expect(cache.written[0]?.blocks.map((block) => [block.ordinal, block.excerpt])).toEqual([
      [0, 'alpha beta'],
      [1, 'gamma delta'],
    ]);
  });

  it('keeps a block the model cannot read without a vector, and does not send it again', async () => {
    const embedder = fakeEmbedder({
      refuse: (text) => (text.includes('ꩰ') ? 'nothing-readable' : null),
    });
    const { engine, cache, vault } = setUp({ 'A.md': 'ꩰ\n\nbees' }, { embedder });
    await engine.start();
    await engine.settled();
    expect(cache.written[0]?.blocks.map((block) => block.vector === null)).toEqual([true, false]);
    const text = 'ꩰ\n\nbees\n\nhoney';
    vault.files.set('A.md', text);
    engine.hear(changed('A.md', text));
    await engine.settled();
    expect(embedder.passages()).toEqual(['A\nbees', 'A\nhoney']);
  });

  it('cuts a block longer than a chunk before the model sees it', async () => {
    const long = Array.from({ length: 300 }, (_, at) => `w${at}`).join(' ');
    const { engine, embedder } = setUp({ 'A.md': long });
    await engine.start();
    await engine.settled();
    expect(embedder.passages().length).toBeGreaterThan(1);
    for (const passage of embedder.passages())
      expect(passage.length).toBeLessThanOrEqual(MAX_CHUNK_CHARACTERS + 'A\n'.length);
  });

  it('reads again a note that changed while it was being read', async () => {
    const vault = disk({ 'A.md': 'bees' });
    let hearDuringRead: (() => void) | null = null;
    const engine = createSemanticEngine({
      vault: VAULT,
      fs: {
        readNotes: async (paths) => {
          const read = await vault.fs.readNotes(paths);
          hearDuringRead?.();
          hearDuringRead = null;
          return read;
        },
      },
      markdown: blockMarkdown(),
      index: vault.index,
      embedder: fakeEmbedder(),
      cache: memoryEmbeddingCache({ vault: VAULT }),
      idle: countingIdle(),
      optIn: optIn(),
    });
    hearDuringRead = () => {
      vault.files.set('A.md', 'honey');
      engine.hear(changed('A.md', 'honey'));
    };
    await engine.start();
    await engine.settled();
    expect((await engine.search({ query: 'honey' })).hits[0]?.text).toBe('honey');
  });

  it('refuses to write into another vault’s cache, and says so', async () => {
    const cache = memoryEmbeddingCache({ vault: '/another' });
    const { engine } = setUp(NOTES, { cache });
    await engine.start();
    await engine.settled();
    expect(engine.progress().failure).toBe('another vault was opened before this could be cached');
  });

  it('writes nothing more once stopped', async () => {
    const { engine, cache } = setUp(NOTES);
    engine.stop();
    await engine.start();
    await engine.settled();
    expect(cache.written).toEqual([]);
  });

  it('loads what an earlier launch cached rather than embedding it again', async () => {
    const cache = memoryEmbeddingCache({ vault: VAULT });
    const first = setUp(NOTES, { cache });
    await first.engine.start();
    await first.engine.settled();
    const later = setUp(NOTES, { cache });
    await later.engine.start();
    await later.engine.settled();
    expect(later.embedder.passages()).toEqual([]);
    expect((await later.engine.search({ query: 'honey' })).hits[0]?.path).toBe('Home/Garden.md');
  });

  it('tells each listener as the build moves, until it stops listening', async () => {
    const { engine } = setUp(NOTES);
    const heard: string[] = [];
    const stop = engine.subscribe(({ done, total }) => heard.push(`${done}/${total}`));
    await engine.start();
    await engine.settled();
    expect(heard).toEqual(['0/3', '3/3', '0/0']);
    stop();
    await engine.search({ query: 'bees' });
    expect(heard).toHaveLength(3);
  });

  it('says how far it has got while it builds', async () => {
    const seen: string[] = [];
    const vault = disk(NOTES);
    const engine = createSemanticEngine({
      vault: VAULT,
      fs: vault.fs,
      markdown: blockMarkdown(),
      index: vault.index,
      embedder: fakeEmbedder(),
      cache: memoryEmbeddingCache({ vault: VAULT }),
      idle: countingIdle(),
      optIn: optIn(),
      onProgress: ({ done, total }) => seen.push(`${done}/${total}`),
    });
    await engine.start();
    await engine.settled();
    expect(seen).toEqual(['0/3', '3/3', '0/0']);
  });
});
