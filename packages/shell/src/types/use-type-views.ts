import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createVaultPath,
  landingView,
  layoutChoices,
  savedViewSummary,
  splitFrontmatter,
  takenViewPaths,
  viewAfterRemoval,
  type ObjectType,
  type SavedViewSummary,
  type VaultPath,
} from '@dfai/domain';
import {
  addTypeView,
  duplicateTab,
  moveTypeView,
  renameTab,
  type MarkdownPort,
  type TypeViewPorts,
  type VaultFsPort,
} from '@dfai/application';
import type { ViewTabEditing } from '@dfai/ui';
import type { OpenEditors } from '../panes/open-editors.ts';
import { errorMessage } from '../query/error-message.ts';
import { writeNoteProperties } from '../query/use-view-writes.ts';
import type { TypeTabStore } from './browser-type-tab-store.ts';
import { stillUnread, viewsAsShown, withPropertiesWritten } from './unread-views.ts';

/** What a type's tabs open into, and what they do when there is nothing left to open. */
export interface TabLanding {
  readonly typeName: string;
  /** Opens a view where the tabs are: their pane. */
  readonly onOpenView: (path: VaultPath) => void;
  /** The page's own reading of the view it shows, which its tabs include before the catalogue does. */
  readonly current?: SavedViewSummary | undefined;
}

/** Asks the usual question before deleting, and says when the file has gone. */
export type AskDelete = (entry: { path: VaultPath; kind: 'file' }, onDeleted: () => void) => void;

/**
 * A type's views, as its page uses them (issue #11, ADR-0023): which one a
 * click on the type lands on, which type a view belongs to, and the tabs'
 * commands. The rules are the domain's and the writes the application's; this
 * holds the remembered tab and the last error, and wires them together.
 *
 * The tabs' writes run one at a time, each against the views as the tabs show
 * them — the page's own reading and this window's unread writes included — so
 * a second move or a second "+" made before the index is read again is asked
 * of the views as they now are.
 */
export function useTypeViews({
  ports,
  types,
  savedViews,
  viewPaths,
  vaultKey,
  store,
  onChanged,
  onOpenType,
  onEditTemplate,
  askDelete,
}: {
  ports: { fs: VaultFsPort; markdown: MarkdownPort; editors: OpenEditors };
  types: readonly ObjectType[];
  savedViews: readonly SavedViewSummary[];
  viewPaths: readonly string[];
  vaultKey: string | null;
  store: TypeTabStore;
  /** Re-reads the tree, the index and the catalogue, after a view was written. */
  onChanged: () => void;
  /** Opens a type's own page: its default table, or its definition to edit. */
  onOpenType: (name: string, mode: 'notes' | 'edit') => void;
  /** Opens a type's template, made if it has none (ADR-0026). */
  onEditTemplate: (typeName: string) => void;
  askDelete: AskDelete;
}) {
  const [error, setError] = useState<string | null>(null);
  const tabWrites = useTabWrites({ ports, savedViews, viewPaths, vaultKey });

  const run = useCallback((work: Promise<unknown>) => {
    setError(null);
    work.catch((cause: unknown) => setError(errorMessage(cause)));
    return work;
  }, []);

  /** The view a click on the type opens, or null when it shows its default table. */
  const landing = useCallback(
    (typeName: string): VaultPath | null => {
      const remembered = vaultKey === null ? null : store.read({ vault: vaultKey, type: typeName });
      return landingView({ views: savedViews, typeName, remembered })?.path ?? null;
    },
    [savedViews, store, vaultKey],
  );

  /** The type a note is one of the views of, while the vault defines that type. */
  const ownerOf = useCallback(
    (path: VaultPath): string | null => {
      const owner = savedViews.find((view) => view.path === path)?.type ?? null;
      return types.some((type) => type.name === owner) ? owner : null;
    },
    [savedViews, types],
  );

  /** Keeps a view as its type's tab to come back to, on this Mac. */
  const remember = useCallback(
    (path: VaultPath) => {
      const owner = ownerOf(path);
      if (owner !== null && vaultKey !== null) store.write({ vault: vaultKey, type: owner, path });
    },
    [ownerOf, store, vaultKey],
  );

  const editingFor = useCallback(
    ({ typeName, onOpenView, current }: TabLanding): ViewTabEditing | undefined => {
      const type = types.find((candidate) => candidate.name === typeName);
      if (type === undefined) return undefined;
      const { queue, known, forget, portsFor } = tabWrites;
      // Worked out when the write's turn comes, not when it was asked for.
      const at = () => ({ ports: portsFor(current), type, ...known(current) });
      // The promise `run` reports a failure on, so the tabs may also act on it.
      const written = (work: Promise<unknown>) => run(work.finally(onChanged));
      const thenOpen = (write: () => Promise<VaultPath>) => {
        void written(queue(write).then(onOpenView));
      };
      return {
        typeLabel: type.label,
        layouts: layoutChoices(type),
        onAdd: (layout) => thenOpen(() => addTypeView({ ...at(), layout })),
        onRename: ({ path, name }) =>
          thenOpen(() => renameTab({ ...at(), path: createVaultPath(path), name })),
        onDuplicate: (path) =>
          thenOpen(() => duplicateTab({ ...at(), path: createVaultPath(path) })),
        onMove: ({ path, to }) =>
          written(queue(() => moveTypeView({ ...at(), typeName, path, to }))),
        onDelete: (path) => {
          const next = viewAfterRemoval({ views: known(current).views, typeName, path });
          askDelete({ path: createVaultPath(path), kind: 'file' }, () => {
            forget(path);
            if (next === null) onOpenType(typeName, 'notes');
            else onOpenView(next);
          });
        },
        onEditType: () => onOpenType(typeName, 'edit'),
        onEditTemplate: () => onEditTemplate(typeName),
      };
    },
    [types, tabWrites, run, onChanged, onOpenType, onEditTemplate, askDelete],
  );

  return { landing, ownerOf, remember, editingFor, error };
}

/**
 * The tabs' writes, one at a time, and the views they are asked against: the
 * latest catalogue, plus every view this window wrote that it has not read back.
 */
function useTabWrites({
  ports: { fs, markdown, editors },
  savedViews,
  viewPaths,
  vaultKey,
}: {
  ports: { fs: VaultFsPort; markdown: MarkdownPort; editors: OpenEditors };
  savedViews: readonly SavedViewSummary[];
  viewPaths: readonly string[];
  vaultKey: string | null;
}) {
  const unread = useRef(new Map<string, SavedViewSummary>());
  const latest = useRef({ savedViews, viewPaths });
  const tail = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    latest.current = { savedViews, viewPaths };
    unread.current = stillUnread(unread.current, savedViews);
  }, [savedViews, viewPaths]);
  // Another vault's writes say nothing about this one's views.
  useEffect(() => {
    unread.current = new Map();
  }, [vaultKey]);

  return useMemo(() => {
    const known = (current?: SavedViewSummary) => {
      const views = viewsAsShown({
        catalogue: latest.current.savedViews,
        current,
        unread: unread.current,
      });
      const takenPaths = takenViewPaths({ listed: latest.current.viewPaths, views });
      return { views, takenPaths };
    };
    /** The use-cases' ports, noting each view they write as unread until the catalogue has it. */
    const portsFor = (current?: SavedViewSummary): TypeViewPorts => ({
      fs: {
        ...fs,
        createNote: async (args) => {
          const modified = await fs.createNote(args);
          const { frontmatter } = splitFrontmatter(args.contents);
          const view = savedViewSummary(args.path, markdown.frontmatterProperties(frontmatter));
          if (view !== null) unread.current.set(view.path, view);
          return modified;
        },
      },
      markdown,
      writeProperties: async ({ path, values }) => {
        await writeNoteProperties({ editors, fs, markdown, path, values });
        const view = known(current).views.find((each) => each.path === path);
        if (view !== undefined) unread.current.set(path, withPropertiesWritten(view, values));
      },
    });
    /** Runs `write` once every write asked before it has settled. */
    const queue = <T>(write: () => Promise<T>): Promise<T> => {
      const next = tail.current.then(write);
      // Safe to ignore here: `next` itself is handed back, and its caller reports the failure.
      tail.current = next.catch(() => undefined);
      return next;
    };
    const forget = (path: string) => {
      unread.current.delete(path);
    };
    return { portsFor, known, queue, forget };
  }, [fs, markdown, editors]);
}
