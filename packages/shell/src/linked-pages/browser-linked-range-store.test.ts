// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserLinkedRangeStore } from './browser-linked-range-store.ts';

const KEY = 'atlas.linked-ranges';

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('the linked range store', () => {
  it('remembers nothing until a section is left on a range', () => {
    expect(createBrowserLinkedRangeStore().read('person')).toEqual({});
  });

  it('keeps each page type’s sections across launches, apart from every other type’s', () => {
    const store = createBrowserLinkedRangeStore();
    store.write('person', 'meetings', 'all');
    store.write('person', 'notes', 'all');
    store.write('company', 'meetings', 'recent');
    const relaunched = createBrowserLinkedRangeStore();
    expect(relaunched.read('person')).toEqual({ meetings: 'all', notes: 'all' });
    expect(relaunched.read('company')).toEqual({ meetings: 'recent' });
    expect(relaunched.read('project')).toEqual({});
  });

  it('takes the last choice for a section', () => {
    const store = createBrowserLinkedRangeStore();
    store.write('person', 'meetings', 'all');
    store.write('person', 'meetings', 'recent');
    expect(store.read('person')).toEqual({ meetings: 'recent' });
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? '')).toEqual({
      person: { meetings: 'recent' },
    });
  });

  it('reads what it does not recognise as nothing remembered', () => {
    window.localStorage.setItem(KEY, '{"person": {"meetings": "forever", "notes": "all"}, "x": 3}');
    const store = createBrowserLinkedRangeStore();
    expect(store.read('person')).toEqual({ notes: 'all' });
    expect(store.read('x')).toEqual({});
    window.localStorage.setItem(KEY, 'not json');
    expect(createBrowserLinkedRangeStore().read('person')).toEqual({});
    window.localStorage.setItem(KEY, '["a"]');
    expect(createBrowserLinkedRangeStore().read('person')).toEqual({});
  });

  it('holds a choice for the session where storage refuses it', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const store = createBrowserLinkedRangeStore();
    store.write('person', 'meetings', 'all');
    expect(store.read('person')).toEqual({ meetings: 'all' });
  });

  it('starts with nothing remembered where storage cannot be read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(createBrowserLinkedRangeStore().read('person')).toEqual({});
  });
});
