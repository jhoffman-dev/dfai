/**
 * The chat's two drafting tools (P32-05), run through the same routes an MCP
 * client calls: a dashboard spec checked and left in the Inbox, a refusal
 * the model can read and fix, and neither offered to a rule's Claude step.
 */
import { describe, expect, it } from 'vitest';
import { apiFixture } from '../testing/api-fixture.ts';
import { jsonLinesMarkdown, jsonLinesNote } from '../testing/proposal-vault.ts';
import { createChatToolbox, createReadToolbox } from './toolbox.ts';

const TASK_TYPE = jsonLinesNote({
  name: 'task',
  properties: { status: { kind: 'select', options: ['inbox', 'done'] } },
});

function toolbox() {
  const fixture = apiFixture({
    files: { '.atlas/types/task.md': TASK_TYPE },
    markdown: jsonLinesMarkdown(),
  });
  let ids = 0;
  const box = createChatToolbox({
    api: fixture.deps,
    fs: fixture.fs,
    markdown: jsonLinesMarkdown(),
    newId: () => `id-${(ids += 1)}`,
  });
  return { fixture, box };
}

const dashboard = (widgets: unknown[]) => ({
  id: 'call-1',
  name: 'make_dashboard',
  input: { spec: { kind: 'dashboard', name: 'Larkspur Payroll', widgets } },
});

describe('make_dashboard in the chat', () => {
  it('leaves the dashboard in the Inbox as a proposal, and tells the model so', async () => {
    const { fixture, box } = toolbox();

    const { result, proposal } = await box.run(
      dashboard([{ kind: 'donut', type: 'task', groupBy: 'status' }]),
    );

    expect(proposal).toBeNull();
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual({
      proposedSpec: {
        kind: 'dashboard',
        title: 'Larkspur Payroll',
        proposal: 'Inbox/Proposals/Larkspur Payroll.md',
        problem: null,
      },
    });
    expect(fixture.writes.map(({ path }) => path)).toEqual(['Inbox/Proposals/Larkspur Payroll.md']);
  });

  it('hands a refused spec’s problems back whole, so the model can fix them', async () => {
    const { fixture, box } = toolbox();

    const { result } = await box.run(dashboard([{ kind: 'donut', type: 'task' }]));

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content)).toMatchObject({
      error: {
        code: 'invalid',
        problems: [{ at: 'widgets[0]', message: 'A donut needs a property to group by.' }],
      },
    });
    expect(fixture.writes).toEqual([]);
  });

  it('runs propose_tasks through its route: with no Claude set up, it says so', async () => {
    const { box } = toolbox();
    const { result } = await box.run({
      id: 'call-2',
      name: 'propose_tasks',
      input: { meeting: 'Meetings/Sync.md' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content)).toMatchObject({ error: { code: 'conflict' } });
  });

  it('is not a tool a rule’s Claude step can be given', async () => {
    const { fixture } = toolbox();
    const reading = createReadToolbox({
      api: fixture.deps,
      tools: ['make_dashboard', 'propose_tasks', 'atlas_search'],
      newId: () => 'x',
    });
    expect(reading.specs.map((spec) => spec.name)).toEqual(['atlas_search']);
    const { result } = await reading.run(dashboard([{ kind: 'number', type: 'task' }]));
    expect(result).toMatchObject({ isError: true, content: 'There is no tool "make_dashboard".' });
    expect(fixture.writes).toEqual([]);
  });
});
