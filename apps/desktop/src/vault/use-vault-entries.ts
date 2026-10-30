import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CHAT_NOTE_LABEL,
  deleteRefusal,
  isInChats,
  isMovable,
  moveTargets,
  newFolderRefusal,
  noteLabelForNotice,
  noteTitle,
  parentVaultPath,
  renameRefusal,
  vaultPathName,
  vaultPathSegments,
  VAULT_ROOT,
  type MovableEntry,
  type NameClash,
  type VaultPath,
} from '@dfai/domain';
import {
  countOtherFiles,
  type OtherFilesCount,
  createFolder,
  deleteEntry,
  linksToUpdate,
  listVaultFolders,
  moveEntryInto,
  previewDeletion,
  renameEntry,
  updateLinks,
  type IndexPort,
  type LinkUpdate,
  type LinkUpdatePanes,
  type OpenEditorsPort,
  type Relocation,
  type VaultFsPort,
} from '@dfai/application';
import type { DeletionSubject, MenuCommand, MoveDestination } from '@dfai/ui';

/** The tree, as moving and deleting has to keep it in step. */
export interface TreeState {
  readonly reload: () => Promise<void>;
  readonly expandDirectory: (path: VaultPath) => void;
  readonly forgetDirectory: (path: VaultPath) => void;
  readonly isExpanded: (path: VaultPath) => boolean;
}

/** What the hook reaches: the files, the index, the panes and the tree. */
export interface VaultEntryPorts {
  readonly fs: VaultFsPort;
  readonly index: IndexPort;
  /** The panes' editors; `follow` also moves the layout onto where a note went. */
  readonly editors: OpenEditorsPort & Pick<LinkUpdatePanes, 'reload'>;
  readonly tree: TreeState;
  /** Closes every pane holding one of these notes, after a delete. */
  readonly closeNotes: (paths: readonly VaultPath[]) => void;
  /** Re-reads the index after a change. */
  readonly refresh: () => void;
  /** Makes a blank note in a folder and opens it. */
  readonly createNoteIn: (folder: VaultPath) => Promise<void>;
  /** Puts up one of Pages' overlays, or takes it down, by the one-overlay rule. */
  readonly overlay: {
    readonly show: (which: 'move-picker' | 'delete-dialog') => void;
    readonly hide: (which: 'move-picker' | 'delete-dialog') => void;
  };
}

/** The folder picker, while it is up. */
export interface MoveChoice {
  readonly subject: string;
  readonly destinations: readonly MoveDestination[];
  readonly pick: (folder: string) => void;
  readonly close: () => void;
}

/** The offer to re-point links a move left behind, while it stands. */
export interface LinkOffer {
  readonly text: string;
  readonly action: string;
  readonly update: () => void;
  readonly dismiss: () => void;
}

/** The question before a delete, while it is up. */
export interface DeleteQuestion {
  readonly subject: DeletionSubject;
  readonly confirm: () => void;
  readonly close: () => void;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What the offer says: how many links, in how many notes, still name what moved. */
function linkOfferText(update: LinkUpdate, entry: MovableEntry): string {
  const links = count(update.total, 'link', 'links');
  const notes = count(update.notes.length, 'note', 'notes');
  const verb = update.total === 1 ? 'points' : 'point';
  return `${links} in ${notes} still ${verb} at “${shownName(entry)}”.`;
}

const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** An entry's name as Pages shows it: a note by its title, a folder by its name. */
const shownName = (entry: MovableEntry): string =>
  entry.kind === 'file' ? noteTitle(entry.path) : vaultPathName(entry.path);

/** A folder as the picker lists it: "Pages" at the top, then by name and where it is. */
function destinationOf(folder: VaultPath): MoveDestination {
  if (folder === VAULT_ROOT) return { path: folder, name: 'Pages', place: '' };
  const above = vaultPathSegments(parentVaultPath(folder));
  return { path: folder, name: vaultPathName(folder), place: ['Pages', ...above].join(' / ') };
}

/** What a warning about a shared name says: which note `[[name]]` opens now. */
const clashNotice = (clashes: readonly NameClash[]): string | null =>
  clashes.length === 0 ? null : clashes.map(clashLine).join(' ');

/** One shared name; one a chat note now answers to is its question, so it is not repeated. */
const clashLine = ({ name, opens }: NameClash): string =>
  isInChats(opens)
    ? `More than one note now shares a name with ${CHAT_NOTE_LABEL}; links to that name open the chat note.`
    : `More than one note is called “${name}”: [[${name}]] now opens ${opens}.`;

/** What the question says of a folder's other files: nothing yet until they are counted for it. */
function otherFilesOf(
  folder: VaultPath,
  counted: ({ for: VaultPath } & OtherFilesCount) | null,
): Pick<DeletionSubject, 'otherFiles' | 'links' | 'link'> {
  if (counted?.for !== folder) return { otherFiles: null };
  const within = (path: VaultPath) => path.slice(folder.length + 1);
  return { otherFiles: counted.count, links: counted.links.map(within), link: counted.link };
}

/**
 * Making, renaming, moving and deleting in Pages, and everything that has to
 * follow: the panes, the tree, the index and the one-overlay rule.
 *
 * The rules are the domain's and the steps are the use-cases'; this holds what
 * is on screen while they run — the entry being named, the picker, the question
 * — and turns what they report into notices.
 */
export function useVaultEntries(ports: VaultEntryPorts, notePaths: readonly VaultPath[]) {
  const [renaming, setRenaming] = useState<VaultPath | null>(null);
  const [choice, setChoice] = useState<MovableEntry | null>(null);
  const [folders, setFolders] = useState<readonly VaultPath[]>([]);
  const [doomed, setDoomed] = useState<MovableEntry | null>(null);
  /** What the asker wants done once the entry is gone — a type's tabs land on the next view. */
  const afterDelete = useRef<(() => void) | null>(null);
  const [otherFiles, setOtherFiles] = useState<({ for: VaultPath } & OtherFilesCount) | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [linksLeft, setLinksLeft] = useState<{ update: LinkUpdate; entry: MovableEntry } | null>(
    null,
  );
  const { tree, overlay } = ports;

  /**
   * The tree after a move: re-read first, then the destination opened, so the
   * entry is never drawn in its old folder and its new one at the same time.
   */
  const settle = useCallback(
    async (entry: MovableEntry, moved: Relocation) => {
      const wasOpen = entry.kind === 'directory' && tree.isExpanded(entry.path);
      if (entry.kind === 'directory') tree.forgetDirectory(entry.path);
      setNotice(clashNotice(moved.clashes));
      ports.refresh();
      await tree.reload();
      tree.expandDirectory(parentVaultPath(moved.move.to));
      if (wasOpen) tree.expandDirectory(moved.move.to);
    },
    [tree, ports],
  );

  /** After a move lands: whether any link still names where it was, to offer to update. */
  const offerLinks = useCallback(
    async (entry: MovableEntry, moved: Relocation, before: readonly VaultPath[]) => {
      const update = await linksToUpdate({ fs: ports.fs, move: moved.move, notePaths: before });
      setLinksLeft(update.total === 0 ? null : { update, entry });
    },
    [ports.fs],
  );

  const run = useCallback((work: Promise<unknown>) => {
    work.catch((cause: unknown) => setNotice(message(cause)));
  }, []);

  const moveInto = useCallback(
    (entry: MovableEntry, folder: VaultPath) =>
      run(
        moveEntryInto({ ports, entry, folder, notePaths }).then(async (moved) => {
          await settle(entry, moved);
          await offerLinks(entry, moved, notePaths);
        }),
      ),
    [ports, notePaths, settle, offerLinks, run],
  );

  const rename = useCallback(
    (entry: MovableEntry, name: string) => {
      setRenaming(null);
      run(
        renameEntry({ ports, entry, name, notePaths }).then(async (moved) => {
          if (moved === null) return;
          await settle(entry, moved);
          await offerLinks(entry, moved, notePaths);
        }),
      );
    },
    [ports, notePaths, settle, offerLinks, run],
  );

  const newFolderIn = useCallback(
    (parent: VaultPath) =>
      run(
        createFolder({ fs: ports.fs, parent }).then(async (made) => {
          setRenaming(made);
          await tree.reload();
          tree.expandDirectory(parent);
        }),
      ),
    [ports.fs, tree, run],
  );

  const newNoteIn = useCallback(
    (folder: VaultPath) => {
      tree.expandDirectory(folder);
      run(ports.createNoteIn(folder));
    },
    [ports, tree, run],
  );

  const askMove = useCallback(
    (entry: MovableEntry) =>
      run(
        listVaultFolders({ fs: ports.fs }).then((listed) => {
          setFolders(listed);
          setChoice(entry);
          overlay.show('move-picker');
        }),
      ),
    [ports.fs, overlay, run],
  );

  const askDelete = useCallback(
    (entry: MovableEntry, onDeleted?: () => void) => {
      afterDelete.current = onDeleted ?? null;
      setDoomed(entry);
      overlay.show('delete-dialog');
    },
    [overlay],
  );

  const confirmDelete = useCallback(
    (entry: MovableEntry) => {
      overlay.hide('delete-dialog');
      setDoomed(null);
      const then = afterDelete.current;
      afterDelete.current = null;
      run(
        deleteEntry({ ...ports, entry, notePaths }).then(async (gone) => {
          ports.closeNotes(gone);
          then?.();
          if (entry.kind === 'directory') tree.forgetDirectory(entry.path);
          setNotice(null);
          ports.refresh();
          await tree.reload();
        }),
      );
    },
    [ports, notePaths, tree, overlay, run],
  );

  /** A row's commands, each offered only where the domain allows it. */
  const menuFor = useCallback(
    (entry: MovableEntry): MenuCommand[] => {
      const here = entry.kind === 'directory' ? entry.path : parentVaultPath(entry.path);
      return [
        { label: 'New note here', onSelect: () => newNoteIn(here), movesFocus: true },
        {
          label: 'New folder',
          onSelect: () => newFolderIn(here),
          disabled: newFolderRefusal(here) !== null,
          movesFocus: true,
        },
        {
          label: 'Rename',
          onSelect: () => setRenaming(entry.path),
          disabled: renameRefusal(entry) !== null,
          movesFocus: true,
        },
        {
          label: 'Move to…',
          onSelect: () => askMove(entry),
          disabled: !isMovable(entry),
          movesFocus: true,
        },
        {
          label: 'Delete…',
          onSelect: () => askDelete(entry),
          disabled: deleteRefusal(entry) !== null,
          movesFocus: true,
          destructive: true,
        },
      ];
    },
    [newNoteIn, newFolderIn, askMove, askDelete],
  );

  const picker: MoveChoice | null = useMemo(
    () =>
      choice === null
        ? null
        : {
            subject: shownName(choice),
            destinations: moveTargets(choice, folders).map(destinationOf),
            pick: (folder: string) => {
              overlay.hide('move-picker');
              setChoice(null);
              moveInto(choice, folder as VaultPath);
            },
            close: () => {
              overlay.hide('move-picker');
              setChoice(null);
            },
          },
    [choice, folders, overlay, moveInto],
  );

  // The folder's other files are counted from a listing, which takes a moment:
  // the question shows the notes at once and the rest when they are known.
  useEffect(() => {
    if (doomed === null || doomed.kind !== 'directory') return;
    let cancelled = false;
    countOtherFiles({ fs: ports.fs, entry: doomed, notes: notePaths })
      .then((counted) => {
        if (!cancelled) setOtherFiles({ for: doomed.path, ...counted });
      })
      // Safe to leave uncounted: the question still names the folder and its
      // notes, and the Trash keeps everything whatever the count said.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [doomed, ports.fs, notePaths]);

  const question: DeleteQuestion | null = useMemo(() => {
    if (doomed === null) return null;
    const preview = previewDeletion({ entry: doomed, notePaths, editors: ports.editors });
    return {
      subject: {
        name: shownName(doomed),
        kind: doomed.kind === 'directory' ? 'folder' : 'note',
        notes: preview.notes.length,
        ...otherFilesOf(doomed.path, otherFiles),
        unsaved: preview.unsaved.map(noteTitle),
      },
      confirm: () => confirmDelete(doomed),
      close: () => {
        overlay.hide('delete-dialog');
        afterDelete.current = null;
        setDoomed(null);
      },
    };
  }, [doomed, notePaths, ports.editors, confirmDelete, overlay, otherFiles]);

  const links = useMemo<LinkOffer | null>(() => {
    if (linksLeft === null) return null;
    const { update, entry } = linksLeft;
    return {
      text: linkOfferText(update, entry),
      action: `Update ${count(update.total, 'link', 'links')}`,
      dismiss: () => setLinksLeft(null),
      update: () => {
        setLinksLeft(null);
        run(
          updateLinks({ fs: ports.fs, openNotes: ports.editors, update }).then((report) => {
            ports.refresh();
            if (report.failed.length > 0) {
              setNotice(
                `${count(report.failed.length, 'note', 'notes')} could not be updated: ${report.failed
                  .map(({ path, reason }) => `${noteLabelForNotice(path)} (${reason})`)
                  .join(', ')}.`,
              );
            }
          }),
        );
      },
    };
  }, [linksLeft, ports, run]);

  return {
    menuFor,
    offerLinks,
    links,
    renaming,
    rename,
    cancelRename: useCallback(() => setRenaming(null), []),
    newNoteIn,
    newFolderIn,
    moveInto,
    askMove,
    askDelete,
    picker,
    question,
    notice,
  };
}
