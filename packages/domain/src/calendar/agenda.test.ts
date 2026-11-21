import { describe, expect, it } from 'vitest';
import { buildAgenda, isOverdue, relativeDay } from './agenda.ts';
import { calendarEvents, type CalendarEvent } from './calendar-event.ts';
import { useZone, ZONES } from './zones.test-support.ts';

const TODAY = '2026-09-24';

function events(
  rows: { title: string; due: string; end?: string; status?: string }[],
): CalendarEvent[] {
  return calendarEvents({
    rows: rows.map(({ title, ...values }) => ({ path: `${title}.md`, title, values })),
    dateKey: 'due',
    endKey: 'end',
  }).events;
}

const isDone = (values: Readonly<Record<string, unknown>>) => values['status'] === 'done';

const titles = (list: readonly CalendarEvent[]) => list.map((event) => event.title);

describe.each(ZONES)('buildAgenda in %s', (zone) => {
  useZone(zone);

  const all = events([
    { title: 'old open', due: '2026-09-20' },
    { title: 'old done', due: '2026-09-21', status: 'done' },
    { title: 'older open', due: '2026-09-02T09:00' },
    { title: 'today later', due: '2026-09-24T15:00' },
    { title: 'today all day', due: '2026-09-24' },
    { title: 'today early', due: '2026-09-24T08:00' },
    { title: 'next week', due: '2026-10-01' },
    { title: 'far off', due: '2026-12-01' },
  ]);

  it('puts what is past and not done in Overdue, oldest first', () => {
    const agenda = buildAgenda({ events: all, from: TODAY, days: 30, today: TODAY, isDone });
    expect(titles(agenda.overdue)).toEqual(['older open', 'old open']);
  });

  it('lists the days from the anchor with notes, in the order of the day', () => {
    const agenda = buildAgenda({ events: all, from: TODAY, days: 30, today: TODAY, isDone });
    expect(agenda.days.map((day) => day.date)).toEqual(['2026-09-24', '2026-10-01']);
    expect(titles(agenda.days[0]?.events ?? [])).toEqual([
      'today all day',
      'today early',
      'today later',
    ]);
  });

  it('lists more days when more are loaded', () => {
    const agenda = buildAgenda({ events: all, from: TODAY, days: 90, today: TODAY, isDone });
    expect(agenda.days.at(-1)?.date).toBe('2026-12-01');
  });

  it('lists today even when nothing is on it, so the list says so', () => {
    const agenda = buildAgenda({ events: [], from: TODAY, days: 30, today: TODAY, isDone });
    expect(agenda.days).toEqual([{ date: TODAY, events: [] }]);
  });

  it('never lists an overdue note twice, when the agenda starts in the past', () => {
    const agenda = buildAgenda({ events: all, from: '2026-09-19', days: 10, today: TODAY, isDone });
    const listed = agenda.days.flatMap((day) => titles(day.events));
    expect(listed).toContain('old done');
    expect(listed).not.toContain('old open');
    expect(titles(agenda.overdue)).toContain('old open');
  });

  it('lists a stretch on each of its days, and it is not overdue while it runs', () => {
    const trip = events([{ title: 'trip', due: '2026-09-23', end: '2026-09-25' }]);
    const agenda = buildAgenda({ events: trip, from: TODAY, days: 3, today: TODAY, isDone });
    expect(agenda.overdue).toEqual([]);
    expect(agenda.days.map((day) => day.date)).toEqual(['2026-09-24', '2026-09-25']);
  });

  it('lists nothing from an anchor it cannot read', () => {
    expect(buildAgenda({ events: all, from: 'soon', days: 30, today: TODAY, isDone }).days).toEqual(
      [],
    );
  });
});

describe('isOverdue', () => {
  it('is not overdue on the day it is due, or once it is done', () => {
    const [due, done] = events([
      { title: 'due', due: TODAY },
      { title: 'done', due: '2026-09-01', status: 'done' },
    ]);
    expect(due && isOverdue({ event: due, today: TODAY, isDone })).toBe(false);
    expect(done && isOverdue({ event: done, today: TODAY, isDone })).toBe(false);
  });

  it('is overdue today when a timed note ran until midnight last night', () => {
    const [night] = events([{ title: 'night', due: '2026-09-23T22:00', end: '2026-09-24T00:00' }]);
    expect(night && isOverdue({ event: night, today: TODAY, isDone })).toBe(true);
  });
});

describe('relativeDay', () => {
  it('names the days either side of today', () => {
    expect(relativeDay('2026-09-24', TODAY)).toBe('Today');
    expect(relativeDay('2026-09-25', TODAY)).toBe('Tomorrow');
    expect(relativeDay('2026-09-23', TODAY)).toBe('Yesterday');
    expect(relativeDay('2026-09-26', TODAY)).toBeNull();
  });
});

describe('an agenda at the last day a date can hold', () => {
  it('lists a day once and stops at 9999-12-31', () => {
    const agenda = buildAgenda({
      events: events([
        { title: 'penultimate', due: '9999-12-30' },
        { title: 'last', due: '9999-12-31' },
      ]),
      from: '9999-12-30',
      days: 30,
      today: '9999-12-30',
      isDone,
    });
    expect(agenda.days.map((day) => day.date)).toEqual(['9999-12-30', '9999-12-31']);
  });
});

describe('a calendar of tasks by their due: Overdue as Today says it (#928)', () => {
  const tasks = events([
    { title: 'nine', due: '2026-09-24T09:00' },
    { title: 'three', due: '2026-09-24T15:00' },
    { title: 'all day', due: '2026-09-24' },
    { title: 'yesterday', due: '2026-09-23' },
    { title: 'nine done', due: '2026-09-24T09:00', status: 'done' },
  ]);
  const agendaAt = (time: string | null) =>
    buildAgenda({ events: tasks, from: TODAY, days: 1, today: TODAY, isDone, dues: { time } });

  it('puts a timed due today in Overdue the minute after its time, and only then', () => {
    expect(titles(agendaAt('09:00').overdue)).toEqual(['yesterday']);
    expect(titles(agendaAt('09:01').overdue)).toEqual(['yesterday', 'nine']);
    expect(titles(agendaAt('09:01').days[0]?.events ?? [])).toEqual([
      'all day',
      'nine done',
      'three',
    ]);
  });

  it('leaves a date-only due today under today all day, and a done one out of Overdue', () => {
    expect(titles(agendaAt('23:59').overdue)).toEqual(['yesterday', 'nine', 'three']);
  });

  it('reads dues by their day where the time is not known, as any calendar does', () => {
    expect(titles(agendaAt(null).overdue)).toEqual(['yesterday']);
    const plain = buildAgenda({ events: tasks, from: TODAY, days: 1, today: TODAY, isDone });
    expect(titles(plain.overdue)).toEqual(['yesterday']);
  });

  it('keeps the calendar’s own rule for a note with an end', () => {
    const [block] = events([{ title: 'block', due: '2026-09-24T09:00', end: '2026-09-24T10:00' }]);
    if (block === undefined) throw new Error('no event');
    expect(isOverdue({ event: block, today: TODAY, isDone, dues: { time: '11:00' } })).toBe(false);
  });
});
