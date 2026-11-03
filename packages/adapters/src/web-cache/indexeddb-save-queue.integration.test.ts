import { queueSave, type QueuedSave } from '@dfai/domain';
import { IDBDatabase, IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { indexedDbReadCache } from './indexeddb-read-cache.ts';
import { indexedDbSaveQueue } from './indexeddb-save-queue.ts';

function save(path: string, contents: string): QueuedSave {
  const decision = queueSave(
    undefined,
    {
      account: 'mara-quill',
      vault: 'github:mara-quill/larkspur-vault#main',
      path,
      contents,
      expectedModified: 4,
    },
    { order: 0, provisional: -1 },
  );
  if (decision.kind !== 'queued') throw new Error('not queued');
  return decision.save;
}

describe('indexedDbSaveQueue', () => {
  it('keeps a waiting save across a reopen, as a reload opens it', async () => {
    const factory = new IDBFactory();
    await indexedDbSaveQueue(factory).put(save('Plan.md', 'offline edit'));
    expect(await indexedDbSaveQueue(factory).all()).toEqual([save('Plan.md', 'offline edit')]);
  });

  it('replaces a note’s save, removes one and clears them all', async () => {
    const queue = indexedDbSaveQueue(new IDBFactory());
    await queue.put(save('A.md', 'one'));
    await queue.put(save('A.md', 'one two'));
    await queue.put(save('B.md', 'b'));
    expect((await queue.all()).map((queued) => queued.contents)).toEqual(['one two', 'b']);
    await queue.remove(save('A.md', '').key);
    expect((await queue.all()).map((queued) => queued.path)).toEqual(['B.md']);
    await queue.clear();
    expect(await queue.all()).toEqual([]);
  });

  it('fails a put the browser refuses, so the save is never told it waits', async () => {
    const factory = new IDBFactory();
    const refusing = {
      open: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
    } as unknown as IDBFactory;
    await expect(indexedDbSaveQueue(refusing).put(save('A.md', 'a'))).rejects.toThrow('quota');
    expect(await indexedDbSaveQueue(factory).all()).toEqual([]);
  });

  it('reads one note’s save back by its key, and nothing for one not there', async () => {
    const queue = indexedDbSaveQueue(new IDBFactory());
    await queue.put(save('A.md', 'one'));
    expect(await queue.get(save('A.md', '').key)).toEqual(save('A.md', 'one'));
    expect(await queue.get(save('B.md', '').key)).toBeNull();
  });

  it('asks for strict durability for the queue alone, so a save told waiting is on disk', async () => {
    const transaction = vi.spyOn(IDBDatabase.prototype, 'transaction');
    const factory = new IDBFactory();
    await indexedDbSaveQueue(factory).put(save('A.md', 'one'));
    expect(transaction).toHaveBeenCalledWith('saves', 'readwrite', { durability: 'strict' });
    transaction.mockClear();
    await indexedDbReadCache(factory).put({ key: 'k', value: 1, bytes: 2, usedAt: 3 });
    expect(transaction.mock.calls.length).toBeGreaterThan(0);
    expect(transaction.mock.calls.every((call) => call[2] === undefined)).toBe(true);
    transaction.mockRestore();
  });
});
