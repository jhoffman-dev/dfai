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
