import { describe, expect, it } from 'vitest';
import {
  calendarEvents,
  clarifyPlan,
  createVaultPath,
  dueEventTime,
  dueOf,
  isPastDue,
  judgedDue,
  linkingAmong,
  loopTask,
  movedDue,
  weeklyReview,
} from '@dfai/domain';
import { DUE_FORM_DAY, EVERY_DUE_VALUE } from '@dfai/domain/testing';
import { listInbox } from '../inbox/list-inbox.ts';
import { readReviewSources } from '../review/review-reads.ts';
import { fakeIndexPort, fakeVaultFs } from '../testing/fake-ports.ts';
import { jsonMarkdown, jsonNote } from '../testing/json-markdown.ts';
import { atlasQueryIndex } from '../testing/query-index.ts';
import { readToday } from './read-today.ts';

/**
 * PR #930: one cross-check over every due value — the written forms, the odd
 * ones, the lists of one. The answer is worked out once, by the due module
 * (`judgedDue`, `dueOf`), and every surface's own read must give it: Today
 * and the review through the real index, the Inbox's read, the assistant's
 * item, the calendar's event. Then every promise must equal its write: a
 * row's "keeps HH:MM" its Clarify, a placed event its move. Two surfaces that
 * part fail here, whatever each one's own sweep expects.
 */
const NEXT_DAY = '2026-12-05';
const AT = { today: DUE_FORM_DAY, time: '16:00' };
const clock = {
  today: () => DUE_FORM_DAY,
  now: () => Date.UTC(2026, 11, 4, 16),
  localNow: () => `${DUE_FORM_DAY}T16:00:00`,
};

function portsFor(path: string, value: unknown) {
  const markdown = jsonMarkdown();
  const files = { [path]: jsonNote({ type: 'task', status: 'next-action', due: value }) };
  return {
    index: fakeIndexPort({ query: atlasQueryIndex({ markdown, files }) }),
    fs: fakeVaultFs(),
    markdown,
  };
}

/** What every surface must answer for a value, worked out once. */
function expected(value: unknown) {
  const due = judgedDue(value);
  return {
    day: due?.day ?? null,
    time: due?.time ?? null,
    overdue: due !== null && isPastDue(due, AT),
    placed: dueOf(value) !== null,
  };
}

describe.each(EVERY_DUE_VALUE)('a due written $form', ({ value }) => {
  const want = expected(value);

  it('reads alike on Today, the review, the Inbox, the assistant and a task calendar', async () => {
    const today = await readToday({ ...portsFor('Tasks/Probe.md', value), clock });
    const placed = today.sections.flatMap((section) =>
      section.groups.flatMap((group) => group.tasks.map((task) => ({ id: section.id, task }))),
    );
    const onToday = placed.find((each) => each.task.title === 'Probe');
    expect([onToday?.task.due, onToday?.task.dueTime ?? null]).toEqual([want.day, want.time]);
    expect(onToday?.id === 'overdue').toBe(want.overdue);

    const { tasks } = await readReviewSources(portsFor('Tasks/Probe.md', value));
    expect([tasks[0]?.due, tasks[0]?.dueTime ?? null]).toEqual([want.day, want.time]);
    const review = weeklyReview({ tasks, projects: [], at: { ...AT, now: clock.now() } });
    expect(review.overdue.length === 1).toBe(want.overdue);

    const inbox = await listInbox({ index: portsFor('Inbox/Probe.md', value).index });
    const row = inbox.items.find((item) => item.title === 'Probe')?.task;
    expect([row?.due, row?.dueTime ?? null]).toEqual([want.day, want.time]);

    const loop = loopTask({
      row: {
        path: 'Tasks/Probe.md',
        title: 'Probe',
        values: { status: 'next-action', due: value },
      },
      words: { key: 'status', done: 'done' },
      context: {
        ...linkingAmong([createVaultPath('Tasks/Probe.md')]),
        sources: new Map(),
        hasBlock: () => false,
        day: AT.today,
        time: AT.time,
      },
    });
    expect([loop.due, loop.overdue]).toEqual([want.day, want.overdue]);

    const { events } = calendarEvents({
      rows: [{ path: 'Tasks/Probe.md', title: 'Probe', values: { due: value } }],
      dateKey: 'due',
      endKey: null,
      readStart: dueEventTime,
    });
    expect(events.length === 1).toBe(want.placed);
    if (want.placed) {
      expect(events[0]?.start.date).toBe(want.day);
      expect(events[0]?.start.minutes !== null).toBe(want.time !== null);
    }
  });

  it('keeps every promise in what it writes', async () => {
    // An Inbox row that says "keeps HH:MM" sends its new day to keep it: Clarify writes that time.
    const inbox = await listInbox({ index: portsFor('Inbox/Probe.md', value).index });
    const dueTime = inbox.items.find((item) => item.title === 'Probe')?.task?.dueTime;
    const plan = clarifyPlan({
      path: createVaultPath('Inbox/Probe.md'),
      properties: { type: 'task', status: 'inbox', due: value },
      clarification: { due: NEXT_DAY, ...(dueTime !== undefined && { keepsDueTime: true }) },
      notePaths: [],
      today: '2026-12-01',
    });
    const written = 'changes' in plan ? plan.changes['due'] : undefined;
    expect(dueOf(written)).toMatchObject({ day: NEXT_DAY, time: dueTime ?? null });

    // A note a task calendar places moves as it is shown: its day on, its time kept.
    const moved = movedDue({ start: value, end: null, days: 1, minutes: 0 });
    expect(moved === null).toBe(!want.placed);
    if (moved !== null)
      expect(dueOf(moved.start)).toMatchObject({ day: NEXT_DAY, time: want.time });
  });
});
