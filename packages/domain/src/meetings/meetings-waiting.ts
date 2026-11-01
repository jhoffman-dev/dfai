/**
 * ADR-0035 parts 1 and 3: a Mac that is not named says how many meetings
 * wait for the Mac that is, instead of dropping them without a word.
 *
 * What waits is what a claim would settle: a meeting file the import would
 * judge that has no `atlas_import_outcome` stamp yet. A sync-conflict copy
 * is the person's to merge and a file that cannot be read is not the
 * import's to settle; neither is cleared by a claim, so neither counts — a
 * banner that a claim cannot clear would never go away.
 *
 * A count is only given on fresh sync state (part 4): a pull that started
 * since this Mac last slept has completed, sync is not paused here, the
 * settings it left can be read, and the pull finished after each file
 * counted was last modified here. Until then the banner says nothing about
 * how many ("Unknown" in ADR-0035): a stamp the named Mac made may be in
 * flight. A vault that does not sync is unchanged (ADR-0035): it has one Mac,
 * so no banner is shown in it.
 */

import type { ActivityReport } from '../activity/activity-event.ts';
import type { ClaimRefusal } from '../sync/automations-claim.ts';
import { isConflictCopyPath } from '../sync/conflict-copy.ts';
import {
  pulledAfterArrival,
  pulledSinceLastSleep,
  type PullStanding,
} from '../sync/pull-freshness.ts';
import type { NoteChange } from '../index/note-changes.ts';
import { isMeetingArrival, isMeetingInboxPath, type ImportOutcome } from './meeting-arrival.ts';
import {
  postProcessingPending,
  type PostProcessingFacts,
  type PostProcessingLedger,
} from './post-processing-pending.ts';

/** One file where meetings land, as the import read it: null when it could not be read, frontmatter included. */
export interface WaitingMeetingFile {
  readonly path: string;
  readonly read: {
    /** It declares the import contract (`atlas_import`). */
    readonly importDeclared: boolean;
    /** Its `atlas_import_outcome` stamp; null when it has none. */
    readonly importOutcome: ImportOutcome | null;
    /** When it was last modified on this Mac, on its clock; null when the vault cannot tell (ADR-0053). */
    readonly modifiedAt: number | null;
    /** What says whether its summary and tasks are still to come. */
    readonly postProcessing: PostProcessingFacts;
  } | null;
}

/** A completed pull: what a count is judged against. */
export type CountableStanding = Extract<PullStanding, { kind: 'pulled' }>;

/**
 * What one file is to the count: it waits for the named Mac to import it, or
 * to post-process it; it would but changed here after the pull and is left
 * for the next one (gate 1, never guessed at); or it is not the count's.
 */
function standingOfFile(
  file: WaitingMeetingFile,
  standing: CountableStanding,
  ledger: PostProcessingLedger,
): 'waits' | 'pending' | 'deferred' | 'not' {
  if (isConflictCopyPath(file.path) || file.read === null) return 'not';
  const { importDeclared, importOutcome, modifiedAt, postProcessing } = file.read;
  if (!isMeetingArrival({ path: file.path, importDeclared, importOutcome })) return 'not';
  const counted =
    importOutcome === null
      ? 'waits'
      : postProcessingPending({ path: file.path, importOutcome, facts: postProcessing, ledger })
        ? 'pending'
        : 'not';
  if (counted === 'not') return 'not';
  // An unknown time is after every pull: left for the next one, as the gate would hold it.
  const arrived = modifiedAt ?? Number.POSITIVE_INFINITY;
  return pulledAfterArrival({ standing, modifiedAt: arrived }) ? counted : 'deferred';
}

/** Whether one file waits for the named Mac to import it, judged against the pull that lets it be counted. */
export function waitsForImport(
  file: WaitingMeetingFile,
  standing: CountableStanding,
  ledger: PostProcessingLedger,
): boolean {
  return standingOfFile(file, standing, ledger) === 'waits';
}

/** What a count is made of: the meetings not imported, the ones imported but pending, their sum, and the ones left for the next pull. */
export interface WaitingTally {
  readonly count: number;
  readonly unimported: number;
  readonly pending: number;
  readonly deferred: number;
}

/** How many of the files wait for the named Mac — not imported, or pending — and how many are left for the next pull to judge. */
export function waitingMeetingTally(
  files: readonly WaitingMeetingFile[],
  standing: CountableStanding,
  ledger: PostProcessingLedger,
): WaitingTally {
  const judged = files.map((file) => standingOfFile(file, standing, ledger));
  const unimported = judged.filter((each) => each === 'waits').length;
  const pending = judged.filter((each) => each === 'pending').length;
  return {
    count: unimported + pending,
    unimported,
    pending,
    deferred: judged.filter((each) => each === 'deferred').length,
  };
}

/**
 * Whether news of notes may change the count: some note where meetings land
 * was added, changed or removed. Any other note's never can.
 */
export function touchesWaitingMeetings(changes: readonly Pick<NoteChange, 'path'>[]): boolean {
  return changes.some((change) => isMeetingInboxPath(change.path));
}

/** Why no count is given: not yet, or — for a vault that does not sync — never. */
export type UncountedWhy = 'paused' | 'no-pull' | 'pulling' | 'settings-unreadable' | 'not-synced';

export type WaitingCountGate =
  | { readonly open: true; readonly standing: CountableStanding }
  | { readonly open: false; readonly why: UncountedWhy };

/**
 * Whether a count may be given now, and against which pull: gate 2 of
 * ADR-0035 part 4 and the pause, judged as for the import itself, but on a
 * Mac that is not named. Gate 1 is each file's, in {@link waitsForImport}.
 */
export function waitingCountGate({
  standing,
  asleepNowMs,
  paused,
}: {
  standing: PullStanding | null;
  /** The host's time asleep since boot, read now; null when it could not be read. */
  asleepNowMs: number | null;
  /** Whether sync is paused on this Mac, in a vault known to sync. */
  paused: boolean;
}): WaitingCountGate {
  if (standing?.kind === 'not-synced') return { open: false, why: 'not-synced' };
  if (paused) return { open: false, why: 'paused' };
  if (standing?.kind === 'settings-unreadable') return { open: false, why: 'settings-unreadable' };
  // Said apart from no pull: what is shown is kept until the pull completes, never flipped mid-pull.
  if (standing?.kind === 'pulling') return { open: false, why: 'pulling' };
  if (standing?.kind !== 'pulled' || !pulledSinceLastSleep({ standing, asleepNowMs })) {
    return { open: false, why: 'no-pull' };
  }
  return { open: true, standing };
}

/**
 * What a Mac that is not named says of the meetings waiting for the one that
 * is — or, on the named Mac, that its own step cannot reach Claude (#182,
 * ADR-0035 part 1), with how many meetings' summaries and tasks are pending:
 * null until a count may be given under the gates.
 */
export type MeetingsWaiting =
  | { readonly kind: 'counted'; readonly mac: string; readonly count: number }
  | { readonly kind: 'uncounted'; readonly mac: string; readonly why: UncountedWhy }
  | {
      readonly kind: 'failing';
      readonly mac: string;
      readonly count: number | null;
      /** Why, as the step logged it: the fix-it line. */
      readonly problem: string;
    };

/** The named Mac as the person knows it: its name from the settings, never its id. */
export function waitingMacLabel(name: string | null): string {
  const trimmed = name?.trim() ?? '';
  return trimmed === '' ? 'the Mac that runs the automations' : trimmed;
}

const meetingsOf = (count: number) => (count === 1 ? '1 meeting' : `${count} meetings`);

/**
 * The Inbox's line: "N meetings waiting for <Mac>", or, before a count can
 * be given, what it waits for and nothing about how many. Null when none
 * waits, when the settings cannot be read (the Inbox says that already, and
 * which Mac is named is not known), and in a vault that does not sync.
 */
export function meetingsWaitingLine(waiting: MeetingsWaiting): string | null {
  if (waiting.kind === 'failing') return failingLine(waiting);
  if (waiting.kind === 'counted') {
    return waiting.count === 0 ? null : `${meetingsOf(waiting.count)} waiting for ${waiting.mac}`;
  }
  switch (waiting.why) {
    case 'paused':
      return `Meetings may be waiting for ${waiting.mac}: they are counted once sync resumes.`;
    case 'no-pull':
    case 'pulling':
      return `Meetings may be waiting for ${waiting.mac}: they are counted after the next sync.`;
    case 'settings-unreadable':
    case 'not-synced':
      return null;
  }
}

/** The named Mac's line while its step cannot reach Claude: said whatever the count, which follows once known. */
function failingLine({ mac, count }: Extract<MeetingsWaiting, { kind: 'failing' }>): string {
  const pending = 'summaries and tasks are pending';
  const where = `Claude is unavailable on ${mac}`;
  return count === null || count === 0
    ? `${where}: ${pending}.`
    : `${where}: ${pending} for ${meetingsOf(count)}.`;
}

/**
 * Whether the named Mac's failure is news to Activity: said once per
 * failure, not on every run that fails again the same way. A different
 * problem is a new failure; one that cleared and came back is too, as the
 * caller forgets what it warned of once the step runs.
 */
export function failingWarningDue({
  problem,
  warned,
}: {
  problem: string;
  /** The problem last warned of for the vault while it has kept failing; null when none was. */
  warned: string | null;
}): boolean {
  return problem !== warned;
}

/** Activity's warning that the named Mac's step cannot reach Claude, and what to do. */
export function postProcessingFailingReport({
  mac,
  problem,
}: {
  mac: string;
  problem: string;
}): ActivityReport {
  return {
    level: 'warning',
    kind: 'meeting',
    message: `Claude is unavailable on ${mac}: summaries and tasks are pending. ${problem}`,
    subject: null,
  };
}

/**
 * Whether a count is news to Activity (#175: "once per sync" read as "once
 * per count"). Activity warns at most once per distinct count in a session
 * for the vault: a pull that changes nothing, about once a minute, is never
 * news. Nor is a drop that deferral alone explains — files edited here are
 * left for the next pull to judge, and come back then — so the count with
 * the deferred files put back must not be one already warned of.
 */
export function waitingWarningDue({
  count,
  deferred,
  warned,
}: {
  count: number;
  deferred: number;
  /** The counts already warned of for the vault in this session. */
  warned: ReadonlySet<number>;
}): boolean {
  if (count === 0 || warned.has(count)) return false;
  return ![...warned].some((said) => said > count && said <= count + deferred);
}

/** Activity's warning that meetings wait for the named Mac; null when none does. */
export function meetingsWaitingReport({
  count,
  mac,
}: {
  count: number;
  mac: string;
}): ActivityReport | null {
  if (count === 0) return null;
  const verb = count === 1 ? 'is waiting for' : 'are waiting for';
  const them = count === 1 ? 'it' : 'them';
  return {
    level: 'warning',
    kind: 'meeting',
    message: `${meetingsOf(count)} ${verb} ${mac} to process ${them}.`,
    subject: null,
  };
}

/**
 * Whether the banner's "Process here" is refused now, and why (ADR-0035
 * part 2): on the facts that judged its line — a count is given only while a
 * pull since the last launch or wake has completed and sync is not paused —
 * and a last sync or look that failed. The claim asks the gates again as it
 * is pressed (`claimRefusal`).
 */
export function processHereRefusal({
  waiting,
  failing,
}: {
  waiting: MeetingsWaiting;
  /** Whether this Mac's last sync or look at GitHub failed. */
  failing: boolean;
}): ClaimRefusal | null {
  // Said on the named Mac, which has nothing to claim.
  if (waiting.kind === 'failing') return null;
  if (waiting.kind === 'uncounted' && waiting.why === 'paused') return 'paused';
  if (failing) return 'failing';
  return waiting.kind === 'counted' ? null : waiting.why;
}
