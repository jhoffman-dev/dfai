import { useEffect } from 'react';
import { createVaultPath } from '@dfai/domain';
import { QUERY_SCOPE } from '@dfai/application';
import { hideOverlay, showOverlay, useWindowOverlay } from '../overlay-store.ts';
import { LoadedLater } from '../page-frame-fallback.tsx';
import { queryScreen } from '../pages-on-first-use.ts';
import type { PageContainerProps } from '../workspace/page-wiring.ts';
import { useScopedIndexKey } from '../reads/use-scoped-index-key.ts';
import { setQueryText, type QueryTextStore } from './query-text-store.ts';
import { useQueryPage } from './use-query-page.ts';

const QueryScreen = queryScreen.Component;

/** What the query page needs from the window beyond what every page is handed. */
export interface QueryWiring {
  /** Where the page says what is being written, for the chat's window. */
  readonly text: QueryTextStore;
}

/**
 * The query page as a tab (ADR-0019, tab-model.md PR B): it builds and runs
 * the query itself, so typing draws this and not the window. What is typed
 * is told to the window's query-text store under this tab, which the chat
 * reads for the focused tab while it is open; a closed tab says nothing.
 */
export function QueryContainer({ wiring, tabId, chrome }: PageContainerProps) {
  const { pages, pane, overlays } = wiring;
  // A query of the whole vault: any note's news reads it again (#327).
  const indexKey = useScopedIndexKey({
    status: pane.indexStatus,
    vault: pane.vault,
    reader: ['query'],
    scope: QUERY_SCOPE,
  });
  const query = useQueryPage({
    ports: {
      index: pane.index,
      fs: pages.ports.fs,
      markdown: pane.notes.markdown,
      editors: pane.editors,
      activity: pane.activity,
    },
    open: true,
    indexKey,
    viewPaths: pane.viewPaths,
    dashboards: pane.dashboards,
    onSavedView: pages.openNote,
    onChanged: pane.onChanged,
    types: pane.types,
    notePaths: pane.notePaths,
    onOpenNote: (path) => pages.openNote(createVaultPath(path)),
  });
  const { text } = pages.query;
  const written = query.language === 'atlas' ? query.atlas.composer.text : '';
  useEffect(() => setQueryText(text, tabId, written), [text, tabId, written]);
  useEffect(() => () => setQueryText(text, tabId, null), [text, tabId]);
  const overlay = useWindowOverlay(overlays);
  return (
    <LoadedLater chrome={chrome}>
      <QueryScreen
        query={query}
        onOpenNote={pages.openNote}
        popups={(name) => ({
          open: overlay === `query-${name}`,
          onOpenChange: (open) =>
            open ? showOverlay(overlays, `query-${name}`) : hideOverlay(overlays, `query-${name}`),
        })}
        {...chrome}
      />
    </LoadedLater>
  );
}
