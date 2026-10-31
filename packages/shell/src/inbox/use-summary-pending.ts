import { useEffect, useMemo, useState } from 'react';
import { createVaultPath, type InboxItem, type VaultPath } from '@dfai/domain';
import { readMeetingSummaryStates, type ArchivePorts, type Clock } from '@dfai/application';

const NONE: ReadonlyMap<string, string> = new Map();

/**
 * Why each imported meeting the Inbox lists still waits for its summary
 * (#186): the meetings whose summary is pending, by path, each with the
 * words the rule's last failure gave, or that it has yet to run. Read only
 * while the page shows, again whenever the rows or the index change; what
 * it reads is the use-case's, and it writes nothing.
 */
export function useSummaryPending({
  ports,
  notePaths,
  vaultKey,
  items,
  open,
  clock,
  indexKey,
}: {
  ports: Pick<ArchivePorts, 'fs' | 'markdown'>;
  notePaths: readonly VaultPath[];
  vaultKey: string | null;
  items: readonly InboxItem[] | null;
  open: boolean;
  clock: Pick<Clock, 'today'>;
  indexKey: string;
}): ReadonlyMap<string, string> {
  const [read, setRead] = useState<{
    vaultKey: string | null;
    pending: ReadonlyMap<string, string>;
  }>({ vaultKey: null, pending: NONE });
  // One key for the same meetings, so a re-render with the same rows reads nothing again.
  const asked = useMemo(
    () =>
      (items ?? [])
        .filter((item) => item.importOutcome === 'imported')
        .map(({ path }) => path)
        .join('\n'),
    [items],
  );

  useEffect(() => {
    if (!open || asked === '') return;
    let cancelled = false;
    readMeetingSummaryStates({
      fs: ports.fs,
      markdown: ports.markdown,
      notePaths,
      paths: asked.split('\n').map(createVaultPath),
      today: clock.today(),
    })
      .then(({ states, pendingWhy }) => {
        if (cancelled) return;
        const pending = new Map(
          [...states].flatMap(([path, state]) => (state === 'pending' ? [[path, pendingWhy]] : [])),
        );
        setRead({ vaultKey, pending });
      })
      .catch(() => {
        // Safe to go without: a row then shows no summary state, and the next read tries again.
        if (!cancelled) setRead({ vaultKey, pending: NONE });
      });
    return () => {
      cancelled = true;
    };
    // The index key is in so a meeting written since — its summary, say — is read again.
  }, [asked, open, vaultKey, indexKey, ports, notePaths, clock]);

  return read.vaultKey === vaultKey && open ? read.pending : NONE;
}
