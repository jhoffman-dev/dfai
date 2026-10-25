import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const { readCacheLoad, tauriEmbeddingCache } = await import('./tauri-embedding-cache.ts');
const { browserIdle } = await import('./browser-idle.ts');
const { CacheDamagedError } = await import('@dfai/application');

/**
 * Bytes as `embedding_cache_load` writes them: header length, header lines (the
 * notes and vector length, then arrays of blocks), padding spaces to a multiple
 * of 4, then little-endian f32s.
 */
function loadBytes({
  notes = [],
  blocks,
  dimensions,
  vectors,
  perLine = 1_000,
  pad = 0,
}: {
  notes?: readonly unknown[];
  blocks: readonly unknown[];
  dimensions: number;
  vectors: readonly number[];
  perLine?: number;
  /** More spaces than the alignment needs, so the vectors start at a place that is not a multiple of 4. */
  pad?: number;
}): ArrayBuffer {
  const lines = [JSON.stringify({ dimensions, notes })];
  for (let at = 0; at < blocks.length; at += perLine)
    lines.push(JSON.stringify(blocks.slice(at, at + perLine)));
  let text = lines.join('\n') + ' '.repeat(pad);
  while (text.length % 4 !== 0) text += ' ';
  const json = new TextEncoder().encode(text);
  const bytes = new Uint8Array(4 + json.length + vectors.length * 4);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, json.length, true);
  bytes.set(json, 4);
  vectors.forEach((value, at) => view.setFloat32(4 + json.length + at * 4, value, true));
  return bytes.buffer;
}

const block = (path: string, ordinal: number, embedded: boolean) => ({
  path,
  ordinal,
  digest: `d${ordinal}`,
  anchor: null,
  heading: null,
  embedded,
});

/** Does not wait: a frame letting go is not what these tests are about. */
const noPause = async () => undefined;

describe('readCacheLoad', () => {
  it('matches each embedded block with its vector, in order, and gives the rest none', async () => {
    const notes = [{ path: 'a.md', digest: 'n', title: 'A' }];
    const blocks = [block('a.md', 0, true), block('a.md', 1, false), block('a.md', 2, true)];
    const loaded = await readCacheLoad(
      loadBytes({ notes, blocks, dimensions: 2, vectors: [1, 0, 0.5, -0.5] }),
      noPause,
    );
    expect(loaded.notes).toEqual(notes);
    expect(loaded.blocks.map((each) => each.vector && Array.from(each.vector))).toEqual([
      [1, 0],
      null,
      [0.5, -0.5],
    ]);
    expect(loaded.blocks[0]).toMatchObject({ path: 'a.md', ordinal: 0, digest: 'd0' });
    expect('embedded' in (loaded.blocks[0] as object)).toBe(false);
  });

  it('reads every line of blocks, and lets a frame go by while it does', async () => {
    const blocks = Array.from({ length: 2_500 }, (_, at) => block('a.md', at, false));
    let pauses = 0;
    // Each look at the clock finds ten milliseconds gone: every line of blocks is a slice.
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (now += 10));
    const loaded = await readCacheLoad(
      loadBytes({ blocks, dimensions: 0, vectors: [], perLine: 1_000 }),
      async () => {
        pauses += 1;
      },
    );
    expect(loaded.blocks).toHaveLength(2_500);
    expect(loaded.blocks.at(-1)).toMatchObject({ ordinal: 2_499 });
    vi.restoreAllMocks();
    expect(pauses).toBe(3);
  });

  it('views the vectors in place when the header leaves them aligned, and copies them when it does not', async () => {
    const blocks = [block('a.md', 0, true)];
    const aligned = loadBytes({ blocks, dimensions: 1, vectors: [0.25] });
    const view = (await readCacheLoad(aligned, noPause)).blocks[0]?.vector;
    expect(view?.buffer).toBe(aligned);
    // A host that did not pad: the vectors start at 1 mod 4, so they cannot be viewed in place.
    const text = new TextEncoder().encode(
      `${JSON.stringify({ dimensions: 1, notes: [] })}\n${JSON.stringify(blocks)}`,
    );
    const bytes = new Uint8Array(4 + text.length + 4);
    const dataView = new DataView(bytes.buffer);
    dataView.setUint32(0, text.length, true);
    bytes.set(text, 4);
    dataView.setFloat32(4 + text.length, 0.25, true);
    const misaligned = (await readCacheLoad(bytes.buffer, noPause)).blocks[0]?.vector;
    expect(Array.from(misaligned ?? [])).toEqual([0.25]);
  });

  it('reads an empty cache', async () => {
    await expect(
      readCacheLoad(loadBytes({ blocks: [], dimensions: 0, vectors: [] }), noPause),
    ).resolves.toEqual({
      notes: [],
      blocks: [],
    });
  });

  it('refuses numbers that are not the embedded blocks’ vectors of the length the header names', async () => {
    const blocks = [block('a.md', 0, true), block('a.md', 1, true)];
    await expect(
      readCacheLoad(loadBytes({ blocks, dimensions: 2, vectors: [1, 2, 3] }), noPause),
    ).rejects.toThrow('3 numbers cannot be 2 vectors of 2');
    await expect(
      readCacheLoad(loadBytes({ blocks: [], dimensions: 0, vectors: [1] }), noPause),
    ).rejects.toThrow('1 numbers cannot be 0 vectors');
  });

  it('reads the bytes the host wrote, from the fixture the host’s own test keeps in step', async () => {
    const file = await readFile(
      new URL(
        '../../../../apps/desktop/src-tauri/tests/fixtures/embedding-cache-load.bin',
        import.meta.url,
      ),
    );
    const bytes = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
    const loaded = await readCacheLoad(bytes as ArrayBuffer, noPause);
    expect(loaded.notes).toEqual([
      { path: 'Home/Garden é.md', digest: 'nb', title: 'Title of Home/Garden é.md' },
      { path: 'Meetings/Standup.md', digest: 'na', title: 'Title of Meetings/Standup.md' },
    ]);
    expect(
      loaded.blocks.map((each) => [
        each.path,
        each.ordinal,
        each.vector && Array.from(each.vector),
      ]),
    ).toEqual([
      ['Home/Garden é.md', 0, [0.25, 0.25, 0.5]],
      ['Meetings/Standup.md', 0, [1, 0, 0.5]],
      ['Meetings/Standup.md', 1, null],
      ['Meetings/Standup.md', 2, [0, 1, -0.5]],
    ]);
    expect(loaded.blocks[1]).toMatchObject({ anchor: 'k3x9a1', heading: 'Payroll', digest: 'd0' });
  });
});

describe('tauriEmbeddingCache', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('opens the cache for a generation and says whether it is fresh', async () => {
    invoke.mockResolvedValue({ fresh: true });
    await expect(tauriEmbeddingCache.open({ generation: 'chunks-1' })).resolves.toEqual({
      fresh: true,
    });
    expect(invoke).toHaveBeenCalledWith('embedding_cache_open', { generation: 'chunks-1' });
  });

  it('sends vectors as plain numbers, and a block without one as null, naming the vault', async () => {
    invoke.mockResolvedValue(null);
    await tauriEmbeddingCache.put(
      [
        {
          path: 'a.md',
          digest: 'n',
          title: 'A',
          blocks: [
            {
              ordinal: 0,
              digest: 'd',
              anchor: 'k3',
              heading: 'H',
              excerpt: 'e',
              vector: Float32Array.from([0.5]),
            },
            { ordinal: 1, digest: 'e', anchor: null, heading: null, excerpt: '', vector: null },
          ],
        },
      ],
      { vault: '/Vault' },
    );
    expect(invoke).toHaveBeenCalledWith('embedding_cache_put', {
      vault: '/Vault',
      notes: [
        {
          path: 'a.md',
          digest: 'n',
          title: 'A',
          blocks: [
            { ordinal: 0, digest: 'd', anchor: 'k3', heading: 'H', excerpt: 'e', vector: [0.5] },
            { ordinal: 1, digest: 'e', anchor: null, heading: null, excerpt: '', vector: null },
          ],
        },
      ],
    });
  });

  it('asks for excerpts by block, removes by path, and clears', async () => {
    invoke.mockResolvedValue(['one']);
    await expect(
      tauriEmbeddingCache.excerpts([{ path: 'a.md', ordinal: 2, digest: 'd2' }]),
    ).resolves.toEqual(['one']);
    expect(invoke).toHaveBeenLastCalledWith('embedding_cache_excerpts', {
      keys: [{ path: 'a.md', ordinal: 2, digest: 'd2' }],
    });
    invoke.mockResolvedValue(null);
    await tauriEmbeddingCache.remove(['a.md'], { vault: '/Vault' });
    expect(invoke).toHaveBeenLastCalledWith('embedding_cache_remove', {
      vault: '/Vault',
      paths: ['a.md'],
    });
    await tauriEmbeddingCache.clear();
    expect(invoke).toHaveBeenLastCalledWith('embedding_cache_clear');
  });

  it('loads through the bytes the host sends', async () => {
    invoke.mockResolvedValue(
      loadBytes({ blocks: [block('a.md', 0, true)], dimensions: 1, vectors: [1] }),
    );
    const loaded = await tauriEmbeddingCache.load();
    expect(Array.from(loaded.blocks[0]?.vector ?? [])).toEqual([1]);
    expect(invoke).toHaveBeenCalledWith('embedding_cache_load');
  });

  it('says a cache the host found torn and made again, so the window starts over', async () => {
    invoke.mockRejectedValue('the embeddings cache was damaged and was made again');
    await expect(tauriEmbeddingCache.put([], { vault: '/Vault' })).rejects.toBeInstanceOf(
      CacheDamagedError,
    );
  });

  it('turns the host’s refusal into an Error that says it was the cache', async () => {
    invoke.mockRejectedValue('another vault was opened before this could be cached');
    await expect(tauriEmbeddingCache.remove(['a.md'], { vault: '/Other' })).rejects.toThrow(
      'The embeddings cache: another vault was opened before this could be cached',
    );
  });
});

describe('browserIdle', () => {
  it('waits for an idle callback where the webview has one', async () => {
    let handed: (() => void) | null = null;
    const idle = browserIdle({
      requestIdleCallback: (callback, options) => {
        expect(options.timeout).toBe(500);
        handed = callback;
        return 1;
      },
    });
    let done = false;
    const waiting = idle.idle().then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    (handed as unknown as () => void)();
    await waiting;
    expect(done).toBe(true);
  });

  it('takes its turn just after a frame where there is none, and after a while if no frame comes', async () => {
    vi.useFakeTimers();
    try {
      let frame: (() => void) | null = null;
      const framed = browserIdle({
        requestAnimationFrame: (callback) => {
          frame = callback;
          return 1;
        },
      });
      let done = false;
      const waiting = framed.idle().then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(done).toBe(false);
      (frame as unknown as () => void)();
      await vi.advanceTimersByTimeAsync(0);
      await waiting;
      expect(done).toBe(true);

      let late = false;
      const never = browserIdle({ requestAnimationFrame: () => 1 });
      const lateWait = never.idle().then(() => {
        late = true;
      });
      await vi.advanceTimersByTimeAsync(499);
      expect(late).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await lateWait;
      expect(late).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
