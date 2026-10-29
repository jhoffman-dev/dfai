import { isArchivedPath } from '../archive/archive.ts';
import type { MeetingAttendee } from '../meetings/meeting-header.ts';
import { emailKey } from '../meetings/mapping/meeting-email-key.ts';
import type { ProposalConfidence } from '../proposals/proposal.ts';
import { paraOf } from '../types/para-value.ts';
import type { VaultPath } from '../vault/vault-path.ts';
import type { DirectoryPerson } from './attendee-matching.ts';
import { isOwnerAttendee, isOwnerNote, ownerAddresses, sameName } from './vault-owner.ts';

/** A project's statuses that say it is over: nothing is filed under it any more. */
export const CLOSED_PROJECT_STATUSES = ['done', 'cancelled', 'dropped'] as const;

/** The open project or area a meeting is filed under. */
export interface FiledProject {
  readonly path: VaultPath;
  readonly title: string;
}

/** A meeting as the series rule reads it (#227). */
export interface SeriesMeeting {
  readonly path: VaultPath;
  readonly title: string;
  /** `YYYY-MM-DD`. */
  readonly date: string;
  /** `HH:MM`, local; null when its note does not say. */
  readonly start: string | null;
  readonly provider: string;
  /** Who was there besides the vault's owner ({@link meetingParticipants}). */
  readonly participants: readonly string[];
  /** The open project or area it is filed under; null when none, or one that is closed. */
  readonly project: FiledProject | null;
  /**
   * Whether its `project` holds anything, open or not. One filed under a
   * closed project (`project` null) still holds its day in its series.
   */
  readonly filed: boolean;
}

/** What a meeting is likely filed under, how sure that is, and why. */
export interface ProjectSuggestion {
  readonly project: VaultPath;
  readonly title: string;
  readonly confidence: ProposalConfidence;
  /** Whence: the same meeting's copy from another provider, or earlier meetings of its series. */
  readonly via: 'twin' | 'series';
  /** In a sentence: "Same series as 2026-10-07 Larkspur Standup: …". */
  readonly reason: string;
}

/** Two copies of one meeting start less than this far apart: the notetakers start recording at different moments. */
export const TWIN_START_MINUTES = 15;

/**
 * How much two meetings' people must overlap to be one series: shared over
 * all (Jaccard), owner aside. Half: the same 1:1 counterpart, or most of a
 * team — never one colleague two teams share.
 */
export const SERIES_PEOPLE_OVERLAP = 0.5;

/**
 * The words a title says nothing with: "1:1", "Weekly Sync", "Daily
 * Standup", "Team Meeting". A title made only of these is generic — many
 * series share it — so it never ties two meetings by itself.
 */
const GENERIC_TITLE_WORDS = new Set(
  (
    '1 11 1on1 one on a an the and with daily weekly biweekly monthly quarterly team quick ' +
    'standup stand up sync syncup meeting meet call chat check in checkin catch catchup huddle ' +
    'all hands retro retrospective planning sprint review demo office hours untitled new ' +
    'zoom google teams connect touch base intro introduction lunch coffee busy hold focus ' +
    'time event discussion session update updates status follow followup kickoff kick off ' +
    'brainstorm working'
  ).split(' '),
);

/** How many of a series' latest days the majority is taken over: the recent past, not its whole history. */
export const SERIES_WINDOW = 6;

/**
 * Whether a note can have meetings filed under it: a project or an area by
 * its PARA — never a resource or an archived one (#213) — outside the
 * Archive, and not done, cancelled or dropped.
 */
export function isOpenFiling({
  path,
  type,
  para,
  status,
}: {
  path: string;
  type: unknown;
  para: unknown;
  status: unknown;
}): boolean {
  if (isArchivedPath(path)) return false;
  const value = paraOf({ type, para });
  if (value !== 'project' && value !== 'area') return false;
  const state = typeof status === 'string' ? status.trim().toLowerCase() : '';
  return !(CLOSED_PROJECT_STATUSES as readonly string[]).includes(state);
}

/**
 * A meeting's title as a series shares it: letters and digits only, case
 * folded and accents dropped, so "Ledger v2 Sync" is "Ledger V2 Sync"
 * and "1:1" is "1-1".
 */
export function seriesTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The vault's owner, as a meeting's participants leave them out. */
export interface ParticipantOwner {
  readonly selfName: string | null;
  /** Every name the owner goes by: the profile's, and each name and alias of their Person notes. */
  readonly names: readonly string[];
  readonly selfEmails: readonly string[];
  /** The owner's own Person notes. */
  readonly notes: readonly VaultPath[];
}

/**
 * The vault's owner as participants leave them out: their name, the
 * vault's `selfEmails` and the addresses on their own Person note, those
 * Person notes — of that name or alias, or at one of those addresses — and
 * every name and alias the notes give. Any of them is the owner: leaving one
 * in would make every meeting share a participant.
 */
export function participantOwnerOf({
  people,
  selfName,
  selfEmails,
}: {
  people: readonly DirectoryPerson[];
  selfName: string | null;
  selfEmails: readonly string[];
}): ParticipantOwner {
  const emails = [...new Set([...selfEmails, ...ownerAddresses(people, selfName)])];
  const mine = new Set(emails.map(emailKey));
  const own = people.filter(
    (person) => isOwnerNote(person, selfName) || person.emails.some((e) => mine.has(emailKey(e))),
  );
  const names = [selfName, ...own.flatMap((person) => [person.name, ...person.aliases])].filter(
    (name): name is string => name !== null && name.trim() !== '',
  );
  return {
    selfName,
    names: [...new Set(names)],
    selfEmails: emails,
    notes: own.map((person) => person.path),
  };
}

/**
 * Whether the owner can be told at all: by a name, an address or a Person
 * note. When not, the owner is left in every meeting's participants, and no
 * series or twin is sure enough to file a meeting by itself.
 */
export function isOwnerKnown(owner: ParticipantOwner): boolean {
  return owner.names.length > 0 || owner.selfEmails.length > 0 || owner.notes.length > 0;
}

/**
 * Who was at a meeting besides the vault's owner, as keys two meetings can
 * share: each attendee's address (their name when they have none) and each
 * Person note it links. The owner is at every meeting, so sharing them
 * says nothing about which series a meeting is.
 */
export function meetingParticipants({
  attendees,
  people,
  owner,
}: {
  attendees: readonly MeetingAttendee[];
  people: readonly VaultPath[];
  owner: ParticipantOwner;
}): string[] {
  const ownNotes = new Set(owner.notes.map((path) => path.toLowerCase()));
  const listed = attendees
    .filter((attendee) => !isOwnerParticipant(attendee, owner))
    .map(({ name, email }) =>
      email === null ? `name:${seriesTitle(name)}` : `email:${emailKey(email)}`,
    );
  const linked = people
    .map((path) => path.toLowerCase())
    .filter((path) => !ownNotes.has(path))
    .map((path) => `note:${path}`);
  return [...new Set([...listed, ...linked])];
}

function isOwnerParticipant(attendee: MeetingAttendee, owner: ParticipantOwner): boolean {
  return (
    isOwnerAttendee({ attendee, selfName: null, selfEmails: owner.selfEmails }) ||
    owner.names.some((name) => sameName(attendee.name, name))
  );
}

/**
 * Where `meeting` is likely filed, from the meetings around it (#227), or
 * null when nothing says: its twin — the same meeting recorded by another
 * notetaker — when that is filed; else the majority of its series' latest
 * meetings ({@link seriesSuggestion}). Never an AI's guess, and never a
 * closed project. When unsure it says so: two twins filed apart, or an owner
 * who cannot be told from the people at a meeting, never make it high.
 */
export function suggestMeetingProject({
  meeting,
  others,
  ownerKnown,
}: {
  meeting: SeriesMeeting;
  others: readonly SeriesMeeting[];
  /** Whether the owner was left out of participants ({@link isOwnerKnown}). */
  ownerKnown: boolean;
}): ProjectSuggestion | null {
  const elsewhere = others.filter((other) => other.path !== meeting.path);
  const twin = twinOf(meeting, elsewhere);
  const suggestion = twin.kind === 'one' ? twin.suggestion : seriesSuggestion(meeting, elsewhere);
  const sure = ownerKnown && twin.kind !== 'disagreeing';
  return suggestion !== null && !sure ? atMostMedium(suggestion) : suggestion;
}

function atMostMedium(suggestion: ProjectSuggestion): ProjectSuggestion {
  return suggestion.confidence === 'high' ? { ...suggestion, confidence: 'medium' } : suggestion;
}

/** What this meeting's filed copies from other providers say: none, one project, or not one. */
type TwinReading =
  | { readonly kind: 'none' }
  | { readonly kind: 'one'; readonly suggestion: ProjectSuggestion }
  | { readonly kind: 'disagreeing' };

/**
 * The filed copies of this meeting from another provider ({@link isTwin}),
 * nearest start first. They answer only when every one is filed under the
 * same open project; copies filed apart, or under a closed one, answer nothing.
 */
function twinOf(meeting: SeriesMeeting, others: readonly SeriesMeeting[]): TwinReading {
  const twins = others
    .filter((other) => other.filed && isTwin(meeting, other))
    .sort((left, right) => startGap(meeting, left) - startGap(meeting, right));
  const [twin] = twins;
  if (twin === undefined) return { kind: 'none' };
  const project = twin.project;
  if (project === null || twins.some((other) => other.project?.path !== project.path)) {
    return { kind: 'disagreeing' };
  }
  return {
    kind: 'one',
    suggestion: {
      project: project.path,
      title: project.title,
      confidence: 'high',
      via: 'twin',
      reason: `The same meeting as ${twin.provider}’s copy, ${described(twin)}, which is filed under ${project.title}.`,
    },
  };
}

/**
 * Whether `other` is another notetaker's copy of `meeting`: the same day,
 * started less than {@link TWIN_START_MINUTES} apart, the same series title,
 * and a person in common — or, for a title that is not generic, nobody listed
 * on one side to compare. Never people alone, nor a title alone when both
 * list who was there.
 */
function isTwin(meeting: SeriesMeeting, other: SeriesMeeting): boolean {
  if (other.date !== meeting.date || other.provider === meeting.provider) return false;
  if (startGap(meeting, other) >= TWIN_START_MINUTES) return false;
  if (!sameSeriesTitle(meeting, other)) return false;
  if (sharesParticipant(meeting, other)) return true;
  return eitherUnlisted(meeting, other) && !isGenericTitle(meeting.title);
}

/** Minutes between two meetings' starts; past any twin when either does not say. */
function startGap(left: SeriesMeeting, right: SeriesMeeting): number {
  const [from, to] = [minutesOf(left.start), minutesOf(right.start)];
  return from === null || to === null ? Number.POSITIVE_INFINITY : Math.abs(from - to);
}

function minutesOf(start: string | null): number | null {
  const match = start === null ? null : /^(\d{1,2}):(\d{2})/.exec(start.trim());
  return match === null ? null : Number(match[1]) * 60 + Number(match[2]);
}

/**
 * The filed meetings of `meeting`'s series, and whether only their titles tie
 * them to it: the same series title and much the same people
 * ({@link samePeople}); or, for a title that is not generic, nobody listed on
 * one side to compare.
 */
function seriesOf(meeting: SeriesMeeting, others: readonly SeriesMeeting[]) {
  const titled = others.filter((other) => other.filed && sameSeriesTitle(meeting, other));
  const together = titled.filter((other) => samePeople(meeting, other));
  if (together.length > 0) return { members: together, titleOnly: false };
  if (isGenericTitle(meeting.title)) return { members: [], titleOnly: true };
  // Nobody listed on one side: the title is all there is to go on.
  const unlisted = titled.filter((other) => eitherUnlisted(meeting, other));
  return { members: unlisted, titleOnly: true };
}

function sameSeriesTitle(left: SeriesMeeting, right: SeriesMeeting): boolean {
  const title = seriesTitle(left.title);
  return title !== '' && title === seriesTitle(right.title);
}

/** Whether a title is made only of words many series share ({@link GENERIC_TITLE_WORDS}). */
export function isGenericTitle(title: string): boolean {
  const words = seriesTitle(title).split(' ');
  return words.every((word) => word === '' || GENERIC_TITLE_WORDS.has(word));
}

function eitherUnlisted(left: SeriesMeeting, right: SeriesMeeting): boolean {
  return left.participants.length === 0 || right.participants.length === 0;
}

function sharesParticipant(left: SeriesMeeting, right: SeriesMeeting): boolean {
  const theirs = new Set(right.participants);
  return left.participants.some((participant) => theirs.has(participant));
}

/**
 * Whether two meetings had much the same people: of the Person notes both
 * link, or else of the attendees both list, at least
 * {@link SERIES_PEOPLE_OVERLAP} shared of all. Each kind is compared only
 * when both meetings have it: one notetaker's names are not another's links.
 */
function samePeople(left: SeriesMeeting, right: SeriesMeeting): boolean {
  return [linkedPeople, listedPeople].some((kind) => {
    const [mine, theirs] = [kind(left), kind(right)];
    if (mine.size === 0 || theirs.size === 0) return false;
    const shared = [...mine].filter((key) => theirs.has(key)).length;
    return shared / (mine.size + theirs.size - shared) >= SERIES_PEOPLE_OVERLAP;
  });
}

const linkedPeople = (meeting: SeriesMeeting) =>
  new Set(meeting.participants.filter((key) => key.startsWith('note:')));

const listedPeople = (meeting: SeriesMeeting) =>
  new Set(meeting.participants.filter((key) => !key.startsWith('note:')));

/** One day of a series, and the meetings of it held that day. */
interface SeriesDay {
  readonly date: string;
  readonly meetings: readonly SeriesMeeting[];
}

/**
 * The project most of the series' latest days are filed under (#227): the
 * {@link SERIES_WINDOW} days nearest the meeting, each day one vote per
 * project — two notetakers' copies of one meeting are one meeting. A tie
 * goes to the nearest day. A day filed under a project now closed votes for
 * it too: the series moved on to it, so it outvotes an older open one; when
 * it wins, nothing is suggested.
 *
 * High when two or more days agree, two thirds of them, the nearest among
 * them, and the series shares people with the meeting; medium on a plain
 * majority, or a series of one; low when the nearest day had to break a tie,
 * no project holds a majority, or the nearest day is filed under a closed
 * project. A series tied by title alone, with nobody listed to compare, is
 * medium at most.
 */
function seriesSuggestion(
  meeting: SeriesMeeting,
  others: readonly SeriesMeeting[],
): ProjectSuggestion | null {
  const { members, titleOnly } = seriesOf(meeting, others);
  const days = nearestDays(meeting, members).slice(0, SERIES_WINDOW);
  const tally = tallied(days);
  const [winner, runnerUp] = tally;
  const project = winner?.project ?? null;
  if (winner === undefined || project === null) return null;
  const tied = runnerUp !== undefined && runnerUp.votes === winner.votes;
  const nearestAgrees = filedUnder(days[0], project.path);
  const share = winner.votes / days.length;
  const confidence = seriesConfidence({
    votes: winner.votes,
    share,
    tied,
    nearestAgrees,
    nearestClosed: days[0] !== undefined && projectsOf(days[0]).includes(null),
    days,
  });
  const latest = days.find((day) => filedUnder(day, project.path))!;
  return {
    project: project.path,
    title: project.title,
    confidence: titleOnly && confidence === 'high' ? 'medium' : confidence,
    via: 'series',
    reason: seriesReason({ latest, project, votes: winner.votes, days: days.length, titleOnly }),
  };
}

function seriesConfidence({
  votes,
  share,
  tied,
  nearestAgrees,
  nearestClosed,
  days,
}: {
  votes: number;
  share: number;
  tied: boolean;
  nearestAgrees: boolean;
  /** The nearest day is filed under a project now closed: the series may have moved past every open one. */
  nearestClosed: boolean;
  days: readonly SeriesDay[];
}): ProposalConfidence {
  if (tied || nearestClosed) return 'low';
  if (votes >= 2 && share >= 2 / 3 && nearestAgrees) return 'high';
  if (share > 1 / 2 || days.length === 1) return 'medium';
  return 'low';
}

/** The series' days, nearest the meeting first; of two as near, the later. */
function nearestDays(meeting: SeriesMeeting, members: readonly SeriesMeeting[]): SeriesDay[] {
  const byDate = new Map<string, SeriesMeeting[]>();
  for (const member of members)
    byDate.set(member.date, [...(byDate.get(member.date) ?? []), member]);
  const held = dayNumber(meeting.date);
  return [...byDate]
    .map(([date, meetings]) => ({ date, meetings, distance: Math.abs(dayNumber(date) - held) }))
    .sort((left, right) => left.distance - right.distance || compareText(right.date, left.date))
    .map(({ date, meetings }) => ({ date, meetings }));
}

/** Days since the epoch of a `YYYY-MM-DD`; a date that is none counts as far off. */
function dayNumber(date: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) return Number.MAX_SAFE_INTEGER / 2;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000;
}

interface Tally {
  /** The open project voted for; null for one now closed. */
  readonly project: FiledProject | null;
  readonly votes: number;
  /** The index of the nearest day filed under it: what breaks a tie. */
  readonly nearest: number;
}

/**
 * Each project's votes, one per day — every closed project's together as one
 * — most first; a tie, the nearer first, then by title and path.
 */
function tallied(days: readonly SeriesDay[]): Tally[] {
  const tally = new Map<string, Tally>();
  days.forEach((day, at) => {
    for (const project of projectsOf(day)) {
      const key = project?.path ?? '';
      const counted = tally.get(key);
      tally.set(key, {
        project,
        votes: (counted?.votes ?? 0) + 1,
        nearest: counted?.nearest ?? at,
      });
    }
  });
  return [...tally.values()].sort(
    (left, right) =>
      right.votes - left.votes ||
      left.nearest - right.nearest ||
      compareText(titleOf(left).toLowerCase(), titleOf(right).toLowerCase()) ||
      compareText(left.project?.path ?? '', right.project?.path ?? ''),
  );
}

const titleOf = (tally: Tally) => tally.project?.title ?? '';

/** What a day's meetings are filed under: each open project, and null when one is filed under a closed one. */
function projectsOf(day: SeriesDay): (FiledProject | null)[] {
  const projects = new Map<string, FiledProject | null>();
  for (const { project } of day.meetings) projects.set(project?.path ?? '', project);
  return [...projects.values()];
}

function filedUnder(day: SeriesDay | undefined, project: VaultPath): boolean {
  return day?.meetings.some((meeting) => meeting.project?.path === project) === true;
}

function seriesReason({
  latest,
  project,
  votes,
  days,
  titleOnly,
}: {
  latest: SeriesDay;
  project: FiledProject;
  votes: number;
  days: number;
  titleOnly: boolean;
}): string {
  const meeting = latest.meetings.find((each) => each.project?.path === project.path)!;
  const share =
    days === 1
      ? `, which is filed under ${project.title}`
      : `: ${votes} of its last ${days} were filed under ${project.title}`;
  const basis = titleOnly ? ' Matched by title alone: neither lists anyone to compare.' : '';
  return `Same series as ${described(meeting)}${share}.${basis}`;
}

/** "2026-10-07 Larkspur Standup". */
function described(meeting: SeriesMeeting): string {
  return `${meeting.date} ${meeting.title}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
