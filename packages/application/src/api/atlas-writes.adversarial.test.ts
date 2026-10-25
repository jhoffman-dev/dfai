/**
 * Adversarial (P32-05): `make_dashboard` makes a dashboard reachable from the
 * API — as a proposal — so every way a caller might get one into `.atlas`
 * without the app's Accept is tried here. The API names `.atlas` in many
 * spellings; each is refused before anything is written, and no write in
 * any test lands under `.atlas`.
 *
 * A symlink inside the vault that leads into `.atlas` is refused by the host,
 * which resolves a path before writing it (`refuse_hidden_detour`, tested in
 * `apps/desktop/src-tauri/src/vault.rs`); this in-memory vault has no links,
 * so that case is the host's test, not this one's.
 */
import { describe, expect, it } from 'vitest';
import { apiFixture, bodyOf, codeOf, encoded } from '../testing/api-fixture.ts';
import { jsonLinesMarkdown, jsonLinesNote } from '../testing/proposal-vault.ts';

const TASK_TYPE = jsonLinesNote({
  name: 'task',
  properties: { status: { kind: 'select', options: ['inbox', 'done'] } },
});
const BOARD = jsonLinesNote({ atlas: 'dashboard', widgets: [] }, '# Board\n');
const WIDGETS = [{ kind: 'number', type: 'task' }];

function vault(files: Record<string, string> = {}) {
  return apiFixture({
    files: {
      '.atlas/types/task.md': TASK_TYPE,
      '.atlas/dashboards/Board.md': BOARD,
      'Notes/Plan.md': '# Plan\n',
      ...files,
    },
    markdown: jsonLinesMarkdown(),
  });
}

/** Every write that landed anywhere under `.atlas`, however it is cased. */
const intoAtlas = (api: ReturnType<typeof vault>) =>
  api.writes.filter(({ path }) => /(^|\/)\.atlas(\/|$)/i.test(path));

const TRICKS = [
  '.atlas/dashboards/Board.md',
  '.ATLAS/dashboards/Board.md',
  '.Atlas/dashboards/Board.md',
  './.atlas/dashboards/Board.md',
  'x/../.atlas/dashboards/Board.md',
  'Notes/../.atlas/dashboards/Board.md',
  '/.atlas/dashboards/Board.md',
  '.atlas\\dashboards\\Board.md',
  ' .atlas/dashboards/Board.md',
];

describe('the API still never writes .atlas (P32-05)', () => {
  it.each(TRICKS)('refuses a body write to %j', async (path) => {
    const api = vault();
    const response = await api.send({
      method: 'PUT',
      path: `/v1/notes/${encoded(path)}/body`,
      body: { markdown: '# Mine now\n', ifModified: 1 },
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(intoAtlas(api)).toEqual([]);
    expect(api.files.get('.atlas/dashboards/Board.md')?.text).toBe(BOARD);
  });

  it.each(TRICKS)('refuses a property write to %j', async (path) => {
    const api = vault();
    const response = await api.send({
      method: 'PATCH',
      path: `/v1/notes/${encoded(path)}/properties`,
      body: { set: { widgets: WIDGETS } },
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(intoAtlas(api)).toEqual([]);
  });

  it.each(TRICKS)('refuses an append to %j', async (path) => {
    const api = vault();
    const response = await api.send({
      method: 'POST',
      path: `/v1/notes/${encoded(path)}/append`,
      body: { markdown: 'more' },
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(intoAtlas(api)).toEqual([]);
  });

  it.each([
    '.atlas/dashboards',
    '.ATLAS/dashboards',
    './.atlas/dashboards',
    'x/../.atlas/dashboards',
    'Notes/../.atlas',
  ])('refuses a new note in the folder %j', async (folder) => {
    const api = vault();
    const response = await api.send({
      method: 'POST',
      path: '/v1/notes',
      body: { folder, name: 'Sneaked', properties: { atlas: 'dashboard', widgets: WIDGETS } },
    });
    expect(codeOf(response)).toBe('invalid');
    expect(intoAtlas(api)).toEqual([]);
  });

  it('makes a note that says it is a dashboard in user space, never in .atlas/dashboards', async () => {
    const api = vault();
    const response = await api.send({
      method: 'POST',
      path: '/v1/notes',
      body: { name: 'Sneaked', properties: { atlas: 'dashboard', widgets: WIDGETS } },
    });
    expect(response.status).toBe(201);
    expect(api.writes.map(({ path }) => path)).toEqual(['Sneaked.md']);
    expect(intoAtlas(api)).toEqual([]);
  });

  it.each([
    ['../.atlas/dashboards/Board', 'name'],
    ['.atlas', 'name'],
    ['..', 'name'],
    ['a\\..\\.atlas', 'name'],
  ])(
    'make_dashboard refuses the name %j, which cannot steer where it is written',
    async (name, at) => {
      const api = vault();
      const response = await api.send({
        method: 'POST',
        path: '/v1/assistant/make-dashboard',
        body: { spec: { kind: 'dashboard', name, widgets: WIDGETS } },
      });
      expect(codeOf(response)).toBe('invalid');
      expect(
        (bodyOf(response) as { error: { problems: { at: string }[] } }).error.problems.map(
          (problem) => problem.at,
        ),
      ).toEqual([at]);
      expect(api.writes).toEqual([]);
    },
  );

  it('make_dashboard takes no path or folder: what a spec says of one is not carried', async () => {
    const api = vault();
    const response = await api.send({
      method: 'POST',
      path: '/v1/assistant/make-dashboard',
      body: {
        spec: {
          kind: 'dashboard',
          name: 'Payroll',
          path: '.atlas/types/task.md',
          folder: '.atlas/types',
          widgets: [{ kind: 'number', type: 'task', path: '.atlas/types/task.md' }],
        },
      },
    });
    expect(response.status).toBe(200);
    expect(api.writes.map(({ path }) => path)).toEqual(['Inbox/Proposals/Payroll.md']);
    expect(api.files.get('Inbox/Proposals/Payroll.md')?.text).not.toContain('.atlas/types');
  });

  it('a task proposal edited through the API into a dashboard one is still accepted only in the app', async () => {
    const proposal = 'Inbox/Proposals/Send the file.md';
    const api = vault({
      [proposal]: jsonLinesNote({
        type: 'proposal',
        kind: 'task',
        payload: { title: 'Send the file' },
      }),
    });
    const patched = await api.send({
      method: 'PATCH',
      path: `/v1/notes/${encoded(proposal)}/properties`,
      body: { set: { kind: 'dashboard', payload: { title: 'Board', spec: { widgets: WIDGETS } } } },
    });
    expect(patched.status).toBe(200);

    const accepted = await api.send({
      method: 'POST',
      path: `/v1/proposals/${encoded(proposal)}/accept`,
    });

    expect(codeOf(accepted)).toBe('forbidden');
    expect(intoAtlas(api)).toEqual([]);
  });

  it('a dashboard proposal written by hand through the notes routes is accepted only in the app', async () => {
    const api = vault({ 'Inbox/Proposals/Other.md': jsonLinesNote({ type: 'proposal' }) });
    const made = await api.send({
      method: 'POST',
      path: '/v1/notes',
      body: {
        folder: 'Inbox/Proposals',
        name: 'Hand made',
        properties: {
          type: 'proposal',
          kind: 'VIEW',
          payload: { title: 'All tasks', spec: { type: 'task', layout: 'table' } },
        },
      },
    });
    expect(made.status).toBe(201);

    const response = await api.send({
      method: 'POST',
      path: `/v1/proposals/${encoded('Inbox/Proposals/Hand made.md')}/accept`,
    });
    expect(codeOf(response)).toBe('forbidden');
    expect(intoAtlas(api)).toEqual([]);
  });
});
