import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { browserConnection } from './browser-connection.ts';
import { indexedDbReadCache } from './indexeddb-read-cache.ts';

const entry = (key: string, usedAt = 1) => ({
  key,
  value: { text: `# ${key}`, modified: 3 },
  bytes: 20,
  usedAt,
});

describe('indexedDbReadCache', () => {
  it('round-trips a kept read, across a reopen of the database', async () => {
    const factory = new IDBFactory();
    await indexedDbReadCache(factory).put(entry('note\u0000Plan.md'));
    const reopened = indexedDbReadCache(factory);
    expect(await reopened.get('note\u0000Plan.md')).toEqual(entry('note\u0000Plan.md'));
    expect(await reopened.get('note\u0000Other.md')).toBeNull();
  });

  it('touches, lists the facts without values, removes and clears', async () => {
    const store = indexedDbReadCache(new IDBFactory());
    await store.put(entry('a'));
    await store.put(entry('b'));
    await store.touch('a', 9);
    await store.touch('gone', 9);
    expect(await store.facts()).toEqual([
      { key: 'a', bytes: 20, usedAt: 9 },
      { key: 'b', bytes: 20, usedAt: 1 },
    ]);
    await store.remove(['a']);
    expect((await store.facts()).map((fact) => fact.key)).toEqual(['b']);
    await store.clear();
    expect(await store.facts()).toEqual([]);
  });

  it('refuses when the browser will not open the database, and tries again next call', async () => {
    const factory = new IDBFactory();
    let refusals = 1;
    const refusing = {
      open: (name: string, version?: number) => {
        if (refusals-- > 0) throw new DOMException('denied', 'SecurityError');
        return factory.open(name, version);
      },
    } as unknown as IDBFactory;
    const store = indexedDbReadCache(refusing);
    await expect(store.get('a')).rejects.toThrow('denied');
    expect(await store.get('a')).toBeNull();
  });

  it('refuses a value the browser cannot clone, keeping nothing of it', async () => {
    const store = indexedDbReadCache(new IDBFactory());
    await expect(store.put({ ...entry('a'), value: () => 1 })).rejects.toThrow();
    expect(await store.facts()).toEqual([]);
  });
});

describe('browserConnection', () => {
  it('says what the browser says, and tells each change until stopped', () => {
    const events = new EventTarget();
    const navigator = { onLine: false };
    const page = Object.assign(events, { navigator }) as unknown as Window;
    const connection = browserConnection(page);
    const heard: boolean[] = [];
    const stop = connection.onChange((online) => heard.push(online));
    expect(connection.online()).toBe(false);
    page.dispatchEvent(new Event('online'));
    page.dispatchEvent(new Event('offline'));
    stop();
    page.dispatchEvent(new Event('online'));
    expect(heard).toEqual([true, false]);
  });
});
