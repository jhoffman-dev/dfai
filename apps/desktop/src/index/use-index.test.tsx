// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { createVaultPath } from '@dfai/domain';
import {
  createNoteChanges,
  createOwnWrites,
  fakeIndexPort,
  fakeMarkdown,
  fakeVaultFs,
  INDEX_BATCH_SIZE,
  recordingActivity,
} from '@dfai/application';
import { IndexProgressPill, LiveIndexSettings } from './index-progress.tsx';
import type { IndexPhase, IndexStatusStore } from './index-status-store.ts';
import { useHeldIndexKey } from './index-key.test-support.ts';
import { openOnce } from './open-once.ts';
import { refreshAfterWatch } from './watched-paths.ts';
import { useIndex, type IndexPorts, type IndexStatus } from './use-index.ts';

const VAULT = '/vaults/Larkspur';

/** A vault of this many notes, over an index that holds none of them yet. */
function vaultOf(count: number): IndexPorts {
  const paths = Array.from({ length: count }, (_, n) => `Note ${n}.md`);
  return {
    fs: fakeVaultFs({
      listNotes: async () =>
        paths.map((path) => ({ name: path, path: createVaultPath(path), modified: 1, size: 4 })),
      readNotes: async (wanted) =>
        wanted.map((path) => ({ path, text: 'note', modified: 1, size: 4 })),
    }),
    index: fakeIndexPort({ stats: async () => ({ notes: count, properties: 0, links: 0 }) }),
    markdown: fakeMarkdown(),
  };
}

/** Builds the index of a vault this size, and says what the window was told on the way. */
async function build(count: number) {
  const statuses: IndexStatus[] = [];
  const ticks: number[] = [];
  let renders = 0;
  const activity = recordingActivity();
  const changes = createNoteChanges({ onError: () => {} });
  const ports = vaultOf(count);
  const { result } = renderHook(() => {
    renders += 1;
    const index = useIndex({ ports, vaultKey: VAULT, activity, changes });
    if (statuses.at(-1) !== index.status) statuses.push(index.status);
    return index;
  });
  result.current.progress.subscribe(() => ticks.push(result.current.progress.current().done));
  await waitFor(() => expect(result.current.status.kind).toBe('ready'));
  return { statuses, ticks, renders, index: result.current };
}

describe('useIndex while a vault is being indexed (#135)', () => {
  it('tells the window that it is working once, however many batches the build takes', async () => {
    const small = await build(INDEX_BATCH_SIZE);
    const large = await build(INDEX_BATCH_SIZE * 8);

    // Everything that re-reads when the index moves hangs off `status`: a
    // status per batch would run every one of those reads per batch.
    // An open vault not yet synced is building from the first render, never idle (#238).
    expect(large.statuses.map((status) => status.kind)).toEqual(['working', 'ready']);
    expect(large.renders).toBe(small.renders);
  });

  it('says how far it has got to whoever asks, batch by batch', async () => {
    const { ticks, index } = await build(INDEX_BATCH_SIZE * 3);

    expect(ticks.filter((done) => done > 0)).toEqual([
      INDEX_BATCH_SIZE,
      INDEX_BATCH_SIZE * 2,
      INDEX_BATCH_SIZE * 3,
    ]);
    expect(index.progress.current()).toEqual({
      done: INDEX_BATCH_SIZE * 3,
      total: INDEX_BATCH_SIZE * 3,
    });
  });

  it('counts each finished build as a move of the index', async () => {
    const { index } = await build(3);
    expect(index.status).toEqual({ kind: 'ready', notes: 3, revision: 1 });
  });
});

describe('useIndex: whether a refresh caught up (ADR-0034)', () => {
  it('says true once the index holds the files, and false when it could not read them', async () => {
    const activity = recordingActivity();
    const changes = createNoteChanges({ onError: () => {} });
    const ports = vaultOf(2);
    const { result } = renderHook(() => useIndex({ ports, vaultKey: VAULT, activity, changes }));
    await waitFor(() => expect(result.current.status.kind).toBe('ready'));
    let caughtUp: boolean | null = null;
    await act(async () => {
      caughtUp = await result.current.refresh();
    });
    expect(caughtUp).toBe(true);

    ports.fs.listNotes = async () => {
      throw new Error('the disk went away');
    };
    await act(async () => {
      caughtUp = await result.current.refresh();
    });
    expect(caughtUp).toBe(false);
    expect(result.current.status.kind).toBe('failed');
  });
});

describe('useIndex, asked to refresh while a build is running (#135)', () => {
  it('keeps saying how far the build has got', async () => {
    const ports = vaultOf(INDEX_BATCH_SIZE * 2);
    let letSecondBatchIn = () => {};
    const held = new Promise<void>((resolve) => (letSecondBatchIn = resolve));
    let puts = 0;
    ports.index = { ...ports.index, put: async () => void (++puts === 2 && (await held)) };
    const activity = recordingActivity();
    const changes = createNoteChanges({ onError: () => {} });
    const { result } = renderHook(() => useIndex({ ports, vaultKey: VAULT, activity, changes }));
    const halfway = { done: INDEX_BATCH_SIZE, total: INDEX_BATCH_SIZE * 2 };
    await waitFor(() => expect(result.current.progress.current()).toEqual(halfway));

    // What a save does, through the watcher, while the build is still going.
    let refreshed: Promise<unknown> = Promise.resolve();
    act(() => {
      refreshed = result.current.refresh();
    });

    expect(result.current.progress.current()).toEqual(halfway);
    expect(result.current.status.kind).toBe('working');
    letSecondBatchIn();
    await act(() => refreshed);
    expect(result.current.status).toMatchObject({ kind: 'ready', revision: 2 });
  });
});

describe('useIndex, asked to catch up (ADR-0034)', () => {
  /** A vault whose build holds at its first batch until let through, counting every listing of the vault. */
  function heldVault() {
    const ports = vaultOf(INDEX_BATCH_SIZE * 2);
    let letBuildFinish = () => {};
    const held = new Promise<void>((resolve) => (letBuildFinish = resolve));
    let puts = 0;
    ports.index = { ...ports.index, put: async () => void (++puts === 1 && (await held)) };
    const listed = { count: 0 };
    const listNotes = ports.fs.listNotes.bind(ports.fs);
    ports.fs.listNotes = async (...args) => {
      listed.count += 1;
      return listNotes(...args);
    };
    return { ports, listed, letBuildFinish };
  }

  const indexOf = (ports: IndexPorts) => {
    const activity = recordingActivity();
    const changes = createNoteChanges({ onError: () => {} });
    return renderHook(() => useIndex({ ports, vaultKey: VAULT, activity, changes })).result;
  };

  it('waits for the build under way rather than reading the vault again behind it', async () => {
    const { ports, listed, letBuildFinish } = heldVault();
    const result = indexOf(ports);
    await waitFor(() => expect(listed.count).toBe(1));

    let caughtUp: Promise<boolean> = Promise.resolve(false);
    act(() => {
      caughtUp = result.current.catchUp();
    });
    let answered: boolean | null = null;
    void caughtUp.then((held) => (answered = held));
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(answered).toBeNull();

    letBuildFinish();
    await act(async () => {
      answered = await caughtUp;
    });
    expect(answered).toBe(true);
    expect(listed.count).toBe(1);
    expect(result.current.status).toMatchObject({ kind: 'ready', revision: 1 });
  });

  it('waits too for a refresh a change asked for during the build, and asks none of its own', async () => {
    const { ports, listed, letBuildFinish } = heldVault();
    const result = indexOf(ports);
    await waitFor(() => expect(listed.count).toBe(1));

    let caughtUp: Promise<boolean> = Promise.resolve(false);
    act(() => {
      void result.current.refresh();
      caughtUp = result.current.catchUp();
    });
    letBuildFinish();
    let answered: boolean | null = null;
    await act(async () => {
      answered = await caughtUp;
    });
    expect(answered).toBe(true);
    // The build, and the refresh the change asked for; the catch-up answered from the second.
    expect(listed.count).toBe(2);
    expect(result.current.status).toMatchObject({ kind: 'ready', revision: 2 });
  });

  it('asks for one refresh when the last did not hold the files', async () => {
    const ports = vaultOf(2);
    const listNotes = ports.fs.listNotes.bind(ports.fs);
    let listed = 0;
    ports.fs.listNotes = async (...args) => {
      listed += 1;
      if (listed === 1) throw new Error('the disk went away');
      return listNotes(...args);
    };
    const result = indexOf(ports);
    await waitFor(() => expect(result.current.status.kind).toBe('failed'));

    let answered: boolean | null = null;
    await act(async () => {
      answered = await result.current.catchUp();
    });
    expect(answered).toBe(true);
    expect(listed).toBe(2);
    expect(result.current.status.kind).toBe('ready');
  });
});

/** Every phase the store passes through, from now on, each time it changes. */
function phasesOf(store: IndexStatusStore): IndexPhase[] {
  const seen: IndexPhase[] = [store.getState().phase];
  store.subscribe((state) => {
    if (seen.at(-1) !== state.phase) seen.push(state.phase);
  });
  return seen;
}

/** A vault's index, built and ready, with what a test needs to drive it. */
async function readyIndex(ports: IndexPorts = vaultOf(3)) {
  const activity = recordingActivity();
  const changes = createNoteChanges({ onError: () => {} });
  const hook = renderHook(() => useIndex({ ports, vaultKey: VAULT, activity, changes }));
  await waitFor(() => expect(hook.result.current.status.kind).toBe('ready'));
  return { ...hook, ports, changes };
}

describe('useIndex: a refresh keeps the index ready (#238)', () => {
  it('never says building, or anything but ready, while an incremental refresh runs', async () => {
    const { result } = await readyIndex();
    const store = result.current.store;
    const phases = phasesOf(store);
    const revision = store.getState().revision;

    await act(async () => {
      await result.current.refresh();
      await result.current.refresh({ quiet: true });
    });

    expect(phases).toEqual(['ready']);
    // The loud refresh moved it; the quiet one found nothing and left it.
    expect(store.getState().revision).toBe(revision + 1);
  });

  it('says building for the first sync of a vault, and for a rebuild', async () => {
    const activity = recordingActivity();
    const changes = createNoteChanges({ onError: () => {} });
    const ports = vaultOf(3);
    const { result } = renderHook(() => useIndex({ ports, vaultKey: VAULT, activity, changes }));
    // The first sync has started by the time the hook hands its store back.
    const phases = phasesOf(result.current.store);
    await waitFor(() => expect(result.current.status.kind).toBe('ready'));
    expect(phases).toEqual(['building', 'ready']);

    await act(async () => {
      await result.current.rebuild();
    });
    expect(phases).toEqual(['building', 'ready', 'building', 'ready']);
  });

  it('moves the revision on a quiet refresh only when it found a change', async () => {
    const { result, ports } = await readyIndex();
    const store = result.current.store;
    const revision = store.getState().revision;

    await act(async () => {
      await result.current.refresh({ quiet: true });
    });
    expect(store.getState().revision).toBe(revision);

    const listNotes = ports.fs.listNotes.bind(ports.fs);
    ports.fs.listNotes = async (...args) => [
      ...(await listNotes(...args)),
      { name: 'Arrived.md', path: createVaultPath('Arrived.md'), modified: 1, size: 4 },
    ];
    await act(async () => {
      await result.current.refresh({ quiet: true });
    });
    expect(store.getState().revision).toBe(revision + 1);
  });

  it('answers every refresh asked during a sync with one sync after it', async () => {
    const ports = vaultOf(INDEX_BATCH_SIZE);
    let letBuildFinish = () => {};
    const held = new Promise<void>((resolve) => (letBuildFinish = resolve));
    ports.index = { ...ports.index, put: () => held };
    let listed = 0;
    const listNotes = ports.fs.listNotes.bind(ports.fs);
    ports.fs.listNotes = async (...args) => {
      listed += 1;
      return listNotes(...args);
    };
    const activity = recordingActivity();
    const changes = createNoteChanges({ onError: () => {} });
    const { result } = renderHook(() => useIndex({ ports, vaultKey: VAULT, activity, changes }));
    await waitFor(() => expect(listed).toBe(1));

    let asked: Promise<boolean>[] = [];
    act(() => {
      asked = [
        result.current.refresh({ quiet: true }),
        result.current.refresh(),
        result.current.refresh({ quiet: true }),
        result.current.rebuild(),
        result.current.refresh(),
      ];
    });
    letBuildFinish();
    let answers: boolean[] = [];
    await act(async () => {
      answers = await Promise.all(asked);
    });

    expect(listed).toBe(2);
    expect(answers).toEqual([true, true, true, true, true]);
    // Joined: the rebuild asked among them was not lost to the refreshes around it.
    expect(activity.reports.map((report) => report.message)).toContain(
      `Rebuilt the index: ${INDEX_BATCH_SIZE} notes.`,
    );
  });
});

describe('useIndex: what a watcher event moves (#239)', () => {
  /** A ready index, with every key the window would re-run on. */
  async function watched() {
    const activity = recordingActivity();
    const changes = createNoteChanges({ onError: () => {} });
    const ports = vaultOf(3);
    const keys: string[] = [];
    const { result } = renderHook(() => {
      const index = useIndex({ ports, vaultKey: VAULT, activity, changes });
      const key = useHeldIndexKey(index.store, VAULT);
      if (keys.at(-1) !== key) keys.push(key);
      return index;
    });
    await waitFor(() => expect(result.current.status.kind).toBe('ready'));
    const heard = (paths: string[]) =>
      act(async () => {
        await result.current.refresh(refreshAfterWatch(paths));
      });
    return { keys, heard };
  }

  it.each([
    ['a template', '.atlas/templates/Meeting.md'],
    ['an attachment', 'Files/Scan from Mara Quill.pdf'],
  ])('moves the key for %s, which the index does not hold', async (_, path) => {
    const { keys, heard } = await watched();
    const before = keys.at(-1);
    await heard([path]);
    expect(keys.at(-1)).not.toBe(before);
  });

  it('leaves the key for a note whose refresh found nothing', async () => {
    const { keys, heard } = await watched();
    const before = keys.at(-1);
    await heard(['Note 1.md']);
    expect(keys.at(-1)).toBe(before);
  });
});

describe('useIndex: the index is opened once per vault (#238)', () => {
  /** The window's ports, as `app.tsx` makes them: a new opening for each vault. */
  function windowOver(vault: IndexPorts) {
    const opened = { count: 0 };
    const raw = vault.index;
    const portsFor = () => ({
      ...vault,
      index: openOnce({
        ...raw,
        open: async () => {
          opened.count += 1;
          return raw.open();
        },
      }),
    });
    return { opened, portsFor };
  }

  it('opens it once for the first build and every refresh after, and again for each vault', async () => {
    const vault = vaultOf(3);
    const { opened, portsFor } = windowOver(vault);
    const activity = recordingActivity();
    const changes = createNoteChanges({ onError: () => {} });
    const { result, rerender } = renderHook(
      ({ ports, vaultKey }: { ports: IndexPorts; vaultKey: string }) =>
        useIndex({ ports, vaultKey, activity, changes }),
      { initialProps: { ports: portsFor(), vaultKey: VAULT } },
    );
    await waitFor(() => expect(result.current.status.kind).toBe('ready'));
    await act(async () => {
      await result.current.refresh();
      await result.current.refresh({ quiet: true });
      await result.current.rebuild();
    });
    expect(opened.count).toBe(1);

    rerender({ ports: portsFor(), vaultKey: '/vaults/Quill' });
    await waitFor(() => expect(result.current.status.kind).toBe('ready'));
    await act(async () => {
      await result.current.refresh();
    });
    expect(opened.count).toBe(2);
  });

  it('opens it again after a sync that failed on it', async () => {
    const vault = vaultOf(3);
    let failing = false;
    const put = vault.index.put;
    vault.index = {
      ...vault.index,
      put: async (...args) => {
        if (failing) throw new Error('the index went away');
        return put(...args);
      },
    };
    const listNotes = vault.fs.listNotes.bind(vault.fs);
    let arrivals = 0;
    // Each listing has a new note, so every refresh has something to write.
    vault.fs.listNotes = async (...args) => [
      ...(await listNotes(...args)),
      {
        name: `Arrived ${++arrivals}.md`,
        path: createVaultPath(`Arrived ${arrivals}.md`),
        modified: 1,
        size: 4,
      },
    ];
    const { opened, portsFor } = windowOver(vault);
    const { result } = await readyIndex(portsFor());
    expect(opened.count).toBe(1);

    failing = true;
    await act(async () => {
      expect(await result.current.refresh()).toBe(false);
    });
    failing = false;
    await act(async () => {
      expect(await result.current.refresh()).toBe(true);
    });
    expect(opened.count).toBe(2);
  });
});

describe('useIndex under StrictMode (#238)', () => {
  it('subscribes once: one change is heard once, and a quiet refresh that found none moves nothing', async () => {
    const activity = recordingActivity();
    const changes = createNoteChanges({ onError: () => {} });
    const heard: number[] = [];
    changes.subscribe((news) => heard.push(news.changes.length));
    const ports = vaultOf(3);
    const { result } = renderHook(() => useIndex({ ports, vaultKey: VAULT, activity, changes }), {
      // StrictMode at the root, as main.tsx renders it (issue #159).
      reactStrictMode: true,
    });
    await waitFor(() => expect(result.current.status.kind).toBe('ready'));
    // The first build found the three notes; StrictMode's second ask found nothing new.
    expect(heard).toEqual([3]);
    const revision = result.current.store.getState().revision;

    await act(async () => {
      await result.current.refresh({ quiet: true });
    });
    expect(result.current.store.getState().revision).toBe(revision);
    expect(heard).toEqual([3]);
  });
});

describe('IndexProgressPill', () => {
  const progress = (done: number, total: number) => {
    const reached = { done, total };
    return { subscribe: () => () => {}, current: () => reached };
  };
  const working = { kind: 'working', done: 0, total: 0 } as const;

  it('shows how far a build has got, from the progress rather than the status', () => {
    render(<IndexProgressPill status={working} progress={progress(1240, 5000)} />);
    expect(screen.getByText('Indexing 1,240 of 5,000…')).toBeDefined();
  });

  it('is not said to a screen reader, which hears the start and the end from the status', () => {
    render(<IndexProgressPill status={working} progress={progress(1240, 5000)} />);
    expect(screen.getByText('Indexing 1,240 of 5,000…').getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows nothing for a build of one batch, which is over before it could be read', () => {
    const { container } = render(
      <IndexProgressPill status={working} progress={progress(1, INDEX_BATCH_SIZE)} />,
    );
    expect(container.textContent).toBe('');
  });

  it('shows nothing once the build is done', () => {
    const { container } = render(
      <IndexProgressPill
        status={{ kind: 'ready', notes: 5000, revision: 1 }}
        progress={progress(5000, 5000)}
      />,
    );
    expect(container.textContent).toBe('');
  });
});

describe('LiveIndexSettings', () => {
  it('says how far a build has got, and will not start another meanwhile', () => {
    const reached = { done: 1240, total: 5000 };
    render(
      <LiveIndexSettings
        index={{ kind: 'working', done: 0, total: 0 }}
        progress={{ subscribe: () => () => {}, current: () => reached }}
        onRebuild={() => {}}
      />,
    );
    expect(screen.getByText('Indexing 1,240 of 5,000…')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Rebuild' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('useIndex: which of the app’s own writes a sync took in (#254)', () => {
  async function indexWith(ports: IndexPorts) {
    const ownWrites = createOwnWrites({ clock: { now: () => 0 } });
    const saved = { kind: 'text', text: 'note', modified: 1 } as const;
    const written = (path: string) => ownWrites.record({ vault: VAULT, path, left: saved });
    written('Note 0.md');
    const { result } = renderHook(() =>
      useIndex({
        ports,
        vaultKey: VAULT,
        activity: recordingActivity(),
        changes: createNoteChanges({ onError: () => {} }),
        ownWrites,
      }),
    );
    await waitFor(() => expect(result.current.status.kind).not.toBe('working'));
    const held = (path: string) => ownWrites.refreshedAt({ vault: VAULT, path }) !== null;
    return { result, written, held };
  }

  it('holds every write made before a sync that finished, and none made after it', async () => {
    const { result, written, held } = await indexWith(vaultOf(3));
    expect(held('Note 0.md')).toBe(true);
    written('Note 1.md');
    expect(held('Note 1.md')).toBe(false);
    await act(async () => {
      await result.current.refresh();
    });
    expect(held('Note 1.md')).toBe(true);
  });

  it('holds nothing after a sync that failed', async () => {
    const ports = vaultOf(3);
    const failing = {
      ...ports,
      fs: { ...ports.fs, listNotes: () => Promise.reject(new Error('the host is busy')) },
    };
    const { held } = await indexWith(failing);
    expect(held('Note 0.md')).toBe(false);
  });
});

describe('useIndex: settled (#254)', () => {
  it('resolves once the refresh already asked has run, asking none itself', async () => {
    let walks = 0;
    let letGo = () => {};
    const ports = vaultOf(2);
    const listNotes = ports.fs.listNotes;
    const held: IndexPorts = {
      ...ports,
      fs: {
        ...ports.fs,
        listNotes: async (options) => {
          walks += 1;
          if (walks === 2) await new Promise<void>((resolve) => (letGo = resolve));
          return listNotes(options);
        },
      },
    };
    const { result } = renderHook(() =>
      useIndex({
        ports: held,
        vaultKey: VAULT,
        activity: recordingActivity(),
        changes: createNoteChanges({ onError: () => {} }),
      }),
    );
    await waitFor(() => expect(result.current.status.kind).toBe('ready'));
    let refreshed = false;
    void result.current.refresh().then(() => (refreshed = true));
    let settled = false;
    void result.current.settled().then(() => (settled = true));
    await waitFor(() => expect(walks).toBe(2));
    expect(settled).toBe(false);
    await act(async () => {
      letGo();
      await result.current.settled();
    });
    expect(refreshed).toBe(true);
    expect(walks).toBe(2);
  });
});
