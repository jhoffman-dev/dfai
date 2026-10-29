import { useStore } from 'zustand';
import {
  postProcessingLedgerOf,
  postProcessingMark,
  stepUnavailable,
  type AutomationListing,
  type Clock,
} from '@dfai/application';
import { NO_POST_PROCESSING, type PostProcessingLedger } from '@dfai/domain';
import type { AutomationsStore } from '../automations/automations-store.ts';

/** A listing's post-processing ledger, worked out once per listing read and per day. */
const worked = new WeakMap<
  AutomationListing,
  { today: string; ledger: PostProcessingLedger; mark: string }
>();

function ledgerFor(listing: AutomationListing | null, today: string) {
  if (listing === null) return { ledger: NO_POST_PROCESSING, mark: '' };
  const known = worked.get(listing);
  if (known?.today === today) return known;
  const ledger = postProcessingLedgerOf(listing.automations, today);
  const made = { today, ledger, mark: postProcessingMark(ledger) };
  worked.set(listing, made);
  return made;
}

/**
 * What the rules that write summaries have finished with, as the
 * automations runner last read them (#182): read when a count is judged, so
 * nothing is drawn for it.
 */
export function readPostProcessing(
  store: AutomationsStore,
  clock: Pick<Clock, 'today'>,
): PostProcessingLedger {
  return ledgerFor(store.getState().automations?.listing ?? null, clock.today()).ledger;
}

/**
 * What a count of what waits is asked again for (#182): a mark of what the
 * rules that write summaries have finished with, and why this Mac's step
 * cannot reach Claude. Primitives, so the runner is drawn only when either changes.
 */
export function usePostProcessingNews(
  store: AutomationsStore,
  clock: Pick<Clock, 'today'>,
): { readonly mark: string; readonly unavailable: string | null } {
  const mark = useStore(
    store,
    (state) => ledgerFor(state.automations?.listing ?? null, clock.today()).mark,
  );
  const unavailable = useStore(store, (state) => {
    const automations = state.automations;
    if (automations === null || automations.listing === null) return null;
    return stepUnavailable(automations.listing.automations, automations.pauses);
  });
  return { mark, unavailable };
}
