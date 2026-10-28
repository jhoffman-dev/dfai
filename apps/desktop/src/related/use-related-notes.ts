import { useCallback, useEffect, useMemo, useState } from 'react';
import { messageWithoutPaths, type VaultGraph, type VaultPath } from '@dfai/domain';
import {
  acceptRelatedNote,
  findRelatedNotes,
  type DismissedRelatedStore,
  type IdlePort,
  type IndexPort,
  type RelatedNotesState,
  type SemanticEngine,
  type VaultFsPort,
} from '@dfai/application';
import type { RelatedPanelState } from '@dfai/ui';
import type { RelatedPanelMemory } from './browser-related-stores.ts';
import type { TrailMemory } from './trail-memory.ts';

/** What Related notes and trails run on in the window (P32-03). */
export interface RelatedPorts {
  /** The open vault's search by meaning; null where the app offers none. */
  readonly semantic: Pick<SemanticEngine, 'isOn' | 'related' | 'subscribe'> | null;
  /** The window's idle moments: the panel is looked for only once the note is drawn. */
  readonly idle: IdlePort | null;
  /** The open vault's dismissals; null while no vault is open. */
  readonly dismissed: DismissedRelatedStore | null;
  readonly panel: RelatedPanelMemory;
  readonly trails: TrailMemory;
}

/** The note's editor, which is saved before a link is written into its file and read again after. */
interface NoteEditor {
  flush(): Promise<void>;
  reload(): void;
}

const LOADING: RelatedPanelState = { kind: 'loading' };

/**
 * The open note's Related notes: looked for only while the section is open
 * (or a trail stands on the note), and then only once the window is idle
 * after the note is drawn — opening a note never waits on it, nor does any
 * work for it with the section shut. Looked for again as the build moves on
 * while the note is not read yet, and after one is linked, dismissed or
 * fails to link.
 */
export function useRelatedNotes({
  ports,
  graph,
  path,
  fs,
  index,
  editor,
  onChanged,
  trailHere,
}: {
  ports: RelatedPorts;
  graph: VaultGraph | null;
  path: VaultPath | null;
  fs: Pick<VaultFsPort, 'readTextFile' | 'writeTextFile'>;
  index: Pick<IndexPort, 'manifest'>;
  editor: NoteEditor;
  onChanged: () => void;
  /** A trail stands on this note: its next steps by meaning are these. */
  trailHere: boolean;
}) {
  const [open, setOpen] = useState(() => ports.panel.isOpen());
  const [found, setFound] = useState<{ for: VaultPath | null; state: RelatedPanelState }>({
    for: null,
    state: LOADING,
  });
  // Linked or dismissed here since the list was read: gone from it at once, not when the index catches up.
  const [gone, setGone] = useState<{ for: VaultPath | null; paths: ReadonlySet<string> }>({
    for: null,
    paths: new Set(),
  });
  const [round, setRound] = useState(0);
  // Why the last Link on a row failed: said on that row, the rest kept.
  const [problem, setProblem] = useState<{
    for: VaultPath | null;
    related: VaultPath;
    message: string;
  } | null>(null);
  const wanted = (open || trailHere) && path !== null && graph !== null;
  const goneHere = useMemo(
    () => (gone.for === path ? gone.paths : new Set<string>()),
    [gone, path],
  );

  useEffect(() => {
    if (!wanted) return undefined;
    let cancelled = false;
    let stopHearing: (() => void) | null = null;
    const look = async () => {
      await ports.idle?.idle();
      if (cancelled) return;
      const state = await findRelatedNotes({
        semantic: ports.semantic,
        graph,
        dismissed: new Set([...(ports.dismissed?.dismissed(path) ?? []), ...goneHere]),
        path,
      });
      if (cancelled) return;
      setFound({ for: path, state: panelState(state) });
      // Not read yet — the build has not reached it, or found nothing in it so far:
      // looked for again the next time the build moves on (a note read, this one written).
      if (state.kind === 'not-built' && ports.semantic !== null)
        stopHearing = ports.semantic.subscribe(() => {
          stopHearing?.();
          stopHearing = null;
          if (!cancelled) setRound((was) => was + 1);
        });
    };
    look().catch((error: unknown) => {
      if (!cancelled)
        setFound({ for: path, state: { kind: 'failed', message: messageWithoutPaths(error) } });
    });
    return () => {
      cancelled = true;
      stopHearing?.();
    };
  }, [wanted, ports, graph, path, goneHere, round]);

  const hide = useCallback(
    (related: VaultPath) => {
      setGone((was) => ({
        for: path,
        paths: new Set([...(was.for === path ? was.paths : []), related]),
      }));
    },
    [path],
  );

  const accept = useCallback(
    (related: VaultPath) => {
      if (path === null) return;
      setProblem(null);
      const write = async () => {
        await editor.flush();
        await acceptRelatedNote({ fs, index, note: path, target: related });
        editor.reload();
        hide(related);
        onChanged();
      };
      write().catch((error: unknown) => {
        setProblem({ for: path, related, message: messageWithoutPaths(error) });
        // The note may have changed, or gone: the list is read again.
        setRound((was) => was + 1);
      });
    },
    [path, editor, fs, index, hide, onChanged],
  );

  const dismiss = useCallback(
    (related: VaultPath) => {
      if (path === null) return;
      ports.dismissed?.dismiss(path, related);
      hide(related);
    },
    [path, ports, hide],
  );

  const toggle = useCallback(() => {
    ports.panel.setOpen(!open);
    setOpen(!open);
  }, [ports, open]);

  const state = useMemo(() => {
    const shown = found.for === path ? found.state : LOADING;
    if (shown.kind !== 'ready') return shown;
    const failed = problem?.for === path ? problem : null;
    const notes = shown.notes
      .filter((note) => !goneHere.has(note.path))
      .map((note) => (failed?.related === note.path ? { ...note, problem: failed.message } : note));
    return { ...shown, notes };
  }, [found, path, goneHere, problem]);
  return { open, toggle, state, accept, dismiss };
}

function panelState(state: RelatedNotesState): RelatedPanelState {
  switch (state.kind) {
    case 'unavailable':
    case 'off':
      return state;
    case 'not-built':
      return { kind: 'not-built', done: state.progress.done, total: state.progress.total };
    case 'ready':
      return {
        kind: 'ready',
        notes: state.notes.map((note) => ({ path: note.path as VaultPath, title: note.title })),
      };
  }
}
