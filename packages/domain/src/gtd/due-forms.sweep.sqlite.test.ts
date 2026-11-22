import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { linkingAmong } from '../assistant/citation.ts';
import { loopTask } from '../assistant/assistant-items.ts';
import { buildAgenda } from '../calendar/agenda.ts';
import { calendarEvents, occursOn } from '../calendar/calendar-event.ts';
import { indexablePropertiesOf } from '../index/property-value.ts';
import { compileAtlasQuery } from '../query-language/compile.ts';
import { parseAtlasQuery } from '../query-language/parse.ts';
import { DUE_FORM_DAY, DUE_FORMS } from '../testing/due-forms.ts';
import { parseObjectType } from '../types/property-def.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import { dueEventTime } from './task-due.ts';

/**
 * #928, PR #930 review: every written form of a due, through each surface the
 * domain draws it on, asked the same three things — which day it is on,
 * whether a time shows, and that no surface drops it where another shows it.
 * The application's and the panel's surfaces are swept beside their reads.
 */
const PATH = 'Tasks/Probe.md';
const ROW = (written: string) => ({
  path: PATH,
  title: 'Probe',
  values: { type: 'task', status: 'next-action', due: written },
});

describe('the assistant’s items', () => {
  const context = {
    ...linkingAmong([createVaultPath(PATH)]),
    sources: new Map<string, string>(),
    hasBlock: () => false,
    day: DUE_FORM_DAY,
    time: '16:00',
  };

  it.each(DUE_FORMS)('read $form as its day, overdue at 16:00 only for a time', (form) => {
    const loop = loopTask({
      row: ROW(form.written),
      words: { key: 'status', done: 'done' },
      context,
    });
    expect(loop.due).toBe(form.day);
    expect(loop.overdue).toBe(form.time !== null);
  });
});

describe('a calendar of tasks by due: the agenda and the grid', () => {
  it.each(DUE_FORMS)('place $form on its day, timed only for a time', (form) => {
    const { events, unscheduled } = calendarEvents({
      rows: [ROW(form.written)],
      dateKey: 'due',
      endKey: null,
      readStart: dueEventTime,
    });
    expect(unscheduled).toBe(form.day === null ? 1 : 0);
    const [event] = events;
    expect(event?.start.date ?? null).toBe(form.day);
    expect(event === undefined ? null : event.start.minutes !== null).toBe(
      form.day === null ? null : form.time !== null,
    );
    // The grid: on its day and no other.
    expect(event !== undefined && occursOn(event, DUE_FORM_DAY)).toBe(form.day !== null);
    // The agenda, at midday: under today, none of them yet overdue.
    const agenda = buildAgenda({
      events,
      from: DUE_FORM_DAY,
      days: 1,
      today: DUE_FORM_DAY,
      isDone: () => false,
      dues: { time: '12:00' },
    });
    const listed = agenda.days[0]?.events.map((each) => each.path) ?? [];
    expect(listed).toEqual(form.day === null ? [] : [PATH]);
    expect(agenda.overdue).toEqual([]);
  });
});

describe('task tables: filtered and sorted by due', () => {
  const TYPES = [parseObjectType({ name: 'task', properties: { due: 'date', status: 'text' } })];
  const INDEX_TODAY = "date('now', 'localtime'";

  function titles(written: string, text: string): unknown[] {
    const database = new DatabaseSync(':memory:');
    database.exec(`
      CREATE TABLE files (path TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
                          modified INTEGER, size INTEGER NOT NULL, progress INTEGER);
      CREATE TABLE props (path TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0,
                          value_text TEXT, value_num REAL, value_date TEXT, value_json TEXT);
      CREATE TABLE relations (src TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL,
                              target TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', dst TEXT);
      CREATE TABLE links (src TEXT NOT NULL, dst TEXT, target TEXT NOT NULL, kind TEXT NOT NULL);`);
    const notes = {
      'Tasks/Probe.md': written,
      'Tasks/Earlier.md': '2026-12-03',
      'Tasks/Later.md': '2026-12-05',
    };
    for (const [path, due] of Object.entries(notes)) {
      const title = path.slice(6, -3);
      database.prepare('INSERT INTO files VALUES (?, ?, ?, 0, 1, NULL)').run(path, title, '');
      for (const row of indexablePropertiesOf({ type: 'task', status: 'next-action', due })) {
        database
          .prepare('INSERT INTO props VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(path, row.key, row.index, row.text, row.number, row.date, row.json);
      }
    }
    const { sql, parameters } = compileAtlasQuery(parseAtlasQuery(text), {
      types: TYPES,
      resolveLink: () => null,
    });
    return database
      .prepare(sql.replaceAll(INDEX_TODAY, `date('${DUE_FORM_DAY}'`))
      .all(...parameters)
      .map((row) => row['title']);
  }

  it.each(DUE_FORMS)('find $form on its day, and sort it within its day', (form) => {
    expect(titles(form.written, 'FROM task WHERE due = @today')).toEqual(
      form.day === null ? [] : ['Probe'],
    );
    // Sorted by due, on its day between the day before and the day after; with no due, last.
    expect(titles(form.written, 'FROM task SORT BY due')).toEqual(
      form.day === null ? ['Earlier', 'Later', 'Probe'] : ['Earlier', 'Probe', 'Later'],
    );
  });
});
