/**
 * "Process here" (ADR-0035 part 2, #176): a person's click names this Mac
 * as the one that runs the vault's automations. It is the existing claim, a
 * write of `automationsMac` (this Mac's id) and `automationsMacName` to the
 * settings note, which the other Mac reads on its next sync and stands down.
 *
 * The button is refused while this Mac's sync could not share the claim, or
 * has not shown what the other Mac last said: sync paused here, failing, or
 * no pull completed since the app launched or the Mac last woke. Otherwise
 * a Mac that cannot push names itself in settings it cannot share, and both
 * Macs believe they are named.
 *
 * Two Macs that claim within one sync interval both change the same key,
 * which the settings merge (#233) never merges, so it is settled as every
 * settings conflict is (ADR-0025): the Mac whose sync merges keeps its own
 * copy and pushes it, and the other, on its next pull, fast-forwards to it
 * and stands down. The Mac that syncs second wins; there is always exactly
 * one. Documented, not prevented (ADR-0035).
 */

import type { ActivityReport } from '../activity/activity-event.ts';
import { pulledSinceLastSleep, type PullStanding } from './pull-freshness.ts';
import type { SyncPhase } from './sync-state.ts';
import { AUTOMATIONS_MAC_KEY, AUTOMATIONS_MAC_NAME_KEY, automationsMacOf } from './sync-rules.ts';

/** Why this Mac may not claim the automations now. */
export type ClaimRefusal =
  /** Sync is paused here: the claim could not be pushed. */
  | 'paused'
  /** The last sync or look at GitHub failed: the claim may not be pushed. */
  | 'failing'
  /** No pull has completed since the app launched or the Mac last woke: the other Mac's last word is not known. */
  | 'no-pull'
  /** A pull is under way: what it brings is judged once it completes. */
  | 'pulling'
  /** The settings the last pull left cannot be read. */
  | 'settings-unreadable'
  /** The vault does not sync: every Mac it is open on runs the automations. */
  | 'not-synced'
  /** This Mac's id, which the claim writes, has not been read yet. */
  | 'mac-unknown';

/** This Mac, as the claim names it: by the id it keeps for itself, with its name to show. */
export interface ClaimingMac {
  readonly id: string;
  readonly name: string;
}

/**
 * Whether this Mac may claim the automations now (ADR-0035 part 2), judged
 * on the same facts as the gates of part 4: the last pull, the sleep counter
 * read now, the pause, and how the last sync or look ended.
 */
export function claimRefusal({
  standing,
  asleepNowMs,
  paused,
  phase,
}: {
  standing: PullStanding | null;
  /** The host's time asleep since boot, read now; null when it could not be read. */
  asleepNowMs: number | null;
  /** Whether sync is paused on this Mac for the vault. */
  paused: boolean;
  /** How this Mac's sync of the vault last stood. */
  phase: SyncPhase;
}): ClaimRefusal | null {
  if (standing?.kind === 'not-synced') return 'not-synced';
  if (paused) return 'paused';
  if (syncFailing(phase)) return 'failing';
  if (standing?.kind === 'settings-unreadable') return 'settings-unreadable';
  if (standing?.kind === 'pulling') return 'pulling';
  if (standing?.kind !== 'pulled' || !pulledSinceLastSleep({ standing, asleepNowMs })) {
    return 'no-pull';
  }
  return null;
}

/** Whether this Mac's last sync or look at GitHub of the vault failed: a claim then may not be pushed. */
export function syncFailing(phase: SyncPhase): boolean {
  return phase.kind === 'failed';
}

/** What the banner says beside a refused "Process here": which of the reasons holds. */
export function claimRefusalLine(why: ClaimRefusal): string {
  switch (why) {
    case 'paused':
      return 'Sync is paused on this Mac: resume it to process meetings here.';
    case 'failing':
      return 'Sync is failing on this Mac: meetings can be processed here once it syncs.';
    case 'no-pull':
    case 'pulling':
      return 'Meetings can be processed here after the next sync.';
    case 'settings-unreadable':
      return 'The vault’s settings cannot be read, so this Mac cannot be named.';
    case 'not-synced':
      return 'This vault does not sync: the automations already run on this Mac.';
    case 'mac-unknown':
      return 'This Mac’s id has not been read yet, so it cannot be named. Try again in a moment.';
  }
}

/** How a claim ended. */
export type ClaimOutcome =
  /**
   * The settings here now name this Mac; the other Mac hears of it once a
   * sync pushes them. `was` is the name kept for the Mac named before.
   */
  | { readonly kind: 'claimed'; readonly was: string | null }
  /** They already named this Mac, by its id: nothing was written. */
  | { readonly kind: 'already-named' }
  /** Refused before anything was written. */
  | { readonly kind: 'refused'; readonly why: ClaimRefusal }
  /** The settings note could not be read: nothing was written. */
  | { readonly kind: 'unreadable' }
  /** Another vault opened before it was written: nothing was. */
  | { readonly kind: 'vault-closed' }
  /** The write was refused; the settings are as they were. */
  | { readonly kind: 'write-failed'; readonly reason: string };

/** Whether the settings already name this Mac: by id, so a Mac renamed since is still the one named. */
export function namesThisMac(automationsMac: unknown, mac: Pick<ClaimingMac, 'id'>): boolean {
  return automationsMacOf(automationsMac) === mac.id.trim();
}

/** The settings keys the claim writes: this Mac's id, which decides, and its name, to show. */
export function claimedSettings(mac: ClaimingMac): Record<string, string> {
  return { [AUTOMATIONS_MAC_KEY]: mac.id.trim(), [AUTOMATIONS_MAC_NAME_KEY]: mac.name };
}

/** What the banner says after a claim that did not name this Mac; null when there is nothing to say. */
export function claimProblem(outcome: ClaimOutcome): string | null {
  switch (outcome.kind) {
    case 'claimed':
    case 'already-named':
    case 'vault-closed':
      return null;
    case 'refused':
      return claimRefusalLine(outcome.why);
    case 'unreadable':
      return 'The vault’s settings cannot be read, so nothing was changed.';
    case 'write-failed':
      return `This Mac could not be named in the vault’s settings: ${outcome.reason}`;
  }
}

/**
 * What the banner and Activity say from the claim until a sync has pushed it
 * (#630 review): until then the other Mac still believes it is named.
 */
export function claimUnsharedLine(was: string | null): string {
  const other = was?.trim() ? was.trim() : 'the other Mac';
  return `Process here is set on this Mac but not yet shared with ${other}.`;
}

/** Activity's line for a claim, set here but not yet shared, or one whose write failed; null for the rest. */
export function claimReport(outcome: ClaimOutcome): ActivityReport | null {
  if (outcome.kind === 'claimed') {
    return { level: 'info', kind: 'sync', message: claimUnsharedLine(outcome.was), subject: null };
  }
  if (outcome.kind !== 'write-failed') return null;
  return { level: 'warning', kind: 'sync', message: claimProblem(outcome) ?? '', subject: null };
}

/** Activity's line once a sync has pushed the claim: from then on this Mac runs the automations. */
export function claimSharedReport(mac: ClaimingMac): ActivityReport {
  return {
    level: 'info',
    kind: 'sync',
    message: `${mac.name} now runs the automations: meetings that waited are processed here.`,
    subject: null,
  };
}

/**
 * Whether this Mac's claim is written here and not on GitHub (#630 attack):
 * the settings here name this Mac, by id, and those the last fetch brought
 * from GitHub do not. Until GitHub has it the other Mac still believes it is
 * named. Judged from git, so it holds across a restart and a vault switch;
 * GitHub's settings not read (`undefined`) never count as naming this Mac.
 */
export function claimUnsharedOf({
  here,
  onGitHub,
  thisMacId,
}: {
  /** The Mac the settings here name, by id. */
  here: string | null;
  /** The Mac GitHub's settings name, as the last fetch left them; undefined when not read. */
  onGitHub: string | null | undefined;
  thisMacId: string;
}): boolean {
  const mine = automationsMacOf(here);
  return mine !== null && mine === thisMacId.trim() && automationsMacOf(onGitHub) !== mine;
}
