import { ruleHeldByPlatform, type EntryPointsOffered } from '@dfai/application';
import type { AutomationDraft } from '@dfai/domain';

/**
 * Whether the clock and a note may set off this vault's rules on this Mac:
 * the Mac named for its automations (U-29), and only once that is known, and
 * once the owner's name and addresses are read (#173) — a Claude step
 * decides whose a meeting's tasks are by them, so a run on a stand-in would
 * make the owner's tasks someone else's. Null while either is not known:
 * nothing runs, and what a note sets off is held until it is.
 */
export function automationsScheduled({
  automationsHere,
  macKnown,
  ownerKnown,
}: {
  /** Whether this Mac is the one named for the vault's automations. */
  automationsHere: boolean;
  /** Whether this Mac and the vault's sync settings are known yet. */
  macKnown: boolean;
  /** Whether the vault's settings have answered for the owner's name and addresses. */
  ownerKnown: boolean;
}): boolean | null {
  return macKnown && ownerKnown ? automationsHere : null;
}

/**
 * Whether the clock and a note may set off rules, the person's switch taken
 * in (#901): as `scheduled` while Automations is on; false once the vault's
 * settings say it is off, as on a Mac that does not run them, so what a note
 * set off is let go; and null while those settings are unread, so it is held
 * rather than let go for a vault that leaves Automations on.
 */
export function switchedScheduled({
  enabled,
  featuresKnown,
  scheduled,
}: {
  /** Whether Automations is on, held off while the settings are unread. */
  enabled: boolean;
  /** Whether the vault's settings have answered. */
  featuresKnown: boolean;
  /** Whether this Mac runs the rules, Automations aside (`automationsScheduled`). */
  scheduled: boolean | null;
}): boolean | null {
  if (enabled) return scheduled;
  return featuresKnown ? false : null;
}

/** What a rule does as its turn comes: runs, is held saying why, or is let go unrun. */
export type Turn =
  | { readonly kind: 'run' }
  | { readonly kind: 'hold'; readonly reason: string }
  | { readonly kind: 'skip' };

/**
 * What a rule does as its turn comes (#920). One the clock or a note set off
 * whose turn comes after this Mac stopped running the rules — Automations
 * switched off, or the vault's automations named elsewhere — neither runs nor
 * is held: a hold would outlive the switch, under a reason that is not so.
 * Otherwise a rule the platform cannot carry out is held (#657), judged on the
 * platform's own `offered`, which no switch changes; by hand, too.
 */
export function turnOf({
  rule,
  platform,
  runsHere,
  byHand,
}: {
  rule: Pick<AutomationDraft, 'action'>;
  /** What the platform offers with every feature on. */
  platform: EntryPointsOffered;
  /** Whether this Mac runs the vault's rules by themselves just now. */
  runsHere: boolean;
  /** Whether the person asked for this run (Run now). */
  byHand: boolean;
}): Turn {
  if (!byHand && !runsHere) return { kind: 'skip' };
  const reason = ruleHeldByPlatform(rule, platform);
  return reason === null ? { kind: 'run' } : { kind: 'hold', reason };
}
