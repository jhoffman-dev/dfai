import { describe, expect, it } from 'vitest';
import type { SAHPoolUtil } from '@sqlite.org/sqlite-wasm';
import type { IndexedNote } from '@dfai/application';
import { sqliteWasm } from './in-memory-web-index.ts';
import { startIndexHost } from './start-index-host.ts';
import { WEB_INDEX } from './web-index-schema.ts';

/**
 * The index worker's start (#761): when the browser refuses OPFS, as WebKit
 * does in an ephemeral context and perhaps in Private Browsing, the index is
 * kept in memory for the page instead, and says so; anything else that goes
 * wrong is passed on.
 */

const VAULT = 'github:example/garden';
const STILL = { now: () => 0 };

const note = (path: string, body: string): IndexedNote => ({
  path,
  title: path.replace(/\.md$/, ''),
  modified: 1,
  modifiedAt: null,
  size: body.length,
  digest: 'd',
  type: null,
  body,
  summary: '',
  properties: [],
  links: [],
  tags: [],
  relations: [],
  blocks: [],
  checks: [],
  progress: null,
  highlights: [],
});

/** A pool install that fails as the browser makes it fail. */
const refusing = (error: unknown) => (): Promise<SAHPoolUtil> => Promise.reject(error);

const transient = () =>
  new DOMException('The operation failed for an unknown transient reason.', 'UnknownError');

describe('starting the index worker’s host (#761)', () => {
  it('answers from memory when the browser refuses OPFS, and says the index is not kept', async () => {
    const host = await startIndexHost({
      sqlite3: await sqliteWasm(),
      installPool: refusing(transient()),
      shape: WEB_INDEX,
      clock: STILL,
    });

    expect(host.open(VAULT)).toEqual({ fresh: true, kept: false });
    host.put(VAULT, [note('Moss.md', 'a garden of moss and fern')]);
    expect(host.search('fern', 10, {}).map((hit) => hit.path)).toEqual(['Moss.md']);
    expect(host.manifest().map((entry) => entry.path)).toEqual(['Moss.md']);
  });

  it('falls back too when the pool installs but cannot take its files', async () => {
    const pool = {
      reserveMinimumCapacity: () =>
        Promise.reject(new DOMException('The request is not allowed.', 'SecurityError')),
    } as unknown as SAHPoolUtil;
    const host = await startIndexHost({
      sqlite3: await sqliteWasm(),
      installPool: () => Promise.resolve(pool),
      shape: WEB_INDEX,
      clock: STILL,
    });

    expect(host.open(VAULT)).toEqual({ fresh: true, kept: false });
  });

  it('starts every open afresh: nothing of the last is kept in memory', async () => {
    const host = await startIndexHost({
      sqlite3: await sqliteWasm(),
      installPool: refusing(transient()),
      shape: WEB_INDEX,
      clock: STILL,
    });
    host.open(VAULT);
    host.put(VAULT, [note('Moss.md', 'moss')]);

    expect(host.open(VAULT)).toEqual({ fresh: true, kept: false });
    expect(host.manifest()).toEqual([]);
  });

  it('passes on any failure that is not the browser refusing storage', async () => {
    const busy = new DOMException('Another tab holds the file.', 'NoModificationAllowedError');
    const starting = startIndexHost({
      sqlite3: await sqliteWasm(),
      installPool: refusing(busy),
      shape: WEB_INDEX,
      clock: STILL,
    });

    await expect(starting).rejects.toBe(busy);
  });
});
