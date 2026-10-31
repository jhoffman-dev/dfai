// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserGroupFoldStore } from './browser-group-fold-store.ts';

const KEY = 'atlas.view-folds';

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('the group fold store', () => {
  it('remembers nothing folded until something is', () => {
    expect(createBrowserGroupFoldStore().read('vault\u0000Board.md')).toEqual([]);
  });

  it('keeps each view’s folds across launches, apart from every other view’s', () => {
    const store = createBrowserGroupFoldStore();
    store.write('v\u0000Board.md', ['/["status","doing"]']);
    store.write('v\u0000Table.md', ['/["area","home"]']);
    const relaunched = createBrowserGroupFoldStore();
    expect(relaunched.read('v\u0000Board.md')).toEqual(['/["status","doing"]']);
    expect(relaunched.read('v\u0000Table.md')).toEqual(['/["area","home"]']);
  });

  it('forgets a view once nothing in it is folded', () => {
    const store = createBrowserGroupFoldStore();
    store.write('v\u0000Board.md', ['a']);
    store.write('v\u0000Board.md', []);
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? '')).toEqual({});
  });

  it('reads what it does not recognise as nothing folded', () => {
    window.localStorage.setItem(KEY, '{"v\\u0000Board.md": [1, "a", null], "x": "shut"}');
    const store = createBrowserGroupFoldStore();
    expect(store.read('v\u0000Board.md')).toEqual(['a']);
    expect(store.read('x')).toEqual([]);
    window.localStorage.setItem(KEY, 'not json');
    expect(createBrowserGroupFoldStore().read('v\u0000Board.md')).toEqual([]);
    window.localStorage.setItem(KEY, '["a"]');
    expect(createBrowserGroupFoldStore().read('0')).toEqual([]);
  });

  it('keeps folds for the session where storage refuses them', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('The operation is insecure.');
    });
    const store = createBrowserGroupFoldStore();
    expect(store.read('v\u0000Board.md')).toEqual([]);
    store.write('v\u0000Board.md', ['a']);
    expect(store.read('v\u0000Board.md')).toEqual(['a']);
  });
});
