/**
 * What the Friday review draft (#40) is handed: the weekly review's sections
 * (P30-07), the week's finished tasks and meetings, and the Inbox's count —
 * each item with its note's path, which the draft must cite
 * (`cited-items.ts`). Data, fenced as the notes are, never instructions.
 */

import {
  Citations,
  citedSection,
  type CitedLine,
  type CitedStepData,
} from '../automations/cited-data.ts';
import type { PromptData } from '../automations/proposal-schema.ts';
import { localTimeMs, type LocalTime } from '../automations/schedule.ts';
import { addDays } from '../timeline/timeline.ts';
import type { VaultPath } from '../vault/vault-path.ts';
import {
  DAY_MS,
  STALE_WAITING_DAYS,
  UNTOUCHED_SOMEDAY_DAYS,
  type ReviewTask,
  type WeeklyReview,
} from './weekly-review.ts';

/** How far back the draft looks for what got done and who met: a week. */
export const REVIEW_DRAFT_DAYS = 7;

/** The most items one section lists: the draft is a week's review, not the vault. */
export const REVIEW_DRAFT_SECTION_ITEMS = 50;

/** A note the draft may cite: a finished task, or a meeting and its day. */
export interface ReviewSource {
  readonly path: VaultPath;
  readonly title: string;
  /** A meeting's day, `YYYY-MM-DD`. */
  readonly date?: string;
}

/** Everything the draft is worked out from, read at one moment. */
export interface ReviewDraftInput {
  readonly review: WeeklyReview;
  readonly done: readonly ReviewSource[];
  readonly meetings: readonly ReviewSource[];
  readonly inbox: { readonly toFile: number; readonly toAnswer: number; readonly more: boolean };
  /** The index held rows back, so a section may be missing items. */
  readonly truncated: boolean;
  readonly today: string;
  /** Milliseconds since the epoch, from the injected clock. */
  readonly now: number;
}

/**
 * The week the draft counts, from the slot it is written for back to the slot
 * before it: tasks finished from `sinceDay` to `untilDay`, meetings held on
 * those days — exactly seven, so a Friday's meetings are in one review and not
 * the next — and, for a task that says no day it was finished, when it was last
 * changed, from `since` to `until` (milliseconds since the epoch).
 *
 * The days are counted on the calendar, so a clock change moves none. The two
 * moments are the slot and the slot a week before it, taken from the wall clock
 * by how far it is from the instant `now`; across a clock change in between
 * they are an hour out, which only a task with no finished day can feel.
 */
export function reviewDraftWindow({
  slot,
  localNow,
  now,
}: {
  /** The time the schedule fell due that the draft is written for. */
  slot: LocalTime;
  /** The wall clock at `now`. */
  localNow: LocalTime;
  now: number;
}): ReviewWeek {
  const slotDay = slot.slice(0, 10);
  const wallToInstant = (day: string): number => {
    const wall = localTimeMs(`${day}T${slot.slice(11)}`) ?? now;
    return wall - ((localTimeMs(localNow) ?? now) - now);
  };
  const before = addDays(slotDay, -REVIEW_DRAFT_DAYS) ?? slotDay;
  return {
    since: wallToInstant(before),
    until: wallToInstant(slotDay),
    sinceDay: addDays(slotDay, 1 - REVIEW_DRAFT_DAYS) ?? slotDay,
    untilDay: slotDay,
  };
}

/** A week of the draft's window: see {@link reviewDraftWindow}. */
export interface ReviewWeek {
  readonly since: number;
  readonly until: number;
  readonly sinceDay: string;
  readonly untilDay: string;
}

/** The data the step is handed, and the notes it may cite. */
export type ReviewDraftData = CitedStepData;

/** Each section of the draft's data, the items it lists, and how each is said. */
export function reviewDraftData(input: ReviewDraftInput): ReviewDraftData {
  const { review, now } = input;
  // Only a task whose time is known is ever untouched: an unknown time is never stale (ADR-0053).
  const since = (task: ReviewTask) =>
    `untouched for ${Math.floor((now - (task.modified ?? now)) / DAY_MS)} days`;
  const sections: readonly Section[] = [
    { about: `Done in the last ${REVIEW_DRAFT_DAYS} days`, items: input.done.map(plainLine) },
    {
      about: `Meetings in the last ${REVIEW_DRAFT_DAYS} days`,
      items: input.meetings.map((meeting) => sourceLine(meeting, meeting.date ?? '')),
    },
    {
      about: `Waiting on someone for more than ${STALE_WAITING_DAYS} days`,
      items: review.staleWaiting.map((task) =>
        sourceLine(task, `waiting on ${task.waitingOn || 'nobody named'}, ${since(task)}`),
      ),
    },
    {
      about: 'Overdue',
      items: review.overdue.map((task) => sourceLine(task, `due ${task.due ?? ''}`)),
    },
    {
      about: 'Active projects with no next action',
      items: review.projectsWithoutNextAction.map(plainLine),
    },
    {
      about: `Someday, untouched for more than ${UNTOUCHED_SOMEDAY_DAYS} days`,
      items: review.untouchedSomeday.map((task) => sourceLine(task, since(task))),
    },
  ];
  const citations = new Citations();
  const data = sections.map(({ about, items }) =>
    citedSection({ about, lines: items, limit: REVIEW_DRAFT_SECTION_ITEMS, citations }),
  );
  return {
    data: [...data, inboxData(input)],
    sources: citations.sources,
    plain: citations.plain,
  };
}

interface Section {
  readonly about: string;
  readonly items: readonly CitedLine[];
}

const sourceLine = (note: { path: VaultPath; title: string }, detail: string): CitedLine => ({
  note,
  detail,
});

const plainLine = (note: { path: VaultPath; title: string }): CitedLine => sourceLine(note, '');

function inboxData({ inbox, truncated }: ReviewDraftInput): PromptData {
  const notes = `${inbox.more ? 'More than ' : ''}${inbox.toFile} notes to file`;
  const held = truncated
    ? ' The vault holds more tasks than were read: a section may be short.'
    : '';
  return {
    about: 'The Inbox',
    text: `${notes}, ${inbox.toAnswer} proposals to answer.${held}`,
  };
}
