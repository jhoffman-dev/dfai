import { describe, expect, it } from 'vitest';
import { apiFixture, bodyOf, codeOf, encoded } from '../testing/api-fixture.ts';
import { jsonMarkdown } from '../testing/json-markdown.ts';

const note = (type: string) => `---\ntype: ${type}\n---\n\n# Body\n`;

describe('GET /v1/notes', () => {
  const vault = () =>
    apiFixture({
      files: {
        'b.md': note('task'),
        'a.md': '# A\n',
        'Tasks/c.md': note('task'),
        'Tasks/Deep/d.md': '# D\n',
        'Tasksmore/e.md': '# E\n',
        '.atlas/types/task.md': '---\nname: task\n---\n',
        '.obsidian/x.md': '# hidden\n',
        'picture.png': 'not a note',
      },
      index: {
        notesOfType: async () => [
          { path: 'b.md', title: 'b' },
          { path: 'Tasks/c.md', title: 'c' },
        ],
      },
    });

  it('lists the notes the API can reach, in path order, with what identifies each', async () => {
    const response = await vault().send({ method: 'GET', path: '/v1/notes' });

    expect(response.status).toBe(200);
    expect(bodyOf(response)).toEqual({
      notes: [
        { path: 'Tasks/Deep/d.md', title: 'd', type: null, modified: expect.any(Number) },
        { path: 'Tasks/c.md', title: 'c', type: 'task', modified: expect.any(Number) },
        { path: 'Tasksmore/e.md', title: 'e', type: null, modified: expect.any(Number) },
        { path: 'a.md', title: 'a', type: null, modified: expect.any(Number) },
        { path: 'b.md', title: 'b', type: 'task', modified: expect.any(Number) },
      ],
      next: null,
      total: 5,
    });
  });

  it('pages with an opaque cursor until there is no next page', async () => {
    const api = vault();
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: Record<string, string> = { limit: '2', ...(cursor === null ? {} : { cursor }) };
      const body = bodyOf(await api.send({ method: 'GET', path: '/v1/notes', query }));
      const notes = body['notes'] as { path: string }[];
      seen.push(...notes.map((found) => found.path));
      cursor = body['next'] as string | null;
      if (cursor !== null) expect(cursor).not.toContain('/');
      pages += 1;
    } while (cursor !== null && pages < 10);

    expect(pages).toBe(3);
    expect(seen).toEqual(['Tasks/Deep/d.md', 'Tasks/c.md', 'Tasksmore/e.md', 'a.md', 'b.md']);
  });

  it('keeps its place when a note before the cursor is removed between pages', async () => {
    const api = vault();
    const first = bodyOf(
      await api.send({ method: 'GET', path: '/v1/notes', query: { limit: '2' } }),
    );
    api.files.delete('Tasks/Deep/d.md');

    const second = bodyOf(
      await api.send({
        method: 'GET',
        path: '/v1/notes',
        query: { limit: '2', cursor: first['next'] as string },
      }),
    );

    expect((second['notes'] as { path: string }[]).map((found) => found.path)).toEqual([
      'Tasksmore/e.md',
      'a.md',
    ]);
  });

  it('lists only what is inside a folder, all the way down, and not a folder sharing its prefix', async () => {
    const response = await vault().send({
      method: 'GET',
      path: '/v1/notes',
      query: { folder: 'Tasks' },
    });

    expect((bodyOf(response)['notes'] as { path: string }[]).map((found) => found.path)).toEqual([
      'Tasks/Deep/d.md',
      'Tasks/c.md',
    ]);
  });

  it('treats the root folder as everything', async () => {
    const response = await vault().send({
      method: 'GET',
      path: '/v1/notes',
      query: { folder: '' },
    });
    expect(bodyOf(response)['notes']).toHaveLength(5);
  });

  it('lists only notes of a type, as the index knows them', async () => {
    const response = await vault().send({
      method: 'GET',
      path: '/v1/notes',
      query: { type: 'task' },
    });

    expect((bodyOf(response)['notes'] as { path: string }[]).map((found) => found.path)).toEqual([
      'Tasks/c.md',
      'b.md',
    ]);
  });

  it.each([
    ['limit of zero', { limit: '0' }],
    ['limit over 500', { limit: '501' }],
    ['limit that is not a number', { limit: 'ten' }],
    ['limit with a fraction', { limit: '2.5' }],
    ['cursor it never handed out', { cursor: '***' }],
    ['cursor that is not text', { cursor: btoa('\xff\xfe') }],
    ['folder that climbs out', { folder: '../elsewhere' }],
    ['folder in .atlas', { folder: '.atlas' }],
  ])('refuses a %s as invalid', async (_, query) => {
    const response = await vault().send({ method: 'GET', path: '/v1/notes', query });
    expect(codeOf(response)).toBe('invalid');
  });

  it('takes a limit of 500', async () => {
    const response = await vault().send({
      method: 'GET',
      path: '/v1/notes',
      query: { limit: '500' },
    });
    expect(response.status).toBe(200);
  });

  it('pages 100 at a time when no limit is given', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 101 }, (_, at) => [`n${String(at).padStart(3, '0')}.md`, '#\n']),
    );
    const body = bodyOf(await apiFixture({ files }).send({ method: 'GET', path: '/v1/notes' }));

    expect(body['notes']).toHaveLength(100);
    expect(body['next']).not.toBeNull();
  });
});

describe('GET /v1/notes/{path}', () => {
  it('shows a block’s Google Calendar sync state among its properties (#30), with no route of its own', async () => {
    const api = apiFixture({
      files: {
        'Larkspur close block.md': `---\n${JSON.stringify({
          type: 'block',
          start: '2026-10-26T09:00',
          end: '2026-10-26T10:00',
          gcal_event_id: 'dfaiev1',
          gcal_etag: 'v3',
          gcal_calendar: 'dfai-blocks@group.calendar.example.com',
          gcal_missing: true,
        })}\n---\n`,
      },
      markdown: jsonMarkdown(),
    });

    const response = await api.send({
      method: 'GET',
      path: `/v1/notes/${encoded('Larkspur close block.md')}`,
    });

    expect(bodyOf(response)['note']).toMatchObject({
      properties: {
        gcal_event_id: 'dfaiev1',
        gcal_etag: 'v3',
        gcal_calendar: 'dfai-blocks@group.calendar.example.com',
        gcal_missing: true,
      },
    });
  });

  it('names the note as its page does: the title property, not the filename or a heading', async () => {
    const api = apiFixture({
      files: { 'A15-03.md': '---\ntitle: Leftovers\n---\n\n# Other\n' },
    });

    const response = await api.send({ method: 'GET', path: `/v1/notes/${encoded('A15-03.md')}` });

    expect(bodyOf(response)['note']).toMatchObject({ path: 'A15-03.md', title: 'Leftovers' });
  });

  it('answers with the properties, the body byte for byte, and the modified time', async () => {
    const api = apiFixture({
      files: { 'Tasks/Call Sam.md': '---\ntype: task\nstatus: todo\n---\n\n# Call\n\n* x  \n' },
    });

    const response = await api.send({
      method: 'GET',
      path: `/v1/notes/${encoded('Tasks/Call Sam.md')}`,
    });

    expect(bodyOf(response)).toEqual({
      note: {
        path: 'Tasks/Call Sam.md',
        title: 'Call Sam',
        type: 'task',
        modified: api.files.get('Tasks/Call Sam.md')?.modified,
        properties: { type: 'task', status: 'todo' },
        body: '\n# Call\n\n* x  \n',
      },
    });
  });

  it('is internal, not not_found, when the read fails for another reason', async () => {
    const api = apiFixture({ files: { 'Note.md': '#\n' } });
    api.deps = {
      ...api.deps,
      fs: {
        ...api.deps.fs,
        readTextFile: async () => {
          throw new TypeError('IPC bridge gone');
        },
      },
    };

    const response = await api.send({ method: 'GET', path: '/v1/notes/Note.md' });
    expect(codeOf(response)).toBe('internal');
  });

  it('is not_found when there is no such note', async () => {
    const response = await apiFixture().send({ method: 'GET', path: '/v1/notes/Missing.md' });

    expect(codeOf(response)).toBe('not_found');
    expect(response.status).toBe(404);
  });
});

describe('GET /v1/notes/{path}/backlinks', () => {
  it('answers with the notes linking here, leaving out ones the API cannot reach or that have gone', async () => {
    const api = apiFixture({
      files: { 'Target.md': '# T\n', 'From.md': note('project'), '.atlas/views/Board.md': '#\n' },
      index: { backlinks: async () => ['From.md', '.atlas/views/Board.md', 'Gone.md'] },
    });

    const response = await api.send({ method: 'GET', path: '/v1/notes/Target.md/backlinks' });

    expect(bodyOf(response)).toEqual({
      backlinks: [
        { path: 'From.md', title: 'From', type: 'project', modified: expect.any(Number) },
      ],
      next: null,
      total: 1,
    });
  });

  it('is not_found for a note that does not exist', async () => {
    const response = await apiFixture().send({
      method: 'GET',
      path: '/v1/notes/Missing.md/backlinks',
    });
    expect(codeOf(response)).toBe('not_found');
  });
});
