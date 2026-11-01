import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  buildTagTree,
  findTagNode,
  tagKey,
  tagNameFromInput,
  tagRenameProblem,
  type TagCount,
  type TagSort,
} from '@dfai/domain';
import {
  loadTaggedNotes,
  type IndexPort,
  type LinkUpdatePanes,
  type MarkdownPort,
  type TagRenameReport,
  type VaultFsPort,
  type VaultTagRenames,
} from '@dfai/application';
import type { TaggedNotesState, TagRenameState } from '@dfai/ui';

const IDLE: TagRenameState = { kind: 'idle' };
const LOADING: TaggedNotesState = { kind: 'loading' };

export interface TagsPagePorts {
  readonly index: IndexPort;
  readonly fs: VaultFsPort;
  readonly markdown: MarkdownPort;
  readonly editors: LinkUpdatePanes;
  /** The vault's rename queue, shared with the local API. */
  readonly renames: VaultTagRenames;
}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What renaming did, in a sentence: how many notes, and which could not be changed. */
function reportText({ updated, failed }: TagRenameReport): string {
  const done = `Renamed in ${count(updated.length, 'note', 'notes')}.`;
  if (failed.length === 0) return done;
  const left = failed.map(({ path, reason }) => `${path} (${reason})`).join(', ');
  return `${done} ${count(failed.length, 'note', 'notes')} could not be changed: ${left}.`;
}

/**
 * The notes using the chosen tag, read again whenever the index changes. Kept
 * with the tag they were read for, so another tag's list is never shown as
 * this one's while it loads.
 */
function useTaggedNotes(index: IndexPort, key: string | null, indexKey: string) {
  const [read, setRead] = useState<{ key: string; notes: TaggedNotesState } | null>(null);
  useEffect(() => {
    if (key === null) return;
    let cancelled = false;
    const settle = (notes: TaggedNotesState) => {
      if (!cancelled) setRead({ key, notes });
    };
    loadTaggedNotes({ index, key })
      .then((found) => settle({ kind: 'ready', notes: found }))
      .catch((cause: unknown) => settle({ kind: 'failed', message: message(cause) }));
    return () => {
      cancelled = true;
    };
  }, [index, key, indexKey]);
  return read !== null && read.key === key ? read.notes : LOADING;
}

/**
 * The tags page: the vault's tags as a tree, sorted as asked, the notes using
 * the chosen one, and renaming it — previewed first, then written note by
 * note. A tag nothing uses any more is not in the index, so it leaves the
 * tree on its own once the index catches up.
 */
export function useTagsPage({
  ports,
  counts,
  selected,
  indexKey,
  onChanged,
  onSelect,
}: {
  ports: TagsPagePorts;
  counts: readonly TagCount[];
  /** The chosen tag's key, or null. */
  selected: string | null;
  indexKey: string;
  /** Re-reads the index after the rename wrote notes. */
  onChanged: () => void;
  onSelect: (key: string | null) => void;
}) {
  const [sort, setSort] = useState<TagSort>('name');
  // Kept with the tag it is for: choosing another tag leaves a rename behind.
  const [renaming, setRenaming] = useState<{ key: string | null; state: TagRenameState }>({
    key: null,
    state: IDLE,
  });
  const [notice, setNotice] = useState<string | null>(null);
  const tree = useMemo(() => buildTagTree(counts, sort), [counts, sort]);
  const node = selected === null ? null : findTagNode(tree, selected);
  const notes = useTaggedNotes(ports.index, selected, indexKey);
  const rename = renaming.key === selected ? renaming.state : IDLE;
  const setRename = useCallback(
    (state: TagRenameState) => setRenaming({ key: selected, state }),
    [selected],
  );

  const preview = useCallback(
    (typed: string) => {
      if (node === null) return;
      setNotice(null);
      const to = tagNameFromInput(typed);
      const problem = tagRenameProblem({ from: node.name, to });
      if (problem !== null) {
        setRename({ kind: 'refused', message: problem });
        return;
      }
      setRename({ kind: 'checking' });
      ports.renames
        .plan({ ...ports, rename: { from: node.name, to } })
        .then((plan) => setRename({ kind: 'planned', plan }))
        .catch((cause: unknown) => setRename({ kind: 'refused', message: message(cause) }));
    },
    [node, ports, setRename],
  );

  const confirm = useCallback(() => {
    if (rename.kind !== 'planned') return;
    const { plan } = rename;
    setRename({ kind: 'renaming', plan });
    // Merging was agreed when the preview said it merges and the button said so.
    const merge = plan.mergesInto !== null;
    ports.renames
      .rename({ ...ports, openNotes: ports.editors, plan, merge })
      .then((report) => {
        onChanged();
        setRename(IDLE);
        setNotice(reportText(report));
        onSelect(tagKey(plan.rename.to));
      })
      .catch((cause: unknown) => setRename({ kind: 'refused', message: message(cause) }));
  }, [rename, ports, onChanged, onSelect, setRename]);

  const cancel = useCallback(() => setRename(IDLE), [setRename]);

  return { tree, sort, setSort, node, notes, rename, notice, preview, confirm, cancel };
}
