import { describe, expect, it } from 'vitest';
import { DUE_FORM_DAY, ODD_DUE_FORMS } from '@dfai/domain/testing';
import { listInbox } from '../inbox/list-inbox.ts';
import { readReviewSources } from '../review/review-reads.ts';
import { fakeIndexPort, fakeVaultFs } from '../testing/fake-ports.ts';
import { jsonMarkdown, jsonNote } from '../testing/json-markdown.ts';
import { atlasQueryIndex } from '../testing/query-index.ts';
import { readToday } from './read-today.ts';

/**
 * PR #930 audit: a `due` that is not one plain value, read from an index by
 * Today, the weekly review and the Inbox. Each reads the first dated entry's
 * day, as main did; Today and the review show its time; the Inbox, whose new
 * day writes a day over several values, shows no time it would not keep.
 */
const clock = {
  today: () => DUE_FORM_DAY,
  now: () => Date.UTC(2026, 11, 4, 12),
  localNow: () => `${DUE_FORM_DAY}T12:00:00`,
};

const portsFor = (path: string, value: unknown) => {
  const markdown = jsonMarkdown();
  const files = { [path]: jsonNote({ type: 'task', status: 'next-action', due: value }) };
  return {
    index: fakeIndexPort({ query: atlasQueryIndex({ markdown, files }) }),
    fs: fakeVaultFs(),
    markdown,
  };
};

describe('Today and the weekly review', () => {
  it.each(ODD_DUE_FORMS)('read $form by its first dated entry, as main did', async (form) => {
    const report = await readToday({ ...portsFor('Tasks/Probe.md', form.value), clock });
    const probe = report.sections
      .flatMap((section) => section.groups.flatMap((group) => group.tasks))
      .find((task) => task.title === 'Probe');
    expect(probe?.due).toBe(form.indexedDay);
    expect(probe?.dueTime ?? null).toBe(form.indexedTime);
    const { tasks } = await readReviewSources(portsFor('Tasks/Probe.md', form.value));
    expect(tasks[0]?.due).toBe(form.indexedDay);
    expect(tasks[0]?.dueTime ?? null).toBe(form.indexedTime);
  });
});

describe('the Inbox', () => {
  it.each(ODD_DUE_FORMS)('reads $form’s day, and a time only for one value', async (form) => {
    const { index } = portsFor('Inbox/Probe.md', form.value);
    const task = (await listInbox({ index })).items.find((item) => item.title === 'Probe')?.task;
    expect(task?.due).toBe(form.indexedDay);
    const one = Array.isArray(form.value) && form.value.length === 1;
    expect(task?.dueTime ?? null).toBe(one ? form.indexedTime : null);
  });
});
