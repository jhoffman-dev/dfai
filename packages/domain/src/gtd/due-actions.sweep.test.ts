import { describe, expect, it } from 'vitest';
import { calendarEvents } from '../calendar/calendar-event.ts';
import { clarifyPlan } from '../inbox/clarify.ts';
import { repeatingTaskUpdate } from '../query/repeating-task.ts';
import { DUE_FORMS, type DueForm } from '../testing/due-forms.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import { dueEventTime, dueOf, dueRescheduled, dueWithTime, movedDue } from './task-due.ts';

/**
 * #928, PR #930 review: what each action that changes or uses a due writes,
 * for every written form — the exact text, or that the action is not offered
 * (a value that is no due is on no calendar and has no time field). No action
 * offered for a form does nothing. The panel's and the API's are swept beside them.
 */
const NEXT_DAY = '2026-12-05';

/** Each form moved to the next day: its time kept as written; a time the reader does not read dropped. */
const ON_NEXT_DAY: Readonly<Record<string, string | null>> = {
  'a day': '2026-12-05',
  'T15:30': '2026-12-05T15:30',
  'a space': '2026-12-05 15:30',
  seconds: '2026-12-05T15:30:59',
  'a zone': '2026-12-05T15:30Z',
  'T24:00': '2026-12-05',
  'T23:60': null,
  'T15:3': null,
  'a bare T': null,
};

const onCalendar = (form: DueForm) =>
  calendarEvents({
    rows: [{ path: 'Tasks/Probe.md', title: 'Probe', values: { due: form.written } }],
    dateKey: 'due',
    endKey: null,
    readStart: dueEventTime,
  }).events.length === 1;

describe('drag to another day on a task calendar (month, or the all-day strip; pointer or keyboard)', () => {
  it.each(DUE_FORMS)('moves $form to the next day as its due', (form) => {
    expect(onCalendar(form)).toBe(form.day !== null);
    if (form.day === null) return;
    const write = movedDue({ start: form.written, end: null, days: 1, minutes: 0 });
    expect(write.start).toBe(ON_NEXT_DAY[form.form]);
    expect(write.start).not.toBe(form.written);
  });
});

describe('drag onto a clock time (week, three days, day)', () => {
  /** Each timed form an hour later, in its own shape; an all-day due is moved by days only. */
  const AN_HOUR_LATER: Readonly<Record<string, string>> = {
    'T15:30': '2026-12-04T16:30',
    'a space': '2026-12-04 16:30',
    seconds: '2026-12-04T16:30:59',
    'a zone': '2026-12-04T16:30Z',
  };

  it.each(DUE_FORMS)('moves $form an hour on, or is not offered for an all-day due', (form) => {
    if (form.day === null) return expect(onCalendar(form)).toBe(false);
    const event = calendarEvents({
      rows: [{ path: 'Tasks/Probe.md', title: 'Probe', values: { due: form.written } }],
      dateKey: 'due',
      endKey: null,
      readStart: dueEventTime,
    }).events[0];
    // The clock's drag reports minutes only for a note on the clock (`clock-drag.ts`).
    expect(event?.start.minutes !== null).toBe(form.time !== null);
    if (form.time === null) return;
    const write = movedDue({ start: form.written, end: null, days: 0, minutes: 60 });
    expect(write.start).toBe(AN_HOUR_LATER[form.form]);
  });
});

describe('a new day picked by the person: the panel, an Inbox row', () => {
  it.each(DUE_FORMS)('writes $form on the next day', (form) => {
    // A value that is no due is replaced by the day picked, as on main.
    expect(dueRescheduled(form.written, NEXT_DAY)).toBe(ON_NEXT_DAY[form.form] ?? NEXT_DAY);
  });

  it.each(DUE_FORMS)('Clarify from an Inbox row writes $form on the next day', (form) => {
    const plan = clarifyPlan({
      path: createVaultPath('Inbox/Probe.md'),
      properties: { type: 'task', status: 'inbox', due: form.written },
      clarification: { due: NEXT_DAY, keepsDueTime: true },
      notePaths: [],
      today: '2026-12-01',
    });
    expect(plan).toMatchObject({ changes: { due: ON_NEXT_DAY[form.form] ?? NEXT_DAY } });
  });

  it.each(DUE_FORMS)('Clarify through the API writes the day alone for $form', (form) => {
    const plan = clarifyPlan({
      path: createVaultPath('Inbox/Probe.md'),
      properties: { type: 'task', status: 'inbox', due: form.written },
      clarification: { due: NEXT_DAY },
      notePaths: [],
      today: '2026-12-01',
    });
    expect(plan).toMatchObject({ changes: { due: NEXT_DAY } });
  });
});

describe('set time and clear time', () => {
  it.each(DUE_FORMS)('sets 09:05 on $form, or is not offered for no due', (form) => {
    const written = dueWithTime(form.written, '09:05');
    expect(written).toBe(form.day === null ? null : '2026-12-04T09:05');
  });

  it.each(DUE_FORMS)('clears the time of $form, offered only where it shows one', (form) => {
    // The panel offers Clear only where the due reads a time (`DueTimeEditor`).
    const offered = dueOf(form.written)?.time !== undefined && dueOf(form.written)?.time !== null;
    expect(offered).toBe(form.time !== null);
    if (offered) expect(dueWithTime(form.written, null)).toBe('2026-12-04');
  });
});

describe('tick a repeating task (weekly)', () => {
  /** The roll keeps whatever followed the day as written; it is the app's write, not the person's edit. */
  const A_WEEK_ON: Readonly<Record<string, string>> = {
    'a day': '2026-12-11',
    'T15:30': '2026-12-11T15:30',
    'a space': '2026-12-11 15:30',
    seconds: '2026-12-11T15:30:59',
    'a zone': '2026-12-11T15:30Z',
    'T24:00': '2026-12-11T24:00',
    // No due to the index, but a day to the roll, as on main: it rolls to a day.
    'T23:60': '2026-12-11',
    'T15:3': '2026-12-11',
    'a bare T': '2026-12-11',
  };

  it.each(DUE_FORMS)('rolls $form on a week', (form) => {
    const rolled = repeatingTaskUpdate({
      properties: { recurrence: 'weekly', due: form.written },
      statusKey: 'status',
      resetStatus: 'next-action',
    });
    expect(rolled?.['due']).toBe(A_WEEK_ON[form.form]);
  });
});
