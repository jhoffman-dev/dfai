import {
  compileEventNotesQuery,
  compileMeetingCandidatesQuery,
  createVaultPath,
  inWindow,
  isScopeRefusal,
  meetingCandidatesOf,
  meetingWindow,
  planEventNotes,
  splitFrontmatter,
  wikiLinkTargetFor,
  EVENT_ID_LOOKUP_SIZE,
  EVENT_NOTE_KEYS,
  EVENT_NOTES_FOLDER,
  type ActivityReport,
  type EventNoteWrite,
  type ExistingEventNote,
  type GoogleEvent,
  type GoogleProblem,
  type MeetingSetting,
  type MeetingWindow,
  type VaultPath,
} from '@dfai/domain';
import type { IndexPort, QueryResult } from '../index/ports.ts';
import { loadLinkDirectory } from '../meeting-links/link-directory.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import type { Clock } from '../ports.ts';
import { ensureFolder } from '../vault/create-folder.ts';
import type { NoteFile, VaultFsPort } from '../vault/ports.ts';
import { listVaultNotes } from '../vault/read-vault.ts';
import { googleProblemOf } from './google-calendar.ts';
import {
  GoogleCalendarError,
  type CalendarChanges,
  type CalendarFollowing,
  type CalendarSource,
  type MeetingSyncRecords,
} from './ports.ts';

/** A calendar Google would not list this time, and why. The others were synced without it. */
export interface CalendarFailure {
  readonly calendarId: string;
  readonly problem: GoogleProblem;
}

/** What one meetings sync did, as Settings and Activity say it. */
export interface MeetingSyncReport {
  /** When it ran, as the injected clock gave it. */
  readonly ran: number;
  readonly created: number;
  readonly updated: number;
  /** Notes marked because Google cancelled or deleted their event. Never removed. */
  readonly missing: number;
  /** The calendars listed in full this time rather than by what changed. */
  readonly full: readonly string[];
  /** Why it stopped; null when it finished. What it wrote before stopping stays written. */
  readonly problem: GoogleProblem | null;
  /** The calendars that failed while the others synced; each is read again from where it left off. */
  readonly failed: readonly CalendarFailure[];
  /**
   * Google said this Mac's sign-in may not read events. Asking again changes
   * nothing until the person allows it, so the sync waits for that.
   */
  readonly scopeRefused: boolean;
}

export interface MeetingSyncPorts {
  readonly source: CalendarSource;
  readonly records: MeetingSyncRecords;
  readonly fs: VaultFsPort;
  readonly markdown: MarkdownPort;
  readonly index: Pick<IndexPort, 'query'>;
  readonly clock: Pick<Clock, 'today' | 'now'>;
}

export interface MeetingSyncRun {
  readonly vault: string;
  /** The zone the person is in: event notes are written on it only when no calendar read names one. */
  readonly timeZone: string;
  readonly setting: MeetingSetting;
  /** The calendar blocks go to (#30): never read for meetings. */
  readonly blocksCalendarId: string | null;
  /**
   * Asked before each call to Google and each write: false once the person
   * stops reading meetings, and from then on nothing is asked for or
   * written. Left out, a sync runs to its end.
   */
  readonly wanted?: () => boolean;
}

interface Listed {
  readonly events: GoogleEvent[];
  readonly complete: string[];
  readonly following: Record<string, CalendarFollowing>;
  readonly zones: Record<string, string>;
  readonly failed: (CalendarFailure & { readonly cause: unknown })[];
}

const ALWAYS_WANTED = () => true;

/** One calendar's events: what changed since its token, or all of the window when it has none or it expired. */
async function listCalendar(
  ports: MeetingSyncPorts,
  ask: {
    vault: string;
    calendarId: string;
    window: MeetingWindow;
    kept: CalendarFollowing | undefined;
  },
) {
  const { vault, calendarId, window, kept } = ask;
  const token = kept?.fromDay === window.fromDay ? kept.syncToken : null;
  const list = (syncToken: string | null) =>
    ports.source.listEvents({
      vault,
      calendarId,
      timeMin: window.timeMin,
      timeMax: window.timeMax,
      syncToken,
    });
  const answer = await list(token);
  // A token Google no longer honours (410) means listing the window in full again.
  const answered = answer.kind === 'expired' ? await list(null) : answer;
  if (answered.kind === 'expired')
    throw new Error(`Google asked for a full listing of ${calendarId} again`);
  return { ...answered, full: token === null || answer.kind === 'expired' };
}

type Answered = Extract<CalendarChanges, { kind: 'changes' }> & { readonly full: boolean };

function addAnswer(listed: Listed, calendarId: string, answer: Answered, fromDay: string) {
  listed.events.push(...answer.events);
  if (answer.full) listed.complete.push(calendarId);
  if (answer.timeZone !== null) listed.zones[calendarId] = answer.timeZone;
  if (answer.syncToken !== null) {
    listed.following[calendarId] = { syncToken: answer.syncToken, fromDay };
  }
}

/**
 * Each calendar the vault reads, on its own: one Google refuses (a calendar
 * shared and then taken away, a typo) is reported, keeps where it left off,
 * and stops none of the others. Only when every one failed is the sync
 * itself stopped, by the first one's failure.
 */
async function listCalendars(
  ports: MeetingSyncPorts,
  run: MeetingSyncRun,
  window: MeetingWindow,
): Promise<Listed> {
  const kept = ports.records.read(run.vault).calendars;
  const wanted = run.wanted ?? ALWAYS_WANTED;
  const listed: Listed = { events: [], complete: [], following: {}, zones: {}, failed: [] };
  const calendars = run.setting.calendars.filter((id) => id !== run.blocksCalendarId);
  for (const calendarId of calendars) {
    if (!wanted()) break;
    try {
      const answer = await listCalendar(ports, {
        vault: run.vault,
        calendarId,
        window,
        kept: kept[calendarId],
      });
      addAnswer(listed, calendarId, answer, window.fromDay);
    } catch (cause) {
      listed.failed.push({ calendarId, problem: googleProblemOf(cause), cause });
      const before = kept[calendarId];
      if (before !== undefined) listed.following[calendarId] = before;
    }
  }
  const [first] = listed.failed;
  if (first !== undefined && listed.failed.length === calendars.length) throw first.cause;
  return listed;
}

const pathsIn = (result: QueryResult): string[] => {
  const column = result.columns.indexOf('path');
  return result.rows.map((row) => String(row[column]));
};

/** Ids in lists one lookup can carry; one empty list when there are none, so the window is still read. */
function idBatches(events: readonly GoogleEvent[]): string[][] {
  const ids = [...new Set(events.map((event) => event.id))];
  const batches: string[][] = [];
  for (let at = 0; at < ids.length; at += EVENT_ID_LOOKUP_SIZE) {
    batches.push(ids.slice(at, at + EVENT_ID_LOOKUP_SIZE));
  }
  return batches.length === 0 ? [[]] : batches;
}

/**
 * Event notes the last sync may have made that the index has not caught up
 * with yet: those in the folder whose name starts with a day in the window.
 */
async function recentlyMade(fs: VaultFsPort, window: MeetingWindow): Promise<string[]> {
  try {
    const entries = await fs.listDirectory(createVaultPath(EVENT_NOTES_FOLDER));
    return entries
      .filter((entry) => entry.kind === 'file' && entry.path.endsWith('.md'))
      .filter((entry) => inWindow(entry.name.slice(0, 10), window))
      .map((entry) => entry.path);
  } catch {
    // Safe to ignore: before the first sync makes it there is no folder, and
    // so nothing in it; the index has found every note made before that.
    return [];
  }
}

/** The event notes a sync may write to, as the files say, not as the index last read them. */
async function readEventNotes(
  ports: MeetingSyncPorts,
  events: readonly GoogleEvent[],
  window: MeetingWindow,
): Promise<{ existing: ExistingEventNote[]; files: Map<string, NoteFile> }> {
  const paths = new Set(await recentlyMade(ports.fs, window));
  for (const ids of idBatches(events)) {
    const { sql, parameters } = compileEventNotesQuery({
      ids,
      fromDay: window.fromDay,
      toDay: window.toDay,
    });
    for (const path of pathsIn(await ports.index.query(sql, parameters))) paths.add(path);
  }
  const files = await ports.fs.readNotes([...paths]);
  const existing = files.flatMap((file) => {
    const properties = ports.markdown.frontmatterProperties(
      splitFrontmatter(file.text).frontmatter,
    );
    const id = properties[EVENT_NOTE_KEYS.eventId];
    return typeof id === 'string' ? [{ path: createVaultPath(file.path), properties }] : [];
  });
  return { existing, files: new Map(files.map((file) => [file.path, file])) };
}

async function readMeetingNotes(ports: MeetingSyncPorts, window: MeetingWindow) {
  const { sql, parameters } = compileMeetingCandidatesQuery(window);
  const result = await ports.index.query(sql, parameters);
  const cell = (row: readonly unknown[], name: string) => row[result.columns.indexOf(name)];
  return meetingCandidatesOf(
    result.rows.map((row) => ({
      path: String(cell(row, 'path')),
      title: String(cell(row, 'title') ?? ''),
      date: cell(row, 'date'),
      start: cell(row, 'start'),
    })),
  );
}

interface Tally {
  created: number;
  updated: number;
  missing: number;
}

/** Writes the plan: new notes made, owned properties changed, cancelled ones marked; bodies are never touched. */
async function applyWrites(
  ports: MeetingSyncPorts,
  {
    writes,
    files,
    wanted,
  }: {
    writes: readonly EventNoteWrite[];
    files: ReadonlyMap<string, NoteFile>;
    wanted: () => boolean;
  },
): Promise<Tally> {
  const tally: Tally = { created: 0, updated: 0, missing: 0 };
  if (writes.some((write) => write.kind === 'create')) {
    await ensureFolder({ fs: ports.fs, folder: createVaultPath(EVENT_NOTES_FOLDER) });
  }
  for (const write of writes) {
    if (!wanted()) break;
    if (write.kind === 'create') {
      await ports.fs.createNote({
        path: write.path,
        contents: ports.markdown.updateFrontmatter(null, write.properties),
      });
      tally.created += 1;
      continue;
    }
    const file = files.get(write.path);
    // Every update and mark names a note this sync has just read.
    if (file === undefined) continue;
    const changes =
      write.kind === 'missing' ? { [EVENT_NOTE_KEYS.missing]: true } : write.properties;
    const document = splitFrontmatter(file.text);
    await ports.fs.writeTextFile({
      path: write.path,
      contents: ports.markdown.updateFrontmatter(document.frontmatter, changes) + document.body,
      expectedModified: file.modified,
    });
    tally[write.kind === 'missing' ? 'missing' : 'updated'] += 1;
  }
  return tally;
}

/** Plans the writes for what the calendars answered, against what the vault holds now. */
async function planWrites(
  ports: MeetingSyncPorts,
  run: MeetingSyncRun,
  window: MeetingWindow,
  listed: Listed,
) {
  const notes = await readEventNotes(ports, listed.events, window);
  const directory = await loadLinkDirectory({ index: ports.index });
  const notePaths = await listVaultNotes({ fs: ports.fs });
  const writes = planEventNotes({
    events: listed.events,
    existing: notes.existing,
    complete: listed.complete,
    window,
    timeZone: run.timeZone,
    calendarZones: listed.zones,
    ignoredCalendars: run.blocksCalendarId === null ? [] : [run.blocksCalendarId],
    people: directory.people,
    companies: directory.companies,
    meetings: await readMeetingNotes(ports, window),
    linkTo: (path: VaultPath) => `[[${wikiLinkTargetFor(path, notePaths)}]]`,
    taken: new Set(notePaths),
  });
  return { writes, files: notes.files };
}

const NOTHING = { created: 0, updated: 0, missing: 0, full: [], failed: [] } as const;

const refusedScope = (cause: unknown) =>
  cause instanceof GoogleCalendarError && isScopeRefusal(cause.failure);

/**
 * Brings the vault's meetings up to date from Google Calendar (ADR-0046):
 * each calendar the vault reads, by what changed since this Mac last looked,
 * or in full when it has not looked this window; then event notes made,
 * changed and marked as `planEventNotes` says. Where each calendar left off
 * is kept only once every write has landed, so a sync that stops part way
 * is read again from where the last whole one left off — writing what it
 * already wrote changes nothing.
 *
 * Failure is a report, not a rejection: offline, the notes already in the
 * vault stay as they are, and the next sync catches up. A sync the person
 * stops (`wanted`) writes nothing more and keeps no record, so it is read
 * again from where the last whole one left off.
 */
export async function syncMeetings(
  ports: MeetingSyncPorts,
  run: MeetingSyncRun,
): Promise<MeetingSyncReport> {
  const ran = ports.clock.now();
  const wanted = run.wanted ?? ALWAYS_WANTED;
  try {
    const window = meetingWindow({ today: ports.clock.today(), timeZone: run.timeZone });
    if (window === null) throw new Error(`today (${ports.clock.today()}) is not a day`);
    const listed = await listCalendars(ports, run, window);
    const planned = wanted() ? await planWrites(ports, run, window, listed) : null;
    const tally = planned === null ? NOTHING : await applyWrites(ports, { ...planned, wanted });
    if (wanted()) ports.records.write(run.vault, { calendars: listed.following, lastSyncAt: ran });
    const failed = listed.failed.map(({ calendarId, problem }) => ({ calendarId, problem }));
    return {
      ran,
      created: tally.created,
      updated: tally.updated,
      missing: tally.missing,
      full: listed.complete,
      problem: null,
      failed,
      scopeRefused: listed.failed.some(({ cause }) => refusedScope(cause)),
    };
  } catch (cause) {
    return { ran, ...NOTHING, problem: googleProblemOf(cause), scopeRefused: refusedScope(cause) };
  }
}

/**
 * What Settings says went wrong with the last sync: why it stopped, else the
 * first calendar that did not sync, named. Null when it all synced.
 */
export function meetingSyncProblem(report: MeetingSyncReport): GoogleProblem | null {
  if (report.problem !== null) return report.problem;
  const [first] = report.failed;
  if (first === undefined) return null;
  return {
    problem: `${first.calendarId} did not sync: ${first.problem.problem}`,
    fix: first.problem.fix,
  };
}

const counted = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/**
 * What a sync says in Activity: what it wrote, or why it stopped. Null when
 * it wrote nothing and nothing went wrong — a sync every quarter hour that
 * finds nothing new is not news.
 */
export function meetingSyncActivity(report: MeetingSyncReport): ActivityReport | null {
  if (report.problem !== null) {
    const fix = report.problem.fix === null ? '' : ` ${report.problem.fix}`;
    return {
      level: 'warning',
      kind: 'source',
      message: `Meetings from Google Calendar did not sync: ${report.problem.problem}${fix}`,
      subject: null,
    };
  }
  const partial = meetingSyncProblem(report);
  if (partial !== null) {
    const fix = partial.fix === null ? '' : ` ${partial.fix}`;
    return {
      level: 'warning',
      kind: 'source',
      message: `Meetings from Google Calendar: ${partial.problem}${fix} The other calendars synced.`,
      subject: null,
    };
  }
  const parts = [
    report.created > 0 ? `${counted(report.created, 'meeting', 'meetings')} added` : null,
    report.updated > 0 ? `${counted(report.updated, 'meeting', 'meetings')} changed` : null,
    report.missing > 0 ? `${counted(report.missing, 'meeting', 'meetings')} cancelled` : null,
  ].filter((part) => part !== null);
  if (parts.length === 0) return null;
  return {
    level: 'info',
    kind: 'source',
    message: `Meetings from Google Calendar: ${parts.join(', ')}.`,
    subject: null,
  };
}
