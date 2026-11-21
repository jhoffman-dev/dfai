/**
 * Adversarial (ADR-0019, P24-04): a query view and a query widget are things
 * the user can keep and open in the app, so the API runs them as the app does
 * (CLAUDE.md: anything the user can do in the app can be done or read through
 * the API).
 */

import { describe, expect, it } from 'vitest';
import { apiFixture, bodyOf, encoded } from '../testing/api-fixture.ts';
import { jsonMarkdown, jsonNote } from '../testing/json-markdown.ts';

const TASK_TYPE = { name: 'task', label: 'Task', properties: { status: 'text' } };

const vault = (query: (sql: string) => void) =>
  apiFixture({
    markdown: jsonMarkdown(),
    index: {
      query: async (sql: string) => {
        query(sql);
        return {
          columns: ['path', 'title', 'type', 'status'],
          rows: [['tasks/Call.md', 'Call', 'task', 'open']],
          truncated: false,
        };
      },
    },
    files: {
      '.atlas/types/task.md': jsonNote(TASK_TYPE),
      '.atlas/views/Open.md': jsonNote({
        atlas: 'view',
        layout: 'table',
        query: 'FROM task WHERE status != done',
      }),
      '.atlas/dashboards/Home.md': jsonNote({
        atlas: 'dashboard',
        widgets: [{ kind: 'query', title: 'Open', query: 'FROM task WHERE status != done' }],
      }),
    },
  });

const run = (api: ReturnType<typeof vault>, path: string) =>
  api.send({ method: 'POST', path: `/v1/views/${encoded(path)}/run` });

describe('POST /v1/views/{path}/run with DFAI queries (adversarial)', () => {
  it('runs a query view, rather than answering that it names no type', async () => {
    // Why: runViewRoute knows sql: and type: views only; parseSavedView returns
    // null for a query view, so the API answers 400 "does not say which type it lists".
    const asked: string[] = [];
    const response = await run(
      vault((sql) => asked.push(sql)),
      '.atlas/views/Open.md',
    );

    expect(response.status).toBe(200);
    expect(asked.some((sql) => sql.includes('/* atlas-query */'))).toBe(true);
  });

  it("runs a dashboard's query widget against the vault's types", async () => {
    // Why: runViewRoute calls runDashboard without types, so every query widget
    // fails its check with "There is no type called task" — over the API only.
    const response = await run(
      vault(() => {}),
      '.atlas/dashboards/Home.md',
    );

    const widgets = bodyOf(response)['widgets'] as { data: { shape: string } }[];
    expect(widgets[0]?.data).toMatchObject({ shape: 'grouped' });
  });

  it("answers a widget the index stopped at its budget with the host's word, as before (#919)", async () => {
    // The plain sentence is the app's to draw; the API keeps what the index said (v1.md).
    const api = apiFixture({
      markdown: jsonMarkdown(),
      index: { query: () => Promise.reject('interrupted') },
      files: {
        '.atlas/types/task.md': jsonNote(TASK_TYPE),
        '.atlas/dashboards/Home.md': jsonNote({
          atlas: 'dashboard',
          widgets: [{ kind: 'query', title: 'Open', query: 'FROM task WHERE status != done' }],
        }),
      },
    });

    const response = await run(api, '.atlas/dashboards/Home.md');

    const widgets = bodyOf(response)['widgets'] as { data: unknown }[];
    expect(widgets[0]?.data).toEqual({ shape: 'error', message: 'interrupted' });
  });

  it('answers a query view whose text does not read with invalid, saying why', async () => {
    const api = apiFixture({
      markdown: jsonMarkdown(),
      files: {
        '.atlas/types/task.md': jsonNote(TASK_TYPE),
        '.atlas/views/Broken.md': jsonNote({ atlas: 'view', query: 'FROM task WHERE stauts = x' }),
      },
    });
    const response = await run(api, '.atlas/views/Broken.md');
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain('A task has no field called stauts.');
  });
});
