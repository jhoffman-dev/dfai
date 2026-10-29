/**
 * Attack on PR #625 (#107): POST /v1/tasks/done against hostile bodies,
 * paths outside user space, stale stamps, a file that moves between read
 * and write, and a recurrence written the ways the row reads as repeating.
 */
import { describe, expect, it } from 'vitest';
import { apiFixture, codeOf } from '../testing/api-fixture.ts';
import { jsonMarkdown, jsonNote } from '../testing/json-markdown.ts';
import { atlasQueryIndex } from '../testing/query-index.ts';

const note = (lines: readonly string[], body = '\nFeed the hens.\n') =>
  ['---', ...lines, '---', body].join('\n');

const OPEN = note(['type: task', 'status: next-action']);
const DONE = note(['type: task', 'status: archive', 'completed: 2026-09-01']);

type Api = ReturnType<typeof apiFixture>;
const tick = (api: Api, body: unknown) =>
  api.send({ method: 'POST', path: '/v1/tasks/done', body });
const modifiedOf = (api: Api, path: string) => api.files.get(path)?.modified ?? -1;

describe('POST /v1/tasks/done, hostile requests (PR #625)', () => {
  it('refuses a path outside user space — out of the vault, into .atlas, a template — writing nothing', async () => {
    const files = {
      'Tasks/Hens.md': OPEN,
      '.atlas/templates/Task.md': OPEN,
      '.atlas/Hidden.md': OPEN,
    };
    const api = apiFixture({ files });
    for (const path of [
      '../Tasks/Hens.md',
      'Tasks/../../Hens.md',
      '/etc/hosts',
      '.atlas/templates/Task.md',
      '.atlas/Hidden.md',
      '',
    ]) {
      const response = await tick(api, { path, done: true, ifModified: 1 });
      expect(response.status, path).toBeGreaterThanOrEqual(400);
    }
    expect(api.writes).toEqual([]);
  });

  it('refuses a done that is not a boolean, writing nothing', async () => {
    const api = apiFixture({ files: { 'Tasks/Hens.md': OPEN } });
    for (const done of [1, 0, null, 'true', 'false', [], {}]) {
      const response = await tick(api, {
        path: 'Tasks/Hens.md',
        done,
        ifModified: modifiedOf(api, 'Tasks/Hens.md'),
      });
      expect(codeOf(response), JSON.stringify(done)).toBe('invalid');
    }
    expect(api.writes).toEqual([]);
  });

  it('refuses an ifModified that is not a stamp, writing nothing', async () => {
    const api = apiFixture({ files: { 'Tasks/Hens.md': OPEN } });
    for (const ifModified of [-1, 1.5, '1', null]) {
      const response = await tick(api, { path: 'Tasks/Hens.md', done: true, ifModified });
      expect(codeOf(response), JSON.stringify(ifModified)).toBe('invalid');
    }
    expect(api.writes).toEqual([]);
  });

  it('is a conflict for an untick with a stale ifModified', async () => {
    const api = apiFixture({ files: { 'Tasks/Done.md': DONE } });
    const stale = modifiedOf(api, 'Tasks/Done.md') - 1;
    const response = await tick(api, { path: 'Tasks/Done.md', done: false, ifModified: stale });
    expect(codeOf(response)).toBe('conflict');
    expect(api.files.get('Tasks/Done.md')?.text).toBe(DONE);
  });

  it('refuses the same tick of a plain task sent again with the same stamp', async () => {
    const api = apiFixture({ files: { 'Tasks/Hens.md': OPEN } });
    const read = modifiedOf(api, 'Tasks/Hens.md');
    expect((await tick(api, { path: 'Tasks/Hens.md', done: true, ifModified: read })).status).toBe(
      200,
    );
    const once = api.files.get('Tasks/Hens.md')?.text;
    expect(codeOf(await tick(api, { path: 'Tasks/Hens.md', done: true, ifModified: read }))).toBe(
      'conflict',
    );
    expect(api.files.get('Tasks/Hens.md')?.text).toBe(once);
  });

  it('is a conflict, keeping the other edit, when the task changes between its read and the write', async () => {
    const EDITED = `${OPEN}edited on the other Mac\n`;
    const api = apiFixture({ files: { 'Tasks/Hens.md': OPEN } });
    const read = modifiedOf(api, 'Tasks/Hens.md');
    const reading = api.deps.fs.readTextFile;
    let reads = 0;
    api.deps = {
      ...api.deps,
      fs: {
        ...api.deps.fs,
        readTextFile: async (path) => {
          const answer = await reading(path);
          reads += 1;
          if (reads === 1) api.files.set('Tasks/Hens.md', { text: EDITED, modified: 999 });
          return answer;
        },
      },
    };
    const response = await tick(api, { path: 'Tasks/Hens.md', done: true, ifModified: read });
    expect(codeOf(response)).toBe('conflict');
    expect(api.files.get('Tasks/Hens.md')?.text).toBe(EDITED);
  });
});

describe('POST /v1/atlas-query, a query of tasks alone (PR #625)', () => {
  it('answers no hidden task:* column', async () => {
    const files = {
      '.atlas/types/task.md': jsonNote({
        name: 'task',
        label: 'Task',
        properties: { status: { kind: 'select', options: ['next-action', 'waiting'] } },
      }),
      'Tasks/Hens.md': jsonNote({ type: 'task', status: 'next-action', due: '2026-10-28' }),
    };
    const markdown = jsonMarkdown();
    const api = apiFixture({
      files,
      markdown,
      index: { query: atlasQueryIndex({ files, markdown }) },
    });
    const response = await api.send({
      method: 'POST',
      path: '/v1/atlas-query',
      body: { query: 'FROM task SHOW status' },
    });
    expect(response.status).toBe(200);
    const answer = response.body as unknown as {
      columns: string[];
      sql: string;
      rows: unknown[][];
    };
    expect(answer.rows).toHaveLength(1);
    expect(answer.columns.some((column) => column.startsWith('task:'))).toBe(false);
    expect(answer.sql).not.toContain('task:');
  });
});
