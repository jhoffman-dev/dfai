import { useCallback, useEffect, useRef, useState } from 'react';
import {
  changedSinceStranded,
  noteTitle,
  type EditorDocument,
  type StrandedEdit,
  type VaultPath,
} from '@dfai/domain';
import {
  NoteChangedError,
  noteModified,
  NoteStillOpeningError,
  openNote,
  saveNote,
  type PropertyChanges,
  type MarkdownPort,
  type OpenNote,
  type SavedNote,
  type VaultFsPort,
} from '@dfai/application';
import type { NotePaneState } from '@dfai/ui';
import { localToday } from '../today.ts';
import type { Stranding } from './stranded-edits.ts';

export interface NotePorts {
  fs: VaultFsPort;
  markdown: MarkdownPort;
}

export interface NoteView {
  state: NotePaneState;
  dirty: boolean;
  /** The note as opened, for the properties panel. */
  open: OpenNote | null;
  changeDoc: (doc: EditorDocument) => void;
  save: () => void;
  /**
   * Changes one frontmatter key and writes the note. Given a function, the
   * new value is that function of the value in the file when the write runs.
   */
  setProperty: (key: string, value: unknown) => void;
  /**
   * Changes some frontmatter keys and writes the note, through this editor's
   * own save — which is how anything else writes a note a pane is holding.
   */
  setProperties: (changes: PropertyChanges) => Promise<void>;
  /**
   * Re-reads the note from disk, keeping what is on screen until it arrives.
   *
   * For when something else wrote the same note — the other pane, when both
   * hold it. Unsaved edits are kept rather than read over, and the pane is then
   * holding a modification time the file has moved past: `overwrite` and
   * `discard` are the two ways out of that.
   */
  reload: () => void;
  /**
   * Writes what is on screen over the file, whatever it says now.
   *
   * The file is read again first, so what the other writer put in the
   * frontmatter survives and only this pane's text replaces theirs.
   */
  overwrite: () => void;
  /** Throws away the unsaved edits and takes the file as it stands. */
  discard: () => void;
  /**
   * Writes any unsaved edits now, settling once the write has landed or been
   * refused. For leaving the vault: after that, this note's path means a note
   * in the vault opened next.
   */
  flush: () => Promise<void>;
  /**
   * Follows the note to where it was moved, keeping everything on screen —
   * the document, the unsaved typing, the time it was read at — rather than
   * reading it again. The pane is handed the new path next, and carries on as
   * if it had always been there; the next save writes to the new path.
   */
  repoint: (to: VaultPath) => void;
  /**
   * Lets go of the unsaved edits, without reading the note again: it has been
   * deleted, the person was asked, and a save on the way out would try to
   * write a note that is gone.
   */
  abandon: () => void;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Why a pane will not save work it was handed back: the file was written after
 * the work was kept, and saving would write over that without anyone deciding.
 */
export const CHANGED_SINCE_KEPT =
  'This note changed on disk after these unsaved changes were kept. Overwrite the file with them, or discard them.';

/** How long to wait after the last keystroke before writing the note. */
const AUTOSAVE_AFTER_MS = 1200;

/** Opens the selected note, tracks unsaved edits, and writes them back. */
export function useNote({
  ports,
  vault,
  path,
  onSaved,
  onStranded,
  recoverStranded,
  settleStranded,
  onSaveFailed,
  paused = false,
}: {
  ports: NotePorts;
  /**
   * The vault `path` is in. Work on the note belongs to it: what cannot be saved
   * is handed back under it, even once another vault is open.
   */
  vault: string | null;
  path: VaultPath | null;
  /**
   * Called with the note written after a write lands — the pane's own saves and
   * the save on the way out — for whoever else is showing the same note.
   */
  onSaved?: (saved: VaultPath) => void;
  /**
   * Called with the work the save on the way out could not write. The pane is
   * already gone by then, so this is the only place that loss can be noticed.
   */
  onStranded?: (stranded: Stranding) => void;
  /** Work an earlier pane could not save, to put back on screen when this opens. */
  recoverStranded?: (path: VaultPath) => StrandedEdit | null;
  /**
   * Called once work handed back has been written or thrown away. Until then it
   * stays kept, so a quit before either loses nothing.
   */
  settleStranded?: (recovered: RecoveredNote) => void;
  /**
   * Called when a save the pane made for itself is refused, and the pane gives
   * up on it — the save error it shows. Not for a write made through the pane
   * for someone else: its rejection tells them.
   */
  onSaveFailed?: (failure: { path: VaultPath; cause: unknown }) => void;
  /**
   * Whether the autosave stands down: a tab hidden behind another one flushes
   * as it hides and cannot be typed in, so no timer need run for it.
   */
  paused?: boolean;
}): NoteView {
  const [note, setNote] = useState<OpenNote | null>(null);
  const [doc, setDoc] = useState<EditorDocument | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** Bumped to re-read the note that is already open. */
  const [revision, setRevision] = useState(0);
  /**
   * Work handed back that was kept against an older version of the file. Until
   * someone chooses to overwrite or discard, nothing writes it.
   */
  const [outdated, setOutdated] = useState<StrandedEdit | null>(null);

  /** Read when a save lands, so the callback need not be stable to be current. */
  const announceSaved = useRef(onSaved);
  announceSaved.current = onSaved;

  /**
   * For a save nobody outside the pane is waiting on. A refused save is already
   * the pane's save error, shown in its header with the ways out of it; it is
   * passed on to be recorded, and there is nothing more to do with it here.
   */
  const announceSaveFailed = useRef(onSaveFailed);
  announceSaveFailed.current = onSaveFailed;
  const shownInPane = useCallback(
    (at: VaultPath | null) => (cause: unknown) => {
      if (at !== null) announceSaveFailed.current?.({ path: at, cause });
    },
    [],
  );

  /** Read as the pane goes away, when the callbacks cannot be read from a render. */
  const announceStranded = useRef(onStranded);
  announceStranded.current = onStranded;

  const recover = useRef(recoverStranded);
  recover.current = recoverStranded;

  const letGo = useRef(settleStranded);
  letGo.current = settleStranded;

  /**
   * The note whose kept work this pane is holding, handed back and not yet
   * written or thrown away. Read by a write when it lands, which can be after
   * the pane has moved on.
   */
  const recovered = useRef<RecoveredNote | null>(null);

  /**
   * The note the state below belongs to, to tell a re-read from an open. Keyed
   * by vault as well: the same path in another vault is another note.
   */
  const loadedNote = useRef<string | null>(null);

  /** The vault open this instant, for a save on the way out that settles later. */
  const vaultNow = useRef(vault);
  vaultNow.current = vault;

  /**
   * The note this pane holds as of the latest render. A read can resolve after
   * a render that moved the pane on has committed but before its effects have
   * run, when `cancelled` is not yet set — and taking kept work then would take
   * it into a pane whose save on the way out has already been and gone.
   */
  const holding = useRef<string | null>(null);
  holding.current = path === null ? null : noteKey(vault, path);

  /**
   * Whether there are edits still to write, as of this instant.
   *
   * `dirty` is a render behind: a keystroke that lands while a read or a write
   * is in flight has not reached it by the time that promise resolves, and both
   * have to know whether they are about to write over one.
   */
  const unsaved = useRef(false);

  /**
   * The document on screen this instant, for a save to compare what it wrote
   * against. A save carries the document it was handed, and the typing carries
   * on while the write is in flight.
   */
  const onScreen = useRef<EditorDocument | null>(null);

  /**
   * The note this pane was re-pointed at by a move, until the path it is
   * handed catches up. That path change is the same note, already on screen,
   * so it is neither read again nor saved on the way out.
   */
  const repointed = useRef<string | null>(null);

  /**
   * This pane's writes, one at a time. Two property changes a moment apart — a
   * second link picked, a digit typed — would otherwise both start from the
   * same read, and the host would refuse the second as the file having moved
   * on underneath it. `landed` is what the last write left on disk: a write
   * starts from it while it is newer than the note the write's render holds,
   * which a write queued behind another, or asked for before the render after
   * one, always is. A read the pane takes once it has landed is newer still,
   * and lets it go; a read begun before it is older, and is not shown. On a
   * coarse clock the two can share a time (#245), so which came later is
   * told by `step`, which counts each landing and each read begun, rather
   * than by the time. `landedIn` is the vault it landed in: a note of the
   * same name in the next vault is another note.
   */
  const writes = useRef<{
    queue: Promise<unknown>;
    landed: OpenNote | null;
    landedIn: string | null;
    landedAt: number;
    step: number;
  }>({ queue: Promise.resolve(), landed: null, landedIn: null, landedAt: 0, step: 0 });

  /**
   * Where each note this pane followed through a move went, by the key it
   * had before. A write asked for before the move is answered under the old
   * path; it is still this pane's note, under the path it has now.
   */
  const followed = useRef(new Map<string, { key: string; path: VaultPath }>());

  /** Where the note held under `key` is now, after any moves the pane followed; null when it has not moved. */
  const movedTo = useCallback((key: string | null): { key: string; path: VaultPath } | null => {
    let now = key === null ? undefined : followed.current.get(key);
    for (let next = now; next !== undefined; next = followed.current.get(next.key)) now = next;
    return now ?? null;
  }, []);

  /** Records what a write of the pane's left on disk in `vault`, as the newest thing it knows of the note. */
  const recordLanded = useCallback(
    (inVault: string | null) =>
      (saved: SavedNote): SavedNote => {
        writes.current.landed = saved.note;
        writes.current.landedIn = inVault;
        writes.current.landedAt = ++writes.current.step;
        return saved;
      },
    [],
  );

  useEffect(() => {
    if (path === null) {
      loadedNote.current = null;
      onScreen.current = null;
      setNote(null);
      setDoc(null);
      return;
    }

    let cancelled = false;
    const opening = noteKey(vault, path);
    if (repointed.current === opening) {
      repointed.current = null;
      return;
    }
    const reread = loadedNote.current === opening;
    // A re-read of the note already on screen keeps it on screen: blanking to
    // "Reading…" because the other pane saved would be a flicker for nothing.
    setLoading(!reread);
    if (!reread) {
      // Edits on screen belong to the note being left, and its save on the way
      // out has already taken them. Left standing, the autosave would write
      // them into the note being opened — in another vault, its namesake.
      unsaved.current = false;
      setDirty(false);
    }
    setFailure(null);
    setSaveError(null);
    const readAt = ++writes.current.step;
    openNote({ fs: ports.fs, markdown: ports.markdown, path })
      .then((opened) => {
        if (cancelled || holding.current !== opening) return;
        // Typing that landed while this read was in flight belongs to the
        // reader, not to the file: a re-read is something another pane asked
        // for, and applying it here would write the file over the keystrokes.
        // The pane keeps its edits, and the save that follows is refused
        // rather than clobbering — the way out of that is `overwrite`.
        if (loadedNote.current === opening && unsaved.current) return;
        // A write of the pane's landed while this read was out: what it read
        // is from before that write, and shown it would put the older text
        // back for the next save to write over the edit. Read again instead,
        // for anything written since.
        if (writes.current.landedAt > readAt) {
          setRevision((was) => was + 1);
          return;
        }
        loadedNote.current = opening;
        // Begun after the pane's last write landed, this read holds that
        // write or what came after it: a write starts from it now.
        writes.current.landed = null;
        setNote(opened);
        // Work an earlier pane could not write comes back with the note, still
        // unsaved — it is the user's typing. If the file is as it was when the
        // work was kept, saving it now is an ordinary save. If the file has
        // been written since — which, across a quit, can be days of someone
        // else's edits — the pane says so and waits to be told.
        const rescued = recover.current?.(path) ?? null;
        recovered.current = rescued !== null && vault !== null ? { vault, path } : null;
        setOutdated(
          rescued !== null && changedSinceStranded({ edit: rescued, modified: opened.modified })
            ? rescued
            : null,
        );
        onScreen.current = rescued?.doc ?? opened.doc;
        setDoc(rescued?.doc ?? opened.doc);
        setDirty(rescued !== null);
        unsaved.current = rescued !== null;
      })
      .catch((cause: unknown) => {
        if (!cancelled) setFailure(message(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [ports.fs, ports.markdown, vault, path, revision]);

  const reload = useCallback(() => setRevision((was) => was + 1), []);

  const changeDoc = useCallback((next: EditorDocument) => {
    unsaved.current = true;
    onScreen.current = next;
    setDoc(next);
    setDirty(true);
  }, []);

  /** Lets go of handed-back work that has been written or thrown away. */
  const settleRecovered = useCallback((settled: RecoveredNote | null) => {
    if (settled === null) return;
    if (recovered.current === settled) recovered.current = null;
    letGo.current?.(settled);
  }, []);

  /** Runs a write, and settles the header against what is on screen when it lands. */
  const track = useCallback(
    (written: EditorDocument, writing: Promise<SavedNote>) => {
      setSaving(true);
      setSaveError(null);
      // Taken now: what is on screen holds the handed-back work, so once this
      // lands the work is on disk, even if the pane has moved on by then.
      const holdingRecovered = recovered.current;
      // The note the pane held when the write was asked for. A write answered
      // once the pane holds another — the next vault's note of the same name —
      // is that note's news, not this one's.
      const holdingThen = holding.current;
      const vaultThen = vaultNow.current;
      return writing
        .then((saved) => {
          // Moved meanwhile, the note is still this one, at its new path.
          const moved = movedTo(noteKey(vaultThen, saved.note.path));
          const landed = moved === null ? saved.note : { ...saved.note, path: moved.path };
          if (holding.current === (movedTo(holdingThen)?.key ?? holdingThen)) setNote(landed);
          announceSaved.current?.(landed.path);
          settleRecovered(holdingRecovered);
          // An edit made while the write was in flight is newer than what
          // landed, so the note is still unsaved. Clearing the flag over it is
          // what made the autosave stand down and the note switch skip its
          // save, and the edit was gone with the header reading "Saved".
          if (onScreen.current !== written) return;
          setDirty(false);
          unsaved.current = false;
        })
        .catch((cause: unknown) => {
          setSaveError(message(cause));
          // Passed on as well as shown: a caller writing through this pane — a
          // board drag, the local API — must not report a write that never landed.
          throw cause;
        })
        .finally(() => setSaving(false));
    },
    [movedTo],
  );

  /**
   * What a write of `held` starts from: what the last write left, unless the
   * note was read since at a later time. A tie goes to the write, as a read
   * begun after it has already let it go: on a disk that keeps the time to
   * the second, a write within the second leaves the time as it was, and
   * starting from the older read would have the save refused for the bytes
   * the pane itself wrote (#245).
   */
  const startFrom = useCallback((held: OpenNote, inVault: string | null): OpenNote => {
    const { landed, landedIn } = writes.current;
    return landed !== null &&
      landedIn === inVault &&
      landed.path === held.path &&
      landed.modified >= held.modified
      ? landed
      : held;
  }, []);

  const write = useCallback(
    (changes?: PropertyChanges) => {
      if (note === null || doc === null || outdated !== null) return Promise.resolve();
      const run = () => {
        const from = startFrom(note, vault);
        // A change given as a rule is worked out against the properties the
        // write starts from, which is the same frontmatter a direct write would
        // read — and held to a task's rules there, by the save itself.
        return saveNote({
          fs: ports.fs,
          markdown: ports.markdown,
          note: from,
          doc,
          ...(changes === undefined ? {} : { changes: { values: changes, today: localToday() } }),
        });
      };
      const writing = writes.current.queue.then(run, run).then(recordLanded(vault));
      // Reported through `track` below; the queue only has to know it is over.
      writes.current.queue = writing.catch(() => undefined);
      return track(doc, writing);
    },
    [ports.fs, ports.markdown, vault, note, doc, outdated, track, startFrom, recordLanded],
  );

  const save = useCallback(() => void write().catch(shownInPane(path)), [write, shownInPane, path]);

  const flush = useCallback(
    () => (unsaved.current ? write().catch(shownInPane(path)) : Promise.resolve()),
    [write, shownInPane, path],
  );

  // The two ways out of a refused save. Without them a pane holding a
  // modification time the file has moved past can only be refused again, and
  // the work goes when the pane does.
  const overwrite = useCallback(() => {
    if (path === null || doc === null) return;
    const written = doc;
    setOutdated(null);
    track(
      written,
      // Read again first: the refusal means someone else wrote this file, and
      // keeping their frontmatter costs one read and saves the star, the
      // status or the due date they had just set.
      // What it leaves is the pane's newest write, which the next starts from.
      openNote({ fs: ports.fs, markdown: ports.markdown, path })
        .then((fresh) =>
          saveNote({ fs: ports.fs, markdown: ports.markdown, note: fresh, doc: written }),
        )
        .then(recordLanded(vault)),
    ).catch(shownInPane(path));
  }, [ports.fs, ports.markdown, vault, path, doc, track, shownInPane, recordLanded]);

  const discard = useCallback(() => {
    // Thrown away, so let go of — before the read below, which would otherwise
    // be handed the same work again.
    settleRecovered(recovered.current);
    // Clearing this before the read is what lets the read apply: a re-read
    // leaves a pane with unsaved edits alone, and this is the pane saying it
    // no longer has any.
    unsaved.current = false;
    setDirty(false);
    setSaveError(null);
    // Work waiting on this decision is let go of by the read, which works out
    // afresh whether anything handed back is outdated.
    setRevision((was) => was + 1);
  }, []);

  /**
   * The latest note and document, for saving on the way out.
   *
   * The cleanup below runs after the state has already moved to the next note, so
   * it cannot read the note it needs from the render it belongs to.
   */
  const latest = useRef<{
    note: OpenNote | null;
    doc: EditorDocument | null;
    dirty: boolean;
    outdated: StrandedEdit | null;
  }>({ note: null, doc: null, dirty: false, outdated: null });
  latest.current = { note, doc, dirty, outdated };

  const repoint = useCallback(
    (to: VaultPath) => {
      if (vault === null) return;
      const moved = noteKey(vault, to);
      const from = latest.current.note?.path;
      if (from !== undefined && from !== to) {
        followed.current.set(noteKey(vault, from), { key: moved, path: to });
      }
      loadedNote.current = moved;
      repointed.current = moved;
      setNote((was) => (was === null ? was : { ...was, path: to }));
      // Read by the save on the way out, which runs before the next render
      // has put the moved note here.
      const { note: held } = latest.current;
      if (held !== null) latest.current = { ...latest.current, note: { ...held, path: to } };
    },
    [vault],
  );

  const abandon = useCallback(() => {
    unsaved.current = false;
    latest.current = { ...latest.current, dirty: false };
    setDirty(false);
  }, []);

  // Writing after a pause means an edit is never more than a moment from being on
  // disk, which is what people expect of a notes app.
  useEffect(() => {
    if (!dirty || paused || note === null || doc === null) return;
    const timer = setTimeout(() => void write().catch(shownInPane(path)), AUTOSAVE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [dirty, paused, doc, note, write, shownInPane, path]);

  // Leaving a note with unsaved changes must not discard them. This writes the
  // note being left, not the one being opened, which is why it reads the ref.
  //
  // It also runs when the vault changes, after the host has moved to the new
  // one. `ports.fs` and `vault` are this effect's own — the vault the note was
  // opened in — so the write names that vault and the host refuses it rather
  // than writing the other vault's note of the same name, and anything refused
  // is handed back under that vault (R14-01).
  useEffect(() => {
    return () => {
      const { note: leaving, doc: unwritten, dirty: hasEdits, outdated: held } = latest.current;
      const holdingRecovered = recovered.current;
      // `unsaved` is the truth as of now; `dirty` is the last render's. A pane
      // unmounted in the same commit its write landed in — the vault switched
      // under it (R14-01) — has not drawn since, and must not write again.
      if (!hasEdits || !unsaved.current || leaving === null || unwritten === null || vault === null)
        return;
      // Re-pointed by a move and still on screen under its new path: the pane
      // has not left the note, so its edits stay in it, unsaved, to be saved
      // there. Saving them here as well would move the file on underneath it.
      if (holding.current === noteKey(vault, leaving.path) && leaving.path !== path) return;
      // Work that was waiting on a decision goes back to wait, against the
      // file time it was kept at, so the next pane to open the note asks the
      // same question rather than taking the silence as an answer.
      if (held !== null) {
        announceStranded.current?.({ ...held, doc: unwritten, vault });
        return;
      }
      // Behind any write of the pane's still in flight, and from what it
      // leaves: started beside it, from the note as read, this was refused
      // once that write landed, and the typing since was handed back.
      const run = () =>
        saveNote({
          fs: ports.fs,
          markdown: ports.markdown,
          note: startFrom(leaving, vault),
          doc: unwritten,
        });
      const leavingWrite = writes.current.queue.then(run, run);
      // Handled just below; the queue only has to know it is over.
      writes.current.queue = leavingWrite.catch(() => undefined);
      void leavingWrite.then(
        // Landed: the work handed back, if any, is on disk now, and a pane
        // still showing the note is behind the file until it re-reads it.
        () => {
          announceSaved.current?.(leaving.path);
          settleRecovered(holdingRecovered);
        },
        async (cause: unknown) => {
          // Nothing can be shown here — the note is already off the screen — and
          // the pane cannot be asked what it wants. Handing the work back is what
          // keeps a refusal on the way out from being a silent loss. The file's
          // time now is recorded with it, so a change after this is noticed.
          //
          // Once another vault is open, "the file now" would be read from that
          // vault, so the time the note was opened at stands in. If the file has
          // moved past it, the next save of this work is refused, not clobbering.
          const modified =
            vaultNow.current === vault
              ? await noteModified({ fs: ports.fs, path: leaving.path })
              : leaving.modified;
          announceStranded.current?.({
            path: leaving.path,
            doc: unwritten,
            reason: message(cause),
            modified,
            vault,
          });
        },
      );
    };
  }, [ports.fs, ports.markdown, vault, path, startFrom]);

  // A property is written as soon as it is changed, through the same save as the
  // body, so an edit in progress is never lost to a property change.
  const setProperty = useCallback(
    (key: string, value: unknown) =>
      void write(
        // A function is a rule — add this link — worked out against the value
        // the write starts from, not the one on screen when it was asked for.
        typeof value === 'function'
          ? (properties) => ({ [key]: (value as (current: unknown) => unknown)(properties[key]) })
          : { [key]: value },
      ).catch(shownInPane(path)),
    [write, shownInPane, path],
  );

  /**
   * For writes made through this pane from outside it. Unlike the pane's own
   * saves, a write that does not happen is a rejection here: resolving would
   * tell the board or the API it landed.
   */
  const setProperties = useCallback(
    (changes: PropertyChanges) => {
      if (path === null || note === null || doc === null) {
        return Promise.reject(new NoteStillOpeningError(path ?? 'The note'));
      }
      if (outdated !== null) return Promise.reject(new NoteChangedError(path));
      return write(changes);
    },
    [path, note, doc, outdated, write],
  );

  const state: NotePaneState =
    path === null
      ? { kind: 'empty' }
      : failure !== null
        ? { kind: 'failed', message: failure }
        : loading || note === null || doc === null
          ? { kind: 'loading' }
          : {
              kind: 'ready',
              title: noteTitle(path),
              doc,
              dirty,
              saving,
              // Shown as a refused save is, because it is one waiting to happen,
              // and the same two buttons are the way out of it.
              saveError: saveError ?? (outdated !== null ? CHANGED_SINCE_KEPT : null),
            };

  return {
    state,
    dirty,
    open: note,
    changeDoc,
    save,
    setProperty,
    setProperties,
    reload,
    overwrite,
    discard,
    flush,
    repoint,
    abandon,
  };
}

/** A note, named by its vault: a path means nothing without one. */
export interface RecoveredNote {
  readonly vault: string;
  readonly path: VaultPath;
}

/** Which note a pane holds: a path means nothing without its vault. */
const noteKey = (vault: string | null, path: VaultPath): string => `${vault ?? ''}\u0000${path}`;
