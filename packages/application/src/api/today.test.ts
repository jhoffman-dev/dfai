/**
 * The Today page through the API (#111): the page's own read, on the app's
 * clock, writing nothing, and a failing index said without the machine's paths.
 */

import { describe, expect, it } from 'vitest';
import { apiFixture, bodyOf, codeOf, NOW, TODAY } from '../testing/api-fixture.ts';
import { fakeMarkdown } from '../testing/fake-ports.ts';
import { atlasQueryIndex } from '../testing/query-index.ts';

const DAY = 86_400_000;
const note = (frontmatter: readonly string[]) => ['---', ...frontmatter, '---', ''].join('\n');

const FILES = {
  'Projects/DFAI.md': note(['type: project', 'status: active']),
  'Projects/Garden.md': note(['type: project', 'status: active']),
  'People/Mara Quill.md': note(['type: person']),
  'Tasks/Late.md': note(['type: task', 'status: backlog', 'due: 2020-01-01']),
  'Tasks/Due.md': note(['type: task', 'status: next-action', `due: ${TODAY}`]),
  'Tasks/Back.md': note(['type: task', 'status: someday', `defer: ${TODAY}`]),
  'Tasks/Doing.md': note(['type: task', 'status: in-progress']),
  'Tasks/Ship.md': note(['type: task', 'status: next-action', 'project: "[[DFAI]]"']),
  'Tasks/Loose.md': note(['type: task', 'status: next-action']),
  'Tasks/Later.md': note(['type: task', 'status: next-action', 'defer: 2999-01-01']),
  'Tasks/Quote.md': note(['type: task', 'status: waiting', 'waiting_on: [[Mara Quill]]']),
  'Tasks/Done.md': note(['type: task', 'status: archive', `due: ${TODAY}`]),
  'Inbox/Call.md': note(['type: task', 'status: inbox']),
};

const MODIFIED = { 'Tasks/Quote.md': NOW - 3 * DAY };

const ROUTE = { method: 'GET' as const, path: '/v1/today' };

interface Section {
  id: string;
  count: number;
  groups: { label: string | null; project: string | null; tasks: Record<string, unknown>[] }[];
}

describe('GET /v1/today', () => {
  it('answers each task as the contract has it: not the names its project links by (#392)', async () => {
    const query = atlasQueryIndex({ markdown: fakeMarkdown(), files: FILES, modified: MODIFIED });
    const api = apiFixture({ files: FILES, index: { query } });

    const today = bodyOf(await api.send(ROUTE))['today'] as Record<string, unknown>;
    const tasks = (today['sections'] as Section[]).flatMap((section) =>
      section.groups.flatMap((group) => group.tasks),
    );
    expect(tasks.map((task) => task['path'])).toContain('Tasks/Ship.md');
    expect(tasks.filter((task) => Object.hasOwn(task, 'projectLinks'))).toEqual([]);
  });

  it('answers the page’s sections with exactly their tasks, on the app’s clock, writing nothing', async () => {
    const query = atlasQueryIndex({ markdown: fakeMarkdown(), files: FILES, modified: MODIFIED });
    const api = apiFixture({ files: FILES, index: { query } });

    const response = await api.send(ROUTE);

    expect(response.status).toBe(200);
    const today = bodyOf(response)['today'] as Record<string, unknown>;
    const sections = today['sections'] as Section[];
    const paths = (section: Section) =>
      section.groups.flatMap((group) => group.tasks.map((task) => task['path']));
    expect(sections.map((section) => [section.id, section.count, paths(section)])).toEqual([
      ['chosen', 0, []],
      ['carriedOver', 0, []],
      ['overdue', 1, ['Tasks/Late.md']],
      ['dueToday', 1, ['Tasks/Due.md']],
      ['backToday', 1, ['Tasks/Back.md']],
      ['inProgress', 1, ['Tasks/Doing.md']],
      ['nextActions', 2, ['Tasks/Ship.md', 'Tasks/Loose.md']],
      ['waiting', 1, ['Tasks/Quote.md']],
    ]);
    expect(sections[6]?.groups.map((group) => [group.label, group.project])).toEqual([
      ['DFAI', 'Projects/DFAI.md'],
      [null, null],
    ]);
    expect(sections[7]?.groups[0]).toMatchObject({
      label: 'Mara Quill',
      tasks: [
        {
          path: 'Tasks/Quote.md',
          title: 'Quote',
          status: 'waiting',
          due: null,
          defer: null,
          waitingOn: 'Mara Quill',
          contexts: [],
          project: null,
          projectTitle: null,
          modified: NOW - 3 * DAY,
          waitingDays: 3,
        },
      ],
    });
    expect(today['today']).toBe(TODAY);
    // DFAI has a next action; Garden has nothing next.
    expect(today['stalledProjects']).toBe(1);
    expect(today['inbox']).toEqual({ count: 1, toFile: 1, toAnswer: 0, more: false });
    expect(today['truncated']).toBe(false);
    expect(api.writes).toEqual([]);
  });

  it('says the index could not answer, without the machine’s paths', async () => {
    const api = apiFixture({
      index: {
        query: () => Promise.reject(new Error('unable to open /Users/j/Library/atlas/index.db')),
      },
    });
    const response = await api.send(ROUTE);
    expect(response.status).toBe(422);
    expect(codeOf(response)).toBe('query_failed');
    const message = JSON.stringify(response.body);
    expect(message).toContain('The index could not take the Today page');
    expect(message).not.toContain('/Users/j');
  });

  it('is refused while no vault is open', async () => {
    const api = apiFixture();
    api.open = null;
    expect(codeOf(await api.send(ROUTE))).toBe('no_vault');
  });
});
