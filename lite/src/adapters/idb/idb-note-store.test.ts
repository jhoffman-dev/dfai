import { IDBFactory } from 'fake-indexeddb';
import 'fake-indexeddb/auto';
import type { StoredFile } from '../../application/index.ts';
import { openIdbNoteStore } from './index.ts';

const MARA: StoredFile = {
  path: 'People/Mara Quill.md',
  text: 'Leads payroll.',
  baseSha: 'a1',
  dirty: false,
};
const PLAN: StoredFile = {
  path: 'Projects/Larkspur Payroll.md',
  text: 'Plan 🌱',
  baseSha: null,
  dirty: true,
};

beforeEach(() => {
  // A fresh, empty IndexedDB for every test, so none sees another's data.
  globalThis.indexedDB = new IDBFactory();
});

describe('the IndexedDB note store', () => {
  it('round-trips files, sorted by path, and deletes', async () => {
    const store = await openIdbNoteStore('vault');
    await store.put(PLAN);
    await store.put(MARA);
    expect(await store.list()).toEqual([MARA, PLAN]);
    expect(await store.get(PLAN.path)).toEqual(PLAN);
    await store.delete(PLAN.path);
    await store.delete('Nothing here.md');
    expect(await store.get(PLAN.path)).toBeNull();
    expect(await store.list()).toEqual([MARA]);
  });

  it('keeps only the port’s fields', async () => {
    const store = await openIdbNoteStore('vault');
    await store.put({ ...MARA, extra: 'not kept' } as StoredFile);
    expect(await store.get(MARA.path)).toEqual(MARA);
  });

  it('renames in one step', async () => {
    const store = await openIdbNoteStore('vault');
    await store.put(MARA);
    const moved = { ...MARA, path: 'Archive/Mara Quill.md', dirty: true };
    await store.rename(MARA.path, moved);
    expect(await store.list()).toEqual([moved]);
  });

  it('leaves both files as they were when a rename fails', async () => {
    const store = await openIdbNoteStore('vault');
    await store.put(MARA);
    // A record without its key path is refused, so the whole transaction rolls back.
    const broken = { text: 'x', baseSha: null, dirty: true } as unknown as StoredFile;
    await expect(store.rename(MARA.path, broken)).rejects.toThrow();
    expect(await store.list()).toEqual([MARA]);
  });

  it('keeps a key/value beside the files', async () => {
    const store = await openIdbNoteStore('vault');
    expect(await store.getState('sync.lastSeen')).toBeNull();
    await store.setState('sync.lastSeen', '{"treeSha":"t1"}');
    await store.setState('sync.lastSeen', '{"treeSha":"t2"}');
    expect(await store.getState('sync.lastSeen')).toBe('{"treeSha":"t2"}');
  });

  it('keeps everything when the database is opened again', async () => {
    const first = await openIdbNoteStore('vault');
    await first.put(MARA);
    await first.setState('k', 'v');
    const again = await openIdbNoteStore('vault');
    expect(await again.list()).toEqual([MARA]);
    expect(await again.getState('k')).toBe('v');
    expect(await (await openIdbNoteStore('other vault')).list()).toEqual([]);
  });
});
