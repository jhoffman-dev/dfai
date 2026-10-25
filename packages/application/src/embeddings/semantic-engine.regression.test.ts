import { describe, expect, it } from 'vitest';
import { digestOf } from '@dfai/domain';
import { blockMarkdown } from '../testing/block-markdown.ts';
import {
  fakeEmbedder,
  memoryEmbeddingCache,
  type FakeEmbedder,
  type MemoryEmbeddingCache,
} from '../testing/fake-embeddings.ts';
import type { NoteChange } from '@dfai/domain';
import { createSemanticEngine, type SemanticOptIn } from './semantic-engine.ts';
import { CacheMismatchError } from './semantic-search.ts';
import { createEmbeddingBuild } from './embedding-build.ts';
import { inlineChunker } from './note-passages.ts';
import { createSemanticBlocks } from './semantic-blocks.ts';
import {
  CacheDamagedError,
  type CachedEmbeddings,
  type EmbeddingCachePort,
  type IdlePort,
} from './ports.ts';

/*
 * Regression tests for review and attack findings on the embeddings cache and semantic search (#33): the
 * engine end to end over a pretend disk, the fake model and the memory cache.
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

const added = (path: string, text: string): NoteChange => ({
  kind: 'added',
  path,
  type: null,
  digest: digestOf(text),
});
const removed = (path: string, text: string): NoteChange => ({
  kind: 'removed',
  path,
  type: null,
  digest: digestOf(text),
});
const changedTo = (path: string, text: string): NoteChange => ({
  kind: 'changed',
  path,
  type: null,
  digest: digestOf(text),
});

/** A promise and the function that settles it, for holding a port mid-call. */
function gate() {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

const STANDUP = 'Mara Quill moves payday to Friday.\n\nThe printer is broken again.';
const GARDEN = 'Tobias Fenn keeps bees behind the shed.';

describe('a block whose digest is cached is not embedded again', () => {
  it('a note moved to another folder (same title, same blocks) is not sent to the model again', async () => {
    const { engine, vault, embedder } = setUp({ 'Projects/Standup.md': STANDUP });
    await engine.start();
    await engine.settled();
    const before = embedder.passages().length;
    vault.files.delete('Projects/Standup.md');
    vault.files.set('Archive/Standup.md', STANDUP);
    engine.hear({
      vault: VAULT,
      changes: [removed('Projects/Standup.md', STANDUP), added('Archive/Standup.md', STANDUP)],
    });
    await engine.settled();
    // The PR: "A block whose digest is already cached is never embedded again, even if it moved".
    expect(embedder.passages().slice(before)).toEqual([]);
  });

  it('a move as a sync reports it — the new path added before the old removed — is not sent again', async () => {
    const { engine, vault, embedder } = setUp({ 'Projects/Standup.md': STANDUP });
    await engine.start();
    await engine.settled();
    const before = embedder.passages().length;
    vault.files.delete('Projects/Standup.md');
    vault.files.set('Areas/Standup.md', STANDUP);
    // `noteChanges` lists what was added before what was removed.
    engine.hear({
      vault: VAULT,
      changes: [added('Areas/Standup.md', STANDUP), removed('Projects/Standup.md', STANDUP)],
    });
    await engine.settled();
    expect(embedder.passages().slice(before)).toEqual([]);
    const { hits } = await engine.search({ query: 'payday', limit: 100 });
    expect(new Set(hits.map((hit) => hit.path))).toEqual(new Set(['Areas/Standup.md']));
  });
});

describe('the change feed never leaves the cache out of step with the vault', () => {
  it('a note deleted and restored before its forget was written is still found', async () => {
    const { engine } = setUp({ 'Meetings/Standup.md': STANDUP, 'Home/Garden.md': GARDEN });
    await engine.start();
    await engine.settled();
    // Two syncs in quick succession: the file went (a git checkout), then came back unchanged.
    engine.hear({ vault: VAULT, changes: [removed('Home/Garden.md', GARDEN)] });
    engine.hear({ vault: VAULT, changes: [added('Home/Garden.md', GARDEN)] });
    await engine.settled();
    const { hits } = await engine.search({ query: 'honey hive', limit: 100 });
    expect(hits.map((hit) => hit.path)).toContain('Home/Garden.md');
  });

  it('a new note deleted while it is being embedded leaves no ghost in the cache', async () => {
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
    const { engine, vault } = setUp({ 'Meetings/Standup.md': STANDUP }, { cache, embedder });
    await engine.start();
    await engine.settled();

    const hive = 'Hive inspection: the honey is ready to take.';
    vault.files.set('Home/Hive.md', hive);
    holding = true;
    engine.hear({ vault: VAULT, changes: [added('Home/Hive.md', hive)] });
    await entered.opened;
    vault.files.delete('Home/Hive.md');
    engine.hear({ vault: VAULT, changes: [removed('Home/Hive.md', hive)] });
    held.open();
    await engine.settled();

    expect((await cache.load()).notes.map((note) => note.path)).not.toContain('Home/Hive.md');
    const { hits } = await engine.search({ query: 'honey', limit: 100 });
    expect(hits.map((hit) => hit.path)).not.toContain('Home/Hive.md');
  });
});

describe('a hit says what the block it links to says', () => {
  it('a block inserted above while a search reads its excerpts does not give a hit another block’s words', async () => {
    const inner = memoryEmbeddingCache({ vault: VAULT });
    const held = gate();
    const entered = gate();
    let holding = false;
    const cache: MemoryEmbeddingCache = {
      ...inner,
      async excerpts(keys) {
        if (holding) {
          holding = false;
          entered.open();
          await held.opened;
        }
        return inner.excerpts(keys);
      },
    };
    const notes = `${GARDEN}\n\n${STANDUP}`;
    const { engine, vault } = setUp({ 'Meetings/Week.md': notes }, { cache });
    await engine.start();
    await engine.settled();

    holding = true;
    const searching = engine.search({ query: 'when are wages paid', limit: 1 });
    await entered.opened;
    const edited = `The old automobile was sold in May.\n\n${notes}`;
    vault.files.set('Meetings/Week.md', edited);
    engine.hear({ vault: VAULT, changes: [changedTo('Meetings/Week.md', edited)] });
    await engine.settled();
    held.open();
    const { hits } = await searching;
    expect(hits[0]?.text).toContain('payday');
  });
});

describe('a damaged cache is discarded and built again, never a dead end', () => {
  it('a cache whose load fails is cleared and rebuilt, and search answers', async () => {
    const inner = memoryEmbeddingCache({ vault: VAULT });
    await setUp({ 'Meetings/Standup.md': STANDUP }, { cache: inner }).engine.start();
    let cleared = false;
    const cache: EmbeddingCachePort = {
      ...inner,
      async clear() {
        cleared = true;
        await inner.clear();
      },
      async load() {
        if (!cleared)
          throw new Error('The embeddings cache: 3 numbers cannot be 2 vectors of one length');
        return inner.load();
      },
    };
    const { engine } = setUp({ 'Meetings/Standup.md': STANDUP }, { cache });
    await expect(engine.search({ query: 'wages' })).resolves.toBeDefined();
    await engine.settled();
    const { hits } = await engine.search({ query: 'wages' });
    expect(hits[0]?.path).toBe('Meetings/Standup.md');
  });

  it('cached vectors of another length than the model’s are discarded, not a search that throws', async () => {
    const inner = memoryEmbeddingCache({ vault: VAULT });
    const first = setUp({ 'Meetings/Standup.md': STANDUP }, { cache: inner }).engine;
    await first.start();
    await first.settled();
    // A truncated blob read back whole-number: every vector a third of its length.
    const cache: EmbeddingCachePort = {
      ...inner,
      async load(): Promise<CachedEmbeddings> {
        const loaded = await inner.load();
        return {
          notes: loaded.notes,
          blocks: loaded.blocks.map((block) => ({
            ...block,
            vector: block.vector === null ? null : block.vector.subarray(0, 3),
          })),
        };
      },
    };
    const { engine } = setUp({ 'Meetings/Standup.md': STANDUP }, { cache });
    await expect(engine.search({ query: 'wages' })).resolves.toBeDefined();
  });
});

describe('one note’s words never stop the build', () => {
  /** As the host's JSON reader is: a lone UTF-16 surrogate in any string is refused (serde_json). */
  const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  function strictHostCache(): EmbeddingCachePort {
    const inner = memoryEmbeddingCache({ vault: VAULT });
    return {
      ...inner,
      async put(notes, scope) {
        for (const note of notes)
          for (const block of note.blocks)
            if (LONE.test(block.excerpt)) throw new Error('unexpected end of hex escape');
        await inner.put(notes, scope);
      },
    };
  }

  it('a long paragraph with an emoji at the excerpt cut is cached, and so are the notes after it', async () => {
    const long = `${'Field notes on the apiary '.repeat(10).slice(0, 238)}🐝 and more after the cut.`;
    const { engine } = setUp(
      { 'A field notes.md': long, 'Home/Garden.md': GARDEN },
      { cache: strictHostCache() },
    );
    await engine.start();
    await engine.settled();
    expect(engine.progress().failure).toBeNull();
    const { hits } = await engine.search({ query: 'honey hive', limit: 100 });
    expect(hits.map((hit) => hit.path)).toContain('Home/Garden.md');
  });
});

describe('the search seam (#35) holds its own limits', () => {
  it('a NaN limit (an assistant tool’s bad number) gives at most 100 hits', async () => {
    const many = Array.from({ length: 150 }, (_, at) => `Payday note ${at} about wages.`).join(
      '\n\n',
    );
    const { engine } = setUp({ 'Payroll.md': many });
    await engine.start();
    await engine.settled();
    const { hits } = await engine.search({ query: 'wages', limit: Number.NaN });
    expect(hits.length).toBeLessThanOrEqual(100);
  });

  it('a query too long for the model is cut to what it reads, not an error', async () => {
    const embedder = fakeEmbedder({ refuse: (text) => (text.length > 4_000 ? 'too-long' : null) });
    const { engine } = setUp({ 'Meetings/Standup.md': STANDUP }, { embedder });
    await engine.start();
    await engine.settled();
    await expect(
      engine.search({ query: 'when are the wages paid? '.repeat(1_000) }),
    ).resolves.toBeDefined();
  });
});

describe('a link names its note against the whole vault', () => {
  it('is never [[Plan]] when another note in the vault is called Plan, embedded yet or not', async () => {
    const { engine } = setUp({
      'Zeta/Plan.md': 'The wages are paid on Friday.',
      '.atlas/Plan.md': 'A type definition that is never embedded.',
    });
    await engine.start();
    await engine.settled();
    const { hits } = await engine.search({ query: 'when are wages paid' });
    expect(hits[0]?.link).toBe('[[Zeta/Plan]]');
  });
});

describe('one note that cannot be written does not stop the build', () => {
  it('is held with no blocks, and the notes after it are cached', async () => {
    const inner = memoryEmbeddingCache({ vault: VAULT });
    const cache: EmbeddingCachePort = {
      ...inner,
      async put(notes, scope) {
        if (notes.some((note) => note.path === 'Bad.md' && note.blocks.length > 0))
          throw new Error('the host refused this note');
        await inner.put(notes, scope);
      },
    };
    const { engine } = setUp({ 'Bad.md': STANDUP, 'Home/Garden.md': GARDEN }, { cache });
    await engine.start();
    await engine.settled();
    // The two together failed; the next search writes them one at a time and finds the one.
    expect(engine.progress().failure).toBe('the host refused this note');
    await engine.search({ query: 'honey hive' });
    await engine.settled();
    expect(engine.progress()).toEqual({ done: 0, total: 0, failure: null });
    const { hits } = await engine.search({ query: 'honey hive', limit: 100 });
    expect(hits.map((hit) => hit.path)).toContain('Home/Garden.md');
    expect((await inner.load()).notes.map((note) => note.path)).toContain('Bad.md');
  });
});

describe('a chunk the model found too long is not sent whole again', () => {
  it('is cut in halves before sending when the note is embedded again', async () => {
    const long = Array.from({ length: 30 }, (_, at) => `bees${at}`).join(' ');
    const embedder = fakeEmbedder({ refuse: (text) => (text.length > 150 ? 'too-long' : null) });
    const { engine, vault } = setUp({ 'Home/Long.md': `${long}\n\nShort.` }, { embedder });
    await engine.start();
    await engine.settled();
    const before = embedder.passages().length;
    const edited = `${long}\n\nShort, and more.`;
    vault.files.set('Home/Long.md', edited);
    engine.hear({ vault: VAULT, changes: [changedTo('Home/Long.md', edited)] });
    await engine.settled();
    const sent = embedder.passages().slice(before);
    expect(sent.some((text) => text.length > 150)).toBe(false);
  });
});

describe('a cache the host found torn mid-session is started over from the notes', () => {
  it('rebuilds when a write says the cache was made again, and search answers', async () => {
    const inner = memoryEmbeddingCache({ vault: VAULT });
    let tear = true;
    const cache: EmbeddingCachePort = {
      ...inner,
      async put(notes, scope) {
        if (tear) {
          tear = false;
          // The host emptied the file and says so; what the window holds of it is gone.
          await inner.clear();
          throw new CacheDamagedError('the embeddings cache was damaged and was made again');
        }
        await inner.put(notes, scope);
      },
    };
    const { engine } = setUp(
      { 'Meetings/Standup.md': STANDUP, 'Home/Garden.md': GARDEN },
      { cache },
    );
    await engine.start();
    await engine.settled();
    // The rebuild runs behind the failure.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await engine.settled();
    const { hits } = await engine.search({ query: 'honey hive', limit: 100 });
    expect(hits.map((hit) => hit.path)).toContain('Home/Garden.md');
    expect(engine.progress().failure).toBeNull();
  });

  it('a cache torn on every write stops the build with a stated failure, which a search does not resume', async () => {
    const inner = memoryEmbeddingCache({ vault: VAULT });
    const cache: EmbeddingCachePort = {
      ...inner,
      async put() {
        await inner.clear();
        throw new CacheDamagedError('the embeddings cache was damaged and was made again');
      },
    };
    const told: (string | null)[] = [];
    const { engine, embedder } = setUp({ 'Home/Garden.md': GARDEN }, { cache });
    engine.subscribe((progress) => told.push(progress.failure));
    await engine.start();
    for (let at = 0; at < 20; at += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await engine.settled();
    }
    const failure = engine.progress().failure;
    expect(failure).toMatch(/kept being damaged/);
    expect(told.at(-1)).toBe(failure);
    // The first build and two starts over, each sending the one note once.
    expect(embedder.passages()).toHaveLength(3);

    const sent = embedder.passages().length;
    await engine.search({ query: 'honey hive', limit: 100 });
    await engine.settled();
    expect(embedder.passages().length - sent).toBe(0);
    expect(engine.progress().failure).toBe(failure);
  });
});

/** mulberry32: a seeded RNG, so a failing sequence is the same on every run. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const WORDS = ['bees', 'honey', 'payday', 'wages', 'car', 'printer', 'holiday', 'shed', 'Friday'];

/** What the cache holds, by note, in a form two caches can be compared by. */
async function heldOf(cache: MemoryEmbeddingCache) {
  const loaded = await cache.load();
  return Object.fromEntries(
    loaded.notes.map((note) => [
      note.path,
      {
        digest: note.digest,
        blocks: loaded.blocks
          .filter((block) => block.path === note.path)
          .map((block) => [block.ordinal, block.digest, block.vector?.join(',') ?? null]),
      },
    ]),
  );
}

describe('property — after any edits, the cache is a fresh rebuild', () => {
  for (const seed of [1, 7, 538, 2026]) {
    it(`seed ${seed}: random edits, heard as syncs, leave the cache equal to one built afresh`, async () => {
      const random = seeded(seed);
      const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
      const sentence = () =>
        Array.from({ length: 2 + Math.floor(random() * 4) }, () => pick(WORDS)).join(' ');
      const start: Record<string, string> = {};
      for (let at = 0; at < 6; at += 1) start[`Folder ${at % 2}/Note ${at}.md`] = sentence();
      const cache = memoryEmbeddingCache({ vault: VAULT });
      const { engine, vault } = setUp(start, { cache });
      await engine.start();
      await engine.settled();

      for (let step = 0; step < 40; step += 1) {
        const paths = [...vault.files.keys()];
        const path = pick(paths);
        const text = vault.files.get(path) as string;
        const kind = Math.floor(random() * 6);
        const changes: NoteChange[] = [];
        if (kind === 0) {
          const next = `${sentence()}\n\n${text}`;
          vault.files.set(path, next);
          changes.push(changedTo(path, next));
        } else if (kind === 1) {
          const next = text.split('\n\n').slice(1).join('\n\n') || sentence();
          vault.files.set(path, next);
          changes.push(changedTo(path, next));
        } else if (kind === 2) {
          const next = text.replace(' ', '   ');
          vault.files.set(path, next);
          changes.push(changedTo(path, next));
        } else if (kind === 3 && paths.length > 2) {
          vault.files.delete(path);
          changes.push(removed(path, text));
        } else if (kind === 4) {
          const moved = path.startsWith('Folder 0/')
            ? path.replace('Folder 0/', 'Folder 1/')
            : path.replace('Folder 1/', 'Folder 0/');
          if (!vault.files.has(moved)) {
            vault.files.delete(path);
            vault.files.set(moved, text);
            changes.push(removed(path, text), added(moved, text));
          }
        } else {
          const fresh = `Folder ${step % 2}/New ${step}.md`;
          const next = sentence();
          vault.files.set(fresh, next);
          changes.push(added(fresh, next));
        }
        engine.hear({ vault: VAULT, changes });
        // Sometimes a sync lands while the last is still being written.
        if (random() < 0.5) await engine.settled();
      }
      await engine.settled();

      const freshCache = memoryEmbeddingCache({ vault: VAULT });
      const rebuilt = setUp(Object.fromEntries(vault.files), { cache: freshCache }).engine;
      await rebuilt.start();
      await rebuilt.settled();
      expect(await heldOf(cache)).toEqual(await heldOf(freshCache));
    });
  }
});

const TORN = 'the embeddings cache was damaged and was made again';

/** Lets `count` macrotasks go by, settling the build after each: a start-over runs behind a failure. */
async function settleThrough(engine: { settled(): Promise<void> }, count = 30) {
  for (let at = 0; at < count; at += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await engine.settled();
  }
}

function manyNotes(count: number): Record<string, string> {
  const notes: Record<string, string> = {};
  for (let at = 0; at < count; at += 1)
    notes[`Notes/Note ${String(at).padStart(2, '0')}.md`] = `Tobias Fenn note ${at} about bees.`;
  return notes;
}

describe('one torn cache is started over once, by one build', () => {
  it('a tear met while a search waits on the build opens the cache once more, with one write at a time', async () => {
    const inner = memoryEmbeddingCache({ vault: VAULT });
    const held = gate();
    const entered = gate();
    let opens = 0;
    let puts = 0;
    let inFlight = 0;
    let mostInFlight = 0;
    const cache: EmbeddingCachePort = {
      ...inner,
      async open(asked) {
        opens += 1;
        return inner.open(asked);
      },
      async put(notes, scope) {
        puts += 1;
        const first = puts === 1;
        inFlight += 1;
        mostInFlight = Math.max(mostInFlight, inFlight);
        try {
          if (first) {
            entered.open();
            await held.opened;
            await inner.clear();
            throw new CacheDamagedError(TORN);
          }
          await new Promise((resolve) => setTimeout(resolve, 0));
          await inner.put(notes, scope);
        } finally {
          inFlight -= 1;
        }
      },
    };
    const { engine } = setUp(manyNotes(40), { cache });
    await engine.start();
    await entered.opened;
    // A search while the write is under way asks the build to resume once it ends.
    await engine.search({ query: 'bees', limit: 1 });
    held.open();
    await settleThrough(engine, 60);

    expect(opens).toBe(2);
    expect(mostInFlight).toBe(1);
    expect(engine.progress().failure).toBeNull();
    expect((await inner.load()).notes).toHaveLength(40);
  });

  it('a tear found by a search and by the write under way at once is started over once', async () => {
    const inner = memoryEmbeddingCache({ vault: VAULT });
    const held = gate();
    const entered = gate();
    let opens = 0;
    let holdNext = false;
    let tearExcerpts = false;
    const cache: EmbeddingCachePort = {
      ...inner,
      async open(asked) {
        opens += 1;
        return inner.open(asked);
      },
      async excerpts(keys) {
        if (tearExcerpts) {
          tearExcerpts = false;
          throw new CacheDamagedError(TORN);
        }
        return inner.excerpts(keys);
      },
      async put(notes, scope) {
        if (holdNext) {
          holdNext = false;
          entered.open();
          await held.opened;
          await inner.clear();
          throw new CacheDamagedError(TORN);
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

    const edited = `${STANDUP} Ida Brenwick fixed the printer.`;
    vault.files.set('Meetings/Standup.md', edited);
    holdNext = true;
    engine.hear({ vault: VAULT, changes: [changedTo('Meetings/Standup.md', edited)] });
    await entered.opened;
    // The search finds the tear first, and starts over once the write under way ends; the write then finds it too.
    tearExcerpts = true;
    const searched = engine.search({ query: 'honey hive', limit: 100 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    held.open();
    await searched;
    await settleThrough(engine);

    expect(opens).toBe(2);
    expect(engine.progress().failure).toBeNull();
    const { hits } = await engine.search({ query: 'honey hive', limit: 100 });
    expect(hits.map((hit) => hit.path)).toContain('Home/Garden.md');
  });

  it('two tears, each started over, do not stop the build', async () => {
    const inner = memoryEmbeddingCache({ vault: VAULT });
    let tears = 2;
    const cache: EmbeddingCachePort = {
      ...inner,
      async put(notes, scope) {
        if (tears > 0) {
          tears -= 1;
          await inner.clear();
          throw new CacheDamagedError(TORN);
        }
        await inner.put(notes, scope);
      },
    };
    const { engine } = setUp(
      { 'Meetings/Standup.md': STANDUP, 'Home/Garden.md': GARDEN },
      { cache },
    );
    await engine.start();
    await settleThrough(engine);

    expect(tears).toBe(0);
    expect(engine.progress().failure).toBeNull();
    const { hits } = await engine.search({ query: 'honey hive', limit: 100 });
    expect(hits.map((hit) => hit.path)).toContain('Home/Garden.md');
  });

  it('a cache of another model found by searches does not use up the starts over a torn one has', async () => {
    const inner = memoryEmbeddingCache({ vault: VAULT });
    let mismatches = 0;
    let tear = false;
    const cache: EmbeddingCachePort = {
      ...inner,
      async excerpts(keys) {
        if (mismatches > 0) {
          mismatches -= 1;
          throw new CacheMismatchError(384, 768);
        }
        return inner.excerpts(keys);
      },
      async put(notes, scope) {
        if (tear) {
          tear = false;
          await inner.clear();
          throw new CacheDamagedError(TORN);
        }
        await inner.put(notes, scope);
      },
    };
    const { engine, vault } = setUp(
      { 'Meetings/Standup.md': STANDUP, 'Home/Garden.md': GARDEN },
      { cache },
    );
    await engine.start();
    await settleThrough(engine);
    for (let at = 0; at < 3; at += 1) {
      mismatches = 1;
      await engine.search({ query: `honey hive ${at}`, limit: 100 });
      await settleThrough(engine, 5);
    }
    const edited = `${GARDEN} Ida Brenwick buys the honey.`;
    vault.files.set('Home/Garden.md', edited);
    tear = true;
    engine.hear({ vault: VAULT, changes: [changedTo('Home/Garden.md', edited)] });
    await settleThrough(engine);

    expect(engine.progress().failure).toBeNull();
    const { hits } = await engine.search({ query: 'honey hive', limit: 100 });
    expect(hits.map((hit) => hit.path)).toContain('Meetings/Standup.md');
  });

  it('after it stops, the failure says to restart DFAI, and a new engine over the same cache builds again', async () => {
    const inner = memoryEmbeddingCache({ vault: VAULT });
    let torn = true;
    const cache: EmbeddingCachePort = {
      ...inner,
      async put(notes, scope) {
        if (torn) {
          await inner.clear();
          throw new CacheDamagedError(TORN);
        }
        await inner.put(notes, scope);
      },
    };
    const notes = { 'Home/Garden.md': GARDEN };
    const first = setUp(notes, { cache });
    await first.engine.start();
    await settleThrough(first.engine);
    expect(first.engine.progress().failure).toMatch(/Restart DFAI to try again/);
    first.engine.stop();

    // A relaunch makes the engine again (`useSemanticSearch`), and the disk has healed.
    torn = false;
    const second = setUp(notes, { cache });
    await second.engine.start();
    await settleThrough(second.engine);
    expect(second.engine.progress().failure).toBeNull();
    const { hits } = await second.engine.search({ query: 'honey hive', limit: 100 });
    expect(hits.map((hit) => hit.path)).toEqual(['Home/Garden.md']);
  });
});

describe('after one note cannot be written, the build writes notes together again', () => {
  it('writes the failed batch one note at a time, then the rest in batches', async () => {
    const inner = memoryEmbeddingCache({ vault: VAULT });
    const BAD = 'Notes/Note 03.md';
    const sizes: number[] = [];
    const cache: EmbeddingCachePort = {
      ...inner,
      async put(notes, scope) {
        sizes.push(notes.length);
        if (notes.some((note) => note.path === BAD && note.blocks.length > 0))
          throw new Error('The embeddings cache: a row could not be written');
        await inner.put(notes, scope);
      },
    };
    const { engine } = setUp(manyNotes(40), { cache });
    await engine.start();
    await engine.settled();
    expect(sizes).toEqual([16]);

    await engine.search({ query: 'bees', limit: 1 });
    await engine.settled();

    // Notes 00–15 alone (03 three times: written, written alone again, then bare), then 16–31 and 32–39 together.
    expect(sizes.slice(1)).toEqual([...Array<number>(18).fill(1), 16, 8]);
    expect(engine.progress().failure).toBeNull();
    expect((await inner.load()).notes).toHaveLength(40);
  });
});

describe('a build that found the cache damaged is not resumed', () => {
  it('tells of the damage once and writes nothing more, though a resume was asked while it wrote', async () => {
    const inner = memoryEmbeddingCache({ vault: VAULT });
    const held = gate();
    const entered = gate();
    let puts = 0;
    const cache: EmbeddingCachePort = {
      ...inner,
      async put(notes, scope) {
        puts += 1;
        if (puts === 1) {
          entered.open();
          await held.opened;
          await inner.clear();
          throw new CacheDamagedError(TORN);
        }
        await inner.put(notes, scope);
      },
    };
    const notes = manyNotes(40);
    const vault = disk(notes);
    let damaged = 0;
    const build = createEmbeddingBuild({
      vault: VAULT,
      fs: vault.fs,
      chunker: inlineChunker(blockMarkdown()),
      embedder: fakeEmbedder(),
      cache,
      idle,
      blocks: createSemanticBlocks({ notes: [], blocks: [] }),
      onDamaged: () => {
        damaged += 1;
      },
    });
    build.plan(new Map(Object.entries(notes).map(([path, text]) => [path, digestOf(text)])));
    await entered.opened;
    build.resume();
    held.open();
    await build.settled();

    expect(damaged).toBe(1);
    // The engine starts over with a new build; this one writes nothing onto the emptied cache.
    expect(puts).toBe(1);
  });
});
