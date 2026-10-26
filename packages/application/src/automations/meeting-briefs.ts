import {
  automationEntryReport,
  BRIEFS_CAPPED_REASON,
  briefDayOf,
  briefFolder,
  briefItem,
  briefNoteName,
  compileStampedBriefsQuery,
  currentPeriod,
  MAX_BRIEFS_PER_RUN,
  meetingBriefData,
  meetingsToBrief,
  messageWithoutPaths,
  outputPeriod,
  periodNoteMade,
  periodRecorded,
  splitFrontmatter,
  type AutomationRule,
  type DayMeeting,
  type LocalTime,
  type LogEntry,
  type ObjectType,
  type OutputPeriod,
  type PageBrief,
  type PassedOver,
  type PeriodNote,
  type RunTrigger,
  type UnreadPage,
  type VaultPath,
} from '@dfai/domain';
import type { ActivityLog } from '../activity/ports.ts';
import type { ArchivePorts } from '../archive/archive-notes.ts';
import { readBrief } from '../assistant/read-brief.ts';
import { AssistantEntityError } from '../assistant/read-entity.ts';
import { readDayMeetings } from '../google-calendar/read-day-meetings.ts';
import { listVaultNotes } from '../vault/read-vault.ts';
import { askedThisHour } from './ask-allowance.ts';
import { readRuleLog } from './automation-log.ts';
import { ClaudeStepFailed, runClaudeStep, type ClaudeStepPorts } from './claude-step.ts';
import { HeldForPullError, holdUnlessFresh, type FreshPullCheck } from './fresh-pull-hold.ts';
import { PeriodNoteArrived, periodNotesAt, periodNotesInFolder } from './period-state.ts';
import { VaultChangedError } from './vault-guard.ts';

type ClaudeAction = Extract<AutomationRule['action'], { kind: 'claude' }>;

/** What a morning-brief run reaches: a rule's run's ports, with the vault's notes listed. */
export interface MeetingBriefsRun {
  readonly rule: AutomationRule;
  readonly ports: ArchivePorts & {
    readonly types: readonly ObjectType[];
    readonly claude: ClaudeStepPorts;
    readonly notePaths: readonly VaultPath[];
  };
  readonly action: ClaudeAction;
  readonly activity: ActivityLog;
  readonly freshPull?: FreshPullCheck;
  /** The wall clock the run started at. */
  readonly at: LocalTime;
  readonly trigger: RunTrigger;
  /** Writes an entry once the gates allow it: for a run that has made nothing. */
  readonly log: (entry: LogEntry) => Promise<void>;
  /** Writes an entry whatever the gates say: for what a run has already made. */
  readonly append: (entry: LogEntry) => Promise<void>;
}

/** A meeting to brief, and the period its brief is written for: the day's slot and the event. */
interface MeetingToBrief {
  readonly meeting: DayMeeting;
  readonly period: BriefPeriod;
}

/** A brief's period: always for one meeting, its item. */
type BriefPeriod = OutputPeriod & { readonly item: string };

/**
 * The morning brief's run (#39, ADR-0047): for each of today's meetings with a
 * linked person or company whose brief is not made yet, asks the rule's
 * Claude step once, handed what `brief()` says of each of them, and writes one
 * note in `<folder>/<day>/`, each item citing a note it was handed.
 *
 * Each meeting's brief is its own period — the day's slot and the event's id —
 * recorded in the rule's log and in the note's own properties, so a second
 * run that day, on either Mac, makes nothing for it, and a scheduled run never
 * writes one the log says was made, even if its note was deleted since; Run
 * now writes afresh one whose note is gone. A missed 07:00 caught up the next
 * day briefs nothing: those meetings are over.
 *
 * Each meeting is logged as its own entry, and said in Activity as soon as
 * it is logged: a meeting whose ask or write fails is a failed entry, and the
 * others still get their brief. Only a switch of vault, or the gates of a
 * fresh pull shutting, ends the run early. Each brief is named past the
 * notes the run has made already, so two meetings of one start and title get
 * `… 2`. The meetings past the cap are logged last, as left, for Run now.
 * Settles with the last entry, which the caller says in Activity as it says
 * every run's.
 */
export async function briefEachMeeting(run: MeetingBriefsRun): Promise<LogEntry> {
  const slot = periodSlot(run);
  const day = slot === null ? null : briefDayOf({ slot, now: run.at });
  if (slot === null || day === null) return logged(run, ranOn(run, { done: [] }));
  const due = await meetingsDue({ run, slot, day });
  if (due.length === 0) return logged(run, ranOn(run, { done: [], period: { slot } }));
  const passedOver: PassedOver[] = due
    .slice(MAX_BRIEFS_PER_RUN)
    .map(({ meeting }) => ({ path: meeting.path, reason: BRIEFS_CAPPED_REASON }));
  const say = sayInActivity(run);
  const taken: VaultPath[] = [...run.ports.notePaths];
  let last: LogEntry | null = null;
  for (const each of due.slice(0, MAX_BRIEFS_PER_RUN)) {
    if (last !== null) say(last);
    last = await briefOne({ run, day, due: each, taken });
    taken.push(...createdPaths(last));
  }
  if (passedOver.length === 0) return last!;
  say(last!);
  const left = ranOn(run, { done: [], left: passedOver });
  await run.append(left);
  return left;
}

/** Says an entry in Activity, once: for each but the run's last, which its caller says. */
function sayInActivity(run: MeetingBriefsRun): (entry: LogEntry) => void {
  const recorder = run.activity.inOpenVault();
  return (entry) => {
    const report = automationEntryReport(run.rule, entry);
    if (report !== null) recorder.record(report);
  };
}

/** The notes an entry says it made. */
const createdPaths = (entry: LogEntry): VaultPath[] =>
  'done' in entry && entry.done !== undefined
    ? entry.done.flatMap((action) => (action.kind === 'created' ? [action.path] : []))
    : [];

/** The slot the run writes for: the latest due at or before it, or — by hand — today's. */
function periodSlot({ rule, at, trigger }: MeetingBriefsRun): LocalTime | null {
  const find = trigger === 'hand' ? currentPeriod : outputPeriod;
  return find({ schedule: rule.when, at })?.slot ?? null;
}

const ranOn = (
  { at, trigger }: MeetingBriefsRun,
  fields: Pick<Extract<LogEntry, { kind: 'run' }>, 'done'> &
    Partial<Pick<Extract<LogEntry, { kind: 'run' }>, 'period' | 'left' | 'claude'>>,
): LogEntry => ({ kind: 'run', at, trigger, left: [], capped: false, ...fields });

async function logged(run: MeetingBriefsRun, entry: LogEntry): Promise<LogEntry> {
  await run.log(entry);
  return entry;
}

/** The day's meetings to brief whose brief is not made yet, as the log and the day's notes say. */
async function meetingsDue({
  run,
  slot,
  day,
}: {
  run: MeetingBriefsRun;
  slot: LocalTime;
  day: string;
}): Promise<MeetingToBrief[]> {
  const { ports } = run;
  const meetings = meetingsToBrief(await readDayMeetings({ index: ports.index, day }));
  if (meetings.length === 0) return [];
  const items = await itemsOf(ports, meetings);
  const made = await madeCheck({ run, day, items, notePaths: ports.notePaths });
  return meetings
    .map((meeting, at) => ({ meeting, period: { slot, item: items[at]! } }))
    .filter(({ period }) => !made(period));
}

/** Each meeting's brief item, read from its event note's own properties. */
async function itemsOf(
  { fs, markdown }: MeetingBriefsRun['ports'],
  meetings: readonly DayMeeting[],
): Promise<string[]> {
  const files = await fs.readNotes(meetings.map(({ path }) => path));
  const properties = new Map(
    files.map((file) => [
      file.path,
      markdown.frontmatterProperties(splitFrontmatter(file.text).frontmatter),
    ]),
  );
  return meetings.map(({ path }) => briefItem({ path, properties: properties.get(path) ?? {} }));
}

/**
 * Whether a meeting's period is made, as the rule's log and the briefs say,
 * read once: those in the day's folder, and those stamped for one of `items`
 * anywhere, as the index finds them — a brief filed out of the Inbox is still
 * made. Scheduled, anything that records it counts; by hand, only a note
 * still on disk, so a deleted brief is written afresh.
 */
async function madeCheck({
  run,
  day,
  items,
  notePaths,
}: {
  run: MeetingBriefsRun;
  day: string;
  items: readonly string[];
  notePaths: readonly VaultPath[];
}): Promise<(period: OutputPeriod) => boolean> {
  const { rule, ports, at, trigger } = run;
  const { entries } = await readRuleLog(ports.fs, rule);
  const notes = await briefsMade({ run, day, items, notePaths });
  const existing = new Set<string>(notePaths);
  return (period) => {
    const asked = { entries, notes, rule: rule.id, period, schedule: rule.when, now: at };
    return trigger === 'hand'
      ? periodNoteMade({ ...asked, exists: (path) => existing.has(path) }) !== null
      : periodRecorded(asked);
  };
}

/** The briefs that say the period they were made for: the day folder's, and those the index finds stamped for `items`. */
async function briefsMade({
  run,
  day,
  items,
  notePaths,
}: {
  run: MeetingBriefsRun;
  day: string;
  items: readonly string[];
  notePaths: readonly VaultPath[];
}): Promise<PeriodNote[]> {
  const { fs, markdown, index } = run.ports;
  const inDay = await periodNotesInFolder({
    folder: briefFolder(noteFolder(run.action), day),
    fs,
    markdown,
    notePaths,
  });
  const { sql, parameters } = compileStampedBriefsQuery({ rule: run.rule.id, items });
  const result = await index.query(sql, parameters);
  const seen = new Set<string>(inDay.map(({ path }) => path));
  const existing = new Set<string>(notePaths);
  // The index can lag a delete: only a note still listed in the vault counts.
  const elsewhere = result.rows
    .map((row) => String(row[result.columns.indexOf('path')]))
    .filter((path) => existing.has(path) && !seen.has(path));
  return [...inDay, ...(await periodNotesAt({ paths: elsewhere, fs, markdown }))];
}

const noteFolder = (action: ClaudeAction): string =>
  action.output.kind === 'note' ? action.output.folder : '';

/**
 * One meeting's brief: what `brief()` says of each person and company in it,
 * handed to the rule's step, and its note written, named past `taken` — or,
 * when the ask or the write fails, a failed entry. Logged either way. DFAI
 * alone sets the brief's properties: the answer's are ignored, so an
 * invitee's words in a title can never make a brief read as a meeting.
 */
async function briefOne({
  run,
  day,
  due,
  taken,
}: {
  run: MeetingBriefsRun;
  day: string;
  due: MeetingToBrief;
  /** Every note in the vault, and each brief this run has made. */
  taken: readonly VaultPath[];
}): Promise<LogEntry> {
  const { rule, ports, action, at, trigger } = run;
  const hold = () => holdUnlessFresh({ check: run.freshPull, rule, trigger });
  await hold();
  const beforeWrite = async () => {
    await hold();
    if (await madeSince(run, day, due.period)) throw new PeriodNoteArrived();
  };
  try {
    const { done, claude } = await runClaudeStep({
      ports: ports.claude,
      action: { ...action, output: { kind: 'note', folder: briefFolder(noteFolder(action), day) } },
      paths: [],
      fs: ports.fs,
      index: ports.index,
      markdown: ports.markdown,
      editors: ports.editors,
      notePaths: taken,
      rule: rule.id,
      madeBy: `${rule.name} · ${at.replace('T', ' ')}`,
      beforeWrite,
      askedThisHour: await askedThisHour(ports, rule, at),
      stepData: await briefData(run, day, due.meeting),
      noteAs: { name: briefNoteName(due.meeting), properties: {} },
      period: { period: due.period, at },
    });
    const made = done.some(({ kind }) => kind === 'created');
    const entry = ranOn(run, { done, claude, ...(made && { period: due.period }) });
    await (done.length > 0 ? run.append(entry) : run.log(entry));
    return entry;
  } catch (cause) {
    return recordFailure({ run, due, cause });
  }
}

/**
 * What a meeting whose brief was not written logs: found made, or failed with
 * why — the ask, the disk refusing the brief, or a read of what it is handed.
 * Only what ends the whole run is raised, once logged: a switch of vault, or
 * the fresh-pull gates shutting.
 */
async function recordFailure({
  run,
  due,
  cause,
}: {
  run: MeetingBriefsRun;
  due: MeetingToBrief;
  cause: unknown;
}): Promise<LogEntry> {
  if (cause instanceof PeriodNoteArrived) {
    const found = ranOn(run, {
      done: [],
      period: due.period,
      ...(cause.claude !== undefined && { claude: cause.claude }),
    });
    return logged(run, found);
  }
  if (cause instanceof HeldForPullError || cause instanceof VaultChangedError) throw cause;
  const problem = (why: string) => `No brief for “${due.meeting.title}”: ${why}`;
  const { at, trigger } = run;
  if (!(cause instanceof ClaudeStepFailed)) {
    // Read before Claude was asked: nothing made, so it waits on the gates like any such entry.
    return logged(run, {
      kind: 'failed',
      at,
      trigger,
      problem: problem(messageWithoutPaths(cause)),
    });
  }
  const failed: LogEntry = {
    kind: 'failed',
    at,
    trigger,
    problem: problem(cause.message),
    claude: cause.claude,
    ...(cause.made.length > 0 && { done: cause.made }),
  };
  await run.append(failed);
  if (cause.interruption instanceof VaultChangedError) throw cause.interruption;
  return failed;
}

/** Whether the meeting's brief is made now, the log and the day's notes read afresh: synced in while Claude was asked. */
async function madeSince(
  run: MeetingBriefsRun,
  day: string,
  period: BriefPeriod,
): Promise<boolean> {
  const notePaths = await listVaultNotes({ fs: run.ports.fs });
  return (await madeCheck({ run, day, items: [period.item], notePaths }))(period);
}

/** What the step is handed for a meeting: `brief()` of each person and company in it, on its day. */
async function briefData(run: MeetingBriefsRun, day: string, meeting: DayMeeting) {
  const briefs: PageBrief[] = [];
  const unread: UnreadPage[] = [];
  for (const path of [...meeting.people, ...meeting.companies]) {
    try {
      const brief = await readBrief({
        reads: run.ports,
        clock: run.ports.claude.clock,
        path,
        date: day,
      });
      briefs.push({ ...brief, page: brief.entity });
    } catch (cause) {
      // A link to a note that is gone, or is not a page, is said in the data; the others still are.
      if (!(cause instanceof AssistantEntityError)) throw cause;
      unread.push({ path, problem: cause.message });
    }
  }
  return meetingBriefData({ meeting, briefs, unread });
}
