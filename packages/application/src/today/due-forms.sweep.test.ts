import { describe, expect, it } from 'vitest';
import { DUE_FORM_DAY, DUE_FORMS } from '@dfai/domain/testing';
import { listInbox } from '../inbox/list-inbox.ts';
import { readReviewSources } from '../review/review-reads.ts';
import { fakeIndexPort, fakeMarkdown, fakeVaultFs } from '../testing/fake-ports.ts';
import { atlasQueryIndex } from '../testing/query-index.ts';
import { readToday } from './read-today.ts';

/**
 * #928, PR #930 review: every written form of a due, read from an index as
 * Today, the weekly review and the Inbox read it — the day it is on, and the
 * time shown — so no surface drops a due another shows, and a value that is
 * no due is none on each.
 */
const clock = {
  today: () => DUE_FORM_DAY,
  now: () => Date.UTC(2026, 11, 4, 12),
  localNow: () => `${DUE_FORM_DAY}T12:00:00`,
};

const portsFor = (path: string, written: string) => {
  const files = { [path]: `---\ntype: task\nstatus: next-action\ndue: ${written}\n---\n` };
  return {
    index: fakeIndexPort({ query: atlasQueryIndex({ markdown: fakeMarkdown(), files }) }),
    fs: fakeVaultFs(),
    markdown: fakeMarkdown(),
  };
};

describe('Today', () => {
  it.each(DUE_FORMS)(
    'reads $form as its day, with its time shown only when it has one',
    async (form) => {
      const report = await readToday({ ...portsFor('Tasks/Probe.md', form.written), clock });
      const placed = report.sections.flatMap((section) =>
        section.groups.flatMap((group) => group.tasks.map((task) => ({ id: section.id, task }))),
      );
      const probe = placed.find((each) => each.task.title === 'Probe');
      expect(probe?.task.due).toBe(form.day);
      expect(probe?.task.dueTime ?? null).toBe(form.time);
      // At midday, every due on the day is still due today; one with none is a next action.
      expect(probe?.id).toBe(form.day === null ? 'nextActions' : 'dueToday');
    },
  );
});

describe('the weekly review', () => {
  it.each(DUE_FORMS)('reads $form as its day, with its time only when it has one', async (form) => {
    const { tasks } = await readReviewSources(portsFor('Tasks/Probe.md', form.written));
    expect(tasks[0]?.due).toBe(form.day);
    expect(tasks[0]?.dueTime ?? null).toBe(form.time);
  });
});

describe('the Inbox', () => {
  it.each(DUE_FORMS)('reads $form as its day, with its time only when it has one', async (form) => {
    const { index } = portsFor('Inbox/Probe.md', form.written);
    const listing = await listInbox({ index });
    const task = listing.items.find((item) => item.title === 'Probe')?.task;
    expect(task?.due).toBe(form.day);
    expect(task?.dueTime ?? null).toBe(form.time);
  });
});
