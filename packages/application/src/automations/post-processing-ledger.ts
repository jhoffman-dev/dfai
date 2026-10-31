import {
  addDays,
  answeredMeetingOf,
  digestOf,
  meetingReachFrom,
  MEETING_DIGEST_OUTPUT,
  proposalSchemaNamed,
  SUMMARY_PENDING_DAYS,
  writesSummaries,
  type AutomationRule,
  type PostProcessingLedger,
  type VaultPath,
} from '@dfai/domain';
import type { LoadedAutomation } from './load-automations.ts';
import { matchedPaths, type RuleQueryPorts } from './plan-run.ts';

/**
 * What the vault's rules that write summaries have finished with (#182,
 * ADR-0036): the meetings their handled ledgers and the runs their logs still
 * hold have handled or answered, and the words they keep an answer for whose
 * writes are not done, and how far back the most reaching of them takes
 * meetings, each from its own `which` on the day its own clock says
 * (`todayOf`, as `clockForRule` reads it). Read from rules already loaded,
 * so it costs no read; whether one meeting is pending is the domain's
 * (`postProcessingPending`).
 */
export function postProcessingLedgerOf(
  automations: readonly LoadedAutomation[],
  todayOf: (rule: AutomationRule) => string,
): PostProcessingLedger {
  const summarising = automations.filter(({ rule }) => writesSummaries(rule));
  const answered = new Set<string>();
  const stored = new Set<string>();
  for (const { ledger, log } of summarising) {
    for (const path of ledger?.paths.keys() ?? []) answered.add(path);
    for (const { path } of ledger?.answered ?? []) answered.add(path);
    for (const { key } of ledger?.stored ?? []) stored.add(key);
    for (const entry of log) {
      if (entry.kind !== 'run') continue;
      for (const version of entry.versions ?? []) answered.add(version.path);
    }
  }
  const reaches = summarising.map(({ rule }) => meetingReachFrom(rule.which, todayOf(rule)));
  return {
    summarising: summarising.length > 0,
    // Nothing is pending with no rule that summarises, so no day is needed.
    from: reaches.length === 0 ? '' : reaches.reduce((a, b) => (a < b ? a : b)),
    answered,
    stored,
  };
}

/**
 * A short mark of what a post-processing ledger says, so a caller can tell a
 * changed one from the same one read again without comparing sets.
 */
export function postProcessingMark(ledger: PostProcessingLedger): string {
  return digestOf(
    [
      ledger.summarising ? 'on' : 'off',
      ledger.from,
      [...ledger.answered].sort().join('\u0000'),
      [...ledger.stored].sort().join('\u0000'),
    ].join('\u0001'),
  );
}

/**
 * The words a meeting is known by to the step that writes summaries
 * (`meeting:<provider>:<id>:transcript:<digest>`, `handledKeyOf`), which a
 * stored answer is kept under; null when the import vouches for no identity.
 */
export function postProcessingKeyOf({
  text,
  properties,
}: {
  text: string;
  properties: Readonly<Record<string, unknown>>;
}): string | null {
  const keyOf = proposalSchemaNamed(MEETING_DIGEST_OUTPUT)?.handledKeyOf ?? null;
  if (keyOf === null) return null;
  const meeting = answeredMeetingOf(properties);
  return keyOf({ text, ...(meeting !== undefined && { meeting }) });
}

/**
 * Why this Mac's step that writes summaries cannot reach Claude, from the
 * runner's pauses (#182): the first such rule held back for it, as its log
 * said it; null while none is.
 */
export function stepUnavailable(
  automations: readonly LoadedAutomation[],
  pauses: ReadonlyMap<string, { readonly unavailable?: string }>,
): string | null {
  for (const { rule } of automations) {
    if (!writesSummaries(rule)) continue;
    const unavailable = pauses.get(rule.id)?.unavailable;
    if (unavailable !== undefined) return unavailable;
  }
  return null;
}

/** What finding the meetings the rules take needs, besides the index and the vault's types. */
export interface RulesTakeArgs {
  readonly ports: RuleQueryPorts;
  readonly automations: readonly LoadedAutomation[];
  /** The day each rule's clock says (`clockForRule`): its moving dates are pinned to it. */
  readonly todayOf: (rule: AutomationRule) => string;
  /** The meetings to ask about: those that could be pending, whatever the rules take. */
  readonly paths: readonly VaultPath[];
}

/**
 * Which of `paths` the rules that write summaries take (#637 attack): each
 * rule's own query, its moving dates pinned to its day, asked of the index
 * among those meetings alone, as a run set off by them would ask it — with
 * the 14 days back from the earliest of their days. Null when the index
 * could not answer (not ready, or a query refused), so the caller judges by
 * what the `which` proves instead. One query a rule; none when no rule
 * writes summaries or no meeting is asked about.
 */
export async function meetingsTheRulesTake({
  ports,
  automations,
  todayOf,
  paths,
}: RulesTakeArgs): Promise<NonNullable<PostProcessingLedger['taken']> | null> {
  const rules = automations.filter(({ rule }) => writesSummaries(rule)).map(({ rule }) => rule);
  const days = rules.map((rule) => addDays(todayOf(rule), -SUMMARY_PENDING_DAYS) ?? todayOf(rule));
  const from = days.length === 0 ? '' : days.reduce((a, b) => (a < b ? a : b));
  if (rules.length === 0 || paths.length === 0) return { paths: new Set(), from };
  const taken = new Set<string>();
  try {
    for (const rule of rules) {
      const matched = await matchedPaths({ ports, rule, today: todayOf(rule), among: paths });
      for (const path of matched) taken.add(path);
    }
  } catch {
    // Safe to go without: the count then judges by what each rule's `which` proves on its own.
    return null;
  }
  return { paths: taken, from };
}

/**
 * {@link meetingsTheRulesTake}, asked again only when what it depends on
 * moved: the rules' texts and days, the meetings asked about, the ports it
 * is asked through (the types or the notes may have changed), and the
 * caller's `generation` — moved whenever a meeting file changed, since a
 * property the query reads may have.
 */
export function createRulesTakeCache() {
  let last: {
    key: string;
    ports: RuleQueryPorts;
    answer: NonNullable<PostProcessingLedger['taken']> | null;
  } | null = null;
  return async (
    args: RulesTakeArgs & { readonly generation: number },
  ): Promise<NonNullable<PostProcessingLedger['taken']> | null> => {
    const rules = args.automations
      .filter(({ rule }) => writesSummaries(rule))
      .map(({ rule }) => `${rule.id}\u0000${rule.which}\u0000${args.todayOf(rule)}`);
    const key = [args.generation, ...rules, '', ...args.paths].join('\u0001');
    if (last?.key === key && last.ports === args.ports) return last.answer;
    const answer = await meetingsTheRulesTake(args);
    // An answer the index could not give is asked again next time.
    if (answer !== null) last = { key, ports: args.ports, answer };
    return answer;
  };
}
