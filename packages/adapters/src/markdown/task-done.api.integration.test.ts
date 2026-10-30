/**
 * Attack on PR #625 (#107), moved here from the route's own attack file to be
 * written through the real markdown: POST /v1/tasks/done on a recurrence written
 * as a list, which the fake markdown cannot read. The tick rolls the task on
 * by the one-value rule the row's hidden column reads it by (`singleTextOf`).
 */
import { describe, expect, it } from 'vitest';
import { apiFixture } from '@dfai/application';
import { remarkMarkdown } from './markdown-port.ts';

const note = (lines: readonly string[], body = '\nFeed the hens.\n') =>
  ['---', ...lines, '---', body].join('\n');

type Api = ReturnType<typeof apiFixture>;
const tick = (api: Api, body: unknown) =>
  api.send({ method: 'POST', path: '/v1/tasks/done', body });
const modifiedOf = (api: Api, path: string) => api.files.get(path)?.modified ?? -1;

describe('POST /v1/tasks/done, a recurrence the row reads as repeating (PR #625)', () => {
  // The hidden `task:recurrence` column (singleTextSql) reads each of these as
  // "every week", and the row draws the tick as a roll; the file must roll too.
  it.each([
    ['a one-item list', ['recurrence:', '  - every week']],
    ['a list with a blank item', ['recurrence: ["", every week]']],
  ])('rolls a task whose recurrence is %s, rather than ending the series', async (_name, lines) => {
    const path = 'Tasks/Hens.md';
    const text = note(['type: task', 'status: next-action', 'due: 2026-09-21', ...lines]);
    const api = apiFixture({ files: { [path]: text }, markdown: remarkMarkdown });
    const response = await tick(api, { path, done: true, ifModified: modifiedOf(api, path) });
    expect(response.status).toBe(200);
    const after = api.files.get(path)?.text ?? '';
    expect(after).toMatch(/^due: 2026-09-28$/m);
    expect(after).toMatch(/^status: next-action$/m);
  });

  it('ends the series of a recurrence written as two rules, which is no one rule', async () => {
    const path = 'Tasks/Hens.md';
    const text = note([
      'type: task',
      'status: next-action',
      'due: 2026-09-21',
      'recurrence: [every week, every day]',
    ]);
    const api = apiFixture({ files: { [path]: text }, markdown: remarkMarkdown });
    await tick(api, { path, done: true, ifModified: modifiedOf(api, path) });
    const after = api.files.get(path)?.text ?? '';
    expect(after).toMatch(/^status: archive$/m);
    expect(after).toMatch(/^due: 2026-09-21$/m);
  });
});
