import { createStore, type StoreApi } from 'zustand';
import type { TabId } from '@dfai/domain';

/** The query being written in each tab that shows the query page. */
interface QueryTextState {
  readonly byTab: Readonly<Record<TabId, string>>;
}

/**
 * What each query tab is writing, as the chat reads it for the window it
 * opens on (`chatWindowOf`): the focused tab's, and only while that tab is
 * on the query page. The page is a tab now (tab-model.md, PR B) and owns its
 * own hooks, so it says here what is typed; the app subscribes only while
 * the chat is open, as it does for the focused note.
 */
export type QueryTextStore = StoreApi<QueryTextState>;

export function createQueryTextStore(): QueryTextStore {
  return createStore<QueryTextState>()(() => ({ byTab: {} }));
}

/** Says what `tabId` is writing; null once the tab no longer shows the query page. */
export function setQueryText(store: QueryTextStore, tabId: TabId, text: string | null): void {
  const { byTab } = store.getState();
  if ((byTab[tabId] ?? null) === text) return;
  const next = { ...byTab };
  if (text === null) delete next[tabId];
  else next[tabId] = text;
  store.setState({ byTab: next });
}

/** What `tabId` is writing, or null while it shows no query page: read at the moment it is needed. */
export function queryTextOf(store: QueryTextStore, tabId: TabId): string | null {
  return store.getState().byTab[tabId] ?? null;
}
