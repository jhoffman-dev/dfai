import { describe, expect, it } from 'vitest';
import { linkingAmong } from '../assistant/citation.ts';
import { dayOf, loopTask } from '../assistant/assistant-items.ts';
import { calendarEvents } from '../calendar/calendar-event.ts';
import { assistDuplicate } from '../inbox/assist-duplicate.ts';
import { assistHeld, writtenPropertiesOf } from '../inbox/assist-held.ts';
import { clarifyPlan } from '../inbox/clarify.ts';
import { inboxItem } from '../inbox/inbox.ts';
import { nextOccurrence, parseRecurrence } from '../query/recurrence.ts';
import { repeatingTaskUpdate } from '../query/repeating-task.ts';
import { DUE_FORM_DAY, ODD_DUE_FORMS } from '../testing/due-forms.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import type { TaskCandidate } from './task-similarity.ts';
import { dueEventTime } from './task-due.ts';

/**
 * PR #930 audit: a `due` that is not one plain written value — a list, a
 * mapping, a number, `true`, an empty string — through each place that
 * decides something by a due. Each behaves as main did there, or errs to
 * asking; none writes what main would not have.
 */
const PATH = 'Tasks/Probe.md';
const NEXT_DAY = '2026-12-05';

describe('the assistant’s items: as main read them', () => {
  const context = {
    ...linkingAmong([createVaultPath(PATH)]),
    sources: new Map<string, string>(),
    hasBlock: () => false,
    day: '2026-12-06',
    time: '16:00',
  };

  it.each(ODD_DUE_FORMS)('reads $form by its day as main did, and overdue by day', (form) => {
    const loop = loopTask({
      row: { path: PATH, title: 'Probe', values: { status: 'next-action', due: form.value } },
      words: { key: 'status', done: 'done' },
      context,
    });
    // Main: `dayOf` of the value as one line of text, overdue before the day asked about.
    const main = dayOf(form.value);
    expect(loop.due).toBe(main);
    expect(loop.overdue).toBe(main !== null && main < context.day);
  });
});

describe('a calendar of tasks by due: as main placed them', () => {
  it.each(ODD_DUE_FORMS)('leaves $form unscheduled, so no move is offered', (form) => {
    const placed = calendarEvents({
      rows: [{ path: PATH, title: 'Probe', values: { due: form.value } }],
      dateKey: 'due',
      endKey: null,
      readStart: dueEventTime,
    });
    expect(placed.unscheduled).toBe(1);
  });
});

describe('Clarify a new day: as main wrote it', () => {
  it.each(ODD_DUE_FORMS)('writes the day picked over $form, from a row or the API', (form) => {
    for (const keepsDueTime of [true, false]) {
      const plan = clarifyPlan({
        path: createVaultPath('Inbox/Probe.md'),
        properties: { type: 'task', status: 'inbox', due: form.value },
        clarification: { due: NEXT_DAY, keepsDueTime },
        notePaths: [],
        today: '2026-12-01',
      });
      expect(plan).toMatchObject({ changes: { due: NEXT_DAY } });
    }
  });

  it.each(ODD_DUE_FORMS)('says no time is kept on an Inbox row for $form', (form) => {
    // A row's "keeps 15:30" would be a promise its new day does not keep for several values.
    const written = Array.isArray(form.value) ? form.value.join('\u001f') : String(form.value);
    const item = inboxItem({
      path: createVaultPath('Inbox/Probe.md'),
      title: 'Probe',
      type: 'task',
      due: form.indexedDay,
      dueWritten: written,
    });
    expect(item.task?.dueTime ?? null).toBe(form.indexedTime);
  });
});

describe('tick a repeating task: as main rolled it', () => {
  it.each(ODD_DUE_FORMS)('rolls $form as main did', (form) => {
    const rolled = repeatingTaskUpdate({
      properties: { recurrence: 'weekly', due: form.value },
      statusKey: 'status',
      resetStatus: 'next-action',
    });
    const recurrence = parseRecurrence('weekly');
    if (recurrence === null) throw new Error('no recurrence');
    // Main rolled the value as one line of text, and wrote the next day.
    const from = form.value === null || form.value === undefined ? '' : String(form.value);
    expect(rolled?.['due'] ?? null).toBe(nextOccurrence(from, recurrence));
  });
});

describe('a duplicate of a task: never equal unless both hold one value that agrees', () => {
  const candidate = (extra: Partial<TaskCandidate> = {}): TaskCandidate => ({
    path: createVaultPath('Tasks/Call Mara Quill.md'),
    title: 'Call Mara Quill',
    project: null,
    status: 'next-action',
    due: DUE_FORM_DAY,
    dueTime: '15:30',
    recurrence: null,
    waitingOn: '',
    dueUnread: false,
    defer: null,
    contexts: [],
    people: [],
    ...extra,
  });

  function lineFor(value: unknown, task: TaskCandidate, indexedDay: string | null) {
    const written = Array.isArray(value) ? value.join('\u001f') : String(value);
    const item = inboxItem({
      path: createVaultPath('Inbox/Call Mara Quill.md'),
      title: 'Call Mara Quill',
      type: 'task',
      status: 'inbox',
      due: indexedDay,
      dueWritten: written,
    });
    return assistDuplicate({
      answer: {
        item: item.path,
        kind: 'task',
        projects: [],
        due: null,
        waitingOn: null,
        confidence: 'high',
        why: 'The same call.',
        duplicateOf: task.path,
        people: [],
      },
      held: assistHeld(item),
      filing: null,
      candidates: [{ task, likeness: 'same-title' }],
      inboxTwin: null,
      listedPeople: null,
      hasBody: false,
      written: writtenPropertiesOf({ type: 'task', status: 'inbox', due: value }),
    });
  }

  it.each(ODD_DUE_FORMS)('asks, or names due as held, for an item whose due is $form', (form) => {
    const line = lineFor(form.value, candidate(), form.indexedDay);
    const equal = line !== null && line.kind === 'duplicate' && !line.newerHolds.includes('due');
    // Only one value that is the task's own due, at its time, is the same task's due;
    // an empty one holds nothing to lose. Anything else asks, or is carried over.
    const one = Array.isArray(form.value) && form.value.length === 1;
    const agrees = (one && form.indexedTime === '15:30') || form.value === '';
    expect(equal).toBe(agrees);
  });

  it('asks when the kept task’s due holds several values, the item’s first among them', () => {
    const line = lineFor('2026-12-04T15:30', candidate({ dueMany: true }), DUE_FORM_DAY);
    const equal = line !== null && line.kind === 'duplicate' && !line.newerHolds.includes('due');
    expect(equal).toBe(false);
  });
});
