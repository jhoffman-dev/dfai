/**
 * Every written form of `due` the due reader (`gtd/task-due.ts`, #928) is held
 * to, with what every surface must read it as: the day it is on, and the time
 * of day it shows, or no due at all. Each surface's sweep runs over all of them.
 */
export interface DueForm {
  readonly form: string;
  readonly written: string;
  /** `YYYY-MM-DD`, or null for a value every surface reads as no due. */
  readonly day: string | null;
  /** `HH:MM`, or null where no time shows. */
  readonly time: string | null;
}

export const DUE_FORM_DAY = '2026-12-04';

export const DUE_FORMS: readonly DueForm[] = [
  { form: 'a day', written: '2026-12-04', day: DUE_FORM_DAY, time: null },
  { form: 'T15:30', written: '2026-12-04T15:30', day: DUE_FORM_DAY, time: '15:30' },
  { form: 'a space', written: '2026-12-04 15:30', day: DUE_FORM_DAY, time: '15:30' },
  { form: 'seconds', written: '2026-12-04T15:30:59', day: DUE_FORM_DAY, time: '15:30' },
  { form: 'a zone', written: '2026-12-04T15:30Z', day: DUE_FORM_DAY, time: '15:30' },
  { form: 'T24:00', written: '2026-12-04T24:00', day: DUE_FORM_DAY, time: null },
  { form: 'T23:60', written: '2026-12-04T23:60', day: null, time: null },
  { form: 'T15:3', written: '2026-12-04T15:3', day: null, time: null },
  { form: 'a bare T', written: '2026-12-04T', day: null, time: null },
];

/**
 * A `due` that is not one entry (PR #930 audit): a list of several
 * entries, a mapping, a number, `true`, an empty string. What each surface reads it as is pinned beside it, as is what main
 * did; anything that decides behaves as main did, or errs to asking.
 */
export interface OddDueForm {
  readonly form: string;
  readonly value: unknown;
  /** The day Today, the review and the Inbox read from the index (the first dated entry), as main did. */
  readonly indexedDay: string | null;
  /**
   * The time every surface reads and shows: one entry's only. A list of
   * several is judged by its first day alone, as main judged it.
   */
  readonly indexedTime: string | null;
}

export const ODD_DUE_FORMS: readonly OddDueForm[] = [
  {
    form: 'a list of two dates',
    value: ['2026-12-04T15:30', '2026-12-05'],
    indexedDay: DUE_FORM_DAY,
    indexedTime: null,
  },
  {
    form: 'a list, a date then words',
    value: ['2026-12-04', 'soon'],
    indexedDay: DUE_FORM_DAY,
    indexedTime: null,
  },
  {
    form: 'a list, words then a date',
    value: ['soon', '2026-12-04T09:00'],
    indexedDay: DUE_FORM_DAY,
    indexedTime: null,
  },
  { form: 'a list of words', value: ['soon', 'later'], indexedDay: null, indexedTime: null },
  { form: 'a mapping', value: { on: '2026-12-04' }, indexedDay: null, indexedTime: null },
  { form: 'a number', value: 20261204, indexedDay: null, indexedTime: null },
  { form: 'true', value: true, indexedDay: null, indexedTime: null },
  { form: 'an empty string', value: '', indexedDay: null, indexedTime: null },
];

/**
 * A due written as a list whose one entry, blanks aside, is a due (PR #930):
 * read, and acted on, exactly as that entry written alone.
 */
export const LISTED_ONE_FORMS: readonly {
  readonly form: string;
  readonly value: unknown;
  readonly as: string;
}[] = ['2026-12-04T15:30', '2026-12-04'].flatMap((entry) => [
  { form: `[${entry}]`, value: [entry], as: entry },
  { form: `['', ${entry}]`, value: ['', entry], as: entry },
  { form: `[${entry}, '']`, value: [entry, ''], as: entry },
]);

/**
 * A due written as the indexer flattens and trims it (`toIndexableProperties`):
 * nested lists, padding, and non-text items beside a date. Each must read as
 * the index stores it (PR #930).
 */
const TIMED = '2026-12-04T15:30';
export const INDEXED_SHAPES: readonly { readonly form: string; readonly value: unknown }[] = [
  { form: '[[x]]', value: [[TIMED]] },
  { form: '[[x], []]', value: [[TIMED], []] },
  { form: '[[x, y]]', value: [[TIMED, '2026-12-05']] },
  { form: '[[], [x]]', value: [[], [TIMED]] },
  { form: '[[[x]]]', value: [[[TIMED]]] },
  { form: 'padded', value: ` ${TIMED} ` },
  { form: '[padded]', value: [` ${TIMED} `] },
  { form: '[x, null]', value: [TIMED, null] },
  { form: '[null, x]', value: [null, TIMED] },
  { form: '[x, a mapping]', value: [TIMED, { on: '2026-12-05' }] },
  { form: '[x, a number]', value: [TIMED, 5] },
  { form: '[x, true]', value: [TIMED, true] },
  { form: '[a mapping]', value: [{ on: TIMED }] },
];

/** Every value the cross-check runs every surface over: the written forms, the odd ones, the lists of one. */
export const EVERY_DUE_VALUE: readonly { readonly form: string; readonly value: unknown }[] = [
  ...DUE_FORMS.map(({ form, written }) => ({ form, value: written })),
  ...ODD_DUE_FORMS.map(({ form, value }) => ({ form, value })),
  ...LISTED_ONE_FORMS.map(({ form, value }) => ({ form, value })),
  ...INDEXED_SHAPES,
];
