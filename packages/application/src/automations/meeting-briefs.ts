import {
  automationEntryReport,
  BRIEFS_CAPPED_REASON,
  briefDayOf,
  briefFolder,
  briefItem,
  briefNoteName,
  currentPeriod,
  MAX_BRIEFS_PER_RUN,
  meetingBriefData,
  meetingsToBrief,
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
import { holdUnlessFresh, type FreshPullCheck } from './fresh-pull-hold.ts';
import { PeriodNoteArrived, periodNotesInFolder } from './period-state.ts';

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
  readonly period: OutputPeriod;
}

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
 * Each meeting is logged as its own entry, and said once in Activity: a
 * meeting whose ask fails is a failed entry that wrote nothing, and the
 * others still get their brief. Settles with the last entry, which the caller
 * says in Activity as it says every run's.
 */
export async function briefEachMeeting(run: MeetingBriefsRun): Promise<LogEntry> {
  const slot = periodSlot(run);
  const day = slot === null ? null : briefDayOf({ slot, now: run.at });
  if (slot === null || day === null) return logged(run, ranOn(run, { done: [] }));
  const due = await meetingsDue({ run, slot, day });
  if (due.length === 0) return logged(run, ranOn(run, { done: [], period: { slot } }));
  const briefed = due.slice(0, MAX_BRIEFS_PER_RUN);
  const passedOver: PassedOver[] = due
    .slice(MAX_BRIEFS_PER_RUN)
    .map(({ meeting }) => ({ path: meeting.path, reason: BRIEFS_CAPPED_REASON }));
  const entries: LogEntry[] = [];
  for (const [at, each] of briefed.entries()) {
    const left = at === briefed.length - 1 ? passedOver : [];
    entries.push(await briefOne({ run, day, due: each, left }));
  }
  const recorder = run.activity.inOpenVault();
  for (const entry of entries.slice(0, -1)) {
    const report = automationEntryReport(run.rule, entry);
    if (report !== null) recorder.record(report);
  }
  return entries.at(-1)!;
}

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
  const made = await madeCheck({ run, day, notePaths: ports.notePaths });
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
 * Whether a meeting's period is made, as the rule's log and the day folder's
 * notes say, read once. Scheduled, anything that records it counts; by hand,
 * only a note still on disk.
 */
async function madeCheck({
  run,
  day,
  notePaths,
}: {
  run: MeetingBriefsRun;
  day: string;
  notePaths: readonly VaultPath[];
}): Promise<(period: OutputPeriod) => boolean> {
  const { rule, ports, at, trigger, action } = run;
  const { entries } = await readRuleLog(ports.fs, rule);
  const notes: PeriodNote[] = await periodNotesInFolder({
    folder: briefFolder(noteFolder(action), day),
    fs: ports.fs,
    markdown: ports.markdown,
    notePaths,
  });
  const existing = new Set<string>(notePaths);
  return (period) => {
    const asked = { entries, notes, rule: rule.id, period, schedule: rule.when, now: at };
    return trigger === 'hand'
      ? periodNoteMade({ ...asked, exists: (path) => existing.has(path) }) !== null
      : periodRecorded(asked);
  };
}

const noteFolder = (action: ClaudeAction): string =>
  action.output.kind === 'note' ? action.output.folder : '';

/**
 * One meeting's brief: what `brief()` says of each person and company in it,
 * handed to the rule's step, and its note written — or, when the ask fails,
 * a failed entry that wrote nothing. Logged either way.
 */
async function briefOne({
  run,
  day,
  due,
  left,
}: {
  run: MeetingBriefsRun;
  day: string;
  due: MeetingToBrief;
  left: readonly PassedOver[];
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
      notePaths: ports.notePaths,
      rule: rule.id,
      madeBy: `${rule.name} · ${at.replace('T', ' ')}`,
      beforeWrite,
      askedThisHour: await askedThisHour(ports, rule, at),
      stepData: await briefData(run, day, due.meeting),
      noteName: briefNoteName(due.meeting),
      period: { period: due.period, at },
    });
    const made = done.some(({ kind }) => kind === 'created');
    const entry = ranOn(run, { done, left, claude, ...(made && { period: due.period }) });
    await (done.length > 0 ? run.append(entry) : run.log(entry));
    return entry;
  } catch (cause) {
    return recordFailure({ run, due, cause, left });
  }
}

/** What a meeting's ask that did not write logs: found made, or failed with why. Anything else is raised. */
async function recordFailure({
  run,
  due,
  cause,
  left,
}: {
  run: MeetingBriefsRun;
  due: MeetingToBrief;
  cause: unknown;
  left: readonly PassedOver[];
}): Promise<LogEntry> {
  if (cause instanceof PeriodNoteArrived) {
    const found = ranOn(run, {
      done: [],
      left,
      period: due.period,
      ...(cause.claude !== undefined && { claude: cause.claude }),
    });
    return logged(run, found);
  }
  if (!(cause instanceof ClaudeStepFailed)) throw cause;
  const failed: LogEntry = {
    kind: 'failed',
    at: run.at,
    trigger: run.trigger,
    problem: `No brief for “${due.meeting.title}”: ${cause.message}`,
    claude: cause.claude,
    ...(cause.made.length > 0 && { done: cause.made }),
  };
  await run.append(failed);
  if (cause.interruption !== undefined) throw cause.interruption;
  return failed;
}

/** Whether the meeting's brief is made now, the log and the day's notes read afresh: synced in while Claude was asked. */
async function madeSince(
  run: MeetingBriefsRun,
  day: string,
  period: OutputPeriod,
): Promise<boolean> {
  const notePaths = await listVaultNotes({ fs: run.ports.fs });
  return (await madeCheck({ run, day, notePaths }))(period);
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
