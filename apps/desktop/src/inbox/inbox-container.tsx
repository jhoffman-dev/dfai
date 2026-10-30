import { useCallback, useEffect, type ComponentProps } from 'react';
import { createVaultPath, type VaultPath } from '@dfai/domain';
import { INBOX_CHOICES_SCOPE, INBOX_SCOPE, type WindowClosingPort } from '@dfai/application';
import { InboxPage } from '@dfai/ui';
import { useProposals } from '../proposals/use-proposals.ts';
import { useScopedIndexKey } from '../reads/use-scoped-index-key.ts';
import { localClock } from '../today.ts';
import type { PageContainerProps } from '../workspace/page-wiring.ts';
import type { PendingWrites } from '../workspace/pending-writes.ts';
import { useMakeRelated } from '../types/use-create-related.ts';
import type { MeetingsWaitingStore } from '../meetings/meetings-waiting-store.ts';
import { useMeetingsWaitingBanner } from '../meetings/use-meetings-waiting-banner.ts';
import type { SyncStore } from '../sync/sync-store.ts';
import { useInbox } from './use-inbox.ts';

type InboxPageProps = ComponentProps<typeof InboxPage>;

/**
 * What the Inbox page needs from the window beyond what every page is
 * handed: the offers the window makes on it (they are the window's, since a
 * dismissed offer stays dismissed whatever tab the Inbox is in), what it
 * says about the vault's settings and owner, the Inbox view it stands in
 * for, and the window's hold on the writes it makes in the background.
 */
export interface InboxWiring extends Pick<
  InboxPageProps,
  | 'typesOffer'
  | 'taskMigration'
  | 'paraMigration'
  | 'vaultTidy'
  | 'meetingCleanup'
  | 'meetingProjects'
  | 'settingsUnreadable'
  | 'ownerUnknown'
  | 'view'
> {
  /** The window's close, held until the clarifications and answers still being written are written. */
  readonly closing: WindowClosingPort;
  /** Where the page holds its writes for a vault switch and the window's close (#217, #166). */
  readonly pendingWrites: PendingWrites;
  /** What the meeting import says waits for the named Mac, on a Mac that is not named (ADR-0035). */
  readonly meetingsWaiting: MeetingsWaitingStore;
  /** Where sync says how it stands, and the claim "Process here" makes (ADR-0035 part 2). */
  readonly sync: SyncStore;
  /** Opens the line a proposal cites, in the focused pane. */
  readonly onOpenSource: (link: string) => void;
}

/**
 * The Inbox as a tab (tab-model.md, PR B): it lists what waits and answers
 * the proposals itself, so a row leaving or an answer landing draws this and
 * not the window. What is in flight — rows leaving, the serial queue, the
 * last undo — is the window's per vault (`pages.holds`), so a tab switched
 * back to, or the Inbox in both panes, sees the same. The sidebar's count is
 * the window's own read. Writes made in the background are held by the
 * window through `pendingWrites`, so a tab closed mid-write is still waited
 * for. Another vault opening starts the page afresh: `PanesContainer` is
 * keyed by the vault, which is what #130 (#283) keyed the page by.
 */
export function InboxContainer({ wiring, chrome }: PageContainerProps) {
  const { pages, pane } = wiring;
  // The offers are spread below, since each is given only while the window makes it.
  const { closing, pendingWrites, onOpenSource, meetingsWaiting, sync, ...offers } = pages.inbox;
  const waitingBanner = useMeetingsWaitingBanner({
    waiting: meetingsWaiting,
    sync,
    vaultKey: pane.vault,
  });
  // The list and the proposals are read again for news of the Inbox's notes
  // alone, the projects and people it offers for news of those (#325).
  const indexKey = useScopedIndexKey({
    status: pane.indexStatus,
    vault: pane.vault,
    reader: ['inbox'],
    scope: INBOX_SCOPE,
  });
  const choicesKey = useScopedIndexKey({
    status: pane.indexStatus,
    vault: pane.vault,
    reader: ['inbox-choices'],
    scope: INBOX_CHOICES_SCOPE,
  });
  const inbox = useInbox({
    ports: pages.ports,
    notePaths: pane.notePaths,
    vaultKey: pane.vault,
    types: pane.types,
    clock: localClock,
    indexKey,
    choicesKey,
    indexReady: pages.indexReady,
    open: true,
    onSettled: pages.onSettled,
    activity: pane.activity,
    closing,
    held: pages.holds.inbox,
    toasts: pane.toasts,
  });
  const proposals = useProposals({
    ports: pages.ports,
    clock: localClock,
    indexKey,
    onSettled: pages.onSettled,
    activity: pane.activity,
    closing,
    held: pages.holds.proposals,
    toasts: pane.toasts,
    onOpen: pages.openNote,
  });
  // "Create project '…'" in a project picker (#465): made where a new one of its
  // type goes, and filed under by path as any project picked is.
  const makeRelated = useMakeRelated({
    fs: pages.ports.fs,
    markdown: pages.ports.markdown,
    types: pane.types,
    notePaths: pane.notePaths,
    beside: null,
    onChanged: pane.onChanged,
  });
  const createFiling = useCallback(
    async (request: { target: string; name: string }): Promise<VaultPath> =>
      createVaultPath((await makeRelated(request)).path),
    [makeRelated],
  );
  const { written: inboxWritten } = inbox;
  const { written: answersWritten } = proposals;
  useEffect(() => pendingWrites.hold(inboxWritten), [pendingWrites, inboxWritten]);
  useEffect(() => pendingWrites.hold(answersWritten), [pendingWrites, answersWritten]);

  return (
    <InboxPage
      contents={inbox.contents}
      error={inbox.error}
      filing={inbox.filing}
      onCreateFiling={createFiling}
      people={inbox.people}
      statuses={inbox.statuses}
      onOpen={pages.openNote}
      onShowMore={inbox.showMore}
      onClarify={inbox.clarify}
      busy={inbox.busy}
      problem={inbox.problem}
      onUndo={inbox.undo}
      refusals={inbox.refusals}
      summaryPending={inbox.summaryPending}
      meetingsWaiting={waitingBanner}
      {...offers}
      proposals={{ ...proposals.section, onOpen: pages.openNote, onOpenSource }}
      {...chrome}
    />
  );
}
