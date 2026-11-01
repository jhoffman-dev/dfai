// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createVaultPath, STRANDED_EDIT_LIFETIME_MS, type StrandedComments } from '@dfai/domain';
import { useStrandedComments, type StrandedCommentStore } from './stranded-comments.ts';

const NOTE = createVaultPath('Library/The Last Lamp.md');
const VAULT = '/Users/someone/Vault';
const NOW = 1_700_000_000_000;
const REFUSED = 'The comment changed in the note meanwhile, so it was not written over.';
const TYPED = { id: 'k3x9q2', comment: 'Typed, then ⌘W.', base: 'Lit by Mara.' };

/** A store that outlives the hooks over it: a fresh hook on it is DFAI started again. */
function memoryStore({ refuseWrites = false } = {}) {
  const entries = new Map<string, StrandedComments>();
  const store: StrandedCommentStore = {
    read: () => [...entries.values()],
    put: ({ edit }) => {
      if (refuseWrites) return false;
      entries.set(edit.path, edit);
      return true;
    },
    remove: ({ path }) => void entries.delete(path),
  };
  return { store, entries };
}

const run = (store: StrandedCommentStore, now = NOW) =>
  renderHook(() => useStrandedComments({ store, vaultKey: VAULT, now: () => now }));

const keepTyped = (hook: ReturnType<typeof run>) =>
  act(() =>
    hook.result.current.keep({ vault: VAULT, path: NOTE, comments: [TYPED], reason: REFUSED }),
  );

describe('comments a closing note could not write (#534)', () => {
  it('says whose they are, why, and the words, until they are settled', () => {
    const hook = run(memoryStore().store);
    expect(hook.result.current.notice).toBeNull();
    keepTyped(hook);
    expect(hook.result.current.notice).toContain('The Last Lamp');
    expect(hook.result.current.notice).toContain(REFUSED);
    expect(hook.result.current.notice).toContain('Typed, then ⌘W.');
    expect(hook.result.current.waiting).toEqual([NOTE]);
    act(() =>
      hook.result.current.settle({
        vault: VAULT,
        path: NOTE,
        comments: hook.result.current.offered(NOTE),
      }),
    );
    expect(hook.result.current.notice).toBeNull();
    expect(hook.result.current.offered(NOTE)).toEqual([]);
  });

  it('offers them back, with their base, after DFAI starts again', () => {
    const { store } = memoryStore();
    keepTyped(run(store));
    const again = run(store);
    expect(again.result.current.offered(NOTE)).toEqual([TYPED]);
    expect(again.result.current.notice).toContain('Typed, then ⌘W.');
  });

  it('keeps them offered while DFAI runs when the store refuses them', () => {
    const hook = run(memoryStore({ refuseWrites: true }).store);
    keepTyped(hook);
    expect(hook.result.current.offered(NOTE)).toEqual([TYPED]);
  });

  it('lets them go once a month has passed, as kept typing is', () => {
    const { store, entries } = memoryStore();
    keepTyped(run(store));
    const later = run(store, NOW + STRANDED_EDIT_LIFETIME_MS + 1);
    expect(later.result.current.offered(NOTE)).toEqual([]);
    expect(entries.size).toBe(0);
  });

  it('can be discarded by hand', () => {
    const { store, entries } = memoryStore();
    const hook = run(store);
    keepTyped(hook);
    act(() => hook.result.current.forget(NOTE));
    expect(hook.result.current.waiting).toEqual([]);
    expect(entries.size).toBe(0);
  });
});
