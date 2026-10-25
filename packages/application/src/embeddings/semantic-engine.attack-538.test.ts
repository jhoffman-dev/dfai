import { describe, expect, it } from 'vitest';
import { digestOf, type NoteChange } from '@dfai/domain';
import { blockMarkdown } from '../testing/block-markdown.ts';
import {
  fakeEmbedder,
  memoryEmbeddingCache,
  type FakeEmbedder,
  type MemoryEmbeddingCache,
} from '../testing/fake-embeddings.ts';
import { createSemanticEngine, type SemanticOptIn } from './semantic-engine.ts';
import { CacheDamagedError, type EmbeddingCachePort, type IdlePort } from './ports.ts';

/*
 * Attack round on PR #538 (#33): the build, the damage handling and the cache
 * against the vault, over a pretend disk, the fake model and the memory cache.
 */

const VAULT = '/vault';

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

const optIn = (): SemanticOptIn => {
  const on = new Set<string>();
  return { isOn: (vault) => on.has(vault), turnOn: (vault) => on.add(vault) };
};
const idle: IdlePort = { idle: async () => undefined };

function setUp(
  notes: Record<string, string>,
  {
    cache = memoryEmbeddingCache({ vault: VAULT }),
    embedder = fakeEmbedder(),
  }: { cache?: EmbeddingCachePort; embedder?: FakeEmbedder } = {},
) {
  const vault = disk(notes);
  const engine = createSemanticEngine({
    vault: VAULT,
    fs: vault.fs,
    markdown: blockMarkdown(),
    index: vault.index,
    embedder,
    cache,
    idle,
    optIn: optIn(),
  });
  return { engine, vault, embedder };
}

const changedTo = (path: string, text: string): NoteChange => ({
  kind: 'changed',
  path,
  type: null,
  digest: digestOf(text),
});

function gate() {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/** Lets `turns` macrotasks go by: async host calls each take at least one. */
async function turns(count: number) {
  for (let at = 0; at < count; at += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

const STANDUP = 'Mara Quill moves payday to Friday.';
const GARDEN = 'Tobias Fenn keeps bees behind the shed.';

describe('attack-538: a note changed back while it is being embedded', () => {
  it('a note reverted to its cached text while its edit is embedded is cached as the file says', async () => {
    const inner = fakeEmbedder();
    const held = gate();
    const entered = gate();
    let holding = false;
    const embedder: FakeEmbedder = {
      ...inner,
      async embed(args) {
        if (holding && args.purpose === 'passage') {
          holding = false;
          entered.open();
          await held.opened;
        }
        return inner.embed(args);
      },
    };
    const cache = memoryEmbeddingCache({ vault: VAULT });
    const { engine, vault } = setUp({ 'Home/Garden.md': GARDEN }, { cache, embedder });
    await engine.start();
    await engine.settled();

    // An edit is read and sent to the model; the person undoes it before the write lands.
    const edited = 'Tobias Fenn sold the car in May.';
    vault.files.set('Home/Garden.md', edited);
    holding = true;
    engine.hear({ vault: VAULT, changes: [changedTo('Home/Garden.md', edited)] });
    await entered.opened;
    vault.files.set('Home/Garden.md', GARDEN);
    engine.hear({ vault: VAULT, changes: [changedTo('Home/Garden.md', GARDEN)] });
    held.open();
    await engine.settled();

    const [note] = (await cache.load()).notes;
    expect(note?.digest).toBe(digestOf(GARDEN));
    const { hits } = await engine.search({ query: 'honey hive', limit: 100 });
    expect(hits.map((hit) => hit.path)).toContain('Home/Garden.md');
  });
});

describe('attack-538: one note the cache cannot write does not stall the build', () => {
  it('after a batch fails on one note, one resume writes every other note', async () => {
    const inner = memoryEmbeddingCache({ vault: VAULT });
    const BAD = 'Notes/Note 03.md';
    // The host refuses any write that holds this note's blocks (a row it cannot store).
    const cache: MemoryEmbeddingCache = {
      ...inner,
      async put(notes, scope) {
        if (notes.some((note) => note.path === BAD && note.blocks.length > 0))
          throw new Error('The embeddings cache: a row could not be written');
        await inner.put(notes, scope);
      },
    };
    const notes: Record<string, string> = {};
    for (let at = 0; at < 40; at += 1)
      notes[`Notes/Note ${String(at).padStart(2, '0')}.md`] = `Tobias Fenn note ${at} about bees.`;
    const { engine } = setUp(notes, { cache });
    await engine.start();
    await engine.settled();
    expect(engine.progress().failure).not.toBeNull();

    // A search resumes the build (`started.resume()`); the PR: "the next are written one at a time, to find the one that cannot be".
    await engine.search({ query: 'bees', limit: 1 });
    await engine.settled();

    expect(engine.progress().failure).toBeNull();
    expect((await inner.load()).notes).toHaveLength(40);
  });
});

describe('attack-538: a cache that is damaged on every write does not spin', () => {
  it('a disk that tears every write is not cleared and rebuilt without end', async () => {
    const inner = memoryEmbeddingCache({ vault: VAULT });
    let clears = 0;
    const cache: MemoryEmbeddingCache = {
      ...inner,
      async clear() {
        clears += 1;
        await inner.clear();
      },
      async put() {
        // As the host answers when SQLite says the file is corrupt on each write: made again, and torn again.
        await new Promise((resolve) => setTimeout(resolve, 0));
        await inner.clear();
        throw new CacheDamagedError('the embeddings cache was damaged and was made again');
      },
    };
    const embedder = fakeEmbedder();
    const { engine } = setUp(
      { 'Meetings/Standup.md': STANDUP, 'Home/Garden.md': GARDEN },
      {
        cache,
        embedder,
      },
    );
    await engine.start();
    await turns(200);
    const passages = embedder.passages().length;
    engine.stop();

    // A loop with no bound clears the cache and sends every note to the model again, on and on.
    expect(clears).toBeLessThanOrEqual(3);
    expect(passages).toBeLessThanOrEqual(3 * 2);
  });
});

describe('attack-538: a cache torn under a search is started over, as one torn under a write is', () => {
  it('after the host says the cache was made again while reading excerpts, search finds notes again', async () => {
    const inner = memoryEmbeddingCache({ vault: VAULT });
    let tear = false;
    const cache: MemoryEmbeddingCache = {
      ...inner,
      async excerpts(keys) {
        if (tear) {
          tear = false;
          await inner.clear();
          throw new CacheDamagedError('the embeddings cache was damaged and was made again');
        }
        return inner.excerpts(keys);
      },
    };
    const { engine } = setUp(
      { 'Meetings/Standup.md': STANDUP, 'Home/Garden.md': GARDEN },
      {
        cache,
      },
    );
    await engine.start();
    await engine.settled();

    tear = true;
    await engine.search({ query: 'honey hive', limit: 100 }).catch(() => undefined);
    await turns(5);
    await engine.settled();

    const { hits } = await engine.search({ query: 'honey hive', limit: 100 });
    expect(hits.map((hit) => hit.path)).toContain('Home/Garden.md');
  });
});

describe('attack-538: damage met on a one-note write is started over too', () => {
  it('a cache torn by the write of a single changed note is rebuilt, and the other notes are found again', async () => {
    const inner = memoryEmbeddingCache({ vault: VAULT });
    let tear = false;
    const cache: MemoryEmbeddingCache = {
      ...inner,
      async put(notes, scope) {
        if (tear) {
          tear = false;
          // The host emptied the file and says so; the retry of the note alone then lands.
          await inner.clear();
          throw new CacheDamagedError('the embeddings cache was damaged and was made again');
        }
        await inner.put(notes, scope);
      },
    };
    const { engine, vault } = setUp(
      { 'Meetings/Standup.md': STANDUP, 'Home/Garden.md': GARDEN },
      { cache },
    );
    await engine.start();
    await engine.settled();

    // The everyday write: one note edited, one note written.
    const edited = `${STANDUP} The printer is broken again.`;
    vault.files.set('Meetings/Standup.md', edited);
    tear = true;
    engine.hear({ vault: VAULT, changes: [changedTo('Meetings/Standup.md', edited)] });
    await engine.settled();
    await turns(5);
    await engine.settled();

    expect((await inner.load()).notes.map((note) => note.path)).toContain('Home/Garden.md');
    const { hits } = await engine.search({ query: 'honey hive', limit: 100 });
    expect(hits.map((hit) => hit.path)).toContain('Home/Garden.md');
  });
});
