/**
 * The weekly review through the API (P30-07): read from the index on the
 * app's clock, writing nothing, and a failing index is said as the API says
 * every failure — with the machine's paths taken out.
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
  'Tasks/Quote.md': note(['type: task', 'status: waiting', 'waiting_on: [[Mara Quill]]']),
  'Tasks/Ship.md': note([
    'type: task',
    'status: next-action',
    'project: "[[DFAI]]"',
    'due: 2026-09-20',
  ]),
  'Tasks/Cello.md': note(['type: task', 'status: someday']),
  'Inbox/Call.md': note(['type: task', 'status: inbox']),
};

const MODIFIED = {
  'Tasks/Quote.md': NOW - 10 * DAY,
  'Tasks/Ship.md': NOW - DAY,
  'Tasks/Cello.md': NOW - 45 * DAY,
  'Inbox/Call.md': NOW,
};

const WEEKLY = { method: 'GET' as const, path: '/v1/review/weekly' };

describe('GET /v1/review/weekly', () => {
  it('answers each section with exactly its items, on the app’s clock, writing nothing', async () => {
    const query = atlasQueryIndex({ markdown: fakeMarkdown(), files: FILES, modified: MODIFIED });
    const api = apiFixture({ files: FILES, index: { query } });

    const response = await api.send(WEEKLY);

    expect(response.status).toBe(200);
    const review = bodyOf(response)['review'] as Record<string, unknown>;
    const paths = (key: string) => (review[key] as { path: string }[]).map((item) => item.path);
    expect(review['today']).toBe(TODAY);
    expect(paths('staleWaiting')).toEqual(['Tasks/Quote.md']);
    expect(paths('projectsWithoutNextAction')).toEqual(['Projects/Garden.md']);
    expect(paths('overdue')).toEqual(['Tasks/Ship.md']);
    expect(paths('untouchedSomeday')).toEqual(['Tasks/Cello.md']);
    expect(review['inbox']).toEqual({ count: 1, toFile: 1, toAnswer: 0, more: false });
    expect(review['truncated']).toBe(false);
    expect(review['staleWaiting']).toEqual([
      {
        path: 'Tasks/Quote.md',
        title: 'Quote',
        status: 'waiting',
        due: null,
        focus: null,
        focusIsOwn: false,
        defer: null,
        recurrence: null,
        waitingOn: 'Mara Quill',
        contexts: [],
        project: null,
        projectTitle: null,
        modified: NOW - 10 * DAY,
      },
    ]);
    expect(api.writes).toEqual([]);
  });

  it('says the index could not answer, without the machine’s paths', async () => {
    const api = apiFixture({
      index: {
        query: () => Promise.reject(new Error('unable to open /Users/j/Library/atlas/index.db')),
      },
    });
    const response = await api.send(WEEKLY);
    expect(response.status).toBe(422);
    expect(codeOf(response)).toBe('query_failed');
    const message = JSON.stringify(response.body);
    expect(message).toContain('The index could not take the weekly review');
    expect(message).not.toContain('/Users/j');
  });

  it('is refused while no vault is open', async () => {
    const api = apiFixture();
    api.open = null;
    const response = await api.send(WEEKLY);
    expect(codeOf(response)).toBe('no_vault');
  });
});
