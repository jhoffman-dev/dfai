/**
 * ADR-0035 part 4: whether a Mac may act on what sync has brought in.
 *
 * Every Mac, named or not, runs the meeting import and a rule's Claude step
 * only after a pull that completed with the Mac awake throughout, and only if
 * the settings read after that pull still name it. A Mac another claimed
 * while it slept wakes, pulls, finds it is not named, and runs nothing.
 *
 * The host reports one number (#172): how long the Mac has been asleep since
 * it booted. It grows only while the Mac sleeps, the sleeps around a dark
 * wake included, and no clock setting moves it. A pull counts when it
 * *started* at the reading there is now: one that began before a sleep and
 * finished after it may have fetched the state from before the sleep. A new
 * session has no completed pull, so launch needs no reading of its own.
 */

import type { ActivityReport } from '../activity/activity-event.ts';
import type { AutomationRule } from '../automations/automation-rule.ts';
import type { RunTrigger } from '../automations/run-log.ts';

/** What this session knows of one vault's last pull. Null: no pull has completed, or what the files hold is not known. */
export type PullStanding =
  /** The vault does not sync: it has one Mac, and nothing to wait for. */
  | { readonly kind: 'not-synced' }
  /** A pull is under way: what it brings is judged once it has completed. */
  | { readonly kind: 'pulling' }
  /** A pull completed, and the settings it left could not be read: nothing acts until one leaves them readable. */
  | { readonly kind: 'settings-unreadable' }
  | {
      readonly kind: 'pulled';
      /** The host's time asleep since boot, read as the pull started. */
      readonly startedAsleepMs: number;
      /** When it completed, on this Mac's clock. */
      readonly finishedAt: number;
      /** Whether the vault's settings, read once it had completed, name this Mac. */
      readonly namedAfter: boolean;
    };

/**
 * What the vault's settings note says of who runs the automations, as read
 * from the file. `unreadable`: it could not be read, or — in a vault that
 * syncs — it is not there; it then names no one, and nothing runs until it
 * can be read (ADR-0035, "Unknown"). That is not a readable note that names
 * no Mac, which names every Mac.
 */
export type SettingsReading = 'names-this-mac' | 'names-another-mac' | 'unreadable';

/** How one run of git ended, as far as what the vault's files hold of GitHub. */
export type PullEnd =
  /** A sync completed: it brought in all GitHub had as it began. */
  | { readonly kind: 'synced' }
  /** A sync failed: it may have brought files in before it did. */
  | { readonly kind: 'sync-failed' }
  /** A look at GitHub completed, finding `behind` commits of other Macs not yet brought in. */
  | { readonly kind: 'looked'; readonly behind: number }
  /** A look failed: it changed no file. */
  | { readonly kind: 'look-failed' };

/**
 * What a run of git does to what the session knows of the vault's files. A
 * sync that completes, and a look that finds nothing to bring in, complete a
 * pull: either way the files hold everything GitHub had as it began, and
 * after a wake a look is what reopens the gates when no other Mac changed
 * anything. A sync that fails, and a look that finds other Macs' changes,
 * void what was known: the files are short of GitHub, by how much is not
 * known. A look that fails changed nothing, and keeps it.
 */
export function pullEndEffect(end: PullEnd): 'completes' | 'voids' | 'keeps' {
  switch (end.kind) {
    case 'synced':
      return 'completes';
    case 'sync-failed':
      return 'voids';
    case 'looked':
      return end.behind > 0 ? 'voids' : 'completes';
    case 'look-failed':
      return 'keeps';
  }
}

/**
 * The standing a completed pull leaves: null when the counter could not be
 * read as it started — a pull that cannot be placed against a sleep counts
 * for nothing — and `settings-unreadable` when the settings it left cannot be.
 */
export function standingAfterPull({
  startedAsleepMs,
  finishedAt,
  settings,
}: {
  startedAsleepMs: number | null;
  finishedAt: number;
  /** The settings as read from the file once the pull had completed. */
  settings: SettingsReading;
}): PullStanding | null {
  if (startedAsleepMs === null) return null;
  if (settings === 'unreadable') return { kind: 'settings-unreadable' };
  return { kind: 'pulled', startedAsleepMs, finishedAt, namedAfter: settings === 'names-this-mac' };
}

/**
 * How far apart two readings of one awake spell may be. The host reads two
 * clocks one after the other, so a reading moves by the moment between them:
 * rounding can show that as a millisecond, a thread preempted between the two
 * as a few more. No sleep, a dark wake's included, is anywhere near as short.
 */
export const ASLEEP_READING_SLACK_MS = 1_000;

/**
 * Gate 2: a pull has completed that started since this Mac last slept (or
 * since the app launched, which a session with no pull covers). A vault that
 * does not sync has nothing to wait for. With no reading of the counter, it
 * never guesses.
 */
export function pulledSinceLastSleep({
  standing,
  asleepNowMs,
}: {
  standing: PullStanding | null;
  /** The host's time asleep since boot, read now; null when it could not be read. */
  asleepNowMs: number | null;
}): boolean {
  if (standing?.kind === 'not-synced') return true;
  if (standing?.kind !== 'pulled' || asleepNowMs === null) return false;
  return Math.abs(asleepNowMs - standing.startedAsleepMs) <= ASLEEP_READING_SLACK_MS;
}

/**
 * Gate 1: the last completed pull finished later than the file was last
 * modified on this Mac, so whatever another Mac has done to it by then has
 * been brought in. A vault that does not sync has nothing to wait for.
 */
export function pulledAfterArrival({
  standing,
  modifiedAt,
}: {
  standing: PullStanding | null;
  /** When the file was last modified on this Mac, on its clock. */
  modifiedAt: number;
}): boolean {
  if (standing?.kind === 'not-synced') return true;
  return standing?.kind === 'pulled' && standing.finishedAt > modifiedAt;
}

/** Why the gates are shut: what the import and a Claude step wait for. */
export type FreshPullShut =
  /** The settings note cannot be read, now or as the last pull left it: nothing runs. */
  | 'settings-unreadable'
  /** The settings, now or as the last pull left them, name another Mac. */
  | 'not-named'
  /** Sync is paused on this Mac: nothing new is brought in, so nothing acts. */
  | 'paused'
  /** No pull has completed since the vault opened, or the last one failed or found changes. */
  | 'no-pull'
  /** A pull is under way. */
  | 'pulling'
  /** The Mac has slept since the last pull started, or how long it slept cannot be read. */
  | 'slept'
  /** A file to act on changed here after the last pull completed (gate 1). */
  | 'arrived-after-pull'
  /**
   * This Mac claimed the automations and no sync has pushed the claim yet
   * (#176): the other Mac still believes it is named. A look that brings
   * nothing completes a pull but pushes nothing, so it does not open this.
   */
  | 'claim-unshared';

export type FreshPullVerdict =
  { readonly open: true } | { readonly open: false; readonly shut: FreshPullShut };

const OPEN: FreshPullVerdict = { open: true };
const shutFor = (why: FreshPullShut): FreshPullVerdict => ({ open: false, shut: why });

/**
 * Whether this Mac may run the meeting import, or a rule's Claude step, on
 * the vault's files now (ADR-0035 part 4), and if not, why. Asked right
 * before each act and again before each write.
 *
 * In a vault that syncs it is open when sync is not paused here, a pull has
 * completed that started since this Mac last slept (gate 2), the settings
 * that pull left and the settings as read now can both be read and name this
 * Mac, and the pull finished after the files to act on were last modified
 * here (gate 1). A vault that does not sync has nothing to wait for: it is
 * judged by its settings alone, as before ADR-0035.
 */
export function freshPullVerdict({
  standing,
  asleepNowMs,
  settingsNow,
  paused,
  arrivedAt,
  claimUnshared = false,
}: {
  standing: PullStanding | null;
  /** The host's time asleep since boot, read now; null when it could not be read, or was not needed. */
  asleepNowMs: number | null;
  /**
   * The settings note as read from the file now; null when it was not read,
   * which counts as unreadable wherever the standing would let it count.
   */
  settingsNow: SettingsReading | null;
  /** Whether sync is paused on this Mac, in a vault known to sync. */
  paused: boolean;
  /** When the files to act on were last modified here, the latest of them; null for a step that acts on no file. */
  arrivedAt: number | null;
  /** Whether this Mac's claim of the automations is written here and not yet pushed. */
  claimUnshared?: boolean;
}): FreshPullVerdict {
  if (standing?.kind === 'not-synced') return byTheSettings(settingsNow) ?? OPEN;
  if (paused) return shutFor('paused');
  if (claimUnshared) return shutFor('claim-unshared');
  if (standing === null) return shutFor('no-pull');
  if (standing.kind === 'pulling') return shutFor('pulling');
  if (standing.kind === 'settings-unreadable') return shutFor('settings-unreadable');
  const settings = byTheSettings(settingsNow);
  if (settings !== null) return settings;
  if (!standing.namedAfter) return shutFor('not-named');
  if (!pulledSinceLastSleep({ standing, asleepNowMs })) return shutFor('slept');
  if (arrivedAt !== null && !pulledAfterArrival({ standing, modifiedAt: arrivedAt })) {
    return shutFor('arrived-after-pull');
  }
  return OPEN;
}

/** The gates the settings read now shut, if any: unreadable or unread, or naming another Mac. */
function byTheSettings(settingsNow: SettingsReading | null): FreshPullVerdict | null {
  if (settingsNow === null || settingsNow === 'unreadable') return shutFor('settings-unreadable');
  return settingsNow === 'names-another-mac' ? shutFor('not-named') : null;
}

/**
 * Whether a run of the rule waits on the gates: a Claude step, which is not
 * the same twice (ADR-0035), set off by the clock, by the vault opening or by
 * a note. One the person starts by hand is theirs to start.
 */
export function gatedByFreshPull({
  rule,
  trigger,
}: {
  rule: Pick<AutomationRule, 'action'>;
  trigger: RunTrigger;
}): boolean {
  return rule.action.kind === 'claude' && trigger !== 'hand';
}

/**
 * What Activity says, once, when the gates shut for a reason the person can
 * act on: sync paused here, or settings that cannot be read. The others —
 * waiting for the next pull, another Mac named — pass by themselves, or are
 * said by Settings → Sync.
 */
export function freshPullWaitReport(why: FreshPullShut): ActivityReport | null {
  switch (why) {
    case 'paused':
      return {
        level: 'info',
        kind: 'sync',
        message:
          'Sync is paused on this Mac, so automations wait: no meeting is imported and no Claude step runs until sync resumes.',
        subject: null,
      };
    case 'settings-unreadable':
      return {
        level: 'warning',
        kind: 'sync',
        message:
          'The vault’s settings (.atlas/settings.md) cannot be read, so nothing runs: no meeting is imported and no Claude step runs until they can be.',
        subject: null,
      };
    default:
      return null;
  }
}
