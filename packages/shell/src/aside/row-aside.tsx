import { useEffect, useMemo, useRef, useState } from 'react';
import { noteTitle, pageTitle, type TabId, type VaultPath } from '@dfai/domain';
import {
  openNote,
  TaskRuleRefusedError,
  type OpenNote,
  type PropertyChanges,
} from '@dfai/application';
import { PropertiesPane, type OpenHow } from '@dfai/ui';
import { withGiveUpRecorded } from '../activity/with-give-up-recorded.ts';
import type { PaneContext } from '../panes/note-pane-container.tsx';
import { writeNoteProperties } from '../query/use-view-writes.ts';
import { useScopedIndexKey } from '../reads/use-scoped-index-key.ts';
import { useNoteProperties } from '../types/use-note-properties.ts';
import { clearRow, type AsideStore } from './aside-store.ts';

/** What a focused row's note is read and written with, and how it is opened. */
export interface RowPorts {
  /** The panes' shared context: the ports, the types, and the index's news. */
  readonly pane: PaneContext;
  readonly openNote: (path: VaultPath, how?: OpenHow) => void;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The aside's Properties for a table's focused row: the note read by its
 * path — not the table's values, which are only the view's columns — and
 * written as a cell edit is, through the pane holding the note when one
 * does. Read again as the index has news, which is how a write of its own
 * comes back. The table is not drawn for any of it: it told the row's path
 * once, through its steady look. Mounted afresh per row (keyed by path), so
 * a newly focused row never shows the last one's values under its title.
 */
export function RowAside({
  path,
  tab,
  ports,
  aside,
}: {
  path: VaultPath;
  /** The tab whose table focused the row: let go of once the note is gone. */
  tab: TabId;
  ports: RowPorts;
  aside: AsideStore;
}) {
  const { pane, openNote: open } = ports;
  const note = useRowNote({ path, tab, pane, aside });
  const writes = useRowWrites({ path, pane });
  const { notes, types, index, notePaths } = pane;
  // Steady, as the pane's own is: the hook reads the links again when it changes.
  const links = useMemo(
    () => ({ fs: notes.fs, markdown: notes.markdown, notePaths }),
    [notes.fs, notes.markdown, notePaths],
  );
  const properties = useNoteProperties({ note, types, index, links });
  if (note === null) return <p className="aside__empty">Reading…</p>;
  const title = pageTitle({ fileTitle: noteTitle(path), properties: note.properties }).text;
  return (
    <>
      {writes.refused !== null && (
        <p className="aside__empty" role="alert">
          Not saved: {writes.refused}
        </p>
      )}
      <PropertiesPane
        context={`${properties.typeLabel ?? 'Note'} · selected row`}
        title={title}
        path={path}
        typeName={properties.typeName}
        typeLabel={properties.typeLabel}
        rows={properties.rows}
        relationChoices={properties.relationChoices}
        relationTargets={properties.relationTargets}
        fileKeys={properties.keys}
        onChange={writes.change}
        onOpenNote={(target) => open(target)}
        onOpen={() => open(path)}
        onOpenInNewTab={() => open(path, 'new-tab')}
      />
    </>
  );
}

/**
 * The row's note, read afresh as the index's news touches that note (#325:
 * scoped to its path, not to a note saved anywhere); null until read. A note
 * that cannot be read — gone from under its row — lets the row go, so the
 * aside falls back to the page rather than reading forever.
 */
function useRowNote({
  path,
  tab,
  pane,
  aside,
}: {
  path: VaultPath;
  tab: TabId;
  pane: PaneContext;
  aside: AsideStore;
}): OpenNote | null {
  const { notes } = pane;
  const indexKey = useScopedIndexKey({
    status: pane.indexStatus,
    vault: pane.vault,
    reader: ['aside-row', path],
    scope: useMemo(() => ({ notes: [path] }), [path]),
  });
  const [note, setNote] = useState<OpenNote | null>(null);
  useEffect(() => {
    let current = true;
    openNote({ fs: notes.fs, markdown: notes.markdown, path })
      .then((read) => {
        if (current) setNote(read);
      })
      .catch(() => {
        // Safe to ignore the cause: the only answer to a note that is gone is
        // to stop following it, and the table drops the row as the index catches up.
        if (current) clearRow(aside, tab);
      });
    return () => {
      current = false;
    };
  }, [notes, path, indexKey, aside, tab]);
  return note;
}

/**
 * The row's writes, one at a time and coalesced: a property typed key by key
 * would otherwise be a write per key, all racing one read of the file, and
 * every write after the first refused by the file's stamp. Each write takes
 * whatever has been typed since the last one landed. A write the file
 * refuses is said beside the rows, never dropped.
 */
function useRowWrites({ path, pane }: { path: VaultPath; pane: PaneContext }) {
  const [refused, setRefused] = useState<string | null>(null);
  const held = useRef({ queue: Promise.resolve(), pending: new Map<string, unknown>() });
  const { notes, editors, activity, onChanged } = pane;
  const change = (key: string, value: unknown) => {
    held.current.pending.set(key, value);
    const flush = async () => {
      const values = Object.fromEntries(held.current.pending) as PropertyChanges;
      held.current.pending = new Map();
      if (Object.keys(values).length === 0) return;
      const write = { activity, write: 'edit', path, refusal: TaskRuleRefusedError } as const;
      try {
        await withGiveUpRecorded(write, () =>
          writeNoteProperties({ editors, fs: notes.fs, markdown: notes.markdown, path, values }),
        );
        setRefused(null);
        onChanged();
      } catch (cause) {
        setRefused(message(cause));
      }
    };
    // The queue only has to know the last write is over; its outcome is `refused`.
    held.current.queue = held.current.queue.then(flush, flush);
  };
  return { change, refused };
}
