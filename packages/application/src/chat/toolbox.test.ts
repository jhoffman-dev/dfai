import { describe, expect, it } from 'vitest';
import { CHAT_READ_TOOLS } from '@dfai/domain';
import { apiFixture, VAULT } from '../testing/api-fixture.ts';
import { blockMarkdown } from '../testing/block-markdown.ts';
import { NOTE_READ_CHARACTERS } from './note-page.ts';
import { READ_TOOL_SPECS } from './read-tools.ts';
import { createChatToolbox, createToolboxes } from './toolbox.ts';

function toolbox(files: Record<string, string>, index = {}) {
  const fixture = apiFixture({ files, markdown: blockMarkdown(), index });
  let ids = 0;
  const box = createChatToolbox({
    api: fixture.deps,
    fs: fixture.fs,
    markdown: blockMarkdown(),
    newId: () => `id-${(ids += 1)}`,
  });
  return { fixture, box };
}

describe('the chat toolbox', () => {
  it('offers the read routes and the two proposals, and no write route', () => {
    const names = toolbox({}).box.specs.map((spec) => spec.name);
    expect(names).toContain('atlas_search');
    expect(names).toContain('atlas_read_note');
    expect(names).toContain('atlas_archived');
    expect(names).toEqual(expect.arrayContaining(['propose_edit', 'propose_note']));
    expect(names).not.toContain('atlas_replace_note_body');
    expect(names).not.toContain('atlas_sql');
  });

  it('reads a note through the same route the MCP server calls', async () => {
    const { box } = toolbox({ 'Projects/Q3.md': '---\nstatus: open\n---\nShip it.\n' });
    const { result, proposal } = await box.run({
      id: 'call-1',
      name: 'atlas_read_note',
      input: { path: 'Projects/Q3.md' },
    });
    expect(proposal).toBeNull();
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({
      note: { path: 'Projects/Q3.md', properties: { status: 'open' }, body: 'Ship it.\n' },
    });
  });

  it('sends every read tool to a route the API has, with the input it was given', async () => {
    const { box } = toolbox({ 'Plan.md': 'x' });
    const inputs: Record<string, Record<string, unknown>> = {
      atlas_search: { q: 'x', limit: 2, includeArchived: true },
      atlas_read_note: { path: 'Plan.md' },
      atlas_list_notes: { folder: 'Projects', limit: 5 },
      atlas_backlinks: { path: 'Plan.md' },
      atlas_list_types: {},
      atlas_list_views: {},
      atlas_list_type_views: { type: 'task' },
      atlas_list_templates: {},
      atlas_read_template: { name: 'Task' },
      atlas_run_view: { path: '.atlas/views/Board.md', includeArchived: true },
      atlas_run_query: { query: 'FROM task', limit: 10 },
      atlas_calendar: { path: '.atlas/views/Cal.md', range: 'week', anchor: '2026-09-22' },
      atlas_tags: { sort: 'frequency' },
      atlas_tagged_notes: { tag: 'idea', limit: 3 },
      atlas_archived: { search: 'old', limit: 4 },
      atlas_brief: { entity: 'Plan.md', date: '2026-09-22' },
      atlas_open_loops: { entity: 'Plan.md' },
      atlas_meeting_quotes: { entity: 'Plan.md', since: '2026-09-01', about: 'bank', limit: 3 },
    };
    const readTools = box.specs.filter((spec) => spec.name.startsWith('atlas_'));
    expect(readTools.map((spec) => spec.name).sort()).toEqual(Object.keys(inputs).sort());
    for (const [name, input] of Object.entries(inputs)) {
      const { result } = await box.run({ id: name, name, input });
      // Refusals about the vault's contents are fine here; a route that does not exist is not.
      expect(result.content, name).not.toMatch(/^not_found_route/);
    }
  });

  it('answers a refusal from the route as an error result, not a throw', async () => {
    const { box } = toolbox({});
    const { result } = await box.run({
      id: 'c',
      name: 'atlas_read_note',
      input: { path: 'Nope.md' },
    });
    expect(result).toMatchObject({ isError: true, content: expect.stringMatching(/^not_found: /) });
  });

  it('asks search for archived notes only when the model says so', async () => {
    const scopes: unknown[] = [];
    const { box } = toolbox(
      {},
      {
        search: async (_query: string, _limit: number, scope: unknown) => {
          scopes.push(scope);
          return [];
        },
      },
    );
    await box.run({ id: 'a', name: 'atlas_search', input: { q: 'lease' } });
    await box.run({ id: 'b', name: 'atlas_search', input: { q: 'lease', includeArchived: false } });
    await box.run({ id: 'c', name: 'atlas_search', input: { q: 'lease', includeArchived: true } });
    expect(scopes[0]).toEqual(scopes[1]);
    expect(scopes[2]).not.toEqual(scopes[0]);
    const { result } = await box.run({
      id: 'd',
      name: 'atlas_search',
      input: { q: 'lease', limit: 3 },
    });
    expect(JSON.parse(result.content)).toEqual({ hits: [] });
  });

  it('refuses a read when no vault is open', async () => {
    const { box, fixture } = toolbox({ 'A.md': 'a' });
    expect(fixture.open).toEqual(VAULT);
    fixture.open = null;
    const { result } = await box.run({ id: 'c', name: 'atlas_read_note', input: { path: 'A.md' } });
    expect(result).toMatchObject({ isError: true, content: expect.stringMatching(/^no_vault/) });
  });

  it('answers a note too long for one read as its first page, saying how to read on', async () => {
    const { box } = toolbox({ 'Long.md': 'x'.repeat(NOTE_READ_CHARACTERS * 2) });
    const { result } = await box.run({
      id: 'c',
      name: 'atlas_read_note',
      input: { path: 'Long.md' },
    });
    // Still JSON the model can read, saying where the next page starts.
    expect(result.content.length).toBeLessThanOrEqual(NOTE_READ_CHARACTERS);
    const { page } = JSON.parse(result.content) as { page: { next: number; note: string } };
    expect(page.next).toBeGreaterThan(0);
    expect(page.note).toContain(`offset ${page.next}`);
  });

  it('reads a 60 KB note through to its last line (#415)', async () => {
    const lines = Array.from(
      { length: 1550 },
      (_, at) => `Line ${at}: gulls over the harbour wall.`,
    );
    const text = `${lines.join('\n')}\nThe very last line of the logbook.\n`;
    expect(text.length).toBeGreaterThan(58_000);
    const { box } = toolbox({ 'Logbook.md': text });
    const { result } = await box.run({
      id: 'c',
      name: 'atlas_read_note',
      input: { path: 'Logbook.md' },
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({
      note: { body: expect.stringContaining('The very last line of the logbook.') },
    });
  });

  it('turns propose_edit into a proposal and tells the model it is not yet made', async () => {
    const { box, fixture } = toolbox({ 'Plan.md': 'One.\n' });
    const { result, proposal } = await box.run({
      id: 'call-2',
      name: 'propose_edit',
      input: { path: 'Plan.md', edits: [{ find: 'One.', replace: 'Two.' }] },
    });
    expect(proposal).toMatchObject({ kind: 'edit', id: 'id-1', path: 'Plan.md' });
    expect(result).toMatchObject({
      isError: false,
      content: expect.stringContaining('not written unless'),
    });
    expect(fixture.writes).toEqual([]);
  });

  it('turns propose_note into a proposal', async () => {
    const { box } = toolbox({});
    const { proposal } = await box.run({ id: 'c', name: 'propose_note', input: { title: 'Idea' } });
    expect(proposal).toMatchObject({ kind: 'note', title: 'Idea' });
  });

  it('answers a refused proposal, and an unknown tool, as errors the model can read', async () => {
    const { box } = toolbox({});
    const refused = await box.run({
      id: 'c',
      name: 'propose_edit',
      input: { path: 'Nope.md', append: 'x' },
    });
    expect(refused).toMatchObject({ proposal: null, result: { isError: true } });
    const unknown = await box.run({ id: 'd', name: 'rm_rf', input: {} });
    expect(unknown.result).toMatchObject({ isError: true, content: 'There is no tool "rm_rf".' });
  });
});

describe('the toolboxes built once for the chat and a rule’s Claude step (P29-03)', () => {
  function toolboxes(files: Record<string, string>) {
    const fixture = apiFixture({ files, markdown: blockMarkdown() });
    let ids = 0;
    const boxes = createToolboxes({
      api: fixture.deps,
      markdown: blockMarkdown(),
      newId: () => `id-${(ids += 1)}`,
    });
    return { fixture, boxes };
  }

  it('names the same read tools the rule validator knows', () => {
    expect(READ_TOOL_SPECS.map((spec) => spec.name)).toEqual([...CHAT_READ_TOOLS]);
  });

  it('gives the chat every read tool, the proposals and the two drafts', () => {
    const { fixture, boxes } = toolboxes({});
    const names = boxes.chat(fixture.fs).specs.map((spec) => spec.name);
    expect(names).toEqual([
      ...CHAT_READ_TOOLS,
      'propose_edit',
      'propose_note',
      'propose_tasks',
      'make_dashboard',
    ]);
  });

  it('gives a rule only the read tools it names, and runs them as the chat does', async () => {
    const { boxes } = toolboxes({ 'Projects/Q3.md': 'Ship it.\n' });
    const box = boxes.reading(['atlas_read_note', 'propose_edit', 'not_a_tool']);
    expect(box.specs.map((spec) => spec.name)).toEqual(['atlas_read_note']);
    const read = await box.run({
      id: 'c1',
      name: 'atlas_read_note',
      input: { path: 'Projects/Q3.md' },
    });
    expect(read.result.isError).toBe(false);
    expect(JSON.parse(read.result.content)).toMatchObject({ note: { body: 'Ship it.\n' } });
  });

  it('answers a call to a tool it was not given as no such tool, and writes nothing', async () => {
    const { fixture, boxes } = toolboxes({ 'Projects/Q3.md': 'Ship it.\n' });
    const box = boxes.reading(['atlas_read_note']);
    for (const name of ['atlas_search', 'propose_note']) {
      const outcome = await box.run({ id: 'c1', name, input: { title: 'x', q: 'x' } });
      expect(outcome).toEqual({
        result: { callId: 'c1', name, content: `There is no tool "${name}".`, isError: true },
        proposal: null,
      });
    }
    expect(await fixture.fs.readNotes(['x.md'])).toEqual([]);
  });
});
