/**
 * The morning brief (#39, ADR-0047): a pre-read for each of today's meetings,
 * written by a Claude step handed `data: meeting-briefs`. Every rule of it is
 * here — which meetings get one, the day a run briefs, what makes a brief
 * the one already written, where it goes and what it is called, and what the
 * step is handed — and reading the vault is the application's.
 */

import type { BriefParts, OpenLoops } from '../assistant/brief.ts';
import type { DayMeeting } from '../google-calendar/todays-meetings.ts';
import { EVENT_NOTE_KEYS } from '../google-calendar/event-notes.ts';
import { noteTitle } from '../vault/vault-entry.ts';
import { createVaultPath, type VaultPath } from '../vault/vault-path.ts';
import {
  Citations,
  citedSection,
  flattened,
  type CitedLine,
  type CitedStepData,
} from './cited-data.ts';
import type { PromptData } from './proposal-schema.ts';
import type { LocalTime } from './schedule.ts';

/** Where the preset writes the briefs: in the Inbox, so they wait there to be read. */
export const MORNING_BRIEF_FOLDER = 'Inbox/Briefs';

/**
 * The most meetings one run briefs: one ask each, so a day packed with
 * meetings cannot spend the model without bound. Run now briefs the rest.
 */
export const MAX_BRIEFS_PER_RUN = 10;

/** The most lines one section of a brief's data lists. */
export const BRIEF_SECTION_ITEMS = 20;

/** Why a meeting past the run's cap is left for later. */
export const BRIEFS_CAPPED_REASON = `One run briefs at most ${MAX_BRIEFS_PER_RUN} meetings: Run now briefs the rest.`;

/**
 * The day a run briefs: the day its period's slot is on, but only while that
 * is still today. A Mac that slept through yesterday's 07:00 and wakes this
 * morning catches the missed slot up, and must not brief meetings that are
 * over; null then, and the run briefs nothing.
 */
export function briefDayOf({ slot, now }: { slot: LocalTime; now: LocalTime }): string | null {
  const day = slot.slice(0, 10);
  return day === now.slice(0, 10) ? day : null;
}

/**
 * The meetings a brief is written for: those with a linked person or company,
 * since a brief is what the vault knows about who is met. `dayMeetings` has
 * already left out the cancelled (`gcal_missing`), the declined and the all-day.
 */
export function meetingsToBrief(meetings: readonly DayMeeting[]): DayMeeting[] {
  return meetings.filter((meeting) => meeting.people.length + meeting.companies.length > 0);
}

/**
 * What tells one meeting's brief from another's within the day, as the
 * brief's `atlas_period_item` says it: the Google event's id, which the event
 * note on either Mac carries, and the note's path only for an event note that
 * names none. With the period's slot (the day), it is the brief's key.
 */
export function briefItem({
  path,
  properties,
}: {
  path: VaultPath;
  properties: Readonly<Record<string, unknown>>;
}): string {
  const id = properties[EVENT_NOTE_KEYS.eventId];
  return typeof id === 'string' && id.trim() !== '' ? `gcal:${id.trim()}` : path;
}

/** The folder a day's briefs go in: one per day under the rule's own folder. */
export function briefFolder(folder: string, day: string): string {
  return `${folder.replace(/\/+$/, '')}/${day}`;
}

/** What a brief is called: when its meeting starts, then its title — `09.30 Larkspur Payroll sync`. */
export function briefNoteName(meeting: Pick<DayMeeting, 'start' | 'title'>): string {
  const title = flattened(meeting.title);
  return `${meeting.start.replace(':', '.')} ${title === '' ? 'Meeting' : title}`;
}

/** What `brief()` said of one person or company met (P32-04), as a brief's data reads it. */
export interface PageBrief
  extends
    Pick<OpenLoops, 'openTasks' | 'waitingFor' | 'followUps'>,
    Pick<BriefParts, 'lastTouch' | 'lastMeeting' | 'decisions' | 'mentions'> {
  readonly page: { readonly path: string; readonly title: string; readonly type: string };
  readonly truncated: boolean;
}

/** A person or company linked from the meeting whose brief could not be read, and why. */
export interface UnreadPage {
  readonly path: VaultPath;
  readonly problem: string;
}

/**
 * What one meeting's brief is handed: the meeting itself, then for each
 * person and company met what `brief()` says of them — open tasks, who waits
 * on whom, follow-ups, the last meeting and what came of it, decisions and
 * recent mentions — each line linking its note, which the brief must cite.
 */
export function meetingBriefData({
  meeting,
  briefs,
  unread = [],
}: {
  meeting: DayMeeting;
  briefs: readonly PageBrief[];
  unread?: readonly UnreadPage[];
}): CitedStepData {
  const citations = new Citations();
  const section = (about: string, lines: readonly CitedLine[]) =>
    citedSection({ about, lines, limit: BRIEF_SECTION_ITEMS, citations });
  const data: PromptData[] = [
    section('The meeting', meetingLines(meeting)),
    ...briefs.flatMap((brief) => pageSections(brief, section)),
    ...unreadData(unread),
  ];
  return { data, sources: citations.sources, plain: citations.plain };
}

const lineOf = (note: { path: string; title: string }, detail = ''): CitedLine => ({
  note: { path: createVaultPath(note.path), title: note.title },
  detail,
});

function meetingLines(meeting: DayMeeting): CitedLine[] {
  const when = meeting.end === null ? `at ${meeting.start}` : `${meeting.start}–${meeting.end}`;
  const answer = meeting.unanswered ? ', not answered yet' : '';
  return [
    lineOf(meeting, `today ${when}${answer}`),
    ...(meeting.meeting === null
      ? []
      : [lineOf({ path: meeting.meeting, title: noteTitle(meeting.meeting) }, 'its meeting note')]),
  ];
}

type SectionOf = (about: string, lines: readonly CitedLine[]) => PromptData;

function pageSections(brief: PageBrief, section: SectionOf): PromptData[] {
  const { page } = brief;
  const name = flattened(page.title);
  const met = brief.lastTouch?.date ?? null;
  const last = brief.lastMeeting;
  const sections = [
    section(`${page.type} ${name}`, [
      lineOf(page, met === null ? 'not met before' : `last met ${met}`),
    ]),
    section(
      `Open tasks with ${name}`,
      brief.openTasks.map((task) => lineOf(task, taskDetail(task))),
    ),
    section(
      `Waiting for, with ${name}`,
      brief.waitingFor.map((task) => lineOf(task, taskDetail(task))),
    ),
    section(
      `Follow-ups with ${name}`,
      brief.followUps.map((task) => lineOf(task, taskDetail(task))),
    ),
    section(
      `The last meeting with ${name}, and what came of it`,
      last === null
        ? []
        : [
            lineOf(last.meeting, last.meeting.date ?? ''),
            ...last.tasks.map((task) => lineOf(task, taskDetail(task))),
            ...last.decisions.map((decision) => lineOf(decision, 'decided')),
          ],
    ),
    section(
      `Decisions with ${name}`,
      brief.decisions.map((decision) => lineOf(decision, decision.date ?? '')),
    ),
    section(
      `Notes lately mentioning ${name}`,
      brief.mentions.map((note) => lineOf(note)),
    ),
  ];
  return brief.truncated
    ? [
        ...sections,
        {
          about: `More about ${name}`,
          text: 'The vault holds more than was read: a list may be short.',
        },
      ]
    : sections;
}

/** "status next, due 2026-10-20, overdue, waiting on Mara Quill for 9 days". */
function taskDetail(task: PageBrief['openTasks'][number]): string {
  const parts = [
    ...(task.status === null ? [] : [`status ${task.status}`]),
    ...(task.due === null ? [] : [`due ${task.due}`]),
    ...(task.overdue ? ['overdue'] : []),
    ...(task.waitingOn === null ? [] : [`waiting on ${task.waitingOn}`]),
    ...(task.waitingDays === null ? [] : [`for ${task.waitingDays} days`]),
  ];
  return parts.join(', ');
}

function unreadData(unread: readonly UnreadPage[]): PromptData[] {
  if (unread.length === 0) return [];
  const lines = unread.map(
    ({ path, problem }) => `- ${flattened(noteTitle(path))}: ${flattened(problem)}`,
  );
  return [{ about: 'Linked from the meeting, and could not be read', text: lines.join('\n') }];
}
