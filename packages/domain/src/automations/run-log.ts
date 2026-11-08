/**
 * An automation's run log (P25-02): what each run did, in a markdown note a
 * person can read, and exact enough that the last run can be undone from it.
 *
 * Each entry is a `##` section — when, and what happened — then one line per
 * thing done. Paths and values are written as JSON inside code spans, so a
 * note called `a → b.md` or a value with quotes in it reads back as it was:
 *
 * ```markdown
 * ## 2026-09-27 03:00:12 · Ran on schedule
 *
 * Archived 2 notes. Left 1 alone.
 *
 * - archived `"Tasks/A.md"` → `"Archive/Tasks/A.md"`
 * - set `"Tasks/B.md"` `"status"`: `"todo"` → `"done"`
 * - left `"Tasks/C.md"`: It is open in DFAI with unsaved typing.
 * ```
 *
 * A rule a note sets off (P29-01) also writes which version of each note it
 * handled, and the version its own write left, so neither sets it off again:
 *
 * ```markdown
 * - triggered by `"Inbox/Meetings/Standup.md"` at `"1a2b3c4d"`
 * - wrote `"Inbox/Meetings/Standup.md"` at `"5e6f7a8b"`
 * ```
 *
 * And a note of its type it had handled that was deleted, so a new note made
 * at that path later — even from the same bytes — is new to it:
 *
 * ```markdown
 * - went `"Inbox/Meetings/Standup.md"`
 * ```
 *
 * And a note it had handled that moved — tidied into its month, filed,
 * renamed — so the note where it is now is the one it handled, not a new one
 * (#214): its history goes with it, with the version it moved as.
 *
 * ```markdown
 * - moved `"Inbox/Meetings/Standup.md"` to `"Meetings/2026/10/Standup.md"` at `"9c8b7a6d"`
 * ```
 *
 * A rule's Claude step (P29-03) writes what it made — never an edit — and
 * which model answered, and how long it took:
 *
 * ```markdown
 * - proposed `"Inbox/Proposals/Send the payroll file.md"`
 * - created `"Briefs/Morning brief.md"`
 * - claude `"claude-opus-5-5"` in `4210` ms
 * ```
 *
 * A note too long to show the model whole is said, with how much it saw, so
 * a transcript read in part is never taken for one read whole:
 *
 * ```markdown
 * - cut `"Meetings/2026-10-01 Standup.md"`: read `19874` of `48211` characters
 * ```
 *
 * An output that reads a long meeting in parts (P29-05) says how many times it
 * asked, and names each item it left out of an answer it otherwise kept:
 *
 * ```markdown
 * - asked `3` times
 * - adjusted `"Send the contract"`: Its "due" "Friday" is not a date written YYYY-MM-DD, so it has no due date, and one step less confidence.
 * - dropped `"Send the contract"`: Vendor call has no transcript turn ^t0099 that Claude was shown.
 * ```
 *
 * The declared step (ADR-0036) says, for each meeting, how many of its
 * action items it made the owner's tasks and how many it proposed:
 *
 * ```markdown
 * - meeting `"Inbox/Meetings/Standup.md"`: tasks `2`, proposals `1`
 * ```
 *
 * A Claude step that writes one note a period (#40, ADR-0028) says which
 * period the note is for — the time its schedule fell due, and the item it
 * is about when there is one — so a second run in that period makes nothing:
 *
 * ```markdown
 * - period `"2026-10-23T15:00:00"`
 * - period `"2026-10-23T07:00:00"` for `"Meetings/2026-10-23 Standup.md"`
 * ```
 *
 * New entries go at the end; past {@link MAX_LOG_ENTRIES} the oldest go, so
 * the file stays a size a person will read.
 */

import { createVaultPath, type VaultPath } from '../vault/vault-path.ts';
import { noteTitle } from '../vault/vault-entry.ts';
import { AUTOMATIONS_DIRECTORY } from '../vault/vault-visibility.ts';
import { truncated } from './answer-limits.ts';
import {
  formatLedger,
  isEmptyLedger,
  layOver,
  ledgerFromEntries,
  locateLedger,
  markOf,
  pruneLedger,
  recordRun,
  recordStored,
  type HandledLedger,
  type StoredAnswerDraft,
} from './handled-ledger.ts';
import { splitSections, utf8Length } from './log-sections.ts';
import { code, JSON_SPAN } from './log-spans.ts';
import type { PassedOver } from './automation-plan.ts';
import type { NoteCut } from './answered-note.ts';
import type { DroppedItem } from './proposal-schema.ts';
import { CLAUDE_NOTES_PER_RUN } from './claude-step.ts';
import type { NoteVersionRef } from './note-trigger.ts';
import { localTimeMs, type LocalTime } from './schedule.ts';
import type { OutputPeriod } from './output-period.ts';
import type { ModelUsage } from '../chat/model-usage.ts';
import { usageLine, usageOf } from './usage-log-line.ts';

export const MAX_LOG_ENTRIES = 100;
export const LOG_MARKER_VALUE = 'automation-log';

/** What a property held before a rule set it: a value, or no such key at all. */
export type PriorValue = { readonly absent: true } | { readonly value: unknown };

/**
 * The summary a run wrote over (#185): the block as it was, and the keys it
 * was written with, so undoing the run puts that summary back. Its digest is
 * the block's own.
 */
export interface ReplacedSummary {
  readonly block: string;
  readonly of: string | null;
  readonly model: string | null;
}

/** One thing a run, or an undo, did to one note. */
export type DoneAction =
  | { readonly kind: 'archived'; readonly from: VaultPath; readonly to: VaultPath }
  /** A Claude step made a proposal. */
  | { readonly kind: 'proposed'; readonly path: VaultPath }
  /**
   * A Claude step made the one new note its rule asks for, or the declared
   * step one of the owner's tasks — with the digest of what it wrote, so undo
   * trashes it only while it is unchanged (#185).
   */
  | { readonly kind: 'created'; readonly path: VaultPath; readonly digest?: string }
  /**
   * The declared step wrote a meeting's summary block, whose digest this is,
   * with its keys and the meeting's `tasks` (#185): undo takes the block out
   * while it is still this one — or, when it was written over an earlier
   * summary (`replaced`), puts that one back.
   */
  | {
      readonly kind: 'summarised';
      readonly path: VaultPath;
      readonly digest: string;
      readonly replaced?: ReplacedSummary;
    }
  /** Undo trashed a task the declared step made, unchanged since. */
  | { readonly kind: 'trashed'; readonly path: VaultPath }
  /** Undo took a meeting's summary block, its keys and its trashed tasks' links back out. */
  | { readonly kind: 'unsummarised'; readonly path: VaultPath }
  | { readonly kind: 'unarchived'; readonly from: VaultPath; readonly to: VaultPath }
  | {
      readonly kind: 'set' | 'restored';
      readonly path: VaultPath;
      readonly key: string;
      readonly before: PriorValue;
      readonly after: PriorValue;
    };

/** What started a run. */
export type RunTrigger = 'schedule' | 'open' | 'hand' | 'note';

/** A note version a run of a note-triggered rule handled, or left by its own write. */
export interface LoggedVersion extends NoteVersionRef {
  /** True for the version the run's own write left; false for one that was handled. */
  readonly wrote: boolean;
}

/** A note a rule had handled that moved: where from, and the version it is where it is now. */
export interface MovedVersion extends NoteVersionRef {
  readonly from: VaultPath;
}

/** Which model a Claude step asked, and how long it took to answer — or to fail. */
export interface ClaudeRunInfo {
  readonly model: string;
  readonly ms: number;
  /**
   * The notes it was shown only the start of — a long transcript, say — so
   * whoever reads the log knows what the model never saw; left out when it
   * read every note whole.
   */
  readonly cut?: readonly NoteCut[];
  /**
   * How many times the model was asked, once it was: what the hourly cap
   * counts. Left out when it was never asked (a prompt that could not be
   * read, a provider that was not ready), which costs nothing.
   */
  readonly asks?: number;
  /** The items of its answers it left out while keeping the rest, each with why. */
  readonly dropped?: readonly DroppedItem[];
  /** The items it kept with a fault put right (a due date that was no date), each with what. */
  readonly adjusted?: readonly DroppedItem[];
  /** Things the person should know about how the run went, said once each (a relation the Meeting type lacks). */
  readonly warnings?: readonly string[];
  /**
   * How many of the proposals it answered with were made before — by an
   * earlier run, open or answered since — and so were not made again; left
   * out when none were.
   */
  readonly alreadyMade?: number;
  /**
   * For the declared step (ADR-0036): what it made of each meeting it read,
   * in the order read. Left out for any other step.
   */
  readonly meetings?: readonly MeetingTally[];
  /**
   * The tokens its asks spent, summed (#788); left out when any ask's usage
   * is unknown — a provider that said none — so a total is never too low.
   */
  readonly usage?: ModelUsage;
}

/** What the declared step made of one meeting's action items. */
export interface MeetingTally {
  readonly path: VaultPath;
  /** The owner's tasks it made. */
  readonly tasks: number;
  /** The proposals it made: the rest, less any made before. */
  readonly proposals: number;
  /** The items it left out as not the owner's, or not sure enough (#226); none when absent. */
  readonly leftOut?: number;
  /** For a step that summarises: the action items its summary lists. */
  readonly listed?: number;
  /** For a step that summarises: what became of the meeting's summary. */
  readonly summary?: SummaryOutcome;
}

/**
 * What became of a meeting's summary (#185): written at the top; left as the
 * person has it (edited, taken out, or not a block DFAI can read); dropped,
 * its answer not reading; or none to write, the meeting being a backfill of
 * nothing new.
 */
export type SummaryOutcome = 'written' | 'kept' | 'dropped';

const SUMMARY_OUTCOMES: readonly SummaryOutcome[] = ['written', 'kept', 'dropped'];

/** The longest an item's title runs in a log line: it is a model's, and a line is not a note. */
const MAX_DROPPED_TITLE = 120;

export type LogEntry =
  | {
      readonly kind: 'run';
      readonly at: LocalTime;
      readonly trigger: RunTrigger;
      readonly done: readonly DoneAction[];
      readonly left: readonly PassedOver[];
      readonly capped: boolean;
      /** For a rule a note sets off: the versions it handled and the ones it wrote. */
      readonly versions?: readonly LoggedVersion[];
      /** For a rule a note sets off: notes it had handled that were deleted, ending their history. */
      readonly went?: readonly VaultPath[];
      /** For a rule a note sets off: notes it had handled that moved, their history going with them. */
      readonly moved?: readonly MovedVersion[];
      /** For a Claude step: the model it asked. */
      readonly claude?: ClaudeRunInfo;
      /** For a step that writes one note a period: the period it wrote it for, or found it written. */
      readonly period?: OutputPeriod;
    }
  | {
      readonly kind: 'undo';
      readonly at: LocalTime;
      /** When the run it undid ran. */
      readonly of: LocalTime;
      readonly done: readonly DoneAction[];
      readonly left: readonly PassedOver[];
    }
  /** A run that could not start — its query did not read — or whose Claude step failed, and why. */
  | {
      readonly kind: 'failed';
      readonly at: LocalTime;
      readonly trigger: RunTrigger;
      readonly problem: string;
      /** For a Claude step that was asked: the model, and how long until it failed. */
      readonly claude?: ClaudeRunInfo;
      /** For a Claude step cut off part-way: what it had already made, which stays. */
      readonly done?: readonly DoneAction[];
    }
  | { readonly kind: 'turnedOn'; readonly at: LocalTime }
  /** A rule DFAI found that had never run nor been turned on here: its schedule counts from then. */
  | { readonly kind: 'seen'; readonly at: LocalTime }
  /**
   * A rule a note sets off that, while it could not run — held back by the
   * hour's cap, failing, or waiting for the index — heard more syncs' news
   * than it holds, and let the oldest go. Not a run: it counts toward nothing.
   */
  | { readonly kind: 'letGo'; readonly at: LocalTime; readonly count: number };

/**
 * The most a log holds, in bytes, whatever its entries' count: a run that
 * changed 500 notes writes a long entry, and a hundred of those is no note a
 * person will read, nor one worth re-reading every minute.
 */
export const MAX_LOG_BYTES = 256 * 1024;

/** Where a rule's log is kept: beside the rules, under `log/`, named after the rule's id. */
export function logPathFor(ruleId: string): VaultPath {
  return createVaultPath(`${AUTOMATIONS_DIRECTORY}/log/${ruleId}.md`);
}

const TRIGGER_WORDS: Readonly<Record<RunTrigger, string>> = {
  schedule: 'Ran on schedule',
  open: 'Ran when DFAI opened',
  hand: 'Ran by hand',
  note: 'Ran when a note appeared or changed',
};

/** A wall-clock time as a heading shows it: a space where ISO has the `T`. */
const shown = (time: LocalTime): string => time.replace('T', ' ');

const prior = (value: PriorValue): string => ('absent' in value ? 'nothing' : code(value.value));

const LET_GO_HEADING = 'Let news go';

/** What an entry was, as its heading says after the time: "Ran on schedule". */
export function logEntryHeading(entry: LogEntry): string {
  switch (entry.kind) {
    case 'run':
      return TRIGGER_WORDS[entry.trigger];
    case 'failed':
      return `${TRIGGER_WORDS[entry.trigger]}, and could not`;
    case 'undo':
      return `Undid the run of ${shown(entry.of)}`;
    case 'turnedOn':
      return 'Turned on';
    case 'seen':
      return 'First seen';
    case 'letGo':
      return LET_GO_HEADING;
  }
}

function actionLine(action: DoneAction): string {
  if (action.kind === 'archived' || action.kind === 'unarchived') {
    return `- ${action.kind} ${code(action.from)} → ${code(action.to)}`;
  }
  if (action.kind === 'proposed' || action.kind === 'created') {
    const at =
      action.kind === 'created' && action.digest !== undefined ? ` at ${code(action.digest)}` : '';
    return `- ${action.kind} ${code(action.path)}${at}`;
  }
  if (action.kind === 'summarised') {
    const over = action.replaced === undefined ? '' : ` over ${code(action.replaced)}`;
    return `- summarised ${code(action.path)} at ${code(action.digest)}${over}`;
  }
  if (action.kind === 'trashed' || action.kind === 'unsummarised') {
    return `- ${action.kind} ${code(action.path)}`;
  }
  const change = `${prior(action.before)} → ${prior(action.after)}`;
  return `- ${action.kind} ${code(action.path)} ${code(action.key)}: ${change}`;
}

/** A sentence for the entry, above its lines. */
export function logEntrySummary(entry: LogEntry): string {
  if (entry.kind === 'turnedOn' || entry.kind === 'seen') {
    return 'It runs on its schedule from here on.';
  }
  // A failure's words can be a model's (a tool it named, a title it chose): bounded, as the log is.
  if (entry.kind === 'failed') return oneLine(truncated(entry.problem));
  if (entry.kind === 'letGo') return letGoWords(entry.count);
  if (entry.kind === 'run' && entry.period !== undefined && !madeANote(entry)) {
    return `Its note for ${shown(entry.period.slot)} is made already: nothing new.`;
  }
  const askedForNothing =
    entry.kind === 'run' && entry.claude !== undefined && entry.done.length === 0;
  const meetings = 'claude' in entry ? (entry.claude?.meetings ?? []) : [];
  const counts =
    entry.kind === 'run' &&
    meetings.some(
      ({ tasks, proposals, leftOut = 0, summary }) =>
        tasks + proposals + leftOut > 0 || summary !== undefined,
    )
      ? meetingWords(meetings, entry.claude)
      : askedForNothing
        ? nothingProposedWords(entry.claude)
        : countDone(entry.done);
  const left = entry.left.length === 0 ? '' : ` Left ${entry.left.length} alone.`;
  // The cap counts notes: a rule setting two properties makes two lines per note.
  const notes = new Set(entry.done.map((action) => ('path' in action ? action.path : action.from)));
  const capped = entry.kind === 'run' && entry.capped ? cappedWords(entry, notes.size) : '';
  const claude = 'claude' in entry ? entry.claude : undefined;
  return `${counts}${left}${capped}${cutWords(claude?.cut ?? [])}${droppedWords(claude?.dropped ?? [])}${adjustedWords(claude?.adjusted ?? [])}${warningWords(claude?.warnings ?? [])}`;
}

const madeANote = (entry: Extract<LogEntry, { kind: 'run' }>): boolean =>
  entry.done.some((action) => action.kind === 'created');

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What the declared step says it made of each meeting: "Made 2 tasks from
 * Standup, 1 proposal." — and, when it summarises, "Summary written by
 * claude-sonnet-5-5 in 41 s for Standup; 2 tasks made, 3 items listed, 1
 * proposal."
 */
function meetingWords(meetings: readonly MeetingTally[], claude?: ClaudeRunInfo): string {
  return meetings
    .map((tally) =>
      tally.summary === undefined
        ? `Made ${count(tally.tasks, 'task', 'tasks')} from ${noteTitle(tally.path)}, ${count(tally.proposals, 'proposal', 'proposals')}${leftOutWords(tally)}.`
        : summaryWords(tally, claude),
    )
    .join(' ');
}

function summaryWords(tally: MeetingTally, claude?: ClaudeRunInfo): string {
  const title = noteTitle(tally.path);
  const by =
    claude === undefined
      ? ''
      : ` by ${claude.model} in ${Math.max(0, Math.round(claude.ms / 1000))} s`;
  const head =
    tally.summary === 'written'
      ? `Summary written${by} for ${title}`
      : tally.summary === 'kept'
        ? `Summary of ${title} left as you have it`
        : `No summary for ${title}: Claude’s did not read`;
  const made = [
    `${count(tally.tasks, 'task', 'tasks')} made`,
    `${count(tally.listed ?? 0, 'item', 'items')} listed`,
    count(tally.proposals, 'proposal', 'proposals'),
  ];
  return `${head}; ${made.join(', ')}${leftOutWords(tally)}.`;
}

/** ", left out 3 items" when the step left some out as not the owner's or not sure enough. */
function leftOutWords({ leftOut = 0 }: MeetingTally): string {
  return leftOut === 0 ? '' : `, left out ${count(leftOut, 'item', 'items')}`;
}

/** What a run says of what the person should know. */
function warningWords(warnings: readonly string[]): string {
  return warnings.map((warning) => ` ${oneLine(truncated(warning))}`).join('');
}

/** What a run says when it kept items with a fault put right. */
function adjustedWords(adjusted: readonly DroppedItem[]): string {
  if (adjusted.length === 0) return '';
  return ` Put right ${adjusted.length === 1 ? '1 item' : `${adjusted.length} items`} (see the log).`;
}

/** What a run says when it left items out of an answer it kept. */
function droppedWords(dropped: readonly DroppedItem[]): string {
  if (dropped.length === 0) return '';
  const items = dropped.length === 1 ? '1 item' : `${dropped.length} items`;
  return ` Left out ${items} of the answer that did not read.`;
}

/**
 * What a Claude step that made nothing says: that it proposed nothing — or,
 * when what it proposed was all made before, that there was nothing new.
 */
function nothingProposedWords(claude: ClaudeRunInfo | undefined): string {
  const already = claude?.alreadyMade ?? 0;
  return already > 0
    ? `Nothing new to propose (${already} already made).`
    : 'Claude proposed nothing.';
}

/** What a rule that let news go says: how much, and that a run by hand takes the notes it named. */
function letGoWords(count: number): string {
  const syncs = count === 1 ? '1 sync' : `${count} syncs`;
  return `Let go of the news of ${syncs}: more arrived than it holds while it cannot run. Run it by hand to take the notes they named.`;
}

/** What a run says when a note was too long to show the model whole. */
function cutWords(cut: readonly NoteCut[]): string {
  if (cut.length === 0) return '';
  const notes = cut.length === 1 ? '1 note was' : `${cut.length} notes were`;
  return ` ${notes} too long to read whole: Claude saw only the start.`;
}

/** What a run that stopped short says; a Claude step is held to fewer notes, and the rest wait for a run by hand. */
function cappedWords(entry: Extract<LogEntry, { kind: 'run' }>, changed: number): string {
  return entry.claude === undefined
    ? ` Stopped at ${changed}, the most one run may do; the rest wait for the next run.`
    : ` ${CLAUDE_CAPPED}`;
}

function countDone(done: readonly DoneAction[]): string {
  const notes = (count: number) => `${count} ${count === 1 ? 'note' : 'notes'}`;
  const tally = (kind: DoneAction['kind']) => done.filter((action) => action.kind === kind).length;
  const changed = new Set(done.flatMap((action) => (action.kind === 'set' ? [action.path] : [])))
    .size;
  const restored = new Set(
    done.flatMap((action) => (action.kind === 'restored' ? [action.path] : [])),
  ).size;
  const proposals = (count: number) => `${count} ${count === 1 ? 'proposal' : 'proposals'}`;
  const parts = [
    tally('archived') > 0 ? `Archived ${notes(tally('archived'))}.` : '',
    tally('unarchived') > 0 ? `Put back ${notes(tally('unarchived'))}.` : '',
    changed > 0 ? `Changed ${notes(changed)}.` : '',
    restored > 0 ? `Restored ${notes(restored)}.` : '',
    tally('proposed') > 0 ? `Made ${proposals(tally('proposed'))}.` : '',
    tally('created') > 0 ? `Made ${notes(tally('created'))}.` : '',
    tally('trashed') > 0 ? `Trashed ${notes(tally('trashed'))}.` : '',
    tally('unsummarised') > 0
      ? `Took the summary off ${tally('unsummarised') === 1 ? '1 meeting' : `${tally('unsummarised')} meetings`}.`
      : '',
  ].filter((part) => part !== '');
  return parts.length === 0 ? 'Nothing to do.' : parts.join(' ');
}

function claudeLines({
  model,
  ms,
  cut = [],
  asks,
  alreadyMade = 0,
  dropped = [],
  adjusted = [],
  warnings = [],
  meetings = [],
  usage,
}: ClaudeRunInfo): string[] {
  return [
    `- claude ${code(model)} in ${code(ms)} ms`,
    ...(usage === undefined ? [] : [usageLine(usage)]),
    ...meetings.map(
      ({ path, tasks, proposals, listed, summary, leftOut }) =>
        `- meeting ${code(path)}: tasks ${code(tasks)}, proposals ${code(proposals)}${
          summary === undefined ? '' : `, listed ${code(listed ?? 0)}, summary ${code(summary)}`
        }${leftOut === undefined ? '' : `, left out ${code(leftOut)}`}`,
    ),
    ...(asks === undefined ? [] : [`- asked ${code(asks)} ${asks === 1 ? 'time' : 'times'}`]),
    ...(alreadyMade > 0 ? [`- already made ${code(alreadyMade)}`] : []),
    ...cut.map(
      ({ path, shown, of }) => `- cut ${code(path)}: read ${code(shown)} of ${code(of)} characters`,
    ),
    ...dropped.map(
      ({ title, reason }) =>
        `- dropped ${code(truncated(oneLine(title), MAX_DROPPED_TITLE))}: ${oneLine(truncated(reason))}`,
    ),
    ...warnings.map((warning) => `- warned: ${oneLine(truncated(warning))}`),
    ...adjusted.map(
      ({ title, reason }) =>
        `- adjusted ${code(truncated(oneLine(title), MAX_DROPPED_TITLE))}: ${oneLine(truncated(reason))}`,
    ),
  ];
}

const periodLine = ({ slot, item }: OutputPeriod): string =>
  `- period ${code(slot)}${item === undefined ? '' : ` for ${code(item)}`}`;

const movedLine = ({ from, path, digest }: MovedVersion): string =>
  `- moved ${code(from)} to ${code(path)} at ${code(digest)}`;

function versionLine({ path, digest, wrote, keys = [] }: LoggedVersion): string {
  const also = keys.length === 0 ? '' : ` also ${code(keys)}`;
  return `- ${wrote ? 'wrote' : 'triggered by'} ${code(path)} at ${code(digest)}${also}`;
}

/** One entry, as the markdown the log holds. */
export function formatLogEntry(entry: LogEntry): string {
  const lines = [`## ${shown(entry.at)} · ${logEntryHeading(entry)}`, '', logEntrySummary(entry)];
  const done = 'done' in entry ? entry.done.map(actionLine) : [];
  const left =
    'left' in entry
      ? entry.left.map(({ path, reason }) => `- left ${code(path)}: ${oneLine(truncated(reason))}`)
      : [];
  const versions = entry.kind === 'run' ? (entry.versions ?? []).map(versionLine) : [];
  const went = entry.kind === 'run' ? (entry.went ?? []).map((path) => `- went ${code(path)}`) : [];
  const moved = entry.kind === 'run' ? (entry.moved ?? []).map(movedLine) : [];
  const claude = 'claude' in entry && entry.claude !== undefined ? claudeLines(entry.claude) : [];
  const letGo = entry.kind === 'letGo' ? [`- let go ${code(entry.count)}`] : [];
  const period =
    entry.kind === 'run' && entry.period !== undefined ? [periodLine(entry.period)] : [];
  const memory = [...went, ...moved];
  const said = [...done, ...left, ...versions, ...memory, ...claude, ...period];
  if (said.length > 0) lines.push('', ...said);
  if (letGo.length > 0) lines.push('', ...letGo);
  return `${lines.join('\n')}\n`;
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** A new log's text, for the rule named. */
export function newLogText(ruleName: string, entries: readonly LogEntry[]): string {
  const head = `---\natlas: ${LOG_MARKER_VALUE}\n---\n\n# ${oneLine(ruleName)} — run log\n\n`;
  return head + entries.map(formatLogEntry).join('\n');
}

/** The log with one more entry, and whether its handled ledger had to be mended to write it. */
export interface AppendedLog {
  readonly text: string;
  /** True when the ledger did not add up — a line lost, two ledgers, a format unknown — and was rebuilt. */
  readonly ledgerRepaired: boolean;
}

/**
 * The log with one more entry: the text before the first entry kept as it
 * was, the oldest entries dropped past the most a log keeps — by count and by
 * bytes, the ledger's own counted. A section that is no entry — a person's
 * own `## Notes` — is theirs, and is never what makes room.
 *
 * What the rule has handled is not the entries' to hold (they are dropped):
 * the handled ledger, a section of its own at the top, is brought up to date
 * in this same write, with whatever runs an older DFAI added after it laid
 * over it first, and is built from the entries the first time a log without
 * one is added to. `now` is the clock's instant: it dates what the ledger
 * records and what it prunes, and is never derived from an entry's heading,
 * which is the person's wall clock. A ledger that did not add up is rebuilt
 * from the entries still here and vouches only from `now`, which the result
 * says. A notice that news was let go, written right after another, joins
 * it, their counts summed: a burst is one entry and pushes no run out.
 */
export function appendEntryToLog({
  text,
  ruleName,
  entry,
  now,
  keep = MAX_LOG_ENTRIES,
  maxBytes = MAX_LOG_BYTES,
  maxLedgerRecords,
  stored = [],
}: {
  /** The log as it is; null when there is none yet. */
  text: string | null;
  ruleName: string;
  entry: LogEntry;
  /** The model's answers a run read and could not finish with, kept in the ledger for its retry (ADR-0036). */
  stored?: readonly StoredAnswerDraft[];
  /** The instant the entry is written, from the clock. */
  now: number;
  keep?: number;
  maxBytes?: number;
  maxLedgerRecords?: number;
}): AppendedLog {
  const { head, sections: existing } =
    text === null ? { head: newLogText(ruleName, []), sections: [] } : splitSections(text);
  const found = locateLedger(existing);
  const sections = existing.filter((_, at) => !found.at.includes(at));
  const folded = foldLetGo(sections, entry);
  const ledger = ledgerAfter({
    before: found.ledger,
    entries: entriesOf(sections),
    entry,
    written: folded.entry,
    now,
    keep,
    maxLedgerRecords,
    stored,
  });
  const ledgerText =
    found.ledger === null && isEmptyLedger(ledger) ? '' : `${formatLedger(ledger)}\n`;
  const all = [...folded.sections, formatLogEntry(folded.entry)].map((section) =>
    section.replace(/\n*$/, '\n'),
  );
  const isEntry = all.map((section) => parseSection(section) !== null);
  const bytes = all.map((section) => utf8Length(section) + 1);
  let entries = isEntry.filter(Boolean).length;
  let total =
    utf8Length(head) + utf8Length(ledgerText) + bytes.reduce((sum, size) => sum + size, 0);
  const dropped = new Set<number>();
  const pinned = lastPeriodMade(all);
  // The newest entry, the one being added, always stays; so does the one that made a period's note.
  for (let at = 0; at < all.length - 1 && (entries > keep || total > maxBytes); at += 1) {
    if (!isEntry[at] || at === pinned) continue;
    dropped.add(at);
    entries -= 1;
    total -= bytes[at]!;
  }
  const kept = all.filter((_, at) => !dropped.has(at));
  return {
    text: `${head}${ledgerText}${kept.join('\n')}`,
    ledgerRepaired: found.ledger?.damaged === true,
  };
}

/**
 * Where the section is that last made a note for a period (#40), or -1. A log
 * that has outgrown its cap keeps it: the runs after it that found the note
 * made must not push out the only line that says it was.
 */
function lastPeriodMade(sections: readonly string[]): number {
  return sections.findLastIndex((section) => {
    const entry = parseSection(section);
    return (
      entry !== null &&
      entry.kind === 'run' &&
      entry.period !== undefined &&
      entry.done.some((action) => action.kind === 'created')
    );
  });
}

/** {@link appendEntryToLog}, for whoever wants only the text. */
export function appendLogEntry(args: Parameters<typeof appendEntryToLog>[0]): string {
  return appendEntryToLog(args).text;
}

function entriesOf(sections: readonly string[]): LogEntry[] {
  return sections.flatMap((section) => {
    const entry = parseSection(section);
    return entry === null ? [] : [entry];
  });
}

/**
 * The ledger once this entry is in: what it had not folded in laid over it, a
 * run recorded at `now`, what has aged out, overflowed or outgrown its bytes
 * let go, and the entry stamped as the last one folded in. One that did not
 * add up vouches from `now`.
 */
function ledgerAfter({
  before,
  entries,
  entry,
  written,
  now,
  keep,
  maxLedgerRecords,
  stored,
}: {
  before: HandledLedger | null;
  entries: readonly LogEntry[];
  entry: LogEntry;
  written: LogEntry;
  now: number;
  keep: number;
  maxLedgerRecords: number | undefined;
  stored: readonly StoredAnswerDraft[];
}): HandledLedger {
  const caught = before === null ? ledgerFromEntries(entries, keep) : layOver(before, entries);
  const mended = before?.damaged === true ? { ...caught, vouchesFrom: now } : caught;
  const ran = entry.kind === 'run' ? recordRun(mended, entry, now) : mended;
  const recorded = recordStored(ran, stored, now);
  const limits = maxLedgerRecords === undefined ? {} : { maxRecords: maxLedgerRecords };
  const pruned = pruneLedger(recorded, now, limits);
  return { ...pruned, through: markOf(written), damaged: false };
}

/** A let-go notice joins the one right before it, summing the counts; any other entry is added as it is. */
function foldLetGo(
  sections: readonly string[],
  entry: LogEntry,
): { sections: readonly string[]; entry: LogEntry } {
  const last = sections.length === 0 ? null : parseSection(sections[sections.length - 1]!);
  if (entry.kind !== 'letGo' || last?.kind !== 'letGo') return { sections, entry };
  return {
    sections: sections.slice(0, -1),
    entry: { kind: 'letGo', at: entry.at, count: last.count + entry.count },
  };
}

/** How a Claude step's log says it read only the first of the notes; parsed back as `capped`. */
const CLAUDE_CAPPED = `Read the first ${CLAUDE_NOTES_PER_RUN} notes, the most one Claude run takes; run it by hand for the rest.`;

const HEADING = /^## (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) · (.+)$/;
const PRIOR_SPAN = `(nothing|${JSON_SPAN})`;
const MOVE_LINE = new RegExp(`^- (archived|unarchived) ${JSON_SPAN} → ${JSON_SPAN}$`);
const MADE_LINE = new RegExp(`^- (proposed|created) ${JSON_SPAN}(?: at ${JSON_SPAN})?$`);
const SUMMARISED_LINE = new RegExp(
  `^- summarised ${JSON_SPAN} at ${JSON_SPAN}(?: over ${JSON_SPAN})?$`,
);
const TOOK_BACK_LINE = new RegExp(`^- (trashed|unsummarised) ${JSON_SPAN}$`);
const CLAUDE_LINE = new RegExp(`^- claude ${JSON_SPAN} in ${JSON_SPAN} ms$`);
const CUT_LINE = new RegExp(`^- cut ${JSON_SPAN}: read ${JSON_SPAN} of ${JSON_SPAN} characters$`);
const ASKED_LINE = new RegExp(`^- asked ${JSON_SPAN} times?$`);
const WARNED_LINE = /^- warned: (.*)$/;
const ADJUSTED_LINE = new RegExp(`^- adjusted ${JSON_SPAN}: (.*)$`);
const DROPPED_LINE = new RegExp(`^- dropped ${JSON_SPAN}: (.*)$`);
const SET_LINE = new RegExp(
  `^- (set|restored) ${JSON_SPAN} ${JSON_SPAN}: ${PRIOR_SPAN} → ${PRIOR_SPAN}$`,
);
const LEFT_LINE = new RegExp(`^- left ${JSON_SPAN}: (.*)$`);
const VERSION_LINE = new RegExp(
  `^- (triggered by|wrote) ${JSON_SPAN} at ${JSON_SPAN}(?: also ${JSON_SPAN})?$`,
);
const WENT_LINE = new RegExp(`^- went ${JSON_SPAN}$`);
const MOVED_LINE = new RegExp(`^- moved ${JSON_SPAN} to ${JSON_SPAN} at ${JSON_SPAN}$`);
const ALREADY_MADE_LINE = new RegExp(`^- already made ${JSON_SPAN}$`);
/** A code span capturing what is inside it under a name, so optional parts cannot shift each other's groups. */
const namedSpan = (name: string): string => `\`(?<${name}>[^\`]*)\``;
const MEETING_LINE = new RegExp(
  `^- meeting ${JSON_SPAN}: tasks ${JSON_SPAN}, proposals ${JSON_SPAN}` +
    `(?:, listed ${namedSpan('listed')}, summary ${namedSpan('summary')})?` +
    `(?:, left out ${namedSpan('leftOut')})?$`,
);
const LET_GO_LINE = new RegExp(`^- let go ${JSON_SPAN}$`);
const PERIOD_LINE = new RegExp(`^- period ${JSON_SPAN}(?: for ${JSON_SPAN})?$`);

/**
 * Reads a log back into its entries, oldest first. A section or line that does
 * not read — the log is a note, and a person may have edited it — is left out
 * rather than guessed at, so undo only ever does what the log exactly says.
 */
export function parseRunLog(text: string): LogEntry[] {
  return splitSections(text).sections.flatMap((section) => {
    const entry = parseSection(section);
    return entry === null ? [] : [entry];
  });
}

function parseSection(section: string): LogEntry | null {
  const [heading = '', ...rest] = section.split('\n');
  const match = HEADING.exec(heading.trim());
  if (match === null) return null;
  const at = `${match[1]}T${match[2]}`;
  const title = match[3]!;
  const body = rest.map((line) => line.trim());
  if (title === 'Turned on') return { kind: 'turnedOn', at };
  if (title === 'First seen') return { kind: 'seen', at };
  if (title === LET_GO_HEADING) {
    const count = countOn(body, LET_GO_LINE);
    return count === null ? null : { kind: 'letGo', at, count };
  }
  const undid = /^Undid the run of (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(title);
  if (undid !== null) {
    return { kind: 'undo', at, of: `${undid[1]}T${undid[2]}`, ...linesOf(body) };
  }
  const trigger = triggerOf(title.replace(/, and could not$/, ''));
  if (trigger === null) return null;
  const claude = claudeOf(body);
  const made = linesOf(body).done;
  if (title.endsWith(', and could not')) {
    return {
      kind: 'failed',
      at,
      trigger,
      problem: body.find((line) => line !== '') ?? '',
      ...(claude !== null && { claude }),
      ...(made.length > 0 && { done: made }),
    };
  }
  const capped = body.some(
    (line) => line.includes('the most one run may do') || line.includes(CLAUDE_CAPPED),
  );
  const versions = body.flatMap((line) => {
    const version = readVersion(line);
    return version === null ? [] : [version];
  });
  const went = body.flatMap((line) => {
    const path = readWent(line);
    return path === null ? [] : [path];
  });
  const moved = body.flatMap((line) => readMoved(line) ?? []);
  const period = periodOf(body);
  return {
    kind: 'run',
    at,
    trigger,
    capped,
    ...linesOf(body),
    ...(versions.length > 0 && { versions }),
    ...(went.length > 0 && { went }),
    ...(moved.length > 0 && { moved }),
    ...(claude !== null && { claude }),
    ...(period !== null && { period }),
  };
}

/** The period a run's line says it wrote its note for; null when none reads. */
function periodOf(body: readonly string[]): OutputPeriod | null {
  for (const line of body) {
    const match = PERIOD_LINE.exec(line);
    if (match === null) continue;
    try {
      const slot = JSON.parse(match[1]!) as unknown;
      const item = match[2] === undefined ? undefined : (JSON.parse(match[2]) as unknown);
      if (typeof slot !== 'string' || (item !== undefined && typeof item !== 'string')) return null;
      return item === undefined ? { slot } : { slot, item };
    } catch {
      // A line edited into JSON that does not read is left out, as any other line is.
      return null;
    }
  }
  return null;
}

/** The model a Claude step asked, from its line; null when there is none, or it does not read. */
function claudeOf(body: readonly string[]): ClaudeRunInfo | null {
  for (const line of body) {
    const match = CLAUDE_LINE.exec(line);
    if (match === null) continue;
    try {
      const model = JSON.parse(match[1]!) as unknown;
      const ms = JSON.parse(match[2]!) as unknown;
      if (typeof model === 'string' && typeof ms === 'number') {
        const cut = cutOf(body);
        const asks = asksOf(body);
        const dropped = droppedOf(body, DROPPED_LINE);
        const adjusted = droppedOf(body, ADJUSTED_LINE);
        const warnings = body.flatMap((line) => WARNED_LINE.exec(line)?.[1] ?? []);
        const alreadyMade = countOn(body, ALREADY_MADE_LINE);
        const meetings = meetingsOf(body);
        const usage = usageOf(body);
        return {
          model,
          ms,
          ...(cut.length > 0 && { cut }),
          ...(asks !== null && { asks }),
          ...(dropped.length > 0 && { dropped }),
          ...(adjusted.length > 0 && { adjusted }),
          ...(warnings.length > 0 && { warnings }),
          ...(alreadyMade !== null && { alreadyMade }),
          ...(meetings.length > 0 && { meetings }),
          ...(usage !== null && { usage }),
        };
      }
    } catch {
      // A line edited into JSON that does not read is left out, as any other line is.
    }
    return null;
  }
  return null;
}

/** The count the first line of this shape holds: a whole number above none; null when no line reads as one. */
function countOn(body: readonly string[], shape: RegExp): number | null {
  for (const line of body) {
    const match = shape.exec(line);
    if (match === null) continue;
    try {
      const count = JSON.parse(match[1]!) as unknown;
      if (typeof count === 'number' && Number.isInteger(count) && count > 0) return count;
    } catch {
      // A line edited into JSON that does not read is left out, as any other line is.
    }
  }
  return null;
}

/** What the declared step made of each meeting, from its lines; one that does not read is left out. */
function meetingsOf(body: readonly string[]): MeetingTally[] {
  return body.flatMap((line) => {
    const match = MEETING_LINE.exec(line);
    if (match === null) return [];
    try {
      const [tasks, proposals] = [
        JSON.parse(match[2]!) as unknown,
        JSON.parse(match[3]!) as unknown,
      ];
      if (!isCount(tasks) || !isCount(proposals)) return [];
      const summarised = summaryOf(match.groups?.listed, match.groups?.summary);
      const leftOut =
        match.groups?.leftOut === undefined
          ? undefined
          : (JSON.parse(match.groups.leftOut) as unknown);
      if (leftOut !== undefined && !isCount(leftOut)) return [];
      return [
        {
          path: pathOf(match[1]!),
          tasks,
          proposals,
          ...summarised,
          ...(leftOut !== undefined && { leftOut }),
        },
      ];
    } catch {
      // A line edited into JSON that does not read, or a path that is no path, is left out.
      return [];
    }
  });
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** A meeting line's summary, when it says one that reads; nothing otherwise. */
function summaryOf(
  listedJson: string | undefined,
  summaryJson: string | undefined,
): { listed: number; summary: SummaryOutcome } | Record<string, never> {
  if (listedJson === undefined || summaryJson === undefined) return {};
  const [listed, summary] = [JSON.parse(listedJson) as unknown, JSON.parse(summaryJson) as unknown];
  const known = SUMMARY_OUTCOMES.find((outcome) => outcome === summary);
  return isCount(listed) && known !== undefined ? { listed, summary: known } : {};
}

/** The notes a Claude step read only the start of, from its lines; one that does not read is left out. */
function cutOf(body: readonly string[]): NoteCut[] {
  return body.flatMap((line) => {
    const match = CUT_LINE.exec(line);
    if (match === null) return [];
    try {
      const [shown, of] = [JSON.parse(match[2]!) as unknown, JSON.parse(match[3]!) as unknown];
      if (typeof shown !== 'number' || typeof of !== 'number') return [];
      return [{ path: pathOf(match[1]!), shown, of }];
    } catch {
      // A line edited into JSON that does not read, or a path that is no path, is left out.
      return [];
    }
  });
}

/** How many times a Claude step asked, from its line; null when it says nothing, or does not read. */
function asksOf(body: readonly string[]): number | null {
  for (const line of body) {
    const match = ASKED_LINE.exec(line);
    if (match === null) continue;
    try {
      const asks = JSON.parse(match[1]!) as unknown;
      return typeof asks === 'number' && Number.isInteger(asks) && asks > 0 ? asks : null;
    } catch {
      // A line edited into JSON that does not read is left out, as any other line is.
      return null;
    }
  }
  return null;
}

/** The items a Claude step left out of its answers, from its lines; one that does not read is left out. */
function droppedOf(body: readonly string[], pattern: RegExp): DroppedItem[] {
  return body.flatMap((line) => {
    const match = pattern.exec(line);
    if (match === null) return [];
    try {
      const title = JSON.parse(match[1]!) as unknown;
      return typeof title === 'string' ? [{ title, reason: match[2]! }] : [];
    } catch {
      // A line edited into JSON that does not read is left out, as any other line is.
      return [];
    }
  });
}

function readWent(line: string): VaultPath | null {
  const match = WENT_LINE.exec(line);
  if (match === null) return null;
  try {
    return pathOf(match[1]!);
  } catch {
    // A line edited into JSON that does not read, or a path that is no path, is left out.
    return null;
  }
}

function readMoved(line: string): MovedVersion | null {
  const match = MOVED_LINE.exec(line);
  if (match === null) return null;
  try {
    const digest = JSON.parse(match[3]!) as unknown;
    if (typeof digest !== 'string') return null;
    return { from: pathOf(match[1]!), path: pathOf(match[2]!), digest };
  } catch {
    // A line edited into JSON that does not read, or a path that is no path, is left out.
    return null;
  }
}

function readVersion(line: string): LoggedVersion | null {
  const match = VERSION_LINE.exec(line);
  if (match === null) return null;
  try {
    const digest = JSON.parse(match[3]!) as unknown;
    if (typeof digest !== 'string') return null;
    const keys = match[4] === undefined ? [] : (JSON.parse(match[4]) as unknown);
    if (!Array.isArray(keys) || !keys.every((key) => typeof key === 'string')) return null;
    const also = keys.length === 0 ? {} : { keys: keys as string[] };
    return { path: pathOf(match[2]!), digest, wrote: match[1] === 'wrote', ...also };
  } catch {
    // A line edited into JSON that does not read is left out, as any other line is.
    return null;
  }
}

function triggerOf(title: string): RunTrigger | null {
  const found = Object.entries(TRIGGER_WORDS).find(([, words]) => words === title);
  return found === undefined ? null : (found[0] as RunTrigger);
}

function linesOf(body: readonly string[]): { done: DoneAction[]; left: PassedOver[] } {
  const done: DoneAction[] = [];
  const left: PassedOver[] = [];
  for (const line of body) {
    const read = readLine(line);
    if (read === null) continue;
    if ('reason' in read) left.push(read);
    else done.push(read);
  }
  return { done, left };
}

function readLine(line: string): DoneAction | PassedOver | null {
  try {
    const move = MOVE_LINE.exec(line);
    if (move !== null) {
      const kind = move[1] as 'archived' | 'unarchived';
      return { kind, from: pathOf(move[2]!), to: pathOf(move[3]!) };
    }
    const made = MADE_LINE.exec(line);
    if (made !== null) {
      const path = pathOf(made[2]!);
      if (made[1] === 'proposed') return made[3] === undefined ? { kind: 'proposed', path } : null;
      if (made[3] === undefined) return { kind: 'created', path };
      const digest = JSON.parse(made[3]) as unknown;
      return typeof digest === 'string' ? { kind: 'created', path, digest } : null;
    }
    const tookBack = TOOK_BACK_LINE.exec(line);
    if (tookBack !== null) {
      return { kind: tookBack[1] as 'trashed' | 'unsummarised', path: pathOf(tookBack[2]!) };
    }
    const summarised = SUMMARISED_LINE.exec(line);
    if (summarised !== null) {
      const digest = JSON.parse(summarised[2]!) as unknown;
      if (typeof digest !== 'string') return null;
      const path = pathOf(summarised[1]!);
      if (summarised[3] === undefined) return { kind: 'summarised', path, digest };
      const replaced = replacedSummaryOf(JSON.parse(summarised[3]) as unknown);
      return replaced === null ? null : { kind: 'summarised', path, digest, replaced };
    }
    const set = SET_LINE.exec(line);
    if (set !== null) {
      const key = JSON.parse(set[3]!) as unknown;
      if (typeof key !== 'string') return null;
      return {
        kind: set[1] as 'set' | 'restored',
        path: pathOf(set[2]!),
        key,
        before: priorOf(set[4]!),
        after: priorOf(set[6]!),
      };
    }
    const left = LEFT_LINE.exec(line);
    if (left !== null) return { path: pathOf(left[1]!), reason: left[2]! };
  } catch {
    // A line edited into JSON that does not read, or a path that is no path, is left out on purpose.
    return null;
  }
  return null;
}

/** The summary a line says a run wrote over, or null when it is not one a run writes. */
function replacedSummaryOf(value: unknown): ReplacedSummary | null {
  if (typeof value !== 'object' || value === null) return null;
  const { block, of, model } = value as Record<string, unknown>;
  const textOrNull = (each: unknown): each is string | null =>
    each === null || typeof each === 'string';
  if (typeof block !== 'string' || !textOrNull(of) || !textOrNull(model)) return null;
  return { block, of, model };
}

function pathOf(json: string): VaultPath {
  const value = JSON.parse(json) as unknown;
  if (typeof value !== 'string') throw new Error('not a path');
  return createVaultPath(value);
}

function priorOf(written: string): PriorValue {
  if (written === 'nothing') return { absent: true };
  return { value: JSON.parse(written.slice(1, -1)) as unknown };
}

/** When a set value is still what the run left, so undo may put back what was there. */
export function stillAsLeft(current: PriorValue, left: PriorValue): boolean {
  if ('absent' in current || 'absent' in left) return 'absent' in current && 'absent' in left;
  return JSON.stringify(current.value) === JSON.stringify(left.value);
}

/**
 * What undo can put back: a move, a set, a meeting's summary, or a task the
 * declared step made (logged with its digest) — a run that made tasks and
 * wrote no summary is still the last run. What a Claude step proposed is
 * answered in the Inbox.
 */
const isUndoable = (action: DoneAction): boolean =>
  action.kind === 'archived' ||
  action.kind === 'set' ||
  action.kind === 'summarised' ||
  (action.kind === 'created' && action.digest !== undefined);

/**
 * The run that "Undo last run" undoes: the newest run that did something
 * undo can put back, unless it has been undone already. Only the last one —
 * undoing further back would put back notes that later runs have acted on since.
 */
export function lastUndoableRun(
  entries: readonly LogEntry[],
): Extract<LogEntry, { kind: 'run' }> | null {
  const at = entries.findLastIndex((entry) => entry.kind === 'run' && entry.done.some(isUndoable));
  if (at === -1) return null;
  const last = entries[at] as Extract<LogEntry, { kind: 'run' }>;
  // Only an undo written after it undid it: an earlier run in the same second is another run.
  const undone = entries
    .slice(at + 1)
    .some((entry) => entry.kind === 'undo' && entry.of === last.at);
  return undone ? null : last;
}

const isMark = (entry: LogEntry): boolean =>
  entry.kind === 'run' ||
  entry.kind === 'failed' ||
  entry.kind === 'turnedOn' ||
  entry.kind === 'seen';

/**
 * When a scheduled rule last ran — or tried to, was turned on, or was first
 * seen — which its next run is counted from; null when the log says none of
 * those. A mark later than `now` — a clock that ran fast, a log synced from
 * one — is not counted from: it would hold the rule back until then.
 */
export function lastScheduleMark(entries: readonly LogEntry[], now: LocalTime): LocalTime | null {
  const marks = entries
    .filter(isMark)
    .map((entry) => entry.at)
    .filter((at) => !isAhead(at, now));
  return marks.length === 0 ? null : marks.reduce((latest, at) => (at > latest ? at : latest));
}

/** The latest mark later than `now`, for the page to say it was ignored; null when there is none. */
export function futureMarkOf(entries: readonly LogEntry[], now: LocalTime): LocalTime | null {
  const ahead = entries
    .filter(isMark)
    .map((entry) => entry.at)
    .filter((at) => isAhead(at, now));
  return ahead.length === 0 ? null : ahead.reduce((latest, at) => (at > latest ? at : latest));
}

/**
 * The most the wall clock goes back at once: an hour, when the clocks fall
 * back and the same hour shows twice. A mark that far ahead or less is the
 * same instant seen the first time round, so it still counts.
 */
const REPEATED_HOUR_MS = 3_600_000;

/**
 * Whether a mark's wall-clock time is later than `now` by more than a repeated
 * hour. The log keeps wall-clock time, not instants, so a run at 02:30:40 the
 * first time the clocks show 02:30 reads as later than the 02:30:10 of the
 * second pass; compared by the wall clock it would not count, and the rule
 * would run twice.
 */
function isAhead(at: LocalTime, now: LocalTime): boolean {
  const mark = localTimeMs(at);
  const moment = localTimeMs(now);
  if (mark === null || moment === null) return at > now;
  return mark - moment > REPEATED_HOUR_MS;
}

/** Whether a run entry only says notes went or moved: it did, left and handled nothing. */
const isOnlyWent = (entry: Extract<LogEntry, { kind: 'run' }>): boolean =>
  (entry.went ?? []).length + (entry.moved ?? []).length > 0 &&
  entry.done.length === 0 &&
  entry.left.length === 0 &&
  (entry.versions ?? []).length === 0;

/**
 * The newest run, successful or not; null when it has never run. An entry
 * that only says notes went or moved (P29-01) is the rule's memory, not a run.
 */
export function lastRunOf(
  entries: readonly LogEntry[],
): Extract<LogEntry, { kind: 'run' | 'failed' }> | null {
  const runs = entries.filter(
    (entry): entry is Extract<LogEntry, { kind: 'run' | 'failed' }> =>
      entry.kind === 'failed' || (entry.kind === 'run' && !isOnlyWent(entry)),
  );
  return runs.at(-1) ?? null;
}
