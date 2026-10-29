import {
  addDays,
  answeredMeetingOf,
  digestOf,
  MEETING_DIGEST_OUTPUT,
  proposalSchemaNamed,
  SUMMARY_PENDING_DAYS,
  writesSummaries,
  type PostProcessingLedger,
} from '@dfai/domain';
import type { LoadedAutomation } from './load-automations.ts';

/**
 * What the vault's rules that write summaries have finished with (#182,
 * ADR-0036): the meetings their handled ledgers and the runs their logs still
 * hold have handled or answered, and the words they keep an answer for whose
 * writes are not done. Read from rules already loaded, so it costs no read;
 * whether one meeting is pending is the domain's (`postProcessingPending`).
 */
export function postProcessingLedgerOf(
  automations: readonly LoadedAutomation[],
  today: string,
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
  return {
    summarising: summarising.length > 0,
    from: addDays(today, -SUMMARY_PENDING_DAYS) ?? today,
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
