// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  createVaultPath,
  STRANDED_EDIT_LIFETIME_MS,
  type EditorDocument,
  type StrandedEdit,
} from '@dfai/domain';
import { useStrandedEdits, type StrandedEditStore } from './stranded-edits.ts';
import { memoryStrandedStore } from './testing/memory-stranded-store.ts';

const NOTE = createVaultPath('Notes/today.md');
const OTHER = createVaultPath('Notes/other.md');
const VAULT = '/Users/someone/Vault';
const ANOTHER_VAULT = '/Users/someone/Other Vault';
const NOW = 1_700_000_000_000;

const doc = (text: string): EditorDocument => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const REFUSED = 'the note changed on disk since it was opened';

const stranding = (path = NOTE, text = 'Typed.', vault = VAULT) => ({
  path,
  doc: doc(text),
  reason: REFUSED,
  modified: 5,
  vault,
});

/** One run of the app: a fresh hook over whatever the store kept. */
function run({
  store,
  vaultKey = VAULT,
  now = NOW,
}: {
  store: StrandedEditStore;
  vaultKey?: string | null;
  now?: number;
}) {
  return renderHook(() => useStrandedEdits({ store, vaultKey, now: () => now }));
}

describe('work a closing pane could not write', () => {
  it('says which note it belongs to and why it was not saved', () => {
    const { result } = run({ store: memoryStrandedStore().store });

    expect(result.current.notice).toBeNull();
    act(() => result.current.keep(stranding()));

    expect(result.current.notice).toContain('today');
    expect(result.current.notice).toContain(REFUSED);
    expect(result.current.notice).not.toContain('lost if DFAI quits');
    expect(result.current.waiting).toEqual([NOTE]);
  });

  it('names a chat note as one, never by its title, which is the question', () => {
    const { result } = run({ store: memoryStrandedStore().store });
    act(() =>
      result.current.keep(stranding(createVaultPath('Chats/Should Mara Quill get a raise.md'))),
    );

    expect(result.current.notice).toContain('Unsaved changes to a chat note could not be saved');
    expect(result.current.notice).not.toContain('Mara Quill');
  });

  it('hands the work back once, and stops saying so', () => {
    const { result } = run({ store: memoryStrandedStore().store });
    act(() => result.current.keep(stranding()));

    let taken: StrandedEdit | null = null;
    act(() => {
      taken = result.current.take(NOTE);
    });

    // The work as kept, without the vault it was filed under.
    expect(taken).toEqual({
      path: NOTE,
      doc: doc('Typed.'),
      reason: REFUSED,
      modified: 5,
      keptAt: NOW,
    });
    expect(result.current.notice).toBeNull();
    expect(result.current.take(NOTE)).toBeNull();
  });

  it("keeps one note's work when another note's is taken", () => {
    const { result } = run({ store: memoryStrandedStore().store });
    act(() => {
      result.current.keep(stranding(NOTE, 'Typed here.'));
      result.current.keep(stranding(OTHER, 'Typed there.'));
    });

    act(() => void result.current.take(NOTE));

    expect(result.current.take(OTHER)?.doc).toEqual(doc('Typed there.'));
    expect(result.current.notice).toContain('other');
  });

  it('has nothing to hand back for a note it was never given', () => {
    const { result } = run({ store: memoryStrandedStore().store });

    expect(result.current.take(NOTE)).toBeNull();
    expect(result.current.notice).toBeNull();
  });

  it('keeps work for the vault it came from, even while no vault is open', () => {
    const { store, stored } = memoryStrandedStore();
    const { result } = run({ store, vaultKey: null });

    act(() => result.current.keep(stranding()));

    expect(result.current.notice).toBeNull();
    expect(stored(VAULT).map((edit) => edit.path)).toEqual([NOTE]);
  });
});

describe('work handed over after its vault was switched away from', () => {
  it('is kept for the vault it was typed in, not the one open now', () => {
    const { store, stored } = memoryStrandedStore();
    const { result } = run({ store, vaultKey: ANOTHER_VAULT });

    act(() => result.current.keep(stranding(NOTE, 'Typed in the first vault.', VAULT)));

    expect(stored(ANOTHER_VAULT)).toEqual([]);
    expect(stored(VAULT).map((edit) => edit.doc)).toEqual([doc('Typed in the first vault.')]);
  });

  it("is not offered to the open vault's note of the same name", () => {
    const { result } = run({ store: memoryStrandedStore().store, vaultKey: ANOTHER_VAULT });

    act(() => result.current.keep(stranding(NOTE, 'Typed in the first vault.', VAULT)));

    expect(result.current.notice).toBeNull();
    expect(result.current.waiting).toEqual([]);
    expect(result.current.take(NOTE)).toBeNull();
  });

  it('is waiting when its own vault is opened again', () => {
    const { store } = memoryStrandedStore();
    const elsewhere = run({ store, vaultKey: ANOTHER_VAULT });
    act(() => elsewhere.result.current.keep(stranding(NOTE, 'Typed in the first vault.', VAULT)));
    elsewhere.unmount();

    const back = run({ store, vaultKey: VAULT });

    expect(back.result.current.notice).toContain('today');
    expect(back.result.current.take(NOTE)?.doc).toEqual(doc('Typed in the first vault.'));
  });
});

describe('work kept across a quit', () => {
  it('is waiting when the app starts again, and says so', () => {
    const { store } = memoryStrandedStore();
    const first = run({ store });
    act(() => first.result.current.keep(stranding()));
    first.unmount();

    const second = run({ store });

    expect(second.result.current.notice).toContain('today');
    expect(second.result.current.take(NOTE)?.doc).toEqual(doc('Typed.'));
  });

  // R14-05: handed back is not the same as written. Until the pane says the
  // work was saved or thrown away, the store is its only durable copy.
  it('is still kept after it is handed back, so a quit before it is written loses nothing', () => {
    const { store, stored } = memoryStrandedStore();
    const first = run({ store });
    act(() => first.result.current.keep(stranding()));
    first.unmount();
    const second = run({ store });
    act(() => void second.result.current.take(NOTE));

    expect(stored(VAULT).map((edit) => edit.path)).toEqual([NOTE]);
    second.unmount();
    const third = run({ store });

    expect(third.result.current.take(NOTE)?.doc).toEqual(doc('Typed.'));
  });

  it('is handed back again when the pane that took it puts it back', () => {
    const { result } = run({ store: memoryStrandedStore().store });
    act(() => result.current.keep(stranding(NOTE, 'First.')));
    act(() => void result.current.take(NOTE));

    act(() => result.current.keep(stranding(NOTE, 'Put back.')));

    expect(result.current.waiting).toEqual([NOTE]);
    expect(result.current.take(NOTE)?.doc).toEqual(doc('Put back.'));
  });

  it('is let go of once settled, even after its vault was switched away from', () => {
    const { store, stored } = memoryStrandedStore();
    const { result, rerender } = renderHook(
      ({ vaultKey }: { vaultKey: string }) => useStrandedEdits({ store, vaultKey, now: () => NOW }),
      { initialProps: { vaultKey: VAULT } },
    );
    act(() => result.current.keep(stranding()));
    act(() => void result.current.take(NOTE));
    rerender({ vaultKey: ANOTHER_VAULT });

    act(() => result.current.settle({ vault: VAULT, path: NOTE }));

    expect(stored(VAULT)).toEqual([]);
    rerender({ vaultKey: VAULT });
    expect(result.current.take(NOTE)).toBeNull();
  });

  it('is handed back once it is settled, not again on the start after that', () => {
    const { store } = memoryStrandedStore();
    const first = run({ store });
    act(() => first.result.current.keep(stranding()));
    first.unmount();
    const second = run({ store });
    act(() => void second.result.current.take(NOTE));
    act(() => second.result.current.settle({ vault: VAULT, path: NOTE }));
    second.unmount();

    const third = run({ store });

    expect(third.result.current.take(NOTE)).toBeNull();
    expect(third.result.current.notice).toBeNull();
  });

  it("is never offered to another vault's note of the same name", () => {
    const { store } = memoryStrandedStore();
    const first = run({ store });
    act(() => first.result.current.keep(stranding()));
    first.unmount();

    const elsewhere = run({ store, vaultKey: ANOTHER_VAULT });

    expect(elsewhere.result.current.notice).toBeNull();
    expect(elsewhere.result.current.take(NOTE)).toBeNull();
  });

  it('is let go of once it has waited its whole lifetime', () => {
    const { store, stored } = memoryStrandedStore();
    const first = run({ store });
    act(() => {
      first.result.current.keep(stranding(NOTE));
    });
    first.unmount();
    const later = run({ store, now: NOW + STRANDED_EDIT_LIFETIME_MS / 2 });
    act(() => later.result.current.keep(stranding(OTHER)));
    later.unmount();

    const expired = run({ store, now: NOW + STRANDED_EDIT_LIFETIME_MS + 1 });

    expect(expired.result.current.take(NOTE)).toBeNull();
    expect(stored(VAULT).map((edit) => edit.path)).toEqual([OTHER]);
    expect(expired.result.current.waiting).toEqual([OTHER]);
  });

  it('expires a lifetime after it is first seen, when it was stamped in the future', () => {
    // The clock was ahead when the work was kept, and has since been put right.
    const { store, stored } = memoryStrandedStore();
    const ahead = run({ store, now: NOW + STRANDED_EDIT_LIFETIME_MS * 10 });
    act(() => ahead.result.current.keep(stranding(NOTE)));
    ahead.unmount();

    const corrected = run({ store });
    expect(corrected.result.current.waiting).toEqual([NOTE]);
    expect(stored(VAULT).map((edit) => edit.keptAt)).toEqual([NOW]);
    corrected.unmount();
    const expired = run({ store, now: NOW + STRANDED_EDIT_LIFETIME_MS + 1 });

    expect(expired.result.current.waiting).toEqual([]);
    expect(stored(VAULT)).toEqual([]);
  });

  it('says so when work stamped in the future cannot be stored redated', () => {
    const ahead: StrandedEdit = { ...stranding(NOTE), keptAt: NOW + 1 };
    // Refusing the write drops the stored copy, as the browser store does.
    const store: StrandedEditStore = { read: () => [ahead], put: () => false, remove: () => {} };

    const { result } = run({ store });

    expect(result.current.waiting).toEqual([NOTE]);
    expect(result.current.notice).toContain('lost if DFAI quits');
  });

  it('can be discarded by hand, for a note that no longer exists', () => {
    const { store, stored } = memoryStrandedStore();
    const { result } = run({ store });
    act(() => result.current.keep(stranding()));

    act(() => result.current.forget(NOTE));

    expect(result.current.notice).toBeNull();
    expect(stored(VAULT)).toEqual([]);
  });

  it('is still handed back, and said to be at risk, when the store refuses it', () => {
    const { store, stored } = memoryStrandedStore({ refuseWrites: true });
    const { result } = run({ store });

    act(() => result.current.keep(stranding()));

    expect(stored(VAULT)).toEqual([]);
    expect(result.current.notice).toContain('today could not be stored either');
    expect(result.current.notice).toContain('lost if DFAI quits');
    expect(result.current.take(NOTE)?.doc).toEqual(doc('Typed.'));
  });
});
