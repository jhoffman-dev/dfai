// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserHiddenSectionStore as store } from './browser-hidden-section-store.ts';

const KEY = 'atlas.sidebar.hidden';

/** The accessor itself throws in a private window, before any method is called. */
const withDeniedStorage = () => {
  vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
    throw new Error('The operation is insecure.');
  });
};

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('browserHiddenSectionStore', () => {
  it('hides Pages when nothing has been kept on this machine', () => {
    expect(store.read()).toEqual(['userSpace']);
  });

  it('round-trips a choice, an empty list included', () => {
    store.write([]);
    expect(window.localStorage.getItem(KEY)).toBe('[]');
    expect(store.read()).toEqual([]);

    store.write(['userSpace']);
    expect(store.read()).toEqual(['userSpace']);
  });

  it('keeps out of the collapsed sections’ key', () => {
    store.write([]);
    expect(window.localStorage.getItem('atlas.sidebar.collapsed')).toBeNull();
  });

  it.each([['not json'], ['"userSpace"'], ['{}']])(
    'reads the default from a kept value that is not a list: %s',
    (kept) => {
      window.localStorage.setItem(KEY, kept);
      expect(store.read()).toEqual(['userSpace']);
    },
  );

  it('reads the default when the accessor throws, as in a private window', () => {
    withDeniedStorage();
    expect(store.read()).toEqual(['userSpace']);
  });

  it('swallows a write the browser refuses, so the app carries on', () => {
    withDeniedStorage();
    expect(() => store.write([])).not.toThrow();
  });
});
