/**
 * Attack on PR #694 (#693): undoing an accepted chat proposal, held to the
 * version it checked. The hold compares the text as well as the time, but the
 * check before it compares the time only — and on a disk that keeps the time
 * to the second (HFS+, exFAT, SMB; see the host's `BasedOn`) an edit in the
 * same second as the write leaves the time as the proposal recorded it.
 * Same-second edits are written straight into the fixture's store, keeping
 * the recorded `modified`, as such a disk would.
 */
import { describe, expect, it, vi } from 'vitest';
import { createVaultPath } from '@dfai/domain';
import { apiFixture } from '../testing/api-fixture.ts';
import { blockMarkdown } from '../testing/block-markdown.ts';
import { editedBeforeTrash } from '../testing/edited-before-trash.ts';
import { acceptProposal, proposeEdit, proposeNote, undoProposal } from './proposals.ts';

const PLAN = '---\nstatus: open\n---\nIntro.\n';
const IDEA = createVaultPath('Idea.md');
const PLAN_PATH = createVaultPath('Plan.md');
const closed = { state: () => 'closed' as const, reload: vi.fn() };

function trashingVault(files: Record<string, string> = {}) {
  const fixture = apiFixture({ files, markdown: blockMarkdown() });
  const fs = {
    ...fixture.fs,
    trashEntry: async ({ path }: { path: string }) => void fixture.files.delete(path),
  };
  return { fixture, fs, markdown: blockMarkdown() };
}

async function createdIdea() {
  const at = trashingVault();
  const made = proposeNote({
    today: '2026-10-08',
    markdown: at.markdown,
    input: { title: 'Idea' },
    id: 'n1',
    notePaths: [],
  });
  const applied = await acceptProposal({ fs: at.fs, openNotes: closed, proposal: made });
  return { ...at, applied };
}

/** Rewrites a note in the same second as its last write: the time stays as it was. */
function editSameSecond(fixture: ReturnType<typeof apiFixture>, path: string, text: string) {
  const stored = fixture.files.get(path);
  if (stored === undefined) throw new Error(`no such note: ${path}`);
  fixture.files.set(path, { ...stored, text });
}

describe('undoing a created note, an edit in the same second as its creation (attack #694)', () => {
  it('keeps a created note edited in the same second, rather than trashing the typing', async () => {
    const { fixture, fs, applied } = await createdIdea();
    editSameSecond(fixture, IDEA, 'Typed in the same second.\n');

    await undoProposal({ fs, openNotes: closed, applied }).catch(() => undefined);

    expect(fixture.files.get(IDEA)?.text).toBe('Typed in the same second.\n');
  });

  it('refuses to trash a created note only touched: a new time alone refuses it', async () => {
    // Conservative, not a loss: a touch keeps the text but moves the time, and the
    // undo refuses rather than trash. Pinned so a change to it is a decision.
    const { fixture, fs, applied } = await createdIdea();
    const stored = fixture.files.get(IDEA)!;
    fixture.files.set(IDEA, { ...stored, modified: stored.modified + 1 });

    await expect(undoProposal({ fs, openNotes: closed, applied })).rejects.toThrow(/changed since/);
    expect(fixture.files.has(IDEA)).toBe(true);
  });

  it('refuses again on a second try after an edit refused the first', async () => {
    const { fixture, fs, applied } = await createdIdea();
    const editing = editedBeforeTrash(fs, () =>
      fs.writeTextFile({ path: IDEA, contents: 'Typed meanwhile.\n', expectedModified: null }),
    );
    await expect(undoProposal({ fs: editing, openNotes: closed, applied })).rejects.toThrow(
      /changed since/,
    );

    await expect(undoProposal({ fs, openNotes: closed, applied })).rejects.toThrow(/changed since/);
    expect(fixture.files.get(IDEA)?.text).toBe('Typed meanwhile.\n');
  });

  it('keeps a created note edited and then edited back: its time moved on', async () => {
    const { fixture, fs, applied } = await createdIdea();
    const made = fixture.files.get(IDEA)!.text;
    await fs.writeTextFile({ path: IDEA, contents: 'Typed.\n', expectedModified: null });
    await fs.writeTextFile({ path: IDEA, contents: made, expectedModified: null });

    await expect(undoProposal({ fs, openNotes: closed, applied })).rejects.toThrow(/changed since/);
    expect(fixture.files.get(IDEA)?.text).toBe(made);
  });

  it('refuses, and trashes nothing, when the created note was renamed before the undo', async () => {
    const { fixture, fs, applied } = await createdIdea();
    await fs.moveEntry({ from: IDEA, to: createVaultPath('Renamed idea.md') });

    await expect(undoProposal({ fs, openNotes: closed, applied })).rejects.toThrow(/changed since/);
    expect(fixture.files.has('Renamed idea.md')).toBe(true);
  });
});

describe('undoing an edit, an edit in the same second as the accepted write (attack #694)', () => {
  it('keeps typing made in the same second as the accepted write, rather than writing over it', async () => {
    const at = trashingVault({ 'Plan.md': PLAN });
    const made = await proposeEdit({
      today: '2026-10-08',
      fs: at.fs,
      markdown: at.markdown,
      input: { path: 'Plan.md', append: 'More.' },
      id: 'p1',
    });
    const applied = await acceptProposal({ fs: at.fs, openNotes: closed, proposal: made });
    editSameSecond(at.fixture, PLAN_PATH, 'Typed in the same second.\n');

    await undoProposal({ fs: at.fs, openNotes: closed, applied }).catch(() => undefined);

    expect(at.fixture.files.get(PLAN_PATH)?.text).toBe('Typed in the same second.\n');
  });

  it('holds the putting-back write to the accepted text, for typing between the check and it', async () => {
    const at = trashingVault({ 'Plan.md': PLAN });
    const made = await proposeEdit({
      today: '2026-10-08',
      fs: at.fs,
      markdown: at.markdown,
      input: { path: 'Plan.md', append: 'More.' },
      id: 'p1',
    });
    const applied = await acceptProposal({ fs: at.fs, openNotes: closed, proposal: made });
    const typingFirst = {
      ...at.fs,
      writeTextFile: async (args: Parameters<typeof at.fs.writeTextFile>[0]) => {
        editSameSecond(at.fixture, PLAN_PATH, 'Typed in the same second.\n');
        return at.fs.writeTextFile(args);
      },
    };

    await expect(undoProposal({ fs: typingFirst, openNotes: closed, applied })).rejects.toThrow(
      /changed since this was proposed/,
    );
    expect(at.fixture.files.get(PLAN_PATH)?.text).toBe('Typed in the same second.\n');
  });
});
