/**
 * The Inbox's Process through the API (P30-01, ADR-0016's amendment for it):
 * filing notes under a project or an area, held to the Archive's limits — user
 * space only, never over anything, never saving someone's typing. Filing is a
 * link (#214): the note gets `project: [[…]]` and goes to its type's home
 * folder for its day, never into the project's folder.
 */

import { describe, expect, it } from 'vitest';
import type { VaultPath } from '@dfai/domain';
import { apiFixture, bodyOf, codeOf } from '../testing/api-fixture.ts';
import { fakeMarkdown } from '../testing/fake-ports.ts';
import { jsonMarkdown, jsonNote } from '../testing/json-markdown.ts';
import { atlasQueryIndex } from '../testing/query-index.ts';

const PROJECT = '---\ntype: project\n---\n\nThe app.\n';
const AREA = '---\ntype: area\n---\n\nBeds and seeds.\n';
const PERSON = '---\ntype: person\n---\n\nA neighbour.\n';

const processInbox = (body: unknown) => ({
  method: 'POST' as const,
  path: '/v1/inbox/process',
  body,
});

describe('POST /v1/inbox/process', () => {
  it('links each note to its project and files it in its type’s home folder, the rest of it untouched', async () => {
    const api = apiFixture({
      files: {
        'Projects/DFAI.md': PROJECT,
        'Inbox/Call Sam.md': '---\ntype: task\n---\n\nAbout the  *lease*.\n',
        'Inbox/Meetings/Standup.md': 'Notes.\n',
      },
    });

    const response = await api.send(
      processInbox({
        paths: ['Inbox/Call Sam.md', 'Inbox/Meetings/Standup.md'],
        project: 'Projects/DFAI.md',
      }),
    );

    expect(response.status).toBe(200);
    expect(bodyOf(response)).toEqual({
      moves: [
        { from: 'Inbox/Call Sam.md', to: 'Tasks/2026/09/Call Sam.md' },
        { from: 'Inbox/Meetings/Standup.md', to: 'Notes/2026/Standup.md' },
      ],
      linked: [],
      failed: [],
      linksUpdated: 0,
    });
    const filed = api.files.get('Tasks/2026/09/Call Sam.md')?.text ?? '';
    expect(filed).toContain('project: [[DFAI]]');
    expect(filed.endsWith('\nAbout the  *lease*.\n')).toBe(true);
    expect(api.files.has('Inbox/Call Sam.md')).toBe(false);
    expect(api.files.get('Notes/2026/Standup.md')?.text).toContain('project: [[DFAI]]');
  });

  it('files under an area as readily as a project', async () => {
    const api = apiFixture({ files: { 'Areas/Garden.md': AREA, 'Inbox/Seeds.md': 's\n' } });
    const response = await api.send(
      processInbox({ paths: ['Inbox/Seeds.md'], project: 'Areas/Garden.md' }),
    );
    expect(bodyOf(response)['moves']).toEqual([
      { from: 'Inbox/Seeds.md', to: 'Notes/2026/Seeds.md' },
    ]);
    expect(api.files.get('Notes/2026/Seeds.md')?.text).toContain('project: [[Garden]]');
  });

  it('refuses to file under a note that is not a project or an area, and moves nothing', async () => {
    const api = apiFixture({ files: { 'People/Mara Quill.md': PERSON, 'Inbox/Call.md': 'c\n' } });
    const response = await api.send(
      processInbox({ paths: ['Inbox/Call.md'], project: 'People/Mara Quill.md' }),
    );
    expect(codeOf(response)).toBe('invalid');
    expect(JSON.stringify(response.body)).toContain('not a person');
    expect(api.writes).toEqual([]);
    expect(api.files.has('Inbox/Call.md')).toBe(true);
  });

  it('refuses a project in .atlas before reading anything there', async () => {
    const api = apiFixture({
      files: { 'Inbox/Call.md': 'c\n', '.atlas/types/project.md': PROJECT },
    });
    const response = await api.send(
      processInbox({ paths: ['Inbox/Call.md'], project: '.atlas/types/project.md' }),
    );
    expect(codeOf(response)).toBe('invalid');
    expect(JSON.stringify(response.body)).toContain('project must be a note');
  });

  it.each([
    ['no project', { paths: ['Inbox/Call.md'] }],
    ['a project that is not a path', { paths: ['Inbox/Call.md'], project: '../Out.md' }],
    ['a project in .atlas', { paths: ['Inbox/Call.md'], project: '.atlas/types/project.md' }],
    ['a project that is not there', { paths: ['Inbox/Call.md'], project: 'Projects/Gone.md' }],
    ['no paths', { paths: [], project: 'Projects/DFAI.md' }],
  ])('refuses %s as invalid, writing nothing', async (_, body) => {
    const api = apiFixture({ files: { 'Projects/DFAI.md': PROJECT, 'Inbox/Call.md': 'c\n' } });
    const response = await api.send(processInbox(body));
    expect(codeOf(response)).toBe('invalid');
    expect(api.writes).toEqual([]);
  });

  it('lists a note that is not in the Inbox, and files the rest', async () => {
    const api = apiFixture({
      files: { 'Projects/DFAI.md': PROJECT, 'Plan.md': 'p\n', 'Inbox/Call.md': 'c\n' },
    });
    const response = await api.send(
      processInbox({ paths: ['Plan.md', 'Inbox/Call.md'], project: 'Projects/DFAI.md' }),
    );
    expect(bodyOf(response)['failed']).toEqual([
      { path: 'Plan.md', reason: 'It is not in the Inbox.' },
    ]);
    expect(api.files.get('Plan.md')?.text).toBe('p\n');
  });

  it('leaves a note being typed in where it is, never saving the typing', async () => {
    const api = apiFixture({ files: { 'Projects/DFAI.md': PROJECT, 'Inbox/Call.md': 'c\n' } });
    const flushed: (readonly VaultPath[])[] = [];
    api.deps = {
      ...api.deps,
      movingNotes: {
        ...api.deps.movingNotes,
        state: (path) => (path === 'Inbox/Call.md' ? 'dirty' : 'closed'),
        flush: async (paths) => void flushed.push(paths),
      },
    };

    const response = await api.send(
      processInbox({ paths: ['Inbox/Call.md'], project: 'Projects/DFAI.md' }),
    );

    expect(bodyOf(response)['failed']).toEqual([
      { path: 'Inbox/Call.md', reason: expect.any(String), code: 'unsaved_in_app' },
    ]);
    expect(api.files.has('Inbox/Call.md')).toBe(true);
    expect(flushed.flat()).toEqual([]);
  });

  it('never files a note over one already there: it is numbered', async () => {
    const api = apiFixture({
      files: {
        'Projects/DFAI.md': PROJECT,
        'Notes/2026/Call.md': 'older\n',
        'Inbox/Call.md': 'newer\n',
      },
    });
    const response = await api.send(
      processInbox({ paths: ['Inbox/Call.md'], project: 'Projects/DFAI.md' }),
    );
    expect(bodyOf(response)['moves']).toEqual([
      { from: 'Inbox/Call.md', to: 'Notes/2026/Call 2.md' },
    ]);
    expect(api.files.get('Notes/2026/Call.md')?.text).toBe('older\n');
  });
});

describe('PATCH /v1/notes/{path}/properties — a relation to a note of the wrong type (P30-01)', () => {
  const TYPE = '---\nname: task\nproperties: {}\n---\n';
  const files = {
    'Tasks/Call.md': '---\ntype: task\n---\n\nCall.\n',
    'Projects/DFAI.md': PROJECT,
    'People/Mara Quill.md': PERSON,
  };
  const patch = (set: Record<string, unknown>) => ({
    method: 'PATCH' as const,
    path: `/v1/notes/${encodeURIComponent('Tasks/Call.md')}/properties`,
    body: { set },
  });
  const withTaskType = () =>
    apiFixture({
      markdown: jsonMarkdown(),
      files: {
        ...files,
        '.atlas/types/task.md': jsonNote({
          name: 'task',
          properties: { project: { kind: 'relation', target: ['project', 'area'] } },
        }),
      },
    });

  it('refuses a person in a project relation as invalid, writing nothing', async () => {
    const api = withTaskType();
    const response = await api.send(patch({ project: '[[Mara Quill]]' }));
    expect(codeOf(response)).toBe('invalid');
    expect(JSON.stringify(response.body)).toContain('not a person');
    expect(api.writes).toEqual([]);
  });

  it('sets a project, and a note not written yet', async () => {
    const api = withTaskType();
    expect((await api.send(patch({ project: '[[DFAI]]' }))).status).toBe(200);
    expect((await api.send(patch({ project: '[[Someday]]' }))).status).toBe(200);
  });

  it('judges nothing for a note whose type the vault does not define', async () => {
    const api = apiFixture({ files: { ...files, '.atlas/types/other.md': TYPE } });
    expect((await api.send(patch({ project: '[[Mara Quill]]' }))).status).toBe(200);
  });
});

describe('GET /v1/inbox', () => {
  it('lists what waits to be filed, with each meeting’s import standing, and no proposal', async () => {
    const files = {
      'Inbox/Call Sam.md': '---\ntype: task\n---\n',
      'Inbox/Meetings/Standup.md': '---\ntype: meeting\n---\n',
      'Inbox/Proposals/Send the file.md': '---\ntype: proposal\nkind: task\n---\n',
      'Projects/DFAI.md': PROJECT,
    };
    const api = apiFixture({
      files,
      index: { query: atlasQueryIndex({ markdown: fakeMarkdown(), files }) },
    });
    const response = await api.send({ method: 'GET', path: '/v1/inbox' });

    expect(response.status).toBe(200);
    const body = bodyOf(response) as { items: { path: string; importOutcome: unknown }[] };
    expect(body.items.map((item) => [item.path, item.importOutcome]).sort()).toEqual([
      ['Inbox/Call Sam.md', null],
      ['Inbox/Meetings/Standup.md', 'pending'],
    ]);
    expect(bodyOf(response)['truncated']).toBe(false);
    expect(api.writes).toEqual([]);
  });

  it('answers each item with exactly the contract’s keys, and no more (#903)', async () => {
    const files = {
      'Inbox/Call Sam.md': '---\ntype: task\nproject: "[[DFAI]]"\ndue: next Friday\n---\n',
      'Inbox/Payroll article.md': '---\ntype: reference\nproject: Larkspur Payroll\n---\n',
      'Projects/DFAI.md': PROJECT,
    };
    const api = apiFixture({
      files,
      index: { query: atlasQueryIndex({ markdown: fakeMarkdown(), files }) },
    });
    const response = await api.send({ method: 'GET', path: '/v1/inbox' });

    const items = (bodyOf(response) as { items: Record<string, unknown>[] }).items;
    expect(items).toHaveLength(2);
    // A field added to InboxItem fails this until someone decides it belongs in the API.
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual([
        'arrivedIn',
        'importError',
        'importOutcome',
        'path',
        'task',
        'title',
        'type',
      ]);
    }
    const task = items.find((item) => item['path'] === 'Inbox/Call Sam.md')!['task'];
    expect(Object.keys(task as object).sort()).toEqual([
      'defer',
      'due',
      'project',
      'status',
      'waitingOn',
      'waitingOnNames',
    ]);
  });

  it('pages past a full page by cursor, saying where the next starts and how many wait (#167)', async () => {
    const files = {
      'Inbox/A.md': 'a\n',
      'Inbox/B.md': 'b\n',
      'Inbox/C.md': 'c\n',
    };
    const api = apiFixture({
      files,
      index: { query: atlasQueryIndex({ markdown: fakeMarkdown(), files }) },
    });
    const page = (cursor?: string) =>
      api.send({
        method: 'GET',
        path: '/v1/inbox',
        query: { limit: '2', ...(cursor !== undefined && { cursor }) },
      });
    const paths = (body: Record<string, unknown>) =>
      (body['items'] as { path: string }[]).map((item) => item.path);

    const first = bodyOf(await page());
    expect(first).toMatchObject({ truncated: true, total: 3 });
    expect(typeof first['next']).toBe('string');
    const second = bodyOf(await page(String(first['next'])));
    expect(second).toMatchObject({ truncated: false, next: null, total: 3 });
    expect([...paths(first), ...paths(second)].sort()).toEqual([
      'Inbox/A.md',
      'Inbox/B.md',
      'Inbox/C.md',
    ]);
  });

  it('adversarial: an agent that files each page before asking for "next" still reaches every note (#167)', async () => {
    // Filing what a page listed shifts every later note up by that many, so a
    // position ("offset") would skip them: "next" is a cursor, read on from (A2).
    const files: Record<string, string> = {
      'Inbox/A.md': 'a\n',
      'Inbox/B.md': 'b\n',
      'Inbox/C.md': 'c\n',
    };
    const modified = { 'Inbox/A.md': 3, 'Inbox/B.md': 2, 'Inbox/C.md': 1 };
    let query = atlasQueryIndex({ markdown: fakeMarkdown(), files, modified });
    const api = apiFixture({
      files,
      index: { query: (sql, parameters) => query(sql, parameters) },
    });
    const page = async (cursor: string | undefined) =>
      bodyOf(
        await api.send({
          method: 'GET',
          path: '/v1/inbox',
          query: { limit: '1', ...(cursor !== undefined && { cursor }) },
        }),
      ) as { items: { path: string }[]; next: string | null; total: number };

    const seen: string[] = [];
    let cursor: string | null | undefined = undefined;
    while (cursor !== null) {
      const body = await page(cursor);
      seen.push(...body.items.map((item) => item.path));
      // Filed: gone from the Inbox, as POST /v1/inbox/process leaves it.
      for (const item of body.items) delete files[item.path];
      query = atlasQueryIndex({ markdown: fakeMarkdown(), files, modified });
      cursor = body.next;
    }

    expect(seen).toEqual(['Inbox/A.md', 'Inbox/B.md', 'Inbox/C.md']);
  });

  it('neither skips nor repeats a note edited between two pages (A2, #167)', async () => {
    // Editing a note moves it to the top: listed already, it is not listed again on a later page.
    const files: Record<string, string> = {
      'Inbox/A.md': 'a\n',
      'Inbox/B.md': 'b\n',
      'Inbox/C.md': 'c\n',
      'Inbox/D.md': 'd\n',
    };
    const modified: Record<string, number> = {
      'Inbox/A.md': 4,
      'Inbox/B.md': 3,
      'Inbox/C.md': 2,
      'Inbox/D.md': 1,
    };
    let query = atlasQueryIndex({ markdown: fakeMarkdown(), files, modified });
    const api = apiFixture({
      files,
      index: { query: (sql, parameters) => query(sql, parameters) },
    });
    const page = async (cursor?: string) =>
      bodyOf(
        await api.send({
          method: 'GET',
          path: '/v1/inbox',
          query: { limit: '2', ...(cursor !== undefined && { cursor }) },
        }),
      ) as { items: { path: string }[]; next: string | null };

    const first = await page();
    expect(first.items.map((item) => item.path)).toEqual(['Inbox/A.md', 'Inbox/B.md']);
    modified['Inbox/B.md'] = 9;
    query = atlasQueryIndex({ markdown: fakeMarkdown(), files, modified });
    const second = await page(first.next ?? undefined);

    expect(second.items.map((item) => item.path)).toEqual(['Inbox/C.md', 'Inbox/D.md']);
    expect(second.next).toBeNull();
  });

  it('refuses a cursor it did not hand out', async () => {
    const api = apiFixture({ files: {} });
    for (const cursor of [
      'not base64!',
      btoa('Inbox/A.md'),
      btoa('[1.5,"Inbox/A.md"]'),
      btoa('[1,"../A.md"]'),
    ]) {
      expect(codeOf(await api.send({ method: 'GET', path: '/v1/inbox', query: { cursor } }))).toBe(
        'invalid',
      );
    }
  });

  it('refuses a limit that is not a whole number from 1 to 500', async () => {
    const api = apiFixture({ files: {} });
    for (const query of [{ limit: '0' }, { limit: 'all' }, { limit: '501' }]) {
      expect(codeOf(await api.send({ method: 'GET', path: '/v1/inbox', query }))).toBe('invalid');
    }
  });

  it('answers no_vault when no vault is open', async () => {
    const api = apiFixture({ files: {} });
    api.open = null;
    expect(codeOf(await api.send({ method: 'GET', path: '/v1/inbox' }))).toBe('no_vault');
  });
});
