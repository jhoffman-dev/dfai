/**
 * More ways into `.atlas` without the app's Accept (PR #549 attack): spellings
 * the P32-05 adversarial suite leaves out, and note and link proposals —
 * which the API may accept — whose payload points into `.atlas`.
 */
import { describe, expect, it } from 'vitest';
import { apiFixture, encoded } from '../testing/api-fixture.ts';
import { jsonLinesMarkdown, jsonLinesNote } from '../testing/proposal-vault.ts';

const TASK_TYPE = jsonLinesNote({
  name: 'task',
  properties: {
    status: { kind: 'select', options: ['inbox', 'done'] },
    project: { kind: 'relation', target: 'project' },
  },
});
const BOARD = jsonLinesNote({ atlas: 'dashboard', widgets: [] }, '# Board\n');
const WIDGETS = [{ kind: 'number', type: 'task' }];

function vault(files: Record<string, string> = {}) {
  return apiFixture({
    files: {
      '.atlas/types/task.md': TASK_TYPE,
      '.atlas/dashboards/Board.md': BOARD,
      'Inbox/Proposals/Other.md': jsonLinesNote({ type: 'proposal' }),
      ...files,
    },
    markdown: jsonLinesMarkdown(),
  });
}

const intoAtlas = (api: ReturnType<typeof vault>) =>
  api.writes.filter(({ path }) => /(^|\/)\.atlas(\/|$)/i.test(path.normalize('NFC')));

const MORE_TRICKS = [
  '.atlas//dashboards/Board.md',
  '.atlas/./dashboards/Board.md',
  '.atlas/x/../dashboards/Board.md',
  'Notes/./../.atlas/dashboards/Board.md',
  '.atlas\u0000/dashboards/Board.md',
  '.atlas/dashboards/Board.md\u0000.png',
  '.atlas/dashboards/Board.md ',
  '.atlas/dashboards/Board.md.',
  '​.atlas/dashboards/Board.md',
  '.átlas/dashboards/Board.md',
];

async function propose(api: ReturnType<typeof vault>, properties: Record<string, unknown>) {
  const made = await api.send({
    method: 'POST',
    path: '/v1/notes',
    body: {
      folder: 'Inbox/Proposals',
      name: 'Hand made',
      properties: { type: 'proposal', ...properties },
    },
  });
  expect(made.status).toBe(201);
  return api.send({
    method: 'POST',
    path: `/v1/proposals/${encoded('Inbox/Proposals/Hand made.md')}/accept`,
  });
}

describe('the API never writes .atlas: more spellings', () => {
  it.each(MORE_TRICKS)('refuses a body write to %j', async (path) => {
    const api = vault();
    await api.send({
      method: 'PUT',
      path: `/v1/notes/${encoded(path)}/body`,
      body: { markdown: '# Mine now\n', ifModified: 1 },
    });
    expect(intoAtlas(api)).toEqual([]);
    expect(api.files.get('.atlas/dashboards/Board.md')?.text).toBe(BOARD);
  });

  it.each(MORE_TRICKS)('refuses a property write to %j', async (path) => {
    const api = vault();
    await api.send({
      method: 'PATCH',
      path: `/v1/notes/${encoded(path)}/properties`,
      body: { set: { widgets: WIDGETS } },
    });
    expect(intoAtlas(api)).toEqual([]);
  });
});

describe('a proposal the API may accept never writes .atlas', () => {
  it.each(['.atlas/dashboards', '.ATLAS/dashboards', 'x/../.atlas/dashboards', './.atlas'])(
    'a task proposal whose payload folder is %j',
    async (folder) => {
      const api = vault();
      await propose(api, {
        kind: 'task',
        payload: { title: 'Sneaked', folder, properties: { atlas: 'dashboard', widgets: WIDGETS } },
      });
      expect(intoAtlas(api)).toEqual([]);
    },
  );

  it.each(['task', 'project', 'term', 'person', 'decision'])(
    'a %s proposal whose properties say it is a dashboard',
    async (kind) => {
      const api = vault();
      await propose(api, {
        kind,
        payload: { title: 'Sneaked', properties: { atlas: 'dashboard', widgets: WIDGETS } },
      });
      expect(intoAtlas(api)).toEqual([]);
    },
  );

  it.each(['.atlas/types/task.md', '.ATLAS/types/task.md', '.atlas/dashboards/Board.md'])(
    'a link proposal whose note is %j',
    async (note) => {
      const api = vault({ 'Projects/Orchard.md': jsonLinesNote({ type: 'project' }) });
      await propose(api, {
        kind: 'link',
        payload: { note, property: 'project', link: '[[Orchard]]' },
      });
      expect(intoAtlas(api)).toEqual([]);
    },
  );
});
