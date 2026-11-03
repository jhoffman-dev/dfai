import { beforeEach, describe, expect, it } from 'vitest';
import type { Clock } from '@dfai/application';
import { sqliteWasm } from './in-memory-web-index.ts';
import { memoryIndexFiles } from './memory-index-files.ts';
import { MAX_QUERY_BYTES, QUERY_DEADLINE_MS } from './wasm-index-query.ts';
import { createWasmIndexHost } from './wasm-index-host.ts';
import { WEB_INDEX } from './web-index-schema.ts';

/**
 * What a query may build and how long it may take in the browser's index
 * (PR #747's attack): every value is held to the host's result size as it is
 * made, blobs count toward a result's size as text does, and a query that
 * steps little but long is stopped by a deadline on an injected clock.
 */

const VAULT = 'github:example/garden';
const TOO_LARGE = 'the result is larger than DFAI will read';

async function hostOn(clock: Pick<Clock, 'now'>) {
  const sqlite3 = await sqliteWasm();
  const host = createWasmIndexHost({
    sqlite3,
    files: memoryIndexFiles(sqlite3),
    shape: WEB_INDEX,
    clock,
  });
  host.open(VAULT);
  return host;
}

/** A clock that stands still: only the step budget can stop a query. */
const stillClock = { now: () => 0 };

describe('what a query may build (#747)', () => {
  let host: Awaited<ReturnType<typeof hostOn>>;
  beforeEach(async () => {
    host = await hostOn(stillClock);
  });

  it('refuses a value built past the cap, with the host’s words for a result too large', () => {
    expect(() =>
      host.query(`SELECT length(printf('%.*c', ${MAX_QUERY_BYTES + 1}, 'x'))`, []),
    ).toThrow(TOO_LARGE);
  });

  it('counts the blobs a result returns toward its size', () => {
    const rows = Math.ceil(MAX_QUERY_BYTES / 1_000_000) + 2;
    expect(() =>
      host.query(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n LIMIT ${rows}) SELECT zeroblob(1000000) FROM n`,
        [],
      ),
    ).toThrow(TOO_LARGE);
  });

  it('still lets the index write a note larger than a query may build', () => {
    host.query(`SELECT 1`, []);
    const body = 'x'.repeat(MAX_QUERY_BYTES + 10);
    expect(() =>
      host.put(VAULT, [
        {
          path: 'Big.md',
          title: 'Big',
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
        },
      ]),
    ).not.toThrow();
  });
});

describe('how long a query may take (#747)', () => {
  /** 200,000 rows: well under the step budget, so only a deadline stops it. */
  const LONG =
    'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n LIMIT 200000) SELECT count(*) FROM n';

  it('stops a query past its deadline, as one past its steps: interrupted', async () => {
    let now = 0;
    const host = await hostOn({ now: () => (now += QUERY_DEADLINE_MS / 4) });
    expect(() => host.query(LONG, [])).toThrow(/^interrupted$/);
    expect(host.query('SELECT 1', []).rows).toEqual([[1]]);
  });

  it('lets the same query finish while its time lasts', async () => {
    const host = await hostOn(stillClock);
    expect(host.query(LONG, []).rows).toEqual([[200000]]);
  });
});
