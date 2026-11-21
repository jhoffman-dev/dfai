import { DEFAULT_SETTINGS, DEFAULT_UI_PREFS, type Settings } from '../../application/index.ts';
import { SETTINGS_KEY, createLocalSettingsStore } from './index.ts';

/** `Storage` over a Map: the part of localStorage the store uses. */
class MapStorage implements Storage {
  private readonly items = new Map<string, string>();
  get length() {
    return this.items.size;
  }
  clear() {
    this.items.clear();
  }
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
}

const SAVED: Settings = {
  repo: { owner: 'mara-quill', name: 'larkspur-notes', branch: 'main' },
  token: 'github_pat_secret',
  ui: {
    theme: 'dark',
    expandedFolders: ['Projects'],
    lastOpenPath: 'Projects/Plan.md',
    preview: true,
  },
};

describe('the local settings store', () => {
  it('loads the defaults when nothing is saved', () => {
    expect(createLocalSettingsStore(new MapStorage()).load()).toEqual(DEFAULT_SETTINGS);
  });

  it('round-trips what it saves', () => {
    const storage = new MapStorage();
    createLocalSettingsStore(storage).save(SAVED);
    expect(createLocalSettingsStore(storage).load()).toEqual(SAVED);
  });

  it('loads the defaults for settings that are not JSON, without throwing', () => {
    const storage = new MapStorage();
    storage.setItem(SETTINGS_KEY, '{"token":"github_pat_secret", oops');
    expect(createLocalSettingsStore(storage).load()).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps the fields it can read and defaults the rest, one by one', () => {
    const storage = new MapStorage();
    storage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        repo: { owner: 'mara-quill', name: 7, branch: 'main' },
        token: 'github_pat_secret',
        ui: { theme: 'neon', expandedFolders: ['A', 3], lastOpenPath: 'A.md', preview: 'yes' },
      }),
    );
    expect(createLocalSettingsStore(storage).load()).toEqual({
      repo: null,
      token: 'github_pat_secret',
      ui: { ...DEFAULT_UI_PREFS, lastOpenPath: 'A.md' },
    });
  });
});
