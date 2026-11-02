import {
  createVaultPath,
  digestOf,
  handledVersions,
  isInPlay,
  MAX_ACTIONS_PER_RUN,
  missedArrivals,
  noteRunsCappedProblem,
  unhandledVersions,
  writesOneNoteAPeriod,
  type AutomationPlan,
  type AutomationRule,
  type ClaudeStepBudget,
  type DoneAction,
  type HandledLedger,
  type LogEntry,
  type LocalTime,
  type HandledVersions,
  type LoggedVersion,
  type NoteTrigger,
  type NoteVersionRef,
  type VaultPath,
} from '@dfai/domain';
import { heldEntries } from '../index/refresh-index.ts';
import type { IndexEntry, IndexPort } from '../index/ports.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import type { VaultFsPort } from '../vault/ports.ts';
import { writtenAt } from '../vault/written-at.ts';
import type { RuleLog } from './automation-log.ts';
import { withHandledKeys } from './handled-keys.ts';
import { matchedPaths, planMatched, planRun, type RuleQueryPorts } from './plan-run.ts';

/** What a run acts on: the plan, and — for a rule notes set off — the versions it was made for. */
export interface RuleTarget {
  readonly plan: AutomationPlan;
  /** Null for a rule on a clock, which handles no versions. */
  readonly versions: readonly NoteVersionRef[] | null;
}

type PlanRule = Pick<AutomationRule, 'when' | 'which' | 'olderThanDays' | 'action'>;

/**
 * What a rule would do now: what its dry run shows, and a run by hand does.
 *
 * A rule on a clock plans over every note its query matches. A rule notes set
 * off (P29-01), or one that asks Claude (P29-03) on whatever trigger — a model
 * is not asked twice for the same words — plans over the notes its query
 * matches whose version now, as the index last read it, its log has not
 * handled: run by hand, a note-triggered rule does what it would have done had
 * each of them just appeared — and so, where meeting files land, on a meeting
 * the import has let in and no other (#92), as the feed has it. Rejects as
 * `planRun` does.
 */
export async function planRuleNow({
  ports,
  rule,
  log,
  ledger = null,
  today,
}: {
  ports: RuleQueryPorts;
  rule: PlanRule;
  /** The rule's log; empty for a rule not yet saved. */
  log: readonly LogEntry[];
  /** What the rule has handled beyond its entries; null for a log from before the ledger. */
  ledger?: HandledLedger | null | undefined;
  today: string;
}): Promise<RuleTarget> {
  // A note a period asks afresh each period (#40): what it answered last week is this week's too —
  // unless none of the notes it reads changed since, which its versions say (see `askClaude`).
  if (rule.when.kind !== 'note' && writesOneNoteAPeriod(rule) && rule.which.trim() !== '') {
    return planWithVersions({ ports, rule, today });
  }
  if (rule.when.kind !== 'note' && (rule.action.kind !== 'claude' || writesOneNoteAPeriod(rule))) {
    return { plan: await planRun({ ports, rule, today }), versions: null };
  }
  const matched = await matchedPaths({ ports, rule, today });
  const held = await heldEntries(ports.index);
  const handled = handledVersions(log, { ledger, holds: digestsHeld(held) });
  const keyed = await withHandledKeys({
    fs: ports.fs,
    markdown: ports.markdown,
    rule,
    versions: versionsNow(held, matched),
  });
  const versions = unhandledVersions(keyed, handled);
  const plan = await planMatched({
    ports,
    action: rule.action,
    matched: versions.map((version) => version.path),
  });
  return { plan, versions };
}

/** A rule on a clock planned over every note its query matches, with the version each has now. */
async function planWithVersions({
  ports,
  rule,
  today,
}: {
  ports: RuleQueryPorts;
  rule: PlanRule;
  today: string;
}): Promise<RuleTarget> {
  const matched = await matchedPaths({ ports, rule, today });
  const plan = await planMatched({ ports, action: rule.action, matched });
  const versions = versionsNow(await heldEntries(ports.index), matched);
  return { plan, versions };
}

/**
 * What a rule does for the versions the change feed reported: its query asked
 * among those notes alone. Past the most one run may do, the rest wait for a
 * run by hand, and the run says it stopped short.
 */
export async function planForVersions({
  ports,
  rule,
  versions,
  today,
}: {
  ports: RuleQueryPorts;
  rule: PlanRule;
  versions: readonly NoteVersionRef[];
  today: string;
}): Promise<RuleTarget> {
  const taken = versions.slice(0, MAX_ACTIONS_PER_RUN);
  const among = taken.map((version) => version.path);
  const plan = await planRun({ ports, rule, today, among });
  return {
    plan: { ...plan, capped: plan.capped || versions.length > taken.length },
    versions: taken,
  };
}

/**
 * The version of each note the index holds now, that a rule may hear: a note
 * it does not hold is left out, and so is one not let in where meeting files land.
 */
function versionsNow(
  held: ReadonlyMap<string, IndexEntry>,
  paths: readonly VaultPath[],
): NoteVersionRef[] {
  return paths.flatMap((path) => {
    const entry = held.get(path);
    return entry === undefined ||
      !isInPlay({ path, importOutcome: entry.importOutcome, importDeclared: entry.importDeclared })
      ? []
      : [{ path, digest: entry.digest }];
  });
}

/** What a path holds in the index now, for telling one note from another with the same bytes. */
export const digestsHeld =
  (held: ReadonlyMap<string, IndexEntry>) =>
  (path: string): string | undefined =>
    held.get(path)?.digest;

/**
 * What a rule has handled, as its log and ledger say and the index shows the
 * notes now: read at the moment a run decides, so a note that moved is told
 * from a different note with the same bytes.
 */
export async function handledNow({
  index,
  log,
  held,
}: {
  index: IndexPort;
  log: Pick<RuleLog, 'entries' | 'ledger'>;
  /** The index's notes, when the caller has already read them. */
  held?: ReadonlyMap<string, IndexEntry>;
}): Promise<HandledVersions> {
  const notes = held ?? (await heldEntries(index));
  return handledVersions(log.entries, { ledger: log.ledger, holds: digestsHeld(notes) });
}

/**
 * {@link handledNow} for the versions one sync reported, asking the index only
 * when one of them might be handled: a feed with nothing the rule has seen
 * costs it no query.
 */
export async function handledAmong({
  index,
  log,
  versions,
}: {
  index: IndexPort;
  log: Pick<RuleLog, 'entries' | 'ledger'>;
  versions: readonly NoteVersionRef[];
}): Promise<HandledVersions> {
  const anywhere = handledVersions(log.entries, { ledger: log.ledger });
  // Only words answered elsewhere need to know what the notes hold now.
  const needsIndex = versions.some(
    (version) => anywhere.has(version) && !anywhere.hasHere(version),
  );
  return needsIndex ? handledNow({ index, log }) : anywhere;
}

/**
 * The meetings a `created` rule never ran on, though the import let them in
 * since the rule was last saved (`missedArrivals` says which): read from the
 * index as it is now and the rule's own file. A rule whose file cannot be
 * read has none — there is no saying since when it has been listening.
 */
export async function arrivalsMissed({
  fs,
  markdown,
  held,
  rule,
  trigger,
  handled,
}: {
  fs: Pick<VaultFsPort, 'readTextFile' | 'readNotes'>;
  markdown: Pick<MarkdownPort, 'frontmatterProperties'>;
  held: ReadonlyMap<string, IndexEntry>;
  rule: Pick<AutomationRule, 'path' | 'action'>;
  trigger: NoteTrigger;
  handled: HandledVersions;
}): Promise<NoteVersionRef[]> {
  let since: number | null;
  try {
    since = writtenAt(await fs.readTextFile(rule.path));
  } catch {
    // Safe to go without: nothing is caught up with, and a run by hand takes what was missed.
    return [];
  }
  // A vault that cannot tell when the rule was saved cannot tell what arrived since (ADR-0053).
  if (since === null) return [];
  const notes = [...held.values()].map((entry) => ({
    ...entry,
    path: createVaultPath(entry.path),
  }));
  const missed = missedArrivals({ trigger, notes, handled, since });
  // A note whose words were answered at another version (Accept wrote its tasks) was not missed.
  const keyed = await withHandledKeys({ fs, markdown, rule, versions: missed });
  return unhandledVersions(keyed, handled);
}

/**
 * The versions a run acted on, as its log records them so they never set it
 * off again. A version it did not act on is not recorded: heard again, it is
 * looked at again.
 */
export function handledBy(
  versions: readonly NoteVersionRef[],
  done: readonly DoneAction[],
): LoggedVersion[] {
  const actedOn = new Set(done.map((action) => ('path' in action ? action.path : action.from)));
  return versions
    .filter((version) => actedOn.has(version.path))
    .map((version) => ({ ...version, wrote: false }));
}

/**
 * The version each note a run changed or moved was left at, read back from
 * the disk, so the rule's own write does not set it off again.
 *
 * Notes an archive rewrote links in are not among them. Read back, a note's
 * bytes cannot say whether someone also saved it since the index last looked,
 * and taking such an edit for the rule's own would mean it is never heard.
 * Heard instead, a relinked note sets the rule off at most once, and a run
 * that finds it as the rule leaves it costs nothing: it is neither logged
 * nor counted.
 */
export async function writtenBy({
  fs,
  done,
}: {
  fs: Pick<VaultFsPort, 'readNotes'>;
  done: readonly DoneAction[];
}): Promise<LoggedVersion[]> {
  const written = [...new Set(done.map((action) => ('path' in action ? action.path : action.to)))];
  if (written.length === 0) return [];
  return (await fs.readNotes(written)).map((file) => ({
    path: createVaultPath(file.path),
    digest: digestOf(file.text),
    wrote: true,
  }));
}

/**
 * A rule notes set off that has run as often in the last hour as one may
 * (`NOTE_RUNS_PER_HOUR`), or whose step has asked Claude as often as the
 * vault's one allowance, shared by every declared step, lets it (`budget`, #179). It is held back until `until`, when the
 * hour allows another run; what it heard meanwhile is run on then.
 */
export class NoteRunsCappedError extends Error {
  constructor(
    readonly until: LocalTime,
    budget: ClaudeStepBudget,
  ) {
    super(noteRunsCappedProblem(until, budget));
    this.name = 'NoteRunsCappedError';
  }
}
