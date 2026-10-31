// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createVaultPath } from '@dfai/domain';
import {
  createNoteChanges,
  fakeIndexPort,
  fakeMarkdown,
  fakeVaultFs,
  recordingActivity,
  type IndexPort,
  type VaultFsPort,
} from '@dfai/application';
import { useHeldIndexKey } from './index-key.test-support.ts';
import { openOnce } from './open-once.ts';
import { createSyncQueue } from './sync-queue.ts';
import { useIndex, type IndexPorts } from './use-index.ts';

const LARKSPUR = '/vaults/Larkspur';

/** A vault whose listing a test can change, over a raw index port a test can break. */
function editableVault(names: string[]) {
  const files = new Map(names.map((name) => [name, { modified: 1, text: 'note' }]));
  const fs = fakeVaultFs({
    listNotes: async () =>
      [...files].map(([path, file]) => ({
        name: path,
        path: createVaultPath(path),
        modified: file.modified,
        size: file.text.length,
      })),
    readNotes: async (wanted) =>
      wanted.map((path) => {
        const file = files.get(path) ?? { modified: 1, text: 'note' };
        return { path, text: file.text, modified: file.modified, size: file.text.length };
      }),
  }) as VaultFsPort;
  const edit = (path: string, text: string) => {
    const before = files.get(path);
    files.set(path, { modified: (before?.modified ?? 1) + 1, text });
  };
  return { fs, files, edit };
}

/** Records every index key the window would have re-run on, as React rendered them. */
function keysOf(keys: string[], key: string): void {
  if (keys.at(-1) !== key) keys.push(key);
}

describe('useIndex: the change key moves for the sync schedule (#238 attack)', () => {
  it('moves the change key for a local edit whose refresh fails, after a refresh that already failed', async () => {
    const vault = editableVault(['Alder.md', 'Birch.md']);
    let failing = false;
    const raw = fakeIndexPort({
      put: async () => {
        if (failing) throw new Error('disk full');
      },
    });
    const ports: IndexPorts = { fs: vault.fs, index: openOnce(raw), markdown: fakeMarkdown() };
    const activity = recordingActivity();
    const changes = createNoteChanges({ onError: () => {} });
    const keys: string[] = [];
    const { result } = renderHook(() => {
      const index = useIndex({ ports, vaultKey: LARKSPUR, activity, changes });
      keysOf(keys, useHeldIndexKey(index.store, LARKSPUR));
      return index;
    });
    await waitFor(() => expect(result.current.status.kind).toBe('ready'));

    failing = true;
    vault.edit('Alder.md', 'first edit');
    await act(async () => {
      expect(await result.current.refresh()).toBe(false);
    });
    const afterFirstFailure = keys.length;

    // The owner keeps writing while the index is broken. Every edit must still
    // move the key the push schedule counts edits by (use-sync-schedule.ts:58);
    // on main each refresh went working → failed, so each one counted.
    vault.edit('Birch.md', 'second edit');
    await act(async () => {
      expect(await result.current.refresh()).toBe(false);
    });

    expect(keys.length).toBeGreaterThan(afterFirstFailure);
  });
});

describe('useIndex: open-once forgets after any failing call a sync makes (#238 attack)', () => {
  it('opens the index again after a sync whose relation query failed', async () => {
    const vault = editableVault(['Alder.md']);
    let opened = 0;
    let failing = false;
    const raw: IndexPort = fakeIndexPort({
      open: async () => {
        opened += 1;
        return { fresh: false };
      },
      // The relation-holders query a sync makes when a note arrives (refresh-index.ts:348).
      query: async () => {
        if (failing) throw new Error('the index connection went away');
        return { columns: [], rows: [], truncated: false };
      },
    });
    const ports: IndexPorts = { fs: vault.fs, index: openOnce(raw), markdown: fakeMarkdown() };
    const activity = recordingActivity();
    const changes = createNoteChanges({ onError: () => {} });
    const { result } = renderHook(() => useIndex({ ports, vaultKey: LARKSPUR, activity, changes }));
    await waitFor(() => expect(result.current.status.kind).toBe('ready'));
    expect(opened).toBe(1);

    failing = true;
    vault.edit('Cedar.md', 'arrived');
    await act(async () => {
      expect(await result.current.refresh()).toBe(false);
    });
    failing = false;
    await act(async () => {
      expect(await result.current.refresh()).toBe(true);
    });

    // The PR: "forgotten ... when any call a sync makes fails". `query` is one.
    expect(opened).toBe(2);
  });
});

describe('openOnce: what a cached opening says (#238 attack)', () => {
  it('does not still say fresh once the index it opened has been written to', async () => {
    const index = openOnce(fakeIndexPort({ open: async () => ({ fresh: true }) }));
    expect(await index.open()).toEqual({ fresh: true });
    await index.put([], { vault: LARKSPUR });

    // IndexOpening.fresh: "True when the host made the index just now ... so it
    // holds nothing of the vault yet". It holds the vault now; a syncer that
    // trusts it measures from nothing and publishes no changes.
    expect((await index.open()).fresh).toBe(false);
  });
});

describe('createSyncQueue under load (#238 attack)', () => {
  it('runs exactly two syncs for fifty asks made during one, and answers every one', async () => {
    let runs = 0;
    let finishFirst = () => {};
    const queue = createSyncQueue(async () => {
      runs += 1;
      if (runs === 1) await new Promise<void>((resolve) => (finishFirst = resolve));
      return true;
    });
    const first = queue.ask(LARKSPUR, { fromScratch: false, quiet: false });
    const asks = Array.from({ length: 50 }, (_, n) =>
      queue.ask(LARKSPUR, { fromScratch: n === 25, quiet: n % 2 === 0 }),
    );
    finishFirst();
    const answers = await Promise.all([first, ...asks]);
    expect(runs).toBe(2);
    expect(answers.every(Boolean)).toBe(true);
  });

  it('gives a failing waiting sync to every joiner, and the next ask still runs', async () => {
    let runs = 0;
    let finishFirst = () => {};
    const queue = createSyncQueue(async () => {
      runs += 1;
      if (runs === 1) await new Promise<void>((resolve) => (finishFirst = resolve));
      if (runs === 2) throw new Error('the waiting one broke');
      return true;
    });
    void queue.ask(LARKSPUR, { fromScratch: false, quiet: false });
    const joiners = [1, 2, 3].map(() => queue.ask(LARKSPUR, { fromScratch: false, quiet: true }));
    finishFirst();
    const outcomes = await Promise.allSettled(joiners);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(await queue.ask(LARKSPUR, { fromScratch: false, quiet: false })).toBe(true);
    expect(runs).toBe(3);
  });
});

/** Renders the real hook over one set of ports per vault, as `app.tsx` does. */
function windowOn(portsFor: (vault: string) => IndexPorts, first: string) {
  const activity = recordingActivity();
  const changes = createNoteChanges({ onError: () => {} });
  const seen: { vault: string; key: string }[] = [];
  const hook = renderHook(
    ({ vaultKey }: { vaultKey: string }) => {
      const index = useIndex({ ports: portsFor(vaultKey), vaultKey, activity, changes });
      seen.push({ vault: vaultKey, key: useHeldIndexKey(index.store, vaultKey) });
      return index;
    },
    { initialProps: { vaultKey: first } },
  );
  return { ...hook, seen };
}

const QUILL = '/vaults/Quill';

describe('useIndex: vault switches (#238 attack)', () => {
  it('never reads ready for a vault whose opening was still pending at a switch, and the late opening settles nothing', async () => {
    let letLarkspurOpen = () => {};
    const larkspurOpen = new Promise<void>((resolve) => (letLarkspurOpen = resolve));
    const ports = new Map<string, IndexPorts>([
      [
        LARKSPUR,
        {
          fs: editableVault(['Alder.md']).fs,
          index: openOnce(
            fakeIndexPort({
              open: async () => {
                await larkspurOpen;
                return { fresh: false };
              },
              stats: async () => ({ notes: 1, properties: 0, links: 0 }),
            }),
          ),
          markdown: fakeMarkdown(),
        },
      ],
      [
        QUILL,
        {
          fs: editableVault(['Wren.md', 'Heron.md']).fs,
          index: openOnce(
            fakeIndexPort({ stats: async () => ({ notes: 2, properties: 0, links: 0 }) }),
          ),
          markdown: fakeMarkdown(),
        },
      ],
    ]);
    const { result, rerender, seen } = windowOn((vault) => ports.get(vault)!, LARKSPUR);
    rerender({ vaultKey: QUILL });
    await waitFor(() => expect(result.current.status).toMatchObject({ kind: 'ready', notes: 2 }));
    await act(async () => {
      letLarkspurOpen();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(seen.filter(({ vault, key }) => vault === LARKSPUR && key.startsWith('ready'))).toEqual(
      [],
    );
    expect(result.current.status).toMatchObject({ kind: 'ready', notes: 2 });
  });

  it('does not run a sync left waiting on one vault against the vault opened next', async () => {
    let letBuildFinish = () => {};
    const held = new Promise<void>((resolve) => (letBuildFinish = resolve));
    let quillListings = 0;
    const quill = editableVault(['Wren.md']);
    const listQuill = quill.fs.listNotes.bind(quill.fs);
    quill.fs.listNotes = async (...args) => {
      quillListings += 1;
      return listQuill(...args);
    };
    const ports = new Map<string, IndexPorts>([
      [
        LARKSPUR,
        {
          fs: editableVault(['Alder.md']).fs,
          index: openOnce(fakeIndexPort({ put: () => held })),
          markdown: fakeMarkdown(),
        },
      ],
      [QUILL, { fs: quill.fs, index: openOnce(fakeIndexPort()), markdown: fakeMarkdown() }],
    ]);
    const { result, rerender } = windowOn((vault) => ports.get(vault)!, LARKSPUR);
    let waiting: Promise<boolean> = Promise.resolve(true);
    act(() => {
      waiting = result.current.refresh();
    });
    rerender({ vaultKey: QUILL });
    await waitFor(() => expect(result.current.status.kind).toBe('ready'));
    const listedForQuill = quillListings;
    letBuildFinish();
    await act(async () => {
      expect(await waiting).toBe(false);
    });
    expect(quillListings).toBe(listedForQuill);
  });

  it('builds again, and only then reads ready, on going back to a vault left a moment ago', async () => {
    const ports = new Map<string, IndexPorts>([
      [
        LARKSPUR,
        {
          fs: editableVault(['Alder.md']).fs,
          index: openOnce(fakeIndexPort()),
          markdown: fakeMarkdown(),
        },
      ],
      [
        QUILL,
        {
          fs: editableVault(['Wren.md']).fs,
          index: openOnce(fakeIndexPort()),
          markdown: fakeMarkdown(),
        },
      ],
    ]);
    const { result, rerender, seen } = windowOn((vault) => ports.get(vault)!, LARKSPUR);
    await waitFor(() => expect(result.current.status.kind).toBe('ready'));
    const readyKey = seen.at(-1)!.key;
    rerender({ vaultKey: QUILL });
    rerender({ vaultKey: LARKSPUR });
    const backAt = seen.length - 1;
    await waitFor(() => expect(result.current.status.kind).toBe('ready'));
    const after = seen.slice(backAt).map(({ key }) => key);
    expect(after[0]).toBe('building');
    expect(after.at(-1)).not.toBe(readyKey);
  });
});

describe('useIndex: the revision moves for every change readers need (#238 attack)', () => {
  async function readyOver(names: string[]) {
    const vault = editableVault(names);
    const ports: IndexPorts = {
      fs: vault.fs,
      // The index remembers what it was given, so a refresh can tell what changed.
      index: openOnce(rememberingIndex()),
      markdown: fakeMarkdown(),
    };
    const window = windowOn(() => ports, LARKSPUR);
    await waitFor(() => expect(window.result.current.status.kind).toBe('ready'));
    return { ...window, vault };
  }

  it('moves on a quiet refresh that found only a delete', async () => {
    const { result, vault } = await readyOver(['Alder.md', 'Birch.md']);
    const revision = result.current.store.getState().revision;
    vault.files.delete('Birch.md');
    await act(async () => {
      await result.current.refresh({ quiet: true });
    });
    expect(result.current.store.getState().revision).toBe(revision + 1);
  });

  it('moves on a quiet refresh that found an edit of an existing note', async () => {
    const { result, vault } = await readyOver(['Alder.md']);
    const revision = result.current.store.getState().revision;
    vault.edit('Alder.md', '---\ntype: task\n---\nnow a task');
    await act(async () => {
      await result.current.refresh({ quiet: true });
    });
    expect(result.current.store.getState().revision).toBe(revision + 1);
  });

  it('moves once for a pull of many notes at once', async () => {
    const { result, vault } = await readyOver(['Alder.md']);
    const revision = result.current.store.getState().revision;
    for (let n = 0; n < 300; n++)
      vault.files.set(`Pulled ${n}.md`, { modified: 1, text: 'pulled' });
    await act(async () => {
      await result.current.refresh({ quiet: true });
    });
    expect(result.current.store.getState().revision).toBe(revision + 1);
  });

  it('does not move on a quiet refresh that found nothing', async () => {
    const { result } = await readyOver(['Alder.md']);
    const revision = result.current.store.getState().revision;
    await act(async () => {
      await result.current.refresh({ quiet: true });
    });
    expect(result.current.store.getState().revision).toBe(revision);
  });
});

/** An index port that holds what was put, so its manifest answers like the host's. */
function rememberingIndex(): IndexPort {
  const rows = new Map<
    string,
    { modified: number; size: number; type: string | null; digest: string }
  >();
  return fakeIndexPort({
    manifest: async () =>
      [...rows].map(([path, row]) => ({ path, ...row })) as unknown as Awaited<
        ReturnType<IndexPort['manifest']>
      >,
    put: async (notes) => {
      for (const note of notes) {
        const held = note as unknown as {
          path: string;
          modified: number;
          size: number;
          type?: string | null;
          digest?: string;
        };
        rows.set(held.path, {
          modified: held.modified,
          size: held.size,
          type: held.type ?? null,
          digest: held.digest ?? '',
        });
      }
    },
    remove: async (paths) => {
      for (const path of paths) rows.delete(path);
    },
    stats: async () => ({ notes: rows.size, properties: 0, links: 0 }),
  });
}
