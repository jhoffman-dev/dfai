/**
 * What each thing worth knowing says in the Activity log (U-28), and how
 * loudly: one line per event, a summary rather than the detail — a rule's own
 * log, the source's panel and the chat keep that.
 *
 * Nothing here takes a note's contents, a request's body or a chat's words;
 * only names, counts and why something failed.
 */

import { noteTitle } from '../vault/vault-entry.ts';
import { createVaultPath, type VaultPath } from '../vault/vault-path.ts';
import {
  logEntryHeading,
  logEntrySummary,
  type ClaudeRunInfo,
  type LogEntry,
} from '../automations/run-log.ts';
import { planVerb, type AutomationPlan } from '../automations/automation-plan.ts';
import { readsData } from '../automations/claude-step.ts';
import { describeNotLinked } from '../automations/relink-plan.ts';
import type { ActivityLevel, ActivityReport, ActivitySubject } from './activity-event.ts';

/** An automation's rule, as a line names it and links to it; a draft not yet saved has no path. */
export interface RuleNamed {
  readonly name: string;
  readonly path: VaultPath | null;
}

const ruleSubject = (rule: RuleNamed): ActivitySubject | null =>
  rule.path === null ? null : { kind: 'rule', path: rule.path };
const noteSubject = (path: VaultPath): ActivitySubject => ({ kind: 'note', path });

/**
 * A run or an undo, as its rule's log summed it up; null for what is no news —
 * a rule turned on, or first seen. A run that left notes alone is a warning:
 * something in the vault is not as the rule expects.
 */
export function automationEntryReport(rule: RuleNamed, entry: LogEntry): ActivityReport | null {
  if (entry.kind === 'turnedOn' || entry.kind === 'seen') return null;
  // News let go is said as a warning: notes the rule was to run on now wait for a run by hand.
  const left = entry.kind === 'letGo' ? 1 : entry.kind === 'failed' ? 0 : entry.left.length;
  const level: ActivityLevel = entry.kind === 'failed' ? 'error' : left > 0 ? 'warning' : 'info';
  const heading = entry.kind === 'undo' ? 'Undid its last run' : logEntryHeading(entry);
  const notes = entry.kind === 'run' ? triggeringNotes(entry) : '';
  const asked = entry.kind === 'undo' || entry.kind === 'letGo' ? '' : claudeAsked(entry.claude);
  const summary = logEntrySummary(entry);
  // A failure can end on a command to copy, which ends no sentence: the model's words follow.
  const said = asked === '' || /[.!?]$/.test(summary) ? summary : `${summary}.`;
  const heard = entry.kind === 'run' ? heardNotes(entry) : [];
  return {
    level,
    kind: 'automation',
    message: `${rule.name}: ${heading}${notes}. ${said}${asked}`,
    subject: ruleSubject(rule),
    ...(heard.length > 0 && { notes: heard }),
  };
}

/** The notes a run heard, and not its own writes: what the line is about besides its rule (#192). */
function heardNotes(entry: Extract<LogEntry, { kind: 'run' }>): VaultPath[] {
  const heard = (entry.versions ?? []).filter((version) => !version.wrote);
  return [...new Set(heard.map((version) => version.path))];
}

/** Which model a Claude step asked, and for how long: ` Asked claude-opus-5-5, 4.2 s.`; empty for none. */
function claudeAsked(claude: ClaudeRunInfo | undefined): string {
  if (claude === undefined) return '';
  return ` Asked ${claude.model}, ${(claude.ms / 1000).toFixed(1)} s.`;
}

/** How many notes set off by a run a line names before it counts the rest. */
const TRIGGERING_NAMED = 3;

/** The notes that set a run off, as a line names them: ` (Standup, Kickoff and 2 more)`; empty for none. */
function triggeringNotes(entry: Extract<LogEntry, { kind: 'run' }>): string {
  const titles = heardNotes(entry).map(noteTitle);
  if (titles.length === 0) return '';
  const named = titles.slice(0, TRIGGERING_NAMED).join(', ');
  const more = titles.length - TRIGGERING_NAMED;
  return more > 0 ? ` (${named} and ${more} more)` : ` (${named})`;
}

/** A run or an undo that stopped before its log could say what it did. */
export function automationFailedReport({
  rule,
  doing,
  problem,
}: {
  rule: RuleNamed;
  doing: 'run' | 'undo';
  problem: string;
}): ActivityReport {
  const what = doing === 'run' ? 'Could not run' : 'Could not undo its last run';
  return {
    level: 'error',
    kind: 'automation',
    message: `${rule.name}: ${what}. ${problem}`,
    subject: ruleSubject(rule),
  };
}

/**
 * A rule's list of what it has handled did not add up — a line lost or
 * unreadable, two lists, a format this DFAI does not know — and was rebuilt
 * from the entries its log still holds. Said once, when it is rebuilt.
 */
export function ledgerRepairedReport(rule: RuleNamed): ActivityReport {
  return {
    level: 'warning',
    kind: 'automation',
    message: `${rule.name}: Its list of handled notes was damaged and was rebuilt from its log. Meetings written before now that the log does not show are not asked about; run it by hand to take them.`,
    subject: ruleSubject(rule),
  };
}

/** A dry run from the rule's editor: what it would do, or why its query did not read. */
export function dryRunReport(
  rule: RuleNamed,
  outcome: { plan: AutomationPlan } | { problem: string },
): ActivityReport {
  if ('problem' in outcome) {
    return {
      level: 'warning',
      kind: 'automation',
      message: `${rule.name}: Dry run could not read its notes. ${outcome.problem}`,
      subject: ruleSubject(rule),
    };
  }
  const { plan } = outcome;
  const count = plan.paths.length;
  const would =
    plan.periodNote?.made === true
      ? 'Its note for this period is made already'
      : count === 0 && readsData(plan.action)
        ? 'Would write its note'
        : count === 0
          ? 'Nothing to do'
          : `Would ${planVerb(plan.action)} ${notes(count)}`;
  const left = plan.passedOver.length === 0 ? '' : `, and leave ${plan.passedOver.length} alone`;
  const relink = plan.notLinked === undefined ? '' : ` ${describeNotLinked(plan.notLinked)}`;
  return {
    level: 'info',
    kind: 'automation',
    message: `${rule.name}: Dry run. ${would}${left}.${relink}`,
    subject: ruleSubject(rule),
  };
}

/** What a source refresh reports, as far as the log needs it. */
export interface SourceOutcome {
  readonly records: number;
  readonly created: number;
  readonly replaced: number;
  readonly updated: number;
  readonly missing: number;
  readonly error: string | null;
}

/** A source refreshed, or failed to: named by its note, never by its URL, which may hold a key. */
export function sourceRefreshReport(sourcePath: VaultPath, outcome: SourceOutcome): ActivityReport {
  const name = noteTitle(sourcePath);
  const subject: ActivitySubject = { kind: 'source', path: sourcePath };
  if (outcome.error !== null) {
    return {
      level: 'error',
      kind: 'source',
      message: `${name}: Refresh failed. ${outcome.error}`,
      subject,
    };
  }
  const changes = [
    outcome.created > 0 ? `${outcome.created} new` : '',
    outcome.replaced + outcome.updated > 0 ? `${outcome.replaced + outcome.updated} updated` : '',
    outcome.missing > 0 ? `${outcome.missing} gone from the feed` : '',
  ].filter((part) => part !== '');
  const records = `${outcome.records} ${outcome.records === 1 ? 'record' : 'records'}`;
  const detail = changes.length === 0 ? 'nothing changed' : changes.join(', ');
  return {
    level: 'info',
    kind: 'source',
    message: `${name}: Refreshed. ${records}, ${detail}.`,
    subject,
  };
}

/**
 * A write through the local API or MCP: the route as the contract names it,
 * and the note it wrote — never what it wrote. A refused one is a warning:
 * the tool asked for something DFAI would not do.
 */
export function apiWriteReport({
  route,
  notePath,
  refusal,
}: {
  route: string;
  notePath: VaultPath | null;
  refusal: string | null;
}): ActivityReport {
  // `PUT v1/notes/{path}/body`: with its leading slash, a route reads as a machine path and is struck out.
  const said = route.replace(/ \//, ' ');
  const target = notePath === null ? '' : ` ${noteTitle(notePath)}`;
  const subject = notePath === null ? null : noteSubject(notePath);
  if (refusal !== null) {
    return {
      level: 'warning',
      kind: 'api',
      message: `${said} refused${target === '' ? '' : ` for${target}`} (${refusal}).`,
      subject,
    };
  }
  return {
    level: 'info',
    kind: 'api',
    message: `${said}${target === '' ? '' : ` —${target}`}`,
    subject,
  };
}

/** What happened to one of Claude's proposals, or to a turn of the chat. */
export type ChatHappening =
  | { readonly kind: 'accepted'; readonly path: VaultPath; readonly created: boolean }
  | { readonly kind: 'undone'; readonly path: VaultPath }
  | {
      readonly kind: 'refused';
      readonly doing: 'accept' | 'undo';
      readonly path: VaultPath;
      readonly problem: string;
    }
  | { readonly kind: 'turnFailed'; readonly reason: ChatFailure }
  /** The chat note could not be written. Said without the error's words: they can name the note, whose name is the question. */
  | { readonly kind: 'notKept' };

/**
 * Why a turn failed, by kind alone. A provider's own words can quote the
 * question back, and a line is kept for a month, so they never reach it.
 */
export type ChatFailure = 'not_installed' | 'not_logged_in' | 'no_key' | 'unavailable' | 'failed';

const CHAT_FAILURE_WORDS: Readonly<Record<ChatFailure, string>> = {
  not_installed: 'Claude could not answer: Claude Code is not installed.',
  not_logged_in: 'Claude could not answer: Claude Code is not signed in.',
  no_key: 'Claude could not answer: no API key is set.',
  unavailable: 'Claude could not answer: the service could not be reached.',
  failed: 'Claude could not answer.',
};

export function chatReport(happening: ChatHappening): ActivityReport {
  switch (happening.kind) {
    case 'accepted': {
      const what = happening.created ? 'Created' : 'Edited';
      return chatLine(
        'info',
        `${what} ${noteTitle(happening.path)}, as Claude proposed.`,
        happening.path,
      );
    }
    case 'undone':
      return chatLine(
        'info',
        `Undid Claude's change to ${noteTitle(happening.path)}.`,
        happening.path,
      );
    case 'refused': {
      const what = happening.doing === 'accept' ? 'accept' : 'undo';
      const message = `Could not ${what} Claude's change to ${noteTitle(happening.path)}. ${happening.problem}`;
      return chatLine('warning', message, happening.path);
    }
    case 'turnFailed':
      return chatLine('error', CHAT_FAILURE_WORDS[happening.reason], null);
    case 'notKept':
      return chatLine('error', 'The chat could not be saved to Chats/.', null);
  }
}

function chatLine(level: ActivityLevel, message: string, path: VaultPath | null): ActivityReport {
  return { level, kind: 'chat', message, subject: path === null ? null : noteSubject(path) };
}

/** What the meeting import did with one meeting file (ADR-0027). */
export type MeetingImportHappening =
  /**
   * It follows the contract and is the first copy: it waits in the Inbox, its
   * bytes as they came but for the misheard spellings `corrected` counts.
   */
  | { readonly kind: 'arrived'; readonly path: VaultPath; readonly corrected?: number }
  /** It carried an import error and now follows the contract, so the error was taken out. */
  | { readonly kind: 'fixed'; readonly path: VaultPath; readonly corrected?: number }
  /**
   * It breaks the contract. `unmarked` says why the problem could not be
   * written into it, or is null when it was — or was there already.
   */
  | {
      readonly kind: 'invalid';
      readonly path: VaultPath;
      readonly problem: string;
      readonly unmarked: string | null;
    }
  /** A second copy of `of`: archived to `archivedTo` and marked there — or not — and what went wrong. */
  | {
      readonly kind: 'duplicate';
      readonly path: VaultPath;
      readonly of: VaultPath;
      readonly archivedTo: VaultPath | null;
      readonly problem: string | null;
    }
  /** Something stopped the import before it could say what the file is. */
  | { readonly kind: 'failed'; readonly path: VaultPath; readonly problem: string }
  /** The other Mac's version of a meeting file both changed: the person's to compare, never a copy to archive. */
  | { readonly kind: 'conflict'; readonly path: VaultPath };

/**
 * Whether what happened leaves the file as it was, so every catch-up meets it
 * again: a sync conflict's copy, a file that could not be read or written, a
 * problem that could not be marked in it, a copy that could not be moved.
 * The import says such a file once a session, and again only when it changes
 * (#174): the catch-up runs after every pull, and a line a minute about the
 * same file says nothing new.
 */
export function leavesFileUnsettled(happening: MeetingImportHappening): boolean {
  switch (happening.kind) {
    case 'conflict':
    case 'failed':
      return true;
    case 'invalid':
      return happening.unmarked !== null;
    case 'duplicate':
      return happening.archivedTo === null;
    default:
      return false;
  }
}

/** One line per meeting file the import looked at and did something about. */
export function meetingImportReport(happening: MeetingImportHappening): ActivityReport {
  const title = noteTitle(happening.path);
  switch (happening.kind) {
    case 'arrived':
      return meetingLine(
        'info',
        `${title}: arrived in the Inbox.${correctedClause(happening.corrected)}`,
        happening.path,
      );
    case 'fixed':
      return meetingLine(
        'info',
        `${title}: now follows the import contract, so its import error was taken out.${correctedClause(happening.corrected)}`,
        happening.path,
      );
    case 'invalid': {
      const unmarked =
        happening.unmarked === null
          ? ''
          : ` The problem is not in the file: ${happening.unmarked}.`;
      return meetingLine(
        'warning',
        `${title}: could not be imported.${unmarked} ${happening.problem}`,
        happening.path,
      );
    }
    case 'duplicate':
      return duplicateLine(happening);
    case 'failed':
      return meetingLine(
        'error',
        `${title}: could not be imported. ${happening.problem}`,
        happening.path,
      );
    case 'conflict':
      return meetingLine(
        'warning',
        `${title}: another Mac's version of a meeting both changed, kept beside it. Compare the two, keep what you want, and delete the copy; it is not imported.`,
        happening.path,
      );
  }
}

/** How many misheard spellings a meeting let in had put right, and where to take them back; nothing when none. */
function correctedClause(corrected: number | undefined): string {
  if (corrected === undefined || corrected === 0) return '';
  const spellings = corrected === 1 ? '1 misheard spelling' : `${corrected} misheard spellings`;
  return ` ${spellings} corrected; Undo corrections on the meeting puts them back.`;
}

/** The import could not look at one sync's meetings at all — the files are as they were. */
export function meetingImportStoppedReport(problem: string): ActivityReport {
  return {
    level: 'error',
    kind: 'meeting',
    message: `Meetings that arrived could not be imported. ${problem}`,
    subject: null,
  };
}

function duplicateLine({
  path,
  of,
  archivedTo,
  problem,
}: Extract<MeetingImportHappening, { kind: 'duplicate' }>): ActivityReport {
  const copy = `${noteTitle(path)}: a second copy of ${noteTitle(of)}`;
  const why = problem === null ? '' : ` ${problem}`;
  if (archivedTo === null) {
    return meetingLine(
      'warning',
      `${copy}, but it could not be archived.${why} It is tried again when it next changes.`,
      path,
    );
  }
  return meetingLine(
    problem === null ? 'info' : 'warning',
    `${copy}, so it was archived.${why}`,
    archivedTo,
  );
}

function meetingLine(level: ActivityLevel, message: string, path: VaultPath): ActivityReport {
  return { level, kind: 'meeting', message, subject: noteSubject(path) };
}

/** The index made again from nothing, and how many notes it holds. */
export function indexRebuiltReport(notes: number): ActivityReport {
  return {
    level: 'info',
    kind: 'index',
    message: `Rebuilt the index: ${notes} ${notes === 1 ? 'note' : 'notes'}.`,
    subject: null,
  };
}

/** The index could not be opened, rebuilt or brought up to date. */
export function indexFailedReport({
  rebuilding,
  problem,
}: {
  rebuilding: boolean;
  problem: string;
}): ActivityReport {
  const what = rebuilding ? 'could not be rebuilt' : 'could not be brought up to date';
  return { level: 'error', kind: 'index', message: `The index ${what}. ${problem}`, subject: null };
}

/**
 * The index is being built on the window's own thread, because the thread
 * meant for it could not be used: slower, and the window may hitch on a long
 * note. Said once, so a slow index has its reason on record (#135).
 */
export function indexInWindowReport(reason: string): ActivityReport {
  return {
    level: 'warning',
    kind: 'index',
    message: `Indexing in the window, which is slower: the background indexer could not be used. ${reason}`,
    subject: null,
  };
}

/** A note the index could not take, and why. */
export interface NoteNotIndexed {
  readonly path: string;
  readonly problem: string;
}

/**
 * Notes a build of the index could not read as notes, so it holds nothing new
 * of them (one it read before keeps what it last read): one line for however
 * many, linked to the first so it can be opened and looked at (#135).
 */
export function notesNotIndexedReport(
  failed: readonly [NoteNotIndexed, ...NoteNotIndexed[]],
): ActivityReport {
  const [first] = failed;
  const count = `${failed.length} ${failed.length === 1 ? 'note' : 'notes'}`;
  return {
    level: 'warning',
    kind: 'index',
    message: `${count} could not be indexed. The first is ${first.path}: ${first.problem}`,
    subject: noteSubject(createVaultPath(first.path)),
  };
}

/** The writes a failed one can be, as its line says what was being done. */
export type VaultWrite = 'save' | 'create' | 'createFolder' | 'move' | 'trash' | 'writeFile';

const WRITE_WORDS: Readonly<Record<VaultWrite, string>> = {
  save: 'Could not save',
  create: 'Could not create',
  createFolder: 'Could not create the folder',
  move: 'Could not move',
  trash: 'Could not move to the Trash',
  writeFile: 'Could not write',
};

/**
 * A write to the vault that failed or was refused — a save over a note
 * changed since it was read, a write meant for a vault no longer open.
 */
export function writeFailedReport({
  write,
  path,
  problem,
}: {
  write: VaultWrite;
  path: VaultPath;
  problem: string;
}): ActivityReport {
  // Only a save names a note that is there to open; a failed create, move or trash does not.
  const subject = write === 'save' ? noteSubject(path) : null;
  return {
    level: 'error',
    kind: 'save',
    message: `${WRITE_WORDS[write]} ${path}. ${problem}`,
    subject,
  };
}

/** What a screen was writing when it gave up, as its line says it. */
export type ScreenWrite =
  | 'edit'
  | 'view'
  | 'dashboard'
  | 'card'
  | 'image'
  | 'artifact'
  | 'setting'
  | 'connection'
  | 'proposal'
  | 'filing'
  | 'task'
  | 'term'
  | 'block'
  | 'corrections';

const SCREEN_WRITE_WORDS: Readonly<Record<ScreenWrite, string>> = {
  edit: 'Could not save an edit',
  view: 'Could not save the view',
  dashboard: 'Could not add the query to the dashboard',
  card: 'Could not add the card',
  image: 'Could not add the image',
  artifact: 'Could not save the artifact',
  setting: 'Could not save a setting',
  connection: 'Could not change the API connection',
  proposal: 'Could not answer the proposal',
  filing: 'Could not file the note',
  task: 'Could not make the task',
  term: 'Could not save the term',
  block: 'Could not plan the task',
  corrections: 'Could not undo the corrections',
};

/**
 * A write a screen gave up on and shows in its own place — a view's edit, an
 * image, a setting — said once, where it gave up: never for a name tried and
 * passed over, or a write tried again. `path` is the note it was writing, when
 * there is one yet.
 */
export function screenWriteFailedReport({
  write,
  path,
  problem,
}: {
  write: ScreenWrite;
  path: VaultPath | null;
  problem: string;
}): ActivityReport {
  const target = path === null ? '' : ` — ${noteTitle(path)}`;
  return {
    level: 'error',
    kind: 'save',
    message: `${SCREEN_WRITE_WORDS[write]}${target}. ${problem}`,
    subject: path === null ? null : noteSubject(path),
  };
}

/** A notice the window showed: in red as an error, in amber as a warning. */
export function noticeReport(notice: string, level: ActivityLevel = 'error'): ActivityReport {
  return { level, kind: 'app', message: notice, subject: null };
}

function notes(count: number): string {
  return `${count} ${count === 1 ? 'note' : 'notes'}`;
}
