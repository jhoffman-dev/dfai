import { createInboxWrites, type InboxWrites } from '../inbox/inbox-writes.ts';
import { createProposalWrites, type ProposalWrites } from '../proposals/proposal-writes.ts';
import { createTodayWrites, type TodayWrites } from '../today/today-writes.ts';

/**
 * What the pages hold in flight for one vault, kept by the window rather than
 * by the tabs (tab-model.md, PR B): a page's container reads these by
 * selector, so a tab switched back to, or the same page in both panes, sees
 * the same rows leaving, the same task settling and the same serial queue.
 */
export interface PageHolds {
  readonly inbox: InboxWrites;
  readonly proposals: ProposalWrites;
  readonly today: TodayWrites;
}

/** The holds of each vault the window has opened, made as a vault is first opened and kept for it. */
export interface PageHoldsByVault {
  readonly of: (vaultKey: string) => PageHolds;
}

export function createPageHoldsByVault(): PageHoldsByVault {
  const byVault = new Map<string, PageHolds>();
  return {
    of(vaultKey) {
      const known = byVault.get(vaultKey);
      if (known !== undefined) return known;
      const made: PageHolds = {
        inbox: createInboxWrites(),
        proposals: createProposalWrites(),
        today: createTodayWrites(),
      };
      byVault.set(vaultKey, made);
      return made;
    },
  };
}
