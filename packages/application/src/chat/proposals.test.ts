import { describe, expect, it, vi } from 'vitest';
import { createVaultPath, deleteThroughLinkRefusal } from '@dfai/domain';
import { apiFixture } from '../testing/api-fixture.ts';
import { VaultAccessError } from '../vault/ports.ts';
import { blockMarkdown } from '../testing/block-markdown.ts';
import {
  acceptProposal,
  ProposalRefused,
  proposeEdit,
  proposeNote,
  undoProposal,
  type EditProposal,
} from './proposals.ts';

const PLAN = '---\nstatus: open\n---\nIntro  kept  as  typed.\n\n- [ ] Call Sam\n\nOutro.\n';
const path = createVaultPath('Plan.md');

function vault(files: Record<string, string> = { 'Plan.md': PLAN }) {
  const fixture = apiFixture({ files, markdown: blockMarkdown() });
  return { fixture, fs: fixture.fs, markdown: blockMarkdown() };
}

const closed = { state: () => 'closed' as const, reload: vi.fn() };

async function proposal(input: Record<string, unknown>, files?: Record<string, string>) {
  const setup = vault(files);
  const made = await proposeEdit({
    today: '2026-10-08',
    fs: setup.fs,
    markdown: setup.markdown,
    input,
    id: 'p1',
  });
  return { ...setup, made };
}

describe('proposeEdit', () => {
  it('describes the change as blocks, without writing anything', async () => {
    const { made, fixture } = await proposal({
      path: 'Plan.md',
      edits: [{ find: '- [ ] Call Sam', replace: '- [x] Call Sam' }],
    });
    expect(made.afterBody).toBe('Intro  kept  as  typed.\n\n- [x] Call Sam\n\nOutro.\n');
    expect(made.blocks.map((block) => block.kind)).toEqual(['same', 'removed', 'added', 'same']);
    expect(fixture.writes).toEqual([]);
  });

  it('lists property changes against what the note has', async () => {
    const { made } = await proposal({ path: 'Plan.md', properties: { status: 'done', due: null } });
    expect(made.propertyChanges).toEqual([
      { key: 'status', before: 'open', after: 'done' },
      { key: 'due', before: null, after: null },
    ]);
  });

  it.each([
    [{ path: '.atlas/sources/GitHub.md', append: 'x' }, /hidden configuration/],
    [{ path: 'Missing.md', append: 'x' }, /There is no note at "Missing.md"/],
    [{ path: 'Plan.md' }, /needs "edits", "append" or "properties"/],
    [{ path: 'Plan.md', edits: [{ find: 'Nope', replace: 'x' }] }, /no text "Nope"/],
    [{ path: 'Plan.md', edits: 'x' }, /must be a list/],
    [{ path: 'Plan.md', edits: [{ find: 'Outro.' }] }, /Each edit must be/],
    [{ path: 'Plan.md', edits: [{ find: 'Outro.', replace: 'Outro.' }] }, /changes nothing/],
    [{ path: 'Plan.md', properties: [] }, /must be an object/],
    [{ path: 'Plan.md', properties: { ' ': 1 } }, /needs a key/],
    [{ path: 'Plan.md', append: 3 }, /"append" must be text/],
  ])('refuses %j with a reason the model can act on', async (input, reason) => {
    await expect(proposal(input)).rejects.toThrow(reason);
    await expect(proposal(input)).rejects.toBeInstanceOf(ProposalRefused);
  });
});

describe('acceptProposal for an edit', () => {
  it('writes exactly the text the card was drawn from: every other byte is kept', async () => {
    const { made, fs, fixture } = await proposal({
      path: 'Plan.md',
      edits: [{ find: '- [ ] Call Sam', replace: '- [x] Call Sam' }],
    });

    await acceptProposal({ fs, openNotes: closed, proposal: made });

    expect(fixture.files.get('Plan.md')?.text).toBe(
      '---\nstatus: open\n---\nIntro  kept  as  typed.\n\n- [x] Call Sam\n\nOutro.\n',
    );
    expect(fixture.files.get('Plan.md')?.text).toBe(made.contents);
  });

  it('sets properties with the same save', async () => {
    const { made, fs, fixture } = await proposal({
      path: 'Plan.md',
      properties: { status: 'done' },
    });
    await acceptProposal({ fs, openNotes: closed, proposal: made });
    expect(fixture.files.get('Plan.md')?.text).toMatch(/^---\nstatus: done\n---\nIntro {2}kept/);
  });

  it('refuses when a pane holds unsaved typing, and writes nothing', async () => {
    const { made, fs, fixture } = await proposal({ path: 'Plan.md', append: 'More.' });
    const dirty = { state: () => 'dirty' as const, reload: vi.fn() };
    await expect(acceptProposal({ fs, openNotes: dirty, proposal: made })).rejects.toThrow(
      /unsaved typing/,
    );
    expect(fixture.writes).toEqual([]);
  });

  it('refuses when the note changed after the proposal', async () => {
    const { made, fs, fixture } = await proposal({ path: 'Plan.md', append: 'More.' });
    await fs.writeTextFile({
      path,
      contents: 'Someone else wrote this.\n',
      expectedModified: null,
    });
    await expect(acceptProposal({ fs, openNotes: closed, proposal: made })).rejects.toThrow(
      /changed since this was proposed/,
    );
    expect(fixture.files.get('Plan.md')?.text).toBe('Someone else wrote this.\n');
  });

  it('reloads a clean pane holding the note once written', async () => {
    const { made, fs } = await proposal({ path: 'Plan.md', append: 'More.' });
    const clean = { state: () => 'clean' as const, reload: vi.fn() };
    await acceptProposal({ fs, openNotes: clean, proposal: made });
    expect(clean.reload).toHaveBeenCalledWith(path);
  });

  it('can be undone in one step, putting every byte back', async () => {
    const { made, fs, fixture } = await proposal({ path: 'Plan.md', append: 'More.' });
    const applied = await acceptProposal({
      fs,
      openNotes: closed,
      proposal: made,
    });
    await undoProposal({ fs, openNotes: closed, applied });
    expect(fixture.files.get('Plan.md')?.text).toBe(PLAN);
  });

  it('refuses to undo once something else wrote the note', async () => {
    const { made, fs, fixture } = await proposal({ path: 'Plan.md', append: 'More.' });
    const applied = await acceptProposal({
      fs,
      openNotes: closed,
      proposal: made,
    });
    await fs.writeTextFile({ path, contents: 'Later typing.\n', expectedModified: null });
    await expect(undoProposal({ fs, openNotes: closed, applied })).rejects.toThrow(/changed since/);
    expect(fixture.files.get('Plan.md')?.text).toBe('Later typing.\n');
  });
});

describe('proposeNote and accepting it', () => {
  it('describes the new note, then creates it where asked', async () => {
    const { fs, markdown, fixture } = vault({ 'Projects/Q3.md': 'x' });
    const made = proposeNote({
      today: '2026-10-08',
      markdown,
      input: {
        title: 'Launch/plan',
        folder: 'Projects',
        body: 'First.\n',
        properties: { type: 'task' },
      },
      id: 'n1',
      notePaths: [],
    });
    expect(made.title).toBe('Launch plan');
    expect(made.blocks).toEqual([expect.objectContaining({ kind: 'added' })]);
    expect(fixture.writes).toEqual([]);

    const applied = await acceptProposal({
      fs,
      openNotes: closed,
      proposal: made,
    });

    expect(applied).toMatchObject({ kind: 'created', path: 'Projects/Launch plan.md' });
    expect(fixture.files.get('Projects/Launch plan.md')?.text).toBe(
      '---\ntype: task\n---\nFirst.\n',
    );
  });

  it('undoes a created note by putting it in the Trash', async () => {
    const { fs, markdown } = vault({});
    const trashed: string[] = [];
    const tracked = {
      ...fs,
      trashEntry: async ({ path: gone }: { path: string }) => void trashed.push(gone),
    };
    const made = proposeNote({
      today: '2026-10-08',
      markdown,
      input: { title: 'Idea' },
      id: 'n1',
      notePaths: [],
    });
    const applied = await acceptProposal({
      fs: tracked,
      openNotes: closed,
      proposal: made,
    });
    await undoProposal({ fs: tracked, openNotes: closed, applied });
    expect(trashed).toEqual(['Idea.md']);
  });

  it('says why when the host will not trash a created note reached through a link (#685)', async () => {
    const { fs, markdown, fixture } = vault({});
    const refusal = deleteThroughLinkRefusal(createVaultPath('Shared'));
    const refusing = {
      ...fs,
      trashEntry: async () => {
        throw new VaultAccessError(refusal);
      },
    };
    const made = proposeNote({
      today: '2026-10-08',
      markdown,
      input: { title: 'Idea' },
      id: 'n1',
      notePaths: [],
    });
    const applied = await acceptProposal({ fs: refusing, openNotes: closed, proposal: made });

    await expect(undoProposal({ fs: refusing, openNotes: closed, applied })).rejects.toThrow(
      refusal,
    );
    expect(fixture.files.has('Idea.md')).toBe(true);
  });

  it.each([
    [{ title: '  ' }, /needs a "title"/],
    [{ title: 'x', folder: '.atlas/templates' }, /hidden configuration/],
    [{ title: 'x', body: 4 }, /"body" must be text/],
  ])('refuses %j', (input, reason) => {
    expect(() =>
      proposeNote({
        today: '2026-10-08',
        markdown: blockMarkdown(),
        input,
        id: 'n',
        notePaths: [],
      }),
    ).toThrow(reason);
  });

  it('holds a proposed task to the task rules: Waiting needs nobody (#202), Archive is dated (P30-02)', () => {
    const propose = (properties: Record<string, unknown>) =>
      proposeNote({
        today: '2026-10-08',
        markdown: blockMarkdown(),
        input: { title: 'Hear back', properties },
        id: 'n',
        notePaths: [],
      });
    expect(propose({ type: 'task', status: 'waiting' }).contents).toContain('status: waiting');
    expect(propose({ type: 'task', status: 'archive' }).contents).toContain(
      'completed: 2026-10-08',
    );
  });
});

describe('an edit proposal', () => {
  it('keeps the id it was given, for the panel to find it by', async () => {
    const { made } = await proposal({ path: 'Plan.md', append: 'x' });
    expect((made satisfies EditProposal).id).toBe('p1');
  });
});
