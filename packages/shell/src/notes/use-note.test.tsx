// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  createVaultPath,
  type EditorDocument,
  type EditorNode,
  type StrandedEdit,
  type VaultPath,
} from '@dfai/domain';
import {
  fakeHostVaultFs,
  inVault,
  noVaultOpen,
  NoteChangedError,
  NoteStillOpeningError,
  type HostVaultFsPort,
  type VaultFsPort,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { CHANGED_SINCE_KEPT, useNote, type NotePorts, type NoteView } from './use-note.ts';
import { useStrandedEdits, type StrandedEditStore, type Stranding } from './stranded-edits.ts';
import { memoryStrandedStore } from './testing/memory-stranded-store.ts';

/**
 * A pane holding a note that something else is writing at the same time.
 *
 * The reads and the writes can be held open, because every rule here is about
 * what arrives while one of them is in flight: typing during a re-read, typing
 * during a save, a save based on a modification time the file has moved past.
 */

const NOTE = createVaultPath('note.md');
/** The vault every pane here is open in, unless a test switches it. */
const THIS_VAULT = '/vault';
const ORIGINAL = '# Note\n\nFirst line.\n';

/** A read or a write the test can hold open and let go of when it chooses. */
function gate() {
  let waiting: (() => void)[] = [];
  let open = true;
  return {
    hold: () => {
      open = false;
    },
    pass: async (): Promise<void> => {
      if (open) return;
      await new Promise<void>((resolve) => waiting.push(resolve));
    },
    release: () => {
      open = true;
      const queued = waiting;
      waiting = [];
      for (const resolve of queued) resolve();
    },
  };
}

/**
 * `coarse`: a disk whose clock keeps whole seconds, so every write lands in
 * the one tick and leaves the time as it was (#245).
 */
function fakeVault(text: string = ORIGINAL, { coarse = false }: { coarse?: boolean } = {}) {
  const files = new Map<string, { text: string; modified: number }>([
    [NOTE, { text, modified: 1 }],
  ]);
  let clock = 1;
  const tick = () => (coarse ? clock : (clock += 1));
  const reads = gate();
  const writes = gate();
  /** Holds a read's answer once its bytes are taken: what it hands back is the file as it was then. */
  const answers = gate();

  const fs: VaultFsPort = {
    listDirectory: async () => [],
    listFiles: async () => [],
    listNotes: async () => [],
    readNotes: async () => [],
    readBinaryFile: async () => new ArrayBuffer(0),
    createNote: async () => 0,
    createFolder: async () => {},
    moveEntry: async () => {},
    trashEntry: async () => {},
    writeBinaryFile: async () => 0,
    readTextFile: async (path) => {
      await reads.pass();
      const file = files.get(path);
      if (file === undefined) throw new Error(`no such file: ${path}`);
      const taken = { text: file.text, modified: file.modified };
      await answers.pass();
      return taken;
    },
    writeTextFile: async ({ path, contents, expectedModified, expectedText }) => {
      await writes.pass();
      const file = files.get(path);
      if (file === undefined) throw new Error(`no such file: ${path}`);
      // The same refusal the Rust host gives: the file has moved on since it
      // was read — its time, or its bytes — so this write would be writing
      // over someone else's.
      const otherTime = expectedModified !== null && file.modified !== expectedModified;
      if (otherTime || (expectedText !== undefined && file.text !== expectedText)) {
        throw new Error('the note changed on disk since it was opened');
      }
      files.set(path, { text: contents, modified: tick() });
      return clock;
    },
  };

  return {
    fs,
    reads,
    writes,
    answers,
    contents: (): string => files.get(NOTE)?.text ?? '',
    modified: (): number => files.get(NOTE)?.modified ?? 0,
    /** Something else writes the file: the other pane, the board, another app. */
    writeOutside: (contents: string) => {
      files.set(NOTE, { text: contents, modified: tick() });
    },
  };
}

const portsOf = (fs: VaultFsPort): NotePorts => ({ fs, markdown: remarkMarkdown });

const docOf = (body: string): EditorDocument => remarkMarkdown.parseBody(body).doc;

/** Work a pane could not save, kept against the file as it was at `modified`. */
const keptWork = ({ text, modified }: { text: string; modified: number }): StrandedEdit => ({
  path: NOTE,
  doc: docOf(text),
  reason: 'the note changed on disk since it was opened',
  modified,
  keptAt: 1,
});

const textOf = (node: EditorNode | EditorDocument): string =>
  [node.type === 'doc' ? '' : ((node as EditorNode).text ?? '')]
    .concat((node.content ?? []).map(textOf))
    .join(' ');

/** What the pane is showing, as words, for asserting a keystroke survived. */
function shownText(view: { result: { current: NoteView } }): string {
  const state = view.result.current.state;
  return state.kind === 'ready' ? textOf(state.doc) : `«${state.kind}»`;
}

function openPane(args: { fs: VaultFsPort; onSaved?: () => void }) {
  return renderHook(() =>
    useNote({
      ports: portsOf(args.fs),
      vault: THIS_VAULT,
      path: NOTE,
      ...(args.onSaved ? { onSaved: args.onSaved } : {}),
    }),
  );
}

/**
 * One turn of the event loop, so every promise the hook started has settled.
 *
 * Nothing here waits on real time: the gates decide when a read or a write
 * resolves, and this only lets the microtasks behind them run.
 */
const settle = () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));

async function readyPane(vault: ReturnType<typeof fakeVault>, onSaved?: () => void) {
  const view = openPane({ fs: vault.fs, ...(onSaved ? { onSaved } : {}) });
  await waitFor(() => expect(view.result.current.state.kind).toBe('ready'));
  return view;
}

describe('a note open in a pane while something else writes it', () => {
  it('shows what is on disk once the note is open', async () => {
    const vault = fakeVault();
    const view = await readyPane(vault);

    expect(shownText(view)).toContain('First line.');
    expect(view.result.current.dirty).toBe(false);
  });

  // The write succeeds: the pane that wrote has the new file, and a clean pane
  // told to re-read catches up to it.
  it('re-reads what another writer put in the file when nothing is unsaved', async () => {
    const vault = fakeVault();
    const view = await readyPane(vault);

    vault.writeOutside('# Note\n\nWritten by the other pane.\n');
    act(() => view.result.current.reload());
    await settle();

    expect(shownText(view)).toContain('Written by the other pane.');
    expect(view.result.current.dirty).toBe(false);
  });

  it('writes the edit back through its own save, and reports it saved', async () => {
    const vault = fakeVault();
    const view = await readyPane(vault);

    act(() => view.result.current.changeDoc(docOf('Typed in this pane.\n')));
    expect(view.result.current.dirty).toBe(true);
    act(() => view.result.current.save());
    await settle();

    expect(vault.contents()).toContain('Typed in this pane.');
    expect(view.result.current.dirty).toBe(false);
  });

  // R13-01: the re-read above is asked for by the other pane, so it can be in
  // flight while this pane is being typed into.
  it('keeps typing that arrives while the note is being re-read', async () => {
    const vault = fakeVault();
    const view = await readyPane(vault);

    vault.writeOutside('# Note\n\nWritten by the other pane.\n');
    vault.reads.hold();
    act(() => view.result.current.reload());
    act(() => view.result.current.changeDoc(docOf('Typed during the read.\n')));
    vault.reads.release();
    await settle();

    expect(shownText(view)).toContain('Typed during the read.');
    expect(shownText(view)).not.toContain('Written by the other pane.');
    // And it still knows there is something to save, rather than reporting the
    // keystrokes it has just written over as saved.
    expect(view.result.current.dirty).toBe(true);
  });

  it('catches up again after its own edit has been saved', async () => {
    const vault = fakeVault();
    const view = await readyPane(vault);

    act(() => view.result.current.changeDoc(docOf('Typed in this pane.\n')));
    act(() => view.result.current.save());
    await settle();

    vault.writeOutside('# Note\n\nWritten by the other pane.\n');
    act(() => view.result.current.reload());
    await settle();

    expect(shownText(view)).toContain('Written by the other pane.');
  });

  it('applies the file to a pane that was not typed into during the re-read', async () => {
    const vault = fakeVault();
    const view = await readyPane(vault);

    vault.writeOutside('# Note\n\nWritten by the other pane.\n');
    vault.reads.hold();
    act(() => view.result.current.reload());
    vault.reads.release();
    await settle();

    expect(shownText(view)).toContain('Written by the other pane.');
    expect(view.result.current.dirty).toBe(false);
  });

  // R13-04: a save carries the document it was given, and the writing carries
  // on while it is in flight.
  it('stays unsaved when the edit is newer than the save that just landed', async () => {
    const vault = fakeVault();
    const view = await readyPane(vault);

    act(() => view.result.current.changeDoc(docOf('First edit.\n')));
    vault.writes.hold();
    act(() => view.result.current.save());
    act(() => view.result.current.changeDoc(docOf('Second edit.\n')));
    vault.writes.release();
    await settle();

    // What reached the file is not what is on screen, so the header must not
    // say otherwise — and the autosave must still have something to do.
    expect(view.result.current.dirty).toBe(true);
    expect(shownText(view)).toContain('Second edit.');
  });

  it('writes the edit typed during a save when the note is left, rather than losing it', async () => {
    const vault = fakeVault();
    const view = await readyPane(vault);

    act(() => view.result.current.changeDoc(docOf('First edit.\n')));
    vault.writes.hold();
    act(() => view.result.current.save());
    act(() => view.result.current.changeDoc(docOf('Second edit.\n')));
    vault.writes.release();
    await settle();

    // Switching notes, or closing the pane: the way out writes what is unsaved,
    // and this edit is unsaved however recently the last save landed.
    act(() => view.unmount());
    await settle();

    expect(vault.contents()).toContain('Second edit.');
  });

  // The save on the way out started from the note as it was read, beside the
  // save still in flight, and the host refused it once that one landed: the
  // last typing was handed back rather than written.
  it('writes the edit typed during a save when the pane closes before that save lands', async () => {
    const vault = fakeVault();
    const stranded = vi.fn();
    const view = renderHook(() =>
      useNote({ ports: portsOf(vault.fs), vault: THIS_VAULT, path: NOTE, onStranded: stranded }),
    );
    await waitFor(() => expect(view.result.current.state.kind).toBe('ready'));

    act(() => view.result.current.changeDoc(docOf('First edit.\n')));
    vault.writes.hold();
    act(() => view.result.current.save());
    act(() => view.result.current.changeDoc(docOf('First edit. Second edit.\n')));
    act(() => view.unmount());
    vault.writes.release();
    await settle();

    expect(vault.contents()).toContain('First edit. Second edit.');
    expect(stranded).not.toHaveBeenCalled();
  });

  // The write is refused: the file has moved on since this pane read it, so the
  // save must not land — and the typing it was carrying must not go anywhere.
  it('loses nothing when the save is refused because the file moved on', async () => {
    const vault = fakeVault();
    const view = await readyPane(vault);

    act(() => view.result.current.changeDoc(docOf('Typed in this pane.\n')));
    vault.writeOutside('---\nfavorite: true\n---\n\n# Note\n\nFirst line.\n');
    act(() => view.result.current.save());
    await settle();

    const state = view.result.current.state;
    expect(state.kind === 'ready' ? state.saveError : null).toMatch(/changed on disk/);
    // On screen, in the file, and in the header: nothing is claimed to be saved
    // and nothing that was typed has gone.
    expect(shownText(view)).toContain('Typed in this pane.');
    expect(view.result.current.dirty).toBe(true);
    expect(vault.contents()).toContain('favorite: true');
  });

  it('tells of a save it gave up on, once, with the note it was for (A28-01)', async () => {
    const vault = fakeVault();
    const failed: Array<{ path: VaultPath; cause: unknown }> = [];
    const view = renderHook(() =>
      useNote({
        ports: portsOf(vault.fs),
        vault: THIS_VAULT,
        path: NOTE,
        onSaveFailed: (failure) => void failed.push(failure),
      }),
    );
    await waitFor(() => expect(view.result.current.state.kind).toBe('ready'));

    act(() => view.result.current.changeDoc(docOf('Typed in this pane.\n')));
    vault.writeOutside('# Note\n\nWritten elsewhere.\n');
    act(() => view.result.current.save());
    await settle();

    expect(failed).toHaveLength(1);
    expect(failed[0]?.path).toBe(NOTE);
    expect(String(failed[0]?.cause)).toMatch(/changed on disk/);
  });

  it('does not tell of a write made for someone else, whom its rejection tells', async () => {
    const vault = fakeVault();
    const failed: unknown[] = [];
    const view = renderHook(() =>
      useNote({
        ports: portsOf(vault.fs),
        vault: THIS_VAULT,
        path: NOTE,
        onSaveFailed: (failure) => void failed.push(failure),
      }),
    );
    await waitFor(() => expect(view.result.current.state.kind).toBe('ready'));
    vault.writeOutside('# Note\n\nWritten elsewhere.\n');

    await expect(act(() => view.result.current.setProperties({ status: 'done' }))).rejects.toThrow(
      'changed on disk',
    );
    expect(failed).toEqual([]);
  });
});

/**
 * Properties written through a pane on behalf of someone else — a board drag,
 * the local API — must settle the way the write went. Resolving on a refused
 * save would have the caller report a write that never landed.
 */
describe('a task written through a pane is held to its rules (P30-02)', () => {
  const TASK = '---\ntype: task\nstatus: next-action\n---\n\n# Call\n';

  it('writes Waiting with nobody to wait on, as a board drag onto an open task does (#202)', async () => {
    const vault = fakeVault(TASK);
    const view = await readyPane(vault);
    await act(() => view.result.current.setProperties({ status: 'waiting' }));
    expect(vault.contents()).toBe('---\ntype: task\nstatus: waiting\n---\n\n# Call\n');
  });

  it('dates a task finished from its pane', async () => {
    const vault = fakeVault(TASK);
    const view = await readyPane(vault);
    await act(() => view.result.current.setProperties({ status: 'archive' }));
    expect(vault.contents()).toMatch(/\ncompleted: \d{4}-\d{2}-\d{2}\n/);
  });
});

describe('properties written through a pane', () => {
  it('settles once the properties are on disk', async () => {
    const vault = fakeVault();
    const view = await readyPane(vault);

    await act(() => view.result.current.setProperties({ status: 'done' }));

    expect(vault.contents()).toContain('status: done');
  });

  it('rejects when the save is refused because the file moved on', async () => {
    const vault = fakeVault();
    const view = await readyPane(vault);
    vault.writeOutside('# Note\n\nWritten elsewhere.\n');

    await expect(act(() => view.result.current.setProperties({ status: 'done' }))).rejects.toThrow(
      'the note changed on disk since it was opened',
    );
    expect(vault.contents()).toBe('# Note\n\nWritten elsewhere.\n');
  });

  it('lands two property changes made while the first is still being written', async () => {
    // A second link picked, or a digit typed, before the first write is back:
    // both started from the same read, and the host refused the second.
    const vault = fakeVault();
    const view = await readyPane(vault);
    vault.writes.hold();
    act(() => view.result.current.setProperty('tasks', ['[[Write report]]']));
    act(() => view.result.current.setProperty('tasks', ['[[Write report]]', '[[Book flights]]']));
    act(() => view.result.current.setProperty('pages', 412));
    vault.writes.release();
    await settle();
    await settle();

    expect(vault.contents()).toContain(
      'tasks:\n  - "[[Write report]]"\n  - "[[Book flights]]"\npages: 412\n',
    );
    expect(view.result.current.state).toMatchObject({ kind: 'ready', saveError: null });
  });

  it('lands two property changes a moment apart on a disk that keeps whole seconds (#245)', async () => {
    // The first write leaves the time as it was, so the second has to know
    // it is behind the first by more than the time.
    const vault = fakeVault(ORIGINAL, { coarse: true });
    const view = await readyPane(vault);
    vault.writes.hold();
    act(() => view.result.current.setProperty('tasks', ['[[Write report]]']));
    act(() => view.result.current.setProperty('pages', 412));
    vault.writes.release();
    await settle();
    await settle();

    expect(vault.contents()).toContain('tasks:\n  - "[[Write report]]"\npages: 412\n');
    expect(view.result.current.state).toMatchObject({ kind: 'ready', saveError: null });
  });

  it('refuses a save from a note another program rewrote within the same second (#245)', async () => {
    const vault = fakeVault(ORIGINAL, { coarse: true });
    const view = await readyPane(vault);
    const theirs = ORIGINAL.replace('First', 'Fifth');
    vault.writeOutside(theirs);
    expect(vault.modified()).toBe(1);

    await expect(act(() => view.result.current.setProperties({ status: 'done' }))).rejects.toThrow(
      'the note changed on disk since it was opened',
    );
    expect(vault.contents()).toBe(theirs);
  });

  it('works a change given as a rule out against the value the write before it left', async () => {
    const vault = fakeVault();
    const view = await readyPane(vault);
    const append = (link: string) => (current: unknown) => [
      ...(Array.isArray(current) ? current : []),
      link,
    ];
    vault.writes.hold();
    act(() => view.result.current.setProperty('tasks', append('[[Write report]]')));
    act(() => view.result.current.setProperty('tasks', append('[[Book flights]]')));
    vault.writes.release();
    await settle();
    await settle();

    expect(vault.contents()).toContain('tasks:\n  - "[[Write report]]"\n  - "[[Book flights]]"\n');
  });

  it('rejects as still opening, writing nothing, before the pane has read the note', async () => {
    const vault = fakeVault();
    vault.reads.hold();
    const view = openPane({ fs: vault.fs });

    await expect(act(() => view.result.current.setProperties({ status: 'done' }))).rejects.toThrow(
      NoteStillOpeningError,
    );
    vault.reads.release();
    expect(vault.contents()).toBe(ORIGINAL);
  });

  it('rejects while the pane is holding work it could not save', async () => {
    const vault = fakeVault();
    const view = await readyPane(vault);
    act(() => view.result.current.changeDoc(docOf('Typed in this pane.\n')));
    vault.writeOutside('# Note\n\nWritten elsewhere.\n');
    act(() => view.result.current.save());
    await settle();

    await expect(act(() => view.result.current.setProperties({ status: 'done' }))).rejects.toThrow(
      'the note changed on disk since it was opened',
    );
    expect(vault.contents()).toBe('# Note\n\nWritten elsewhere.\n');
  });
});

/**
 * R13-02: the refusal is right, but a pane that can only be refused is a pane
 * whose work has nowhere to go. These are the ways out of one.
 */
describe('a pane whose save was refused', () => {
  const STARRED = '---\nfavorite: true\n---\n\n# Note\n\nWritten by the other pane.\n';

  /** Types into an open pane, then moves the file on underneath it. */
  async function refusedPane(vault: ReturnType<typeof fakeVault>) {
    const view = await readyPane(vault);
    act(() => view.result.current.changeDoc(docOf('Typed in this pane.\n')));
    vault.writeOutside(STARRED);
    act(() => view.result.current.save());
    await settle();
    return view;
  }

  it('can write over the file, keeping what the other writer put in it', async () => {
    const vault = fakeVault();
    const view = await refusedPane(vault);

    act(() => view.result.current.overwrite());
    await settle();

    const onDisk = vault.contents();
    expect(onDisk).toContain('Typed in this pane.');
    // Overwriting is about the body this pane was refused, not about undoing
    // everything the other writer did: its frontmatter is read again and kept.
    expect(onDisk).toContain('favorite: true');
    expect(view.result.current.dirty).toBe(false);
    const state = view.result.current.state;
    expect(state.kind === 'ready' ? state.saveError : 'not ready').toBeNull();
  });

  it('can discard what it typed and show the file instead', async () => {
    const vault = fakeVault();
    const view = await refusedPane(vault);

    act(() => view.result.current.discard());
    await settle();

    expect(shownText(view)).toContain('Written by the other pane.');
    expect(shownText(view)).not.toContain('Typed in this pane.');
    expect(view.result.current.dirty).toBe(false);
    expect(vault.contents()).toBe(STARRED);
  });

  it('hands back the work when the save on the way out is refused', async () => {
    const vault = fakeVault();
    const stranded = vi.fn();
    const view = renderHook(() =>
      useNote({ ports: portsOf(vault.fs), vault: THIS_VAULT, path: NOTE, onStranded: stranded }),
    );
    await waitFor(() => expect(view.result.current.state.kind).toBe('ready'));

    act(() => view.result.current.changeDoc(docOf('Typed in this pane.\n')));
    vault.writeOutside(STARRED);
    act(() => view.unmount());
    await settle();

    expect(stranded).toHaveBeenCalledTimes(1);
    const left = stranded.mock.calls[0]?.[0] as Stranding;
    expect(left.path).toBe(NOTE);
    expect(textOf(left.doc)).toContain('Typed in this pane.');
    expect(left.reason).toMatch(/changed on disk/);
    // The file as it was when the work was kept — after the outside write,
    // which is what the next open compares against.
    expect(left.modified).toBe(vault.modified());
  });

  // Another pane on the same note re-reads on this; without it, that pane kept
  // the text from before and its next save was refused as changed on disk.
  it('tells of the save on the way out once it lands, naming the note it wrote', async () => {
    const vault = fakeVault();
    const saved = vi.fn();
    const view = renderHook(() =>
      useNote({ ports: portsOf(vault.fs), vault: THIS_VAULT, path: NOTE, onSaved: saved }),
    );
    await waitFor(() => expect(view.result.current.state.kind).toBe('ready'));

    act(() => view.result.current.changeDoc(docOf('Typed in this pane.\n')));
    act(() => view.unmount());
    await settle();

    expect(vault.contents()).toContain('Typed in this pane.');
    expect(saved).toHaveBeenCalledWith(NOTE);
  });

  it('hands back nothing when the save on the way out lands', async () => {
    const vault = fakeVault();
    const stranded = vi.fn();
    const view = renderHook(() =>
      useNote({ ports: portsOf(vault.fs), vault: THIS_VAULT, path: NOTE, onStranded: stranded }),
    );
    await waitFor(() => expect(view.result.current.state.kind).toBe('ready'));

    act(() => view.result.current.changeDoc(docOf('Typed in this pane.\n')));
    act(() => view.unmount());
    await settle();

    expect(vault.contents()).toContain('Typed in this pane.');
    expect(stranded).not.toHaveBeenCalled();
  });

  it('opens a note with the work an earlier pane could not save, still unsaved', async () => {
    const vault = fakeVault();
    const rescued = keptWork({
      text: 'Typed before the pane closed.\n',
      modified: vault.modified(),
    });
    const view = renderHook(() =>
      useNote({
        ports: portsOf(vault.fs),
        vault: THIS_VAULT,
        path: NOTE,
        recoverStranded: () => rescued,
      }),
    );
    await waitFor(() => expect(view.result.current.state.kind).toBe('ready'));

    expect(shownText(view)).toContain('Typed before the pane closed.');
    // Unsaved, because it is: the file still says what it said.
    expect(view.result.current.dirty).toBe(true);
    expect(vault.contents()).toBe(ORIGINAL);
  });
});

describe('work handed back after the file under it has moved on', () => {
  const OUTSIDE = '# Note\n\nWritten while the work was waiting.\n';

  async function paneWith(vault: ReturnType<typeof fakeVault>, rescued: StrandedEdit) {
    const stranded = vi.fn();
    // Handed back once, as the kept-work store does.
    let waiting: StrandedEdit | null = rescued;
    const take = () => {
      const taken = waiting;
      waiting = null;
      return taken;
    };
    const view = renderHook(() =>
      useNote({
        ports: portsOf(vault.fs),
        vault: THIS_VAULT,
        path: NOTE,
        onStranded: stranded,
        recoverStranded: take,
      }),
    );
    await waitFor(() => expect(view.result.current.state.kind).toBe('ready'));
    return { view, stranded };
  }

  const saveErrorOf = (view: Awaited<ReturnType<typeof paneWith>>['view']) => {
    const state = view.result.current.state;
    return state.kind === 'ready' ? state.saveError : `«${state.kind}»`;
  };

  it('saves it as usual when the file is as it was when the work was kept', async () => {
    const vault = fakeVault();
    const { view } = await paneWith(
      vault,
      keptWork({ text: 'Kept.\n', modified: vault.modified() }),
    );

    expect(saveErrorOf(view)).toBeNull();
    act(() => view.result.current.save());
    await settle();

    expect(vault.contents()).toContain('Kept.');
  });

  it('says the file changed, and writes nothing until told to', async () => {
    const vault = fakeVault();
    const kept = keptWork({ text: 'Kept.\n', modified: vault.modified() });
    vault.writeOutside(OUTSIDE);
    const { view } = await paneWith(vault, kept);

    expect(shownText(view)).toContain('Kept.');
    expect(view.result.current.dirty).toBe(true);
    expect(saveErrorOf(view)).toBe(CHANGED_SINCE_KEPT);

    act(() => view.result.current.save());
    act(() => view.result.current.setProperty('status', 'done'));
    await settle();

    expect(vault.contents()).toBe(OUTSIDE);
  });

  it('refuses properties written through it from outside, rather than claiming them', async () => {
    const vault = fakeVault();
    const kept = keptWork({ text: 'Kept.\n', modified: vault.modified() });
    vault.writeOutside(OUTSIDE);
    const { view } = await paneWith(vault, kept);

    await expect(act(() => view.result.current.setProperties({ status: 'done' }))).rejects.toThrow(
      NoteChangedError,
    );
    expect(vault.contents()).toBe(OUTSIDE);
  });

  it('writes it over the file when told to overwrite', async () => {
    const vault = fakeVault();
    const kept = keptWork({ text: 'Kept.\n', modified: vault.modified() });
    vault.writeOutside(OUTSIDE);
    const { view } = await paneWith(vault, kept);

    act(() => view.result.current.overwrite());
    await settle();

    expect(vault.contents()).toContain('Kept.');
    expect(saveErrorOf(view)).toBeNull();
    expect(view.result.current.dirty).toBe(false);
  });

  it('takes the file when told to discard', async () => {
    const vault = fakeVault();
    const kept = keptWork({ text: 'Kept.\n', modified: vault.modified() });
    vault.writeOutside(OUTSIDE);
    const { view } = await paneWith(vault, kept);

    act(() => view.result.current.discard());
    await settle();

    expect(shownText(view)).toContain('Written while the work was waiting.');
    expect(shownText(view)).not.toContain('Kept.');
    expect(saveErrorOf(view)).toBeNull();
    expect(vault.contents()).toBe(OUTSIDE);
  });

  it('puts it back to wait, unwritten, when the pane closes without a decision', async () => {
    const vault = fakeVault();
    const kept = keptWork({ text: 'Kept.\n', modified: vault.modified() });
    vault.writeOutside(OUTSIDE);
    const { view, stranded } = await paneWith(vault, kept);

    act(() => view.unmount());
    await settle();

    expect(vault.contents()).toBe(OUTSIDE);
    expect(stranded).toHaveBeenCalledTimes(1);
    const again = stranded.mock.calls[0]?.[0] as Stranding;
    expect(textOf(again.doc)).toContain('Kept.');
    expect(again.modified).toBe(kept.modified);
  });
});

describe('work stranded, then the app quit and started again', () => {
  const VAULT = THIS_VAULT;

  /** One run of the app: the kept work and a pane on the note, over one store. */
  function runApp({
    vault,
    store,
  }: {
    vault: ReturnType<typeof fakeVault>;
    store: StrandedEditStore;
  }) {
    return renderHook(() => {
      const stranded = useStrandedEdits({ store, vaultKey: VAULT, now: () => 1 });
      const note = useNote({
        ports: portsOf(vault.fs),
        vault: THIS_VAULT,
        path: NOTE,
        onStranded: stranded.keep,
        recoverStranded: stranded.take,
        settleStranded: stranded.settle,
      });
      return { stranded, note };
    });
  }

  /** Types, has the save refused by an outside write, and quits. */
  async function strandAndQuit(vault: ReturnType<typeof fakeVault>, store: StrandedEditStore) {
    const first = runApp({ vault, store });
    await waitFor(() => expect(first.result.current.note.state.kind).toBe('ready'));
    act(() => first.result.current.note.changeDoc(docOf('Typed before quitting.\n')));
    vault.writeOutside('# Note\n\nWritten by the other pane.\n');
    act(() => first.unmount());
    await settle();
  }

  const readyText = (view: ReturnType<typeof runApp>) => {
    const state = view.result.current.note.state;
    return state.kind === 'ready' ? textOf(state.doc) : `«${state.kind}»`;
  };

  it('opens the note with the typing on it, as an ordinary save', async () => {
    const vault = fakeVault();
    const { store } = memoryStrandedStore();
    await strandAndQuit(vault, store);

    const second = runApp({ vault, store });
    await waitFor(() => expect(second.result.current.note.state.kind).toBe('ready'));

    expect(readyText(second)).toContain('Typed before quitting.');
    expect(second.result.current.note.dirty).toBe(true);
    const state = second.result.current.note.state;
    expect(state.kind === 'ready' && state.saveError).toBeNull();
  });

  it('hands the typing back once, not on the start after that', async () => {
    const vault = fakeVault();
    const { store } = memoryStrandedStore();
    await strandAndQuit(vault, store);
    const second = runApp({ vault, store });
    await waitFor(() => expect(second.result.current.note.state.kind).toBe('ready'));
    // Quit again without saving: the pane's save on the way out lands, since
    // the file has not moved since it was read.
    act(() => second.unmount());
    await settle();

    const third = runApp({ vault, store });
    await waitFor(() => expect(third.result.current.note.state.kind).toBe('ready'));

    expect(third.result.current.note.dirty).toBe(false);
    expect(third.result.current.stranded.notice).toBeNull();
    expect(vault.contents()).toContain('Typed before quitting.');
  });

  it('says the file changed while it was quit, rather than writing over it', async () => {
    const vault = fakeVault();
    const { store } = memoryStrandedStore();
    await strandAndQuit(vault, store);
    vault.writeOutside('# Note\n\nWritten while DFAI was closed.\n');

    const second = runApp({ vault, store });
    await waitFor(() => expect(second.result.current.note.state.kind).toBe('ready'));

    expect(readyText(second)).toContain('Typed before quitting.');
    const state = second.result.current.note.state;
    expect(state.kind === 'ready' && state.saveError).toBe(CHANGED_SINCE_KEPT);
  });
});

/**
 * R14-05: work handed back to a pane is still only the pane's until it is
 * written. Kept work stays in the store until the pane writes it or is told to
 * throw it away, so a quit or a crash before then loses nothing.
 */
describe('work handed back, until it is written or thrown away', () => {
  const VAULT = THIS_VAULT;
  const WRITTEN_WHILE_CLOSED = '# Note\n\nWritten while DFAI was closed.\n';

  function runApp({
    vault,
    store,
  }: {
    vault: ReturnType<typeof fakeVault>;
    store: StrandedEditStore;
  }) {
    return renderHook(() => {
      const stranded = useStrandedEdits({ store, vaultKey: VAULT, now: () => 1 });
      const note = useNote({
        ports: portsOf(vault.fs),
        vault: VAULT,
        path: NOTE,
        onStranded: stranded.keep,
        recoverStranded: stranded.take,
        settleStranded: stranded.settle,
      });
      return { stranded, note };
    });
  }

  /** Kept work for the note, as a quit would leave it: in the store, no pane open. */
  function keptInStore(vault: ReturnType<typeof fakeVault>) {
    const memory = memoryStrandedStore();
    memory.store.put({
      vaultKey: VAULT,
      edit: keptWork({ text: 'Typed before quitting.\n', modified: vault.modified() }),
    });
    return memory;
  }

  async function ready(view: ReturnType<typeof runApp>) {
    await waitFor(() => expect(view.result.current.note.state.kind).toBe('ready'));
    return view;
  }

  const shown = (view: ReturnType<typeof runApp>) => {
    const state = view.result.current.note.state;
    return state.kind === 'ready' ? textOf(state.doc) : `«${state.kind}»`;
  };

  it('stays in the store while the pane asks whether to overwrite', async () => {
    const vault = fakeVault();
    const { store, stored } = keptInStore(vault);
    vault.writeOutside(WRITTEN_WHILE_CLOSED);

    const asking = await ready(runApp({ vault, store }));
    expect(asking.result.current.note.state).toMatchObject({ saveError: CHANGED_SINCE_KEPT });

    expect(stored(VAULT).map((edit) => textOf(edit.doc))).toEqual([
      expect.stringContaining('Typed before quitting.'),
    ]);
    // A crash at the question: no cleanup runs, and the next start still has it.
    const afterCrash = await ready(runApp({ vault, store }));
    expect(shown(afterCrash)).toContain('Typed before quitting.');
  });

  it('is let go of once the pane overwrites the file with it', async () => {
    const vault = fakeVault();
    const { store, stored } = keptInStore(vault);
    vault.writeOutside(WRITTEN_WHILE_CLOSED);
    const view = await ready(runApp({ vault, store }));

    act(() => view.result.current.note.overwrite());
    await settle();

    expect(vault.contents()).toContain('Typed before quitting.');
    expect(stored(VAULT)).toEqual([]);
  });

  it('is let go of once the pane discards it', async () => {
    const vault = fakeVault();
    const { store, stored } = keptInStore(vault);
    vault.writeOutside(WRITTEN_WHILE_CLOSED);
    const view = await ready(runApp({ vault, store }));

    act(() => view.result.current.note.discard());
    await settle();

    expect(shown(view)).toContain('Written while DFAI was closed.');
    expect(stored(VAULT)).toEqual([]);
  });

  it('stays in the store until an ordinary save of it lands', async () => {
    const vault = fakeVault();
    const { store, stored } = keptInStore(vault);
    const view = await ready(runApp({ vault, store }));
    expect(stored(VAULT)).toHaveLength(1);

    vault.writes.hold();
    act(() => view.result.current.note.save());
    await settle();
    expect(stored(VAULT)).toHaveLength(1);
    vault.writes.release();
    await settle();

    expect(vault.contents()).toContain('Typed before quitting.');
    expect(stored(VAULT)).toEqual([]);
  });

  it('stays in the store when the save of it is refused', async () => {
    const vault = fakeVault();
    const { store, stored } = keptInStore(vault);
    const view = await ready(runApp({ vault, store }));
    vault.writeOutside(WRITTEN_WHILE_CLOSED);

    act(() => view.result.current.note.save());
    await settle();

    expect(vault.contents()).toBe(WRITTEN_WHILE_CLOSED);
    expect(stored(VAULT)).toHaveLength(1);
  });
});

describe('a pane open when another vault is opened', () => {
  const A = '/vaults/a';
  const B = '/vaults/b';
  const IN_A = '# Note\n\nIn vault A.\n';
  const IN_B = '# Note\n\nIn vault B.\n';

  /**
   * The host as it is: two vaults on disk, one of them open, every path resolved
   * against the open one, and a write naming another vault refused.
   */
  function twoVaults({ modifiedInB = 50 }: { modifiedInB?: number } = {}) {
    const disk = new Map([
      [A, { text: IN_A, modified: 1 }],
      [B, { text: IN_B, modified: modifiedInB }],
    ]);
    const host = { open: A };
    const reads = gate();
    const answers = gate();
    const fileIn = (vault: string) => {
      const file = disk.get(vault);
      if (file === undefined) throw new Error(`no vault at ${vault}`);
      return file;
    };
    const fs: HostVaultFsPort = fakeHostVaultFs({
      readTextFile: async () => {
        const vault = host.open;
        await reads.pass();
        return fileIn(vault);
      },
      writeTextFile: async ({ contents, expectedModified, vault }) => {
        if (vault !== host.open) {
          throw new Error('another vault was opened before this could be written');
        }
        const file = fileIn(host.open);
        if (expectedModified !== null && file.modified !== expectedModified) {
          throw new Error('the note changed on disk since it was opened');
        }
        disk.set(host.open, { text: contents, modified: file.modified + 1 });
        // Landed on disk; the answer may still be on its way back.
        await answers.pass();
        return file.modified + 1;
      },
    });
    return { fs, host, reads, answers, textIn: (vault: string) => fileIn(vault).text };
  }

  /** A pane over one note, in whichever vault the app has open. */
  function paneIn(fs: HostVaultFsPort, onStranded: (stranding: Stranding) => void) {
    // One set of ports per vault, as the app keeps: new ports on every render
    // would read the note again on every render.
    const portsIn = new Map([A, B].map((vault) => [vault, portsOf(inVault({ fs, vault }))]));
    return renderHook(
      ({ vault, path }: { vault: string; path: typeof NOTE | null }) =>
        useNote({ ports: portsIn.get(vault) ?? portsOf(noVaultOpen(fs)), vault, path, onStranded }),
      { initialProps: { vault: A, path: NOTE as typeof NOTE | null } },
    );
  }

  it.each([
    ['the same path in the next vault', NOTE],
    ['nothing, as the next vault has no panes remembered', null],
  ])('writes nothing into the next vault when the pane moves to %s', async (_, nextPath) => {
    const { fs, host, textIn } = twoVaults();
    const stranded = vi.fn();
    const view = paneIn(fs, stranded);
    await waitFor(() => expect(view.result.current.state.kind).toBe('ready'));
    act(() => view.result.current.changeDoc(docOf('Typed in vault A.\n')));

    // The host moves first; the pane hears about it on the next render.
    host.open = B;
    view.rerender({ vault: B, path: nextPath });
    await settle();

    expect(textIn(B)).toBe(IN_B);
    expect(textIn(A)).toBe(IN_A);
    expect(stranded).toHaveBeenCalledTimes(1);
    const kept = stranded.mock.calls[0]?.[0] as Stranding;
    expect(kept.vault).toBe(A);
    expect(textOf(kept.doc)).toContain('Typed in vault A.');
    expect(kept.reason).toMatch(/another vault was opened/);
    // A's file as it was opened, not B's time: B's file says nothing about A's.
    expect(kept.modified).toBe(1);
  });

  // Verification of #281: a write's answer from A that comes back once the
  // pane holds B's note of the same name is A's, and says nothing of B's.
  it("starts B's save from B's note, not from a write of A's answered after the switch", async () => {
    const { fs, host, answers, textIn } = twoVaults({ modifiedInB: 1 });
    const view = paneIn(fs, vi.fn());
    await waitFor(() => expect(view.result.current.state.kind).toBe('ready'));
    answers.hold();
    act(() => view.result.current.changeDoc(docOf('# Note\n\nSaved in A.\n')));
    act(() => view.result.current.save());
    await settle();
    expect(textIn(A)).toBe('# Note\n\nSaved in A.\n');

    host.open = B;
    view.rerender({ vault: B, path: NOTE });
    await waitFor(() => expect(shownText(view)).toContain('In vault B.'));
    answers.release();
    await settle();
    await settle();

    act(() => view.result.current.changeDoc(docOf('# Note\n\nIn vault B, typed.\n')));
    act(() => view.result.current.save());
    await settle();
    await settle();
    const state = view.result.current.state;
    expect(state.kind === 'ready' ? state.saveError : 'not ready').toBeNull();
    expect(textIn(B)).toBe('# Note\n\nIn vault B, typed.\n');
  });

  it("autosaves none of A's typing into B's note of the same name while it is being read", async () => {
    // The same time on both, as vaults copied or synced from one another have:
    // then the host's check of the file's time is no protection at all.
    const { fs, host, reads, textIn } = twoVaults({ modifiedInB: 1 });
    const view = paneIn(fs, vi.fn());
    await waitFor(() => expect(view.result.current.state.kind).toBe('ready'));
    vi.useFakeTimers();
    try {
      act(() => view.result.current.changeDoc(docOf('Typed in vault A.\n')));

      // B's note takes its time to arrive, and the autosave's pause passes.
      reads.hold();
      host.open = B;
      view.rerender({ vault: B, path: NOTE });
      await act(async () => void vi.advanceTimersByTime(5_000));

      expect(textIn(B)).toBe(IN_B);
      reads.release();
      await act(async () => void vi.advanceTimersByTime(5_000));
      expect(shownText(view)).toContain('In vault B.');
      expect(shownText(view)).not.toContain('Typed in vault A.');
      expect(textIn(B)).toBe(IN_B);
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes unsaved typing when flushed, and settles once it has landed', async () => {
    const { fs, textIn } = twoVaults();
    const view = paneIn(fs, vi.fn());
    await waitFor(() => expect(view.result.current.state.kind).toBe('ready'));
    act(() => view.result.current.changeDoc(docOf('Typed in vault A.\n')));

    await act(() => view.result.current.flush());

    expect(textIn(A)).toContain('Typed in vault A.');
    expect(view.result.current.dirty).toBe(false);
  });

  it('writes nothing when flushed with nothing unsaved', async () => {
    const { fs } = twoVaults();
    const write = vi.spyOn(fs, 'writeTextFile');
    const view = paneIn(fs, vi.fn());
    await waitFor(() => expect(view.result.current.state.kind).toBe('ready'));

    await act(() => view.result.current.flush());

    expect(write).not.toHaveBeenCalled();
  });
});

describe('a pane on a note that is moved or deleted', () => {
  const MOVED = createVaultPath('Projects/note.md');

  /** The fake vault, with the note moved as the host moves it: same bytes, same time. */
  function movableVault() {
    const vault = fakeVault();
    const files = new Map<string, { text: string; modified: number }>([
      [NOTE, { text: ORIGINAL, modified: 1 }],
    ]);
    let reads = 0;
    let writes = 0;
    let clock = 1;
    /** Holds a write's answer once it is on disk. */
    const answers = gate();
    const fs: VaultFsPort = {
      ...vault.fs,
      readTextFile: async (path) => {
        reads += 1;
        const file = files.get(path);
        if (file === undefined) throw new Error(`no such file: ${path}`);
        return { ...file };
      },
      writeTextFile: async ({ path, contents, expectedModified }) => {
        writes += 1;
        const file = files.get(path);
        if (file === undefined) throw new Error(`no such file: ${path}`);
        if (expectedModified !== null && file.modified !== expectedModified) {
          throw new Error('the note changed on disk since it was opened');
        }
        clock += 1;
        const landed = clock;
        files.set(path, { text: contents, modified: landed });
        await answers.pass();
        return landed;
      },
    };
    return {
      fs,
      answers,
      move: () => {
        const file = files.get(NOTE);
        if (file !== undefined) files.set(MOVED, file);
        files.delete(NOTE);
      },
      text: (path: string) => files.get(path)?.text,
      reads: () => reads,
      writes: () => writes,
    };
  }

  function paneOn(fs: VaultFsPort) {
    return renderHook(({ path }) => useNote({ ports: portsOf(fs), vault: THIS_VAULT, path }), {
      initialProps: { path: NOTE },
    });
  }

  it('follows the note with its unsaved typing, without reading it again, and saves it there', async () => {
    const vault = movableVault();
    const view = paneOn(vault.fs);
    await waitFor(() => expect(view.result.current.state.kind).toBe('ready'));
    act(() => view.result.current.changeDoc(docOf('Typed before the move.\n')));
    const readsBefore = vault.reads();

    vault.move();
    act(() => view.result.current.repoint(MOVED));
    view.rerender({ path: MOVED });
    await settle();

    // Still the page it was, typing and all: no "Reading…", no re-read.
    expect(view.result.current.state.kind).toBe('ready');
    expect(shownText(view)).toContain('Typed before the move.');
    expect(view.result.current.dirty).toBe(true);
    expect(vault.reads()).toBe(readsBefore);
    // Nothing was written on the way "out" of the old path.
    expect(vault.writes()).toBe(0);

    act(() => view.result.current.save());
    await settle();
    expect(vault.text(MOVED)).toContain('Typed before the move.');
    expect(vault.text(NOTE)).toBeUndefined();
    expect(view.result.current.dirty).toBe(false);
  });

  // Verification of #281: the answer to a write made before a move names the
  // path the note had then; it is still this pane's note, under its new path.
  it('saves again after a property write whose answer came back once the note had moved', async () => {
    const vault = movableVault();
    const view = paneOn(vault.fs);
    await waitFor(() => expect(view.result.current.state.kind).toBe('ready'));
    vault.answers.hold();
    act(() => view.result.current.setProperty('status', 'open'));
    await settle();
    expect(vault.text(NOTE)).toContain('status: open');

    vault.move();
    act(() => view.result.current.repoint(MOVED));
    view.rerender({ path: MOVED });
    await settle();
    vault.answers.release();
    await settle();
    await settle();

    await act(() => view.result.current.setProperties({ status: 'done' }));
    expect(vault.text(MOVED)).toContain('status: done');
    expect(vault.text(NOTE)).toBeUndefined();
    const state = view.result.current.state;
    expect(state.kind === 'ready' ? state.saveError : 'not ready').toBeNull();
  });

  it('writes nothing on the way out once told its note was deleted', async () => {
    const vault = movableVault();
    const view = paneOn(vault.fs);
    await waitFor(() => expect(view.result.current.state.kind).toBe('ready'));
    act(() => view.result.current.changeDoc(docOf('Typing nobody wants now.\n')));

    act(() => view.result.current.abandon());
    expect(view.result.current.dirty).toBe(false);
    act(() => view.unmount());
    await settle();

    expect(vault.writes()).toBe(0);
  });
});

/**
 * Attack on #281 (#245): `startFrom` gives a tie of times to the pane's last
 * write. On a coarse clock a read the pane made after that write — a reload
 * for another program's edit, another pane's save, or an overwrite — has the
 * same time, so the save starts from the older write's bytes and is refused.
 */
describe('attack #281: a pane on a coarse clock whose note was read again after its own write', () => {
  const THEIRS = '# Note\n\nWritten by the other app.\n';

  /** Saves once from the pane, so it has a write of its own to start from. */
  async function paneThatSaved(vault: ReturnType<typeof fakeVault>) {
    const view = await readyPane(vault);
    act(() => view.result.current.changeDoc(docOf('# Note\n\nMine.\n')));
    act(() => view.result.current.save());
    await settle();
    expect(vault.contents()).toContain('Mine.');
    return view;
  }

  it('saves an edit made on top of a re-read of another writer’s same-tick change', async () => {
    const vault = fakeVault(ORIGINAL, { coarse: true });
    const view = await paneThatSaved(vault);
    vault.writeOutside(THEIRS);
    act(() => view.result.current.reload());
    await settle();
    expect(shownText(view)).toContain('Written by the other app.');

    act(() =>
      view.result.current.changeDoc(docOf('# Note\n\nWritten by the other app. And me.\n')),
    );
    act(() => view.result.current.save());
    await settle();

    const state = view.result.current.state;
    expect(state.kind === 'ready' ? state.saveError : 'not ready').toBeNull();
    expect(vault.contents()).toContain('And me.');
  });

  it('saves the next edit after overwriting a refused save in the same tick', async () => {
    const vault = fakeVault(ORIGINAL, { coarse: true });
    const view = await paneThatSaved(vault);
    act(() => view.result.current.changeDoc(docOf('# Note\n\nTyped before the refusal.\n')));
    vault.writeOutside(THEIRS);
    act(() => view.result.current.save());
    await settle();
    act(() => view.result.current.overwrite());
    await settle();
    expect(vault.contents()).toContain('Typed before the refusal.');

    act(() => view.result.current.changeDoc(docOf('# Note\n\nTyped after the overwrite.\n')));
    act(() => view.result.current.save());
    await settle();

    const state = view.result.current.state;
    expect(state.kind === 'ready' ? state.saveError : 'not ready').toBeNull();
    expect(vault.contents()).toContain('Typed after the overwrite.');
  });

  it('two panes on one note, saving in turn within one tick, are never refused', async () => {
    const vault = fakeVault(ORIGINAL, { coarse: true });
    const one = await readyPane(vault);
    const two = await readyPane(vault);

    act(() => one.result.current.changeDoc(docOf('# Note\n\nOne.\n')));
    act(() => one.result.current.save());
    await settle();
    act(() => two.result.current.reload());
    await settle();
    act(() => two.result.current.changeDoc(docOf('# Note\n\nOne. Two.\n')));
    act(() => two.result.current.save());
    await settle();
    act(() => one.result.current.reload());
    await settle();
    expect(shownText(one)).toContain('Two.');
    act(() => one.result.current.changeDoc(docOf('# Note\n\nOne. Two. One again.\n')));
    act(() => one.result.current.save());
    await settle();

    const state = one.result.current.state;
    expect(state.kind === 'ready' ? state.saveError : 'not ready').toBeNull();
    expect(vault.contents()).toContain('One again.');
  });
});

/**
 * Verification of #281: a re-read the pane began before one of its own writes
 * landed holds the file from before that write. Applied after it, it puts the
 * older text back on screen, and the next save writes it over the landed edit.
 */
describe('a re-read begun before the pane’s own write landed (#281)', () => {
  it.each([
    ['a fine clock', false],
    ['a coarse clock', true],
  ])('is dropped on %s: the landed text stays on screen and on disk', async (_, coarse) => {
    const vault = fakeVault(ORIGINAL, { coarse });
    const view = await readyPane(vault);
    vault.answers.hold();
    act(() => view.result.current.reload());
    await settle();

    act(() => view.result.current.changeDoc(docOf('# Note\n\nTyped.\n')));
    act(() => view.result.current.save());
    await settle();
    expect(vault.contents()).toBe('# Note\n\nTyped.\n');

    vault.answers.release();
    await settle();
    await settle();
    expect(shownText(view)).toContain('Typed.');
    expect(shownText(view)).not.toContain('First line.');

    act(() => view.result.current.changeDoc(docOf('# Note\n\nTyped. More.\n')));
    act(() => view.result.current.save());
    await settle();
    const state = view.result.current.state;
    expect(state.kind === 'ready' ? state.saveError : 'not ready').toBeNull();
    expect(vault.contents()).toBe('# Note\n\nTyped. More.\n');
  });

  it('still shows another writer’s change that came after the dropped read', async () => {
    const vault = fakeVault(ORIGINAL);
    const view = await readyPane(vault);
    vault.answers.hold();
    act(() => view.result.current.reload());
    await settle();
    act(() => view.result.current.changeDoc(docOf('# Note\n\nTyped.\n')));
    act(() => view.result.current.save());
    await settle();
    vault.writeOutside('# Note\n\nTyped. And theirs.\n');

    vault.answers.release();
    await settle();
    await settle();
    expect(shownText(view)).toContain('And theirs.');
  });
});
