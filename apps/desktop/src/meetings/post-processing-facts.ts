import { useStore } from 'zustand';
import {
  clockForRule,
  type createRulesTakeCache,
  postProcessingLedgerOf,
  postProcessingMark,
  stepUnavailable,
  type AutomationListing,
  type RuleQueryPorts,
  type RunClock,
} from '@dfai/application';
import {
  NO_POST_PROCESSING,
  type AutomationRule,
  type PostProcessingLedger,
  type VaultPath,
} from '@dfai/domain';
import type { AutomationsState, AutomationsStore } from '../automations/automations-store.ts';

/** A listing's post-processing ledger, worked out once per listing read and per day. */
const worked = new WeakMap<
  AutomationListing,
  { today: string; ledger: PostProcessingLedger; mark: string }
>();

/**
 * The ledger the runner's rules give, each rule's reach counted on the clock
 * the runner runs it on (`clockForRule`, the plan zone's for a rule that
 * keeps it), so the count and the rule never disagree by a day.
 */
function ledgerFor(state: AutomationsState, clock: RunClock) {
  const listing = state.automations?.listing ?? null;
  if (listing === null) return { ledger: NO_POST_PROCESSING, mark: '' };
  const todayOf = todayOfRules(state, clock);
  const today = listing.automations.map(({ rule }) => todayOf(rule)).join(',');
  const known = worked.get(listing);
  if (known?.today === today) return known;
  const ledger = postProcessingLedgerOf(listing.automations, todayOf);
  const made = { today, ledger, mark: postProcessingMark(ledger) };
  worked.set(listing, made);
  return made;
}

/** The day each rule's clock says: the plan zone's for a rule that keeps it, else the Mac's. */
function todayOfRules(state: AutomationsState, clock: RunClock) {
  const planZone = state.automations?.planZone ?? null;
  return (rule: AutomationRule) => clockForRule({ rule, clock, planZone }).today();
}

/**
 * Which of the meetings asked about the runner's rules that write summaries
 * take, by their own queries (#637 attack), asked of the index through
 * `take` — the cache that asks again only when the rules, their days, the
 * meetings or `generation` moved. Null while the index is not ready.
 */
export function rulesTakeFrom({
  store,
  clock,
  ports,
  indexReady,
  take,
}: {
  store: AutomationsStore;
  clock: RunClock;
  ports: RuleQueryPorts;
  indexReady: () => boolean;
  take: ReturnType<typeof createRulesTakeCache>;
}) {
  return async (asked: {
    readonly paths: readonly VaultPath[];
    readonly generation: number;
  }): Promise<PostProcessingLedger['taken'] | null> => {
    const state = store.getState();
    const listing = state.automations?.listing ?? null;
    if (!indexReady() || listing === null) return null;
    return take({
      ports,
      automations: listing.automations,
      todayOf: todayOfRules(state, clock),
      ...asked,
    });
  };
}

/**
 * What the rules that write summaries have finished with, as the
 * automations runner last read them (#182): read when a count is judged, so
 * nothing is drawn for it.
 */
export function readPostProcessing(store: AutomationsStore, clock: RunClock): PostProcessingLedger {
  return ledgerFor(store.getState(), clock).ledger;
}

/**
 * What a count of what waits is asked again for (#182): a mark of what the
 * rules that write summaries have finished with, and why this Mac's step
 * cannot reach Claude. Primitives, so the runner is drawn only when either changes.
 */
export function usePostProcessingNews(
  store: AutomationsStore,
  clock: RunClock,
): { readonly mark: string; readonly unavailable: string | null } {
  const mark = useStore(store, (state) => ledgerFor(state, clock).mark);
  const unavailable = useStore(store, (state) => {
    const automations = state.automations;
    if (automations === null || automations.listing === null) return null;
    return stepUnavailable(automations.listing.automations, automations.pauses);
  });
  return { mark, unavailable };
}
