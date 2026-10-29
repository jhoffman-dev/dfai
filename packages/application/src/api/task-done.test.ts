/**
 * #107 (API keeper): POST /v1/tasks/done ticks a task done, or unticks it,
 * as a row's done box does on Today and in a query view — the same change,
 * on the app's clock, through the byte-preserving write a property change takes.
 */
import { describe, expect, it } from 'vitest';
import { apiFixture, bodyOf, codeOf, TODAY } from '../testing/api-fixture.ts';

const note = (lines: readonly string[], body = '\nCall about the proofs.\n') =>
  ['---', ...lines, '---', body].join('\n');

const PRINTER = note(['type: task', 'status: next-action', `focus: ${TODAY}`]);
const BEDS = note([
  'type: task',
  'status: next-action',
  'due: 2026-09-21',
  'recurrence: every week',
]);
const DONE = note(['type: task', 'status: archive', 'completed: 2026-09-01']);

const FILES = {
  'Tasks/Call the printer.md': PRINTER,
  'Tasks/Water the beds.md': BEDS,
  'Tasks/Order chairs.md': DONE,
  'Tasks/Draft.md': note(['type: task', 'status: in-progress']),
  'Notes/Lease.md': note(['type: note']),
};

type Api = ReturnType<typeof apiFixture>;
const tick = (api: Api, body: unknown) =>
  api.send({ method: 'POST', path: '/v1/tasks/done', body });
const text = (api: Api, path: string) => api.files.get(path)?.text;
const modifiedOf = (api: Api, path: string) => api.files.get(path)?.modified ?? -1;

describe('POST /v1/tasks/done', () => {
  it('finishes a task dated today, ends its choice for today, and answers the task', async () => {
    const api = apiFixture({ files: FILES });
    const path = 'Tasks/Call the printer.md';

    const response = await tick(api, { path, done: true, ifModified: modifiedOf(api, path) });

    expect(response.status).toBe(200);
    expect(bodyOf(response)['note']).toMatchObject({ path });
    expect(text(api, path)).toBe(note(['type: task', 'status: archive', `completed: ${TODAY}`]));
  });

  it('rolls a repeating task on, and refuses the same tick sent again', async () => {
    const api = apiFixture({ files: FILES });
    const path = 'Tasks/Water the beds.md';
    const read = modifiedOf(api, path);

    await tick(api, { path, done: true, ifModified: read });
    const rolled = note([
      'type: task',
      'status: next-action',
      'due: 2026-09-28',
      'recurrence: every week',
      'lastCompleted: 2026-09-21',
    ]);
    expect(text(api, path)).toBe(rolled);

    expect(codeOf(await tick(api, { path, done: true, ifModified: read }))).toBe('conflict');
    expect(text(api, path)).toBe(rolled);
  });

  it('needs ifModified to tick, writing nothing without it', async () => {
    const api = apiFixture({ files: FILES });
    const response = await tick(api, { path: 'Tasks/Water the beds.md', done: true });
    expect(codeOf(response)).toBe('invalid');
    expect(text(api, 'Tasks/Water the beds.md')).toBe(BEDS);
  });

  it('unticks a finished task to Next Action, its day taken out, and leaves open work alone', async () => {
    const api = apiFixture({ files: FILES });

    await tick(api, { path: 'Tasks/Order chairs.md', done: false });
    expect(text(api, 'Tasks/Order chairs.md')).toBe(note(['type: task', 'status: next-action']));

    await tick(api, { path: 'Tasks/Draft.md', done: false });
    expect(text(api, 'Tasks/Draft.md')).toBe(FILES['Tasks/Draft.md']);
  });

  it('refuses a note that is not a task, and a body without a true or false done', async () => {
    const api = apiFixture({ files: FILES });
    expect(codeOf(await tick(api, { path: 'Notes/Lease.md', done: false }))).toBe('invalid');
    for (const body of [{ path: 'Tasks/Draft.md' }, { path: 'Tasks/Draft.md', done: 'yes' }]) {
      expect(codeOf(await tick(api, body))).toBe('invalid');
    }
    expect(text(api, 'Notes/Lease.md')).toBe(FILES['Notes/Lease.md']);
    expect(text(api, 'Tasks/Draft.md')).toBe(FILES['Tasks/Draft.md']);
  });
});
