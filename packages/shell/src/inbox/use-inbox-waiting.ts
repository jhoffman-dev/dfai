import { useQuery } from '@tanstack/react-query';
import { tasksStartInInbox, type ObjectType } from '@dfai/domain';
import {
  countInboxWaiting,
  type IndexPort,
  type MarkdownPort,
  type VaultFsPort,
} from '@dfai/application';
import { vaultReadKey } from '../reads/query-client.ts';

/**
 * How many things the Inbox's sidebar row counts — the notes waiting to be
 * filed and the proposals still open — read once for the window and kept
 * until the index has news or a proposal lands (#259), whatever page is
 * open. The Inbox page reads its own list in its tab (tab-model.md, PR B);
 * this is what the sidebar shows while it does not. Null until known.
 */
export function useInboxWaiting({
  index,
  fs,
  markdown,
  vaultKey,
  indexReady,
  types,
}: {
  index: Pick<IndexPort, 'query'>;
  fs: VaultFsPort;
  markdown: MarkdownPort;
  vaultKey: string | null;
  indexReady: boolean;
  /** The vault's types: whether a task with no status starts in the Inbox is the Task type's to say. */
  types: readonly ObjectType[];
}): number | null {
  const startInInbox = tasksStartInInbox(types);
  const { data } = useQuery({
    // The Task type's say is in the key, so a type defined anew counts afresh.
    queryKey: [...vaultReadKey(vaultKey ?? '', 'inbox-waiting'), startInInbox],
    queryFn: () => countInboxWaiting({ index, fs, markdown, tasksStartInInbox: startInInbox }),
    enabled: indexReady && vaultKey !== null,
  });
  return data ?? null;
}
