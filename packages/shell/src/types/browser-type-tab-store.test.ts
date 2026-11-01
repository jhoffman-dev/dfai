// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserTypeTabStore } from './browser-type-tab-store.ts';

const KEY = 'atlas.type-tabs';
const BOARD = '.atlas/views/Board.md';

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('the type tab store', () => {
  it('remembers nothing until a tab is open', () => {
    expect(createBrowserTypeTabStore().read({ vault: '/work', type: 'task' })).toBeNull();
  });

  it('keeps each type’s last tab across launches, per vault and per type', () => {
    const store = createBrowserTypeTabStore();
    store.write({ vault: '/work', type: 'task', path: BOARD });
    store.write({ vault: '/home', type: 'task', path: '.atlas/views/Chores.md' });
    store.write({ vault: '/work', type: 'project', path: '.atlas/views/Projects.md' });

    const relaunched = createBrowserTypeTabStore();
    expect(relaunched.read({ vault: '/work', type: 'task' })).toBe(BOARD);
    expect(relaunched.read({ vault: '/home', type: 'task' })).toBe('.atlas/views/Chores.md');
    expect(relaunched.read({ vault: '/work', type: 'project' })).toBe('.atlas/views/Projects.md');
    expect(relaunched.read({ vault: '/home', type: 'project' })).toBeNull();
  });

  it('reads what it does not recognise as nothing remembered', () => {
    window.localStorage.setItem(KEY, 'not json');
    expect(createBrowserTypeTabStore().read({ vault: '/work', type: 'task' })).toBeNull();

    window.localStorage.setItem(KEY, '["a"]');
    expect(createBrowserTypeTabStore().read({ vault: '/work', type: 'task' })).toBeNull();

    window.localStorage.setItem(KEY, 'null');
    expect(createBrowserTypeTabStore().read({ vault: '/work', type: 'task' })).toBeNull();

    window.localStorage.setItem(
      KEY,
      JSON.stringify({ '/work\u0000task': 7, '/work\u0000project': BOARD }),
    );
    const store = createBrowserTypeTabStore();
    expect(store.read({ vault: '/work', type: 'task' })).toBeNull();
    expect(store.read({ vault: '/work', type: 'project' })).toBe(BOARD);
  });

  it('keeps the last tab for the session where storage refuses it', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('The operation is insecure.');
    });
    const store = createBrowserTypeTabStore();
    expect(store.read({ vault: '/work', type: 'task' })).toBeNull();
    store.write({ vault: '/work', type: 'task', path: BOARD });
    expect(store.read({ vault: '/work', type: 'task' })).toBe(BOARD);
  });

  it('keeps the last tab for the session where storage is full', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });
    const store = createBrowserTypeTabStore();
    store.write({ vault: '/work', type: 'task', path: BOARD });
    expect(store.read({ vault: '/work', type: 'task' })).toBe(BOARD);
  });
});
