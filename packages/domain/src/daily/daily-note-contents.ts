import { GTD_STATUSES, type GtdStatus } from '../gtd/gtd-status.ts';
import { queryBlockFence } from '../query-block/query-block.ts';
import { promisesItsDay } from '../review/weekly-review.ts';
import { VAULT_ROOT } from '../vault/vault-path.ts';
import { DAILY_TYPE } from './daily-note.ts';

/**
 * What today's note starts with in a vault with no Daily template (#110):
 * the day itself, as live query blocks, above a heading for what happened and
 * one for what comes next. A Daily template of the vault's own always wins
 * over this, and a note that is already there is never written again.
 *
 * The blocks are live, so the file holds no copy of a task to go stale: it is
 * written once and stays byte for byte as made. Each names the note's own day
 * rather than `@today`, so last Tuesday's note still shows last Tuesday's day
 * when it is opened again; on the day itself the two are the same day, the
 * Mac's, which is the day `@today` and the Today page read.
 */

/** One heading of the day and the query under it. */
export interface DailyDaySection {
  readonly heading: string;
  /** The query block's text: a `layout:` line, then the query. */
  readonly block: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The statuses that promise a day, as the Today page and the weekly review
 * judge them: a task in one of these is due or late; Someday, Longterm and
 * finished work are neither.
 */
const DAY_STATUSES: readonly GtdStatus[] = GTD_STATUSES.filter((status) =>
  promisesItsDay({
    path: VAULT_ROOT,
    title: '',
    status,
    due: null,
    defer: null,
    waitingOn: '',
    contexts: [],
    project: null,
    projectTitle: null,
    modified: 0,
  }),
);

const anyOf = (statuses: readonly GtdStatus[]) =>
  `(${statuses.map((status) => `status = ${status}`).join(' OR ')})`;

/**
 * What the blocks show: only the fields they ask about, so a block runs in
 * any vault whose Task type can be asked what is due — one without
 * `contexts` or `project` shows no error where the day should be.
 */
const SHOWN = 'SHOW status, due';

/** In play on `day`: not put off to a later one. */
const inPlay = (day: string) => `(defer IS EMPTY OR defer <= ${day})`;

/**
 * The day's sections, in the order the note shows them. Each task is listed
 * once, as on the Today page: a next action due by the day is under Due and
 * overdue only.
 *
 * #108's "Chosen for today" belongs first here once it has merged: a section
 * whose block lists the tasks whose `focus` is the day.
 */
export function dailyDaySections(day: string): readonly DailyDaySection[] {
  if (!DAY.test(day)) throw new RangeError(`today's note needs a day as YYYY-MM-DD, not ${day}`);
  return [
    {
      heading: 'Due and overdue',
      block: [
        'layout: list',
        'FROM task',
        `WHERE due <= ${day} AND ${inPlay(day)} AND ${anyOf(DAY_STATUSES)}`,
        'SORT BY due',
        SHOWN,
      ].join('\n'),
    },
    {
      heading: 'Next actions',
      block: [
        'layout: list',
        'FROM task',
        `WHERE status = next-action AND ${inPlay(day)} AND (due IS EMPTY OR due > ${day})`,
        'SORT BY due',
        SHOWN,
      ].join('\n'),
    },
  ];
}

/** Today's note as it starts on `day` when the vault has no Daily template. */
export function dailyNoteContents(day: string): string {
  const sections = dailyDaySections(day).flatMap(({ heading, block }) => [
    `## ${heading}`,
    '',
    queryBlockFence(block),
    '',
  ]);
  return [
    '---',
    `type: ${DAILY_TYPE}`,
    '---',
    '',
    ...sections,
    '## What happened',
    '',
    '## What is next',
    '',
  ].join('\n');
}
