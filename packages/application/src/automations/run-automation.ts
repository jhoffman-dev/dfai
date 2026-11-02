import {
  automationEntryReport,
  claudeStepBudget,
  leftHandledNotes,
  messageWithoutPaths,
  movedHandledNotes,
  noteRunsHeldUntil,
  noteTriggerHears,
  readsData,
  storedAnswerFor,
  triggeringVersions,
  unhandledVersions,
  type AutomationPlan,
  type AutomationRule,
  type DoneAction,
  type LoggedVersion,
  type LogEntry,
  type MovedVersion,
  type NoteChange,
  type NoteTrigger,
  type NoteVersionRef,
  type OutputPeriod,
  type PassedOver,
  type RunTrigger,
  type StoredAnswerDraft,
  type VaultPath,
} from '@dfai/domain';
import { archiveNotes, type ArchiveOutcome, type ArchivePorts } from '../archive/archive-notes.ts';
import type { ActivityLog } from '../activity/ports.ts';
import type { Clock } from '../ports.ts';
import { AtlasQueryError } from '../query/run-atlas-query.ts';
import { listVaultNotes } from '../vault/read-vault.ts';
import { writtenAt } from '../vault/written-at.ts';
import { changeProperties, type PropertyOutcome } from './apply-changes.ts';
import { withHandledKeys } from './handled-keys.ts';
import {
  ClaudeStepFailed,
  ClaudeUnavailableError,
  runClaudeStep,
  type ClaudeStepPorts,
} from './claude-step.ts';
import { holdUnlessFresh, type FreshPullCheck } from './fresh-pull-hold.ts';
import { briefEachMeeting } from './meeting-briefs.ts';
import { meetingsNotLinked } from './meetings-not-linked.ts';
import { PeriodNoteArrived, periodStateOf } from './period-state.ts';
import { heldEntries } from '../index/refresh-index.ts';
import { allowanceEntries, askedThisHour } from './ask-allowance.ts';
import { appendForRun, reported } from './automation-activity.ts';
import { readRuleLog } from './automation-log.ts';
import {
  arrivalsMissed,
  handledBy,
  handledAmong,
  handledNow,
  NoteRunsCappedError,
  planForVersions,
  planRuleNow,
  writtenBy,
  type RuleTarget,
} from './note-runs.ts';
import type { RuleQueryPorts } from './plan-run.ts';
import { guardedFs, stillInVault, type VaultGuard } from './vault-guard.ts';

/**
 * Everything a run reaches: the archive's ports, the vault's types, and what
 * a Claude step asks (P29-03). The vault's notes are read afresh by each run
 * — a scheduled run can come long after the list on screen was.
 */
export type AutomationPorts = ArchivePorts &
  Pick<RuleQueryPorts, 'types'> & { readonly claude: ClaudeStepPorts };

export interface AutomationRun {
  readonly ports: AutomationPorts;
  readonly rule: AutomationRule;
  readonly clock: Pick<Clock, 'today' | 'now' | 'localNow'>;
  readonly guard: VaultGuard;
  /** Where the run's summary, or why it stopped, is said (U-28). */
  readonly activity: ActivityLog;
  /**
   * The gates of a fresh pull (ADR-0035 part 4). A run that waits on them
   * (`gatedByFreshPull`: a Claude step the person did not start) asks them
   * right before it asks Claude and again before each write, and is held —
   * rejecting with `HeldForPullError`, having written nothing — while they
   * are shut. Left out, nothing waits.
   */
  readonly freshPull?: FreshPullCheck;
  /**
   * Links again the meetings whose linking failed (#192), as the import's
   * linker does, before a run by hand plans: so Run now of the "After a
   * meeting" rule asks Claude about each meeting linked. Settles when done,
   * and never rejects. Left out, none is linked again.
   */
  readonly relink?: (meetings: readonly VaultPath[]) => Promise<unknown>;
}

/**
 * Runs a rule once (P25-02): plans what it would do today, carries the plan
 * out, and logs exactly what happened — a run whose query does not read is
 * logged as one that could not run. Settles with the log entry.
 *
 * The runner decides nothing: which notes, and what to do with each, is the
 * plan's. It only refuses what it must — a note being typed in, a vault that
 * is no longer the one open — and says so.
 *
 * Whatever it changed is logged, even when the run is cut off (A25-01): the
 * entry is written however applying the plan ends. It goes through the rule's
 * own vault's files, not the guarded ones — the guard stops further changes,
 * not the record of those already made; the host still refuses a write once
 * that vault is closed. A log that cannot be written rejects with
 * `AutomationLogError`, carrying what the run did.
 *
 * The run's summary, or why it stopped, goes to the Activity log too.
 */
export async function runAutomation(
  run: AutomationRun & { trigger: RunTrigger },
): Promise<LogEntry> {
  const { activity, rule, trigger } = run;
  const aim: Aim = async (ports, today) => {
    // Run by hand, a rule notes set off does what it would have for each note not yet handled;
    // a Claude step, on any trigger, is never asked again about a version it has answered.
    const remembers = rule.when.kind === 'note' || rule.action.kind === 'claude';
    const log = remembers ? await readRuleLog(run.ports.fs, rule) : null;
    if (trigger === 'hand') await relinkFirst({ run, ports, today });
    return planRuleNow({
      ports,
      rule,
      log: log?.entries ?? [],
      ledger: log?.ledger ?? null,
      today,
    });
  };
  // Not quiet, it always settles with its entry.
  const carryOut = async () => (await runOnce({ run, trigger, aim, quiet: false }))!;
  return reported({ activity, rule, doing: 'run', carryOut });
}

/** Run by hand, the meetings its query matches whose linking failed are linked again (#192). */
async function relinkFirst({
  run,
  ports,
  today,
}: {
  run: AutomationRun;
  ports: RuleQueryPorts;
  today: string;
}): Promise<void> {
  if (run.relink === undefined) return;
  const notLinked = await meetingsNotLinked({ ports, rule: run.rule, today });
  if (notLinked === null) return;
  await run.relink(notLinked.paths);
  // Linking waits on the index and the disk: the vault must still be the rule's to plan in.
  stillInVault(run.guard);
}

/**
 * Runs a rule set off by notes (P29-01) for one sync's changes: the notes of
 * its type that arrived or changed and that its query matches, each version
 * once. Settles with the log entry; null when there was nothing it had not
 * already handled, or nothing to do — such a run writes nothing and says nothing.
 *
 * Its log is read afresh, after any run before it has written: a version its
 * own write left is there by then, and does not set it off again. A path a
 * note it had handled has left — deleted, moved, renamed, archived, or
 * replaced by a new note — is written down as gone, so a new note there is
 * new to it; a note that moved is written down where it is now, so it is not
 * new to it there (#214). A run that changed nothing is said in
 * Activity but kept out of the log, and out of the hourly count. A rule
 * that has run as often this hour as one may rejects with
 * `NoteRunsCappedError` instead, and runs nothing.
 *
 * The guard names the vault the changes were heard in: run after another
 * vault was opened, it stops before reading or writing anything.
 */
export async function runOnNoteChanges(
  run: AutomationRun & { changes: readonly NoteChange[] },
): Promise<LogEntry | null> {
  const { activity, rule, changes } = run;
  if (!rule.enabled || rule.when.kind !== 'note' || !noteTriggerHears(rule.when, changes)) {
    return null;
  }
  const { when } = rule;
  const carryOut = () => runOnHeard({ ...run, when });
  return reported({ activity, rule, doing: 'run', carryOut });
}

async function runOnHeard(
  run: AutomationRun & { changes: readonly NoteChange[]; when: NoteTrigger },
): Promise<LogEntry | null> {
  stillInVault(run.guard);
  const log = await readRuleLog(run.ports.fs, run.rule);
  const { entries } = log;
  const triggering = await withHandledKeys({
    fs: run.ports.fs,
    markdown: run.ports.markdown,
    rule: run.rule,
    versions: triggeringVersions(run.when, run.changes),
  });
  const handled = await handledAmong({ index: run.ports.index, log, versions: triggering });
  const departed: Departures = {
    went: leftHandledNotes(run.changes, handled),
    moved: movedHandledNotes(run.changes, handled),
  };
  const versions = unhandledVersions(triggering, handled);
  const budget = claudeStepBudget(run.rule.action);
  const allowance = await allowanceEntries(run.ports, run.rule, entries);
  const heldUntil = noteRunsHeldUntil(entries, run.clock.localNow(), budget, allowance);
  if (versions.length === 0 || heldUntil !== null) {
    await recordGone(run, departed, 'note');
    if (versions.length > 0 && heldUntil !== null) {
      throw new NoteRunsCappedError(heldUntil, budget);
    }
    return null;
  }
  const aim: Aim = (ports, today) => planForVersions({ ports, rule: run.rule, versions, today });
  return runOnce({ run, trigger: 'note', aim, quiet: true, departed });
}

/**
 * Runs a rule set off by a note being created on the arrivals it never ran
 * on (ADR-0028, "Catching up when DFAI opens"): asked once when a vault
 * opens, on the Mac that runs its automations. An arrival is heard in memory,
 * so one let in just before DFAI was quit — or held back by the hour's cap,
 * or let go — would otherwise wait for a run by hand for ever.
 *
 * It looks only where meeting files land, at meetings the import let in
 * since the rule's file was last saved and of which its log holds nothing
 * (`missedArrivals`), and runs as the feed's news would have: the same query
 * among those notes, the same most per run, the same hourly cap — rejecting
 * with `NoteRunsCappedError` when that holds it back, so the caller keeps it
 * for later as it keeps news. Settles with the log entry; null when the rule
 * is off or is not set off by `created`, nothing was missed, or there was
 * nothing to do.
 */
export async function runOnMissedArrivals(run: AutomationRun): Promise<LogEntry | null> {
  const { activity, rule } = run;
  if (!rule.enabled || rule.when.kind !== 'note' || !rule.when.on.includes('created')) return null;
  const { when } = rule;
  const carryOut = async (): Promise<LogEntry | null> => {
    stillInVault(run.guard);
    const log = await readRuleLog(run.ports.fs, rule);
    const { entries } = log;
    const { fs, index } = run.ports;
    const held = await heldEntries(index);
    const handled = await handledNow({ index, log, held });
    const versions = await arrivalsMissed({
      fs,
      markdown: run.ports.markdown,
      held,
      rule,
      trigger: when,
      handled,
    });
    if (versions.length === 0) return null;
    const budget = claudeStepBudget(rule.action);
    const allowance = await allowanceEntries(run.ports, rule, entries);
    const heldUntil = noteRunsHeldUntil(entries, run.clock.localNow(), budget, allowance);
    if (heldUntil !== null) throw new NoteRunsCappedError(heldUntil, budget);
    const aim: Aim = (ports, today) => planForVersions({ ports, rule, versions, today });
    return runOnce({ run, trigger: 'note', aim, quiet: true });
  };
  return reported({ activity, rule, doing: 'run', carryOut });
}

/**
 * Says that a rule held back let news go (`count` syncs' worth): in Activity
 * first, so it is said even if the log cannot be written, then in the rule's
 * log. What was let go is not lost for good: a run by hand takes every note
 * the rule has not handled.
 */
export async function recordNewsLetGo({
  ports,
  rule,
  clock,
  guard,
  activity,
  count,
}: Pick<AutomationRun, 'rule' | 'guard' | 'activity'> & {
  ports: Pick<AutomationPorts, 'fs'>;
  clock: Pick<Clock, 'now' | 'localNow'>;
  count: number;
}): Promise<LogEntry> {
  stillInVault(guard);
  const entry: LogEntry = { kind: 'letGo', at: clock.localNow(), count };
  const report = automationEntryReport(rule, entry);
  if (report !== null) activity.inOpenVault().record(report);
  await appendForRun({ fs: guardedFs(ports.fs, guard), run: { rule, clock, activity }, entry });
  return entry;
}

/**
 * Notes a rule had handled that left their paths: deleted or replaced, their
 * history ending (`went`), or moved, their history going with them (`moved`).
 * A move is both: its old path went, and it is known where it is now.
 */
interface Departures {
  readonly went: readonly VaultPath[];
  readonly moved: readonly MovedVersion[];
}

const NONE_DEPARTED: Departures = { went: [], moved: [] };

const anyDeparted = ({ went, moved }: Departures): boolean => went.length + moved.length > 0;

/** The departures as a log entry's fields: none, nothing. */
const departureFields = ({ went, moved }: Departures) => ({
  ...(went.length > 0 && { went }),
  ...(moved.length > 0 && { moved }),
});

/**
 * Writes down notes a rule had handled that were deleted or moved, in an
 * entry of their own; none, nothing. Held, like any write of a gated run,
 * while the gates are shut — unless `trigger` is null: the run has made
 * something already, and its record is written whatever the gates say.
 */
async function recordGone(
  run: AutomationRun,
  departed: Departures,
  trigger: RunTrigger | null,
): Promise<void> {
  if (!anyDeparted(departed)) return;
  if (trigger !== null) await holdUnlessFresh({ check: run.freshPull, rule: run.rule, trigger });
  const entry: LogEntry = {
    kind: 'run',
    at: run.clock.localNow(),
    trigger: 'note',
    done: [],
    left: [],
    capped: false,
    ...departureFields(departed),
  };
  await appendForRun({ fs: guardedFs(run.ports.fs, run.guard), run, entry });
}

/** What a run plans over, once the vault's notes are listed. Rejects as `planRun` does. */
type Aim = (
  ports: AutomationPorts & { notePaths: readonly VaultPath[] },
  today: string,
) => Promise<RuleTarget>;

async function runOnce({
  run,
  trigger,
  aim,
  quiet,
  departed = NONE_DEPARTED,
}: {
  run: AutomationRun;
  trigger: RunTrigger;
  aim: Aim;
  /**
   * Whether a run that changed nothing stays out of the log: one notes set
   * off, on every save. With nothing to do it says nothing at all.
   */
  quiet: boolean;
  /** Notes the rule had handled that were deleted or moved, for its log to say. */
  departed?: Departures;
}): Promise<LogEntry | null> {
  const { clock, guard } = run;
  const at = clock.localNow();
  const today = clock.today();
  stillInVault(guard);
  const fs = guardedFs(run.ports.fs, guard);
  const ports = { ...run.ports, fs, notePaths: await listVaultNotes({ fs }) };
  /** Writes the run's entry, whatever the gates say: for what the run has already made. */
  const append = (entry: LogEntry, stored?: readonly StoredAnswerDraft[]) =>
    appendForRun({ fs: run.ports.fs, run, entry, ...(stored !== undefined && { stored }) });
  /** Writes the run's entry once the gates allow it, when the run has made nothing yet. */
  const log = async (entry: LogEntry, paths: readonly string[] = []) => {
    await holdUnlessFresh({ check: run.freshPull, rule: run.rule, trigger, paths });
    await append(entry);
  };
  let target: RuleTarget;
  try {
    target = await aim(ports, today);
  } catch (cause) {
    if (!(cause instanceof AtlasQueryError)) throw cause;
    const failed: LogEntry = { kind: 'failed', at, trigger, problem: messageWithoutPaths(cause) };
    // A query that does not read still heard which notes went: the history is the rule's either way.
    await recordGone(run, departed, trigger);
    await log(failed);
    return failed;
  }
  // The index answered for the vault open when it was asked; that must still be the rule's.
  stillInVault(guard);
  const { plan } = target;
  if (quiet && plan.paths.length === 0 && plan.passedOver.length === 0) {
    await recordGone(run, departed, trigger);
    return null;
  }
  // A step that reads its data runs with no notes; any other has nothing to ask about without one.
  if (plan.action.kind === 'claude' && (plan.paths.length > 0 || readsData(plan.action))) {
    const asked = { run, ports, target, action: plan.action, at, trigger, departed, log, append };
    return askClaude(asked);
  }
  let applied: PropertyOutcome = { done: [], left: [] };
  let versions: LoggedVersion[] = [];
  const entry = (): LogEntry => ({
    kind: 'run',
    at,
    trigger,
    done: applied.done,
    left: [...plan.passedOver, ...applied.left],
    capped: plan.capped,
    ...(target.versions !== null && { versions }),
    ...departureFields(departed),
  });
  try {
    applied = await applyPlan({ ports, plan, today });
  } finally {
    // Each batch records per note and does not throw part-way, so what it returns is all it did;
    // if it throws, it threw before its first change, and the entry says it did nothing.
    if (target.versions !== null) versions = await versionsOf(run, target.versions, applied);
    if (!quiet || applied.done.length > 0 || anyDeparted(departed)) await log(entry());
  }
  // Cut off by a switch: said so to the caller, once what it did is on record.
  stillInVault(guard);
  return entry();
}

/**
 * Carries out a Claude step over the plan's notes (P29-03) and logs it: what
 * it made, or — when it failed, having written nothing — why, as a run that
 * could not. Either way the model it asked and how long it took are on record.
 *
 * Every note it was asked about is handled, whatever it proposed — nothing
 * included: asking again about the same version costs a model's time and says
 * the same. A failed run handles none, so a run by hand asks again; what a
 * half-written run made is on record, and the proposals it made are not made
 * twice. Past the notes one Claude run reads, the log says so and the rest
 * wait for a run by hand.
 *
 * A run that waits on the gates of a fresh pull (ADR-0035 part 4) asks them
 * of its notes before it asks Claude, again once Claude has answered and
 * before the first write, and again before it logs a failure that made
 * nothing: shut at any of these, it is held for the next pull with nothing
 * written. Once it has made something, what it made is logged regardless.
 *
 * A step that writes one note a period (#40) asks nothing when its log says
 * this period's note is made: the run is logged, as one that found it made,
 * and its schedule counts on from it. The run that makes the note says the
 * period it made it for. A step handed `meeting-briefs` writes one note per
 * meeting of the day instead (`briefEachMeeting`, #39).
 */
async function askClaude({
  run,
  ports,
  target,
  action,
  at,
  trigger,
  departed,
  log,
  append,
}: {
  run: AutomationRun;
  ports: AutomationPorts & { notePaths: readonly VaultPath[] };
  target: RuleTarget;
  action: Extract<AutomationRule['action'], { kind: 'claude' }>;
  at: string;
  trigger: RunTrigger;
  departed: Departures;
  log: (entry: LogEntry, paths?: readonly string[]) => Promise<void>;
  append: (entry: LogEntry, stored?: readonly StoredAnswerDraft[]) => Promise<void>;
}): Promise<LogEntry> {
  const { plan } = target;
  if (action.data === 'meeting-briefs') {
    return briefEachMeeting({ ...run, ports, action, at, trigger, log, append });
  }
  const { entries } = await readRuleLog(ports.fs, run.rule);
  const period = await periodStateOf({
    rule: run.rule,
    entries,
    at,
    trigger,
    fs: ports.fs,
    markdown: ports.markdown,
    notePaths: ports.notePaths,
  });
  if (period?.made === true) {
    const found = ranEmpty({ at, trigger, plan, period: period.period });
    await log(found);
    return found;
  }
  if (period !== null && unchangedSinceLastNote({ entries, target, trigger, action })) {
    const unchanged = ranUnchanged({ at, trigger, target });
    await log(unchanged);
    return unchanged;
  }
  const hold = () =>
    holdUnlessFresh({ check: run.freshPull, rule: run.rule, trigger, paths: plan.paths });
  await hold();
  /** The fresh-pull gate, then the period read again: its note may have synced in while Claude was asked. */
  const beforeWrite = async () => {
    await hold();
    if (period !== null && (await periodMadeSince({ run, ports, at, trigger }))) {
      throw new PeriodNoteArrived();
    }
  };
  const spent = await askedThisHour(ports, run.rule, at);
  // Only the declared step keeps answers and tells a backfill from an arrival (ADR-0036).
  const declared = action.apply === 'mine';
  const ledger = declared ? (await readRuleLog(ports.fs, run.rule)).ledger : null;
  try {
    const { done, left, claude } = await runClaudeStep({
      ports: ports.claude,
      action,
      paths: plan.paths,
      fs: ports.fs,
      index: ports.index,
      markdown: ports.markdown,
      editors: ports.editors,
      notePaths: ports.notePaths,
      rule: run.rule.id,
      madeBy: `${run.rule.name} · ${at.replace('T', ' ')}`,
      beforeWrite,
      askedThisHour: spent,
      storedAnswer: (key) => storedAnswerFor(ledger, key),
      ruleSince: declared ? await savedAt(ports.fs, run.rule.path) : null,
      ...(period !== null && { period: { period: period.period, at } }),
    });
    const entry: LogEntry = {
      kind: 'run',
      at,
      trigger,
      done,
      left: [...plan.passedOver, ...left],
      capped: plan.capped,
      ...(target.versions !== null && { versions: askedAbout(target) }),
      ...departureFields(departed),
      claude,
      ...(period !== null &&
        done.some(({ kind }) => kind === 'created') && { period: period.period }),
    };
    await (done.length > 0 ? append(entry) : log(entry, plan.paths));
    return entry;
  } catch (cause) {
    if (cause instanceof PeriodNoteArrived && period !== null) {
      const found: LogEntry = {
        ...ranEmpty({ at, trigger, plan, period: period.period }),
        ...(cause.claude !== undefined && { claude: cause.claude }),
      };
      await log(found);
      return found;
    }
    if (!(cause instanceof ClaudeStepFailed)) throw cause;
    const failed: LogEntry = {
      kind: 'failed',
      at,
      trigger,
      // Already without this machine's paths; stripped again, a fix's URL would be taken for one.
      problem: cause.message,
      claude: cause.claude,
      ...(cause.made.length > 0 && { done: cause.made }),
    };
    const madeSome = cause.made.length > 0;
    if (!madeSome) await hold();
    await recordGone(run, departed, madeSome ? null : trigger);
    // The answers it read are kept with the failure, so its retry asks nothing again (ADR-0036).
    await append(failed, cause.stored);
    // Stopped by something other than the answer — a disk that refused — is raised once it is on record.
    if (cause.interruption !== undefined) throw cause.interruption;
    // Claude out of reach on a run news set off: raised, so the runner backs off and keeps the news.
    if (cause.unavailable !== null && trigger === 'note') {
      throw new ClaudeUnavailableError(failed, cause.unavailable);
    }
    return failed;
  }
}

/**
 * Whether a scheduled run of a step that reads notes has nothing new to ask
 * about: every note its fixed query matches is as it was when the last note
 * was written. A step handed data is not skipped, for the data is what changes
 * from one period to the next; nor is a run by hand, which is asked for.
 */
function unchangedSinceLastNote({
  entries,
  target,
  trigger,
  action,
}: {
  entries: readonly LogEntry[];
  target: RuleTarget;
  trigger: RunTrigger;
  action: Extract<AutomationRule['action'], { kind: 'claude' }>;
}): boolean {
  if (trigger === 'hand' || readsData(action)) return false;
  const now = askedAbout(target);
  if (now.length === 0) return false;
  const last = entries.findLast((entry) => entry.kind === 'run' && entry.versions !== undefined);
  const before = last?.kind === 'run' ? (last.versions ?? []) : null;
  if (before === null) return false;
  const seen = new Set(before.map(({ path, digest }) => `${path}\n${digest}`));
  return (
    now.length === seen.size && now.every(({ path, digest }) => seen.has(`${path}\n${digest}`))
  );
}

/** What a scheduled step logs when none of the notes it reads changed: it asked no one, made nothing. */
function ranUnchanged({
  at,
  trigger,
  target,
}: {
  at: string;
  trigger: RunTrigger;
  target: RuleTarget;
}): LogEntry {
  const { plan } = target;
  return {
    kind: 'run',
    at,
    trigger,
    done: [],
    left: [...plan.passedOver],
    capped: plan.capped,
    versions: askedAbout(target),
  };
}

/** Whether the period's note is made now, as the rule's log and the vault's notes, read afresh, say. */
async function periodMadeSince({
  run,
  ports,
  at,
  trigger,
}: {
  run: AutomationRun;
  ports: Pick<AutomationPorts, 'fs' | 'markdown'>;
  at: string;
  trigger: RunTrigger;
}): Promise<boolean> {
  const { entries } = await readRuleLog(ports.fs, run.rule);
  const state = await periodStateOf({
    rule: run.rule,
    entries,
    at,
    trigger,
    fs: ports.fs,
    markdown: ports.markdown,
    notePaths: await listVaultNotes({ fs: ports.fs }),
  });
  return state?.made === true;
}

/** What a step whose period's note is made logs: a run that did nothing, for that period. */
function ranEmpty({
  at,
  trigger,
  plan,
  period,
}: {
  at: string;
  trigger: RunTrigger;
  plan: AutomationPlan;
  period: OutputPeriod;
}): LogEntry {
  return { kind: 'run', at, trigger, done: [], left: [...plan.passedOver], capped: false, period };
}

/**
 * When a rule's file was last written: a meeting that arrived before it is
 * a backfill to the declared step. Null when it cannot be read.
 */
async function savedAt(fs: AutomationPorts['fs'], path: VaultPath): Promise<number | null> {
  try {
    // Unknown in a vault with no file times (ADR-0053): a backfill too, so only proposals.
    return writtenAt(await fs.readTextFile(path));
  } catch {
    // Safe to go without: every meeting is then taken for a backfill, which makes only proposals.
    return null;
  }
}

/** The versions of the notes a Claude step was asked about: each handled, as it was read. */
function askedAbout({ plan, versions }: RuleTarget): LoggedVersion[] {
  const asked = new Set<string>(plan.paths);
  return (versions ?? [])
    .filter((version) => asked.has(version.path))
    .map((version) => ({ ...version, wrote: false }));
}

/**
 * The versions a note-triggered run records: those it acted on, and those its
 * writes left. Read through the rule's own vault's files, as its log is written.
 */
async function versionsOf(
  run: AutomationRun,
  versions: readonly NoteVersionRef[],
  { done }: PropertyOutcome,
): Promise<LoggedVersion[]> {
  const handled = handledBy(versions, done);
  try {
    return [...handled, ...(await writtenBy({ fs: run.ports.fs, done }))];
  } catch {
    // Safe to go without: the log must still be written. A write heard back then sets the rule
    // off once more, and finds its note already as the rule leaves it — or archived, out of reach.
    return handled;
  }
}

async function applyPlan({
  ports,
  plan,
  today,
}: {
  ports: AutomationPorts & { notePaths: readonly VaultPath[] };
  plan: AutomationPlan;
  today: string;
}): Promise<PropertyOutcome> {
  const { action } = plan;
  // A Claude step with notes to read is asked before this; with none, it does nothing.
  if (plan.paths.length === 0 || action.kind === 'claude') return { done: [], left: [] };
  if (action.kind === 'set') {
    const changes = plan.paths.flatMap((path) =>
      Object.entries(action.values).map(([key, value]) => ({
        path,
        key,
        expect: null,
        to: { value },
      })),
    );
    return changeProperties({ ports, changes, kind: 'set', today });
  }
  const outcome = await archiveNotes({
    ports,
    paths: plan.paths,
    notePaths: ports.notePaths,
    today,
    updateLinks: true,
    unsavedTyping: 'leave',
  });
  return archiveRecord(outcome, 'archived');
}

/**
 * What a batch of moves did, as log lines: each move, and each note it could
 * not move — why, without this machine's paths, since any tool can read the log.
 */
export function archiveRecord(
  outcome: ArchiveOutcome,
  kind: 'archived' | 'unarchived',
): { done: DoneAction[]; left: PassedOver[] } {
  return {
    done: outcome.moves.map(({ move }) => ({ kind, from: move.from, to: move.to })),
    left: outcome.failed.map(({ path, reason }) => ({ path, reason: messageWithoutPaths(reason) })),
  };
}
