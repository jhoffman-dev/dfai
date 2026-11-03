import {
  fakeHostVaultFs,
  HOST_CHANGED_ON_DISK,
  memorySaveQueueStore,
  offlineSaves,
  sharedQueueChanges,
  switchableConnection,
  VaultAccessError,
} from '@dfai/application';
import { createVaultPath as p, queuedSaveKey } from '@dfai/domain';
import { describe, expect, it } from 'vitest';
import { HOLD_MS, storageLock } from '../auth/storage-lock.ts';

/*
 * Attack on PR #753: the save queue under the localStorage lock (no Web
 * Locks). A hold lapses after HOLD_MS, so a send slower than that lets a
 * second tab in while the first tab's request is still with GitHub.
 */

const VAULT = 'github:mara-quill/larkspur-vault#main';
const ACCOUNT = 'mara-quill';

function memoryStorage(): Storage {
  const held = new Map<string, string>();
  return {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => void held.set(key, value),
    removeItem: (key) => void held.delete(key),
    clear: () => held.clear(),
    key: () => null,
    get length() {
      return held.size;
    },
  };
}

/** GitHub as it judges a save: already-there first, then held to the version named. */
function slowFirstWriteGitHub() {
  const note = { text: 'v1', modified: 1 };
  let release: () => void = () => {};
  let started: () => void = () => {};
  const firstStarted = new Promise<void>((resolve) => (started = resolve));
  let calls = 0;
  const apply = (contents: string, expected: number | null) => {
    if (contents === note.text) return note.modified;
    if (expected !== note.modified) throw new VaultAccessError(HOST_CHANGED_ON_DISK);
    note.text = contents;
    note.modified += 10;
    return note.modified;
  };
  const fs = fakeHostVaultFs({
    writeTextFile: async ({ contents, expectedModified }) => {
      calls += 1;
      if (calls > 1) return apply(contents, expectedModified);
      started();
      // The first request reaches GitHub only when the test lets it: a slow iPad connection.
      await new Promise<void>((resolve) => (release = resolve));
      return apply(contents, expectedModified);
    },
  });
  return { fs, note, firstStarted, release: () => release() };
}

describe('the save queue under the localStorage lock, when a hold lapses mid-send', () => {
  it('never marks a save refused that a later turn already landed and carried on from', async () => {
    let now = 1_000;
    let ids = 0;
    const lock = storageLock({
      storage: memoryStorage(),
      now: () => now,
      holderId: () => `tab-${(ids += 1)}`,
      // Waiting moves the fixed clock on: no real time passes.
      wait: async (ms) => void (now += ms),
    });
    const github = slowFirstWriteGitHub();
    const store = memorySaveQueueStore();
    const connection = switchableConnection(false);
    const channel = sharedQueueChanges();
    const tab = () =>
      offlineSaves({
        fs: github.fs,
        store,
        connection,
        device: 'DFAI web',
        report: () => {},
        lock: (task) => lock('dfai-save-queue', task),
        changes: channel(),
        account: () => ACCOUNT,
        vault: () => VAULT,
      });
    const first = tab();
    const second = tab();
    const provisional = await first.fs.writeTextFile({
      vault: VAULT,
      path: p('Plan.md'),
      contents: 'offline',
      expectedModified: 1,
    });
    connection.set(true);
    const firstSending = first.send(ACCOUNT);
    await github.firstStarted;
    // The second tab waits out HOLD_MS, then sends the same save and carries on typing.
    const carriedOn = await second.fs.writeTextFile({
      vault: VAULT,
      path: p('Plan.md'),
      contents: 'offline, then more',
      expectedModified: provisional,
    });
    expect(now).toBeGreaterThan(1_000 + HOLD_MS);
    expect(github.note).toEqual({ text: 'offline, then more', modified: carriedOn });
    github.release();
    await firstSending;
    // Observed: the first tab's late refusal overwrites the landed record (same provisional), so
    // her note shows as refused and her next save from `carriedOn` is refused as stale.
    expect(store.held.get(queuedSaveKey(VAULT, 'Plan.md'))?.state.kind).not.toBe('refused');
  });
});
