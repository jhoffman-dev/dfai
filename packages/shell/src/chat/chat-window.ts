import type { ChatWindow } from '@dfai/application';
import type { VaultPath } from '@dfai/domain';

/**
 * What the chat is opened on: the query being written, the note, view or
 * dashboard the focused tab shows — or nothing, when that tab is on a page
 * that is neither, such as the graph (tab-model.md: a page is a tab, so the
 * focused tab says it all).
 */
export function chatWindowOf({
  query,
  focused,
}: {
  /** The query page's text while a query tab is shown, else null. */
  query: string | null;
  /** The note the focused tab shows, or null while it shows a page or nothing. */
  focused: VaultPath | null;
}): ChatWindow {
  if (query !== null) return { kind: 'query', text: query };
  if (focused === null) return { kind: 'none' };
  return { kind: 'path', path: focused };
}
