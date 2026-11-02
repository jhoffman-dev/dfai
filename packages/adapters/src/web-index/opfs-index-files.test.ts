import { describe, expect, it } from 'vitest';
import type { Database, SAHPoolUtil } from '@sqlite.org/sqlite-wasm';
import { indexFileName, opfsIndexFiles } from './opfs-index-files.ts';

describe('the index files in OPFS (#666)', () => {
  it('names a vault’s file by a fingerprint: the same for one vault, another for the next, and nothing of the vault in it', () => {
    const garden = indexFileName('github:example/garden');
    expect(garden).toMatch(/^\/index-[0-9a-f]{16}\.sqlite3$/);
    expect(indexFileName('github:example/garden')).toBe(garden);
    expect(indexFileName('github:example/gardens')).not.toBe(garden);
    expect(garden).not.toContain('garden');
  });

  it('opens, closes and throws away the vault’s file in the pool', () => {
    const opened: string[] = [];
    const unlinked: string[] = [];
    const closed: string[] = [];
    class FakeDb {
      constructor(readonly name: string) {
        opened.push(name);
      }
      close() {
        closed.push(this.name);
      }
    }
    const pool = {
      OpfsSAHPoolDb: FakeDb,
      unlink: (name: string) => {
        unlinked.push(name);
        return true;
      },
    } as unknown as SAHPoolUtil;
    const files = opfsIndexFiles(pool);
    const database = files.open('github:example/garden') as unknown as FakeDb;
    files.close('github:example/garden', database as unknown as Database);
    files.discard('github:example/garden');
    const name = indexFileName('github:example/garden');
    expect([opened, closed, unlinked]).toEqual([[name], [name], [name]]);
  });
});
