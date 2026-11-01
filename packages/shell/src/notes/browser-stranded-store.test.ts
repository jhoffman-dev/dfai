// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVaultPath, type StrandedComments, type StrandedEdit } from '@dfai/domain';
import { browserStrandedCommentStore, browserStrandedStore } from './browser-stranded-store.ts';

const VAULT = '/Users/someone/Vault';
const NOTE = createVaultPath('Notes/today.md');
const OTHER = createVaultPath('Notes/other.md');

const edit = (path = NOTE, text = 'Typed.', keptAt = 100): StrandedEdit => ({
  path,
  doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
  reason: 'the note changed on disk since it was opened',
  modified: 7,
  keptAt,
});

/** The key the adapter uses, spelled out so a change to it is a visible change. */
const keyFor = (vaultKey: string, path: string) =>
  `atlas.stranded:${JSON.stringify(vaultKey)}:${path}`;

/** Replaces `window.localStorage` for one test, over the real one. */
const withStorage = (overrides: Partial<Storage>) => {
  const real = window.localStorage;
  const storage = {
    get length() {
      return real.length;
    },
    key: (at: number) => real.key(at),
    getItem: (key: string) => real.getItem(key),
    setItem: (key: string, value: string) => real.setItem(key, value),
    removeItem: (key: string) => real.removeItem(key),
    clear: () => real.clear(),
    ...overrides,
  } as Storage;
  vi.spyOn(window, 'localStorage', 'get').mockReturnValue(storage);
};

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

describe('browserStrandedStore', () => {
  it('round-trips kept work, oldest first', () => {
    expect(browserStrandedStore.put({ vaultKey: VAULT, edit: edit(OTHER, 'Later.', 200) })).toBe(
      true,
    );
    expect(browserStrandedStore.put({ vaultKey: VAULT, edit: edit(NOTE, 'Earlier.', 100) })).toBe(
      true,
    );

    expect(browserStrandedStore.read(VAULT)).toEqual([
      edit(NOTE, 'Earlier.', 100),
      edit(OTHER, 'Later.', 200),
    ]);
  });

  it("replaces a note's earlier work rather than keeping both", () => {
    browserStrandedStore.put({ vaultKey: VAULT, edit: edit(NOTE, 'First.') });
    browserStrandedStore.put({ vaultKey: VAULT, edit: edit(NOTE, 'Second.') });

    expect(browserStrandedStore.read(VAULT)).toEqual([edit(NOTE, 'Second.')]);
  });

  it('forgets what is removed', () => {
    browserStrandedStore.put({ vaultKey: VAULT, edit: edit() });
    browserStrandedStore.remove({ vaultKey: VAULT, path: NOTE });

    expect(browserStrandedStore.read(VAULT)).toEqual([]);
    expect(window.localStorage.getItem(keyFor(VAULT, NOTE))).toBeNull();
  });

  it('reads nothing when nothing was kept', () => {
    expect(browserStrandedStore.read(VAULT)).toEqual([]);
  });

  it("keeps each vault's work to itself, including a vault whose name starts another's", () => {
    browserStrandedStore.put({ vaultKey: VAULT, edit: edit(NOTE, 'Here.') });
    browserStrandedStore.put({ vaultKey: `${VAULT}:2`, edit: edit(NOTE, 'There.') });
    browserStrandedStore.put({ vaultKey: `${VAULT}"`, edit: edit(NOTE, 'Quoted.') });

    expect(browserStrandedStore.read(VAULT)).toEqual([edit(NOTE, 'Here.')]);
    expect(browserStrandedStore.read(`${VAULT}:2`)).toEqual([edit(NOTE, 'There.')]);
    expect(browserStrandedStore.read('/Users/someone/Elsewhere')).toEqual([]);

    browserStrandedStore.remove({ vaultKey: VAULT, path: NOTE });
    expect(browserStrandedStore.read(`${VAULT}:2`)).toEqual([edit(NOTE, 'There.')]);
  });

  it('leaves the rest of storage alone', () => {
    window.localStorage.setItem('atlas.theme', 'dark');
    browserStrandedStore.put({ vaultKey: VAULT, edit: edit() });

    expect(browserStrandedStore.read(VAULT)).toHaveLength(1);
    expect(window.localStorage.getItem('atlas.theme')).toBe('dark');
  });

  it.each([
    ['not JSON', '{'],
    ['JSON of the wrong shape', JSON.stringify({ path: 'Notes/today.md', doc: 'Typed.' })],
    ['work for another note than its key names', JSON.stringify(edit(OTHER))],
  ])('reads %s as nothing, and clears it', (_label, stored) => {
    window.localStorage.setItem(keyFor(VAULT, NOTE), stored);
    browserStrandedStore.put({ vaultKey: VAULT, edit: edit(OTHER) });

    expect(browserStrandedStore.read(VAULT)).toEqual([edit(OTHER)]);
    expect(window.localStorage.getItem(keyFor(VAULT, NOTE))).toBeNull();
  });

  it('still reads the rest when a malformed entry cannot be cleared', () => {
    window.localStorage.setItem(keyFor(VAULT, NOTE), '{');
    browserStrandedStore.put({ vaultKey: VAULT, edit: edit(OTHER) });
    withStorage({
      removeItem: () => {
        throw new Error('denied');
      },
    });

    expect(browserStrandedStore.read(VAULT)).toEqual([edit(OTHER)]);
  });

  it('reads nothing when the accessor throws, as in a private window', () => {
    withDeniedStorage();
    expect(browserStrandedStore.read(VAULT)).toEqual([]);
  });

  it('reads nothing when the read itself throws', () => {
    browserStrandedStore.put({ vaultKey: VAULT, edit: edit() });
    withStorage({
      getItem: () => {
        throw new Error('denied');
      },
    });
    expect(browserStrandedStore.read(VAULT)).toEqual([]);
  });

  it('says so when the browser refuses a write, rather than throwing', () => {
    withDeniedStorage();
    expect(browserStrandedStore.put({ vaultKey: VAULT, edit: edit() })).toBe(false);
  });

  it('says so when a write fails on quota, and drops the older copy it would replace', () => {
    browserStrandedStore.put({ vaultKey: VAULT, edit: edit(NOTE, 'Older.') });
    withStorage({
      setItem: () => {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      },
    });

    expect(browserStrandedStore.put({ vaultKey: VAULT, edit: edit(NOTE, 'Newer.') })).toBe(false);
    expect(browserStrandedStore.read(VAULT)).toEqual([]);
  });

  it('carries on when a removal is refused', () => {
    withDeniedStorage();
    expect(() => browserStrandedStore.remove({ vaultKey: VAULT, path: NOTE })).not.toThrow();
  });
});

/*
 * Comments a closing literature note could not write (#534), kept beside its
 * typing under their own key, so neither is ever read back as the other.
 */
describe('kept comments in localStorage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  const comments: StrandedComments = {
    path: NOTE,
    comments: [{ id: 'k3x9q2', comment: 'Typed, then ⌘W.', base: 'Lit by Mara.' }],
    reason: 'The disk is full.',
    keptAt: 100,
  };

  it('reads back what was kept, after a quit', () => {
    expect(browserStrandedCommentStore.put({ vaultKey: VAULT, edit: comments })).toBe(true);
    expect(browserStrandedCommentStore.read(VAULT)).toEqual([comments]);
  });

  it('is not the note’s kept typing, nor that typing the comments', () => {
    browserStrandedCommentStore.put({ vaultKey: VAULT, edit: comments });
    browserStrandedStore.put({ vaultKey: VAULT, edit: edit() });
    expect(browserStrandedStore.read(VAULT)).toEqual([edit()]);
    expect(browserStrandedCommentStore.read(VAULT)).toEqual([comments]);
    browserStrandedCommentStore.remove({ vaultKey: VAULT, path: NOTE });
    expect(browserStrandedStore.read(VAULT)).toEqual([edit()]);
  });

  it('answers that it could not keep them when storage is full', () => {
    withStorage({
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    });
    expect(browserStrandedCommentStore.put({ vaultKey: VAULT, edit: comments })).toBe(false);
  });
});
