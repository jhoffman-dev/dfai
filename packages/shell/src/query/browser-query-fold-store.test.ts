// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserQueryFoldStore } from './browser-query-fold-store.ts';

const KEY = 'atlas.query-folds';

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('the query fold store', () => {
  it('remembers nothing until a view has been folded or opened', () => {
    expect(createBrowserQueryFoldStore().read('vault\u0000Open work.md')).toBeNull();
  });

  it('keeps each view’s fold across launches, apart from every other view’s', () => {
    const store = createBrowserQueryFoldStore();
    store.write('v\u0000Open work.md', false);
    store.write('v\u0000Waiting.md', true);
    const relaunched = createBrowserQueryFoldStore();
    expect(relaunched.read('v\u0000Open work.md')).toBe(false);
    expect(relaunched.read('v\u0000Waiting.md')).toBe(true);
    expect(relaunched.read('v\u0000Other.md')).toBeNull();
  });

  it('sees a fold another pane wrote since it was made', () => {
    const first = createBrowserQueryFoldStore();
    const second = createBrowserQueryFoldStore();
    first.write('v\u0000Open work.md', false);
    expect(second.read('v\u0000Open work.md')).toBe(false);
  });

  it('reads what it does not recognise as nothing remembered', () => {
    window.localStorage.setItem(
      KEY,
      '{"v\\u0000Open work.md": "shut", "v\\u0000Waiting.md": true}',
    );
    const store = createBrowserQueryFoldStore();
    expect(store.read('v\u0000Open work.md')).toBeNull();
    expect(store.read('v\u0000Waiting.md')).toBe(true);
    window.localStorage.setItem(KEY, 'not json');
    expect(createBrowserQueryFoldStore().read('v\u0000Waiting.md')).toBeNull();
    window.localStorage.setItem(KEY, '[true]');
    expect(createBrowserQueryFoldStore().read('0')).toBeNull();
  });

  it('keeps the fold for the session where storage refuses it', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('The operation is insecure.');
    });
    const store = createBrowserQueryFoldStore();
    expect(store.read('v\u0000Open work.md')).toBeNull();
    store.write('v\u0000Open work.md', false);
    expect(store.read('v\u0000Open work.md')).toBe(false);
  });
});
