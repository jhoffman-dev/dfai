/**
 * Second attack on PR #694 (a130f389). The undo of an accepted edit is now
 * held to the text as well as the time; accepting the edit in the first place
 * is still held to the time only (`proposal.baseModified`). On a disk that
 * keeps the time to the second, an edit landing in the same second after the
 * proposal was drafted leaves the time as the proposal recorded it, and
 * Accept writes the proposal's contents — computed from the older text — over
 * that edit. Same-second edits are written straight into the fixture's store,
 * keeping the recorded `modified`, as such a disk would.
 */
import { describe, expect, it, vi } from 'vitest';
import { createVaultPath } from '@dfai/domain';
import { apiFixture } from '../testing/api-fixture.ts';
import { blockMarkdown } from '../testing/block-markdown.ts';
import { acceptProposal, proposeEdit, undoProposal } from './proposals.ts';

const PLAN = '---\nstatus: open\n---\nIntro.\n';
const PLAN_PATH = createVaultPath('Plan.md');
const closed = { state: () => 'closed' as const, reload: vi.fn() };

function vaultWithPlan(text = PLAN) {
  const fixture = apiFixture({ files: { 'Plan.md': text }, markdown: blockMarkdown() });
  return { fixture, fs: fixture.fs, markdown: blockMarkdown() };
}

function editSameSecond(fixture: ReturnType<typeof apiFixture>, path: string, text: string) {
  const stored = fixture.files.get(path);
  if (stored === undefined) throw new Error(`no such note: ${path}`);
  fixture.files.set(path, { ...stored, text });
}

function draftAppend(at: ReturnType<typeof vaultWithPlan>) {
  return proposeEdit({
    today: '2026-10-08',
    fs: at.fs,
    markdown: at.markdown,
    input: { path: 'Plan.md', append: 'More.' },
    id: 'p1',
  });
}

describe('accepting an edit proposal (attack 2 on #694)', () => {
  it('never writes over an edit made in the same second after the proposal was drafted', async () => {
    const at = vaultWithPlan();
    const proposal = await draftAppend(at);
    editSameSecond(at.fixture, PLAN_PATH, `${PLAN}Typed in the same second.\n`);

    await acceptProposal({ fs: at.fs, openNotes: closed, proposal }).catch(() => undefined);

    // Observed: the note is the proposal's contents; the typed line is gone.
    expect(at.fixture.files.get(PLAN_PATH)?.text).toContain('Typed in the same second.');
  });

  it('refuses, writing nothing, when typing lands in the same second between the check and the write', async () => {
    const at = vaultWithPlan();
    const proposal = await draftAppend(at);
    const typed = `${PLAN}Typed in the same second.\n`;
    const typingFirst = {
      ...at.fs,
      writeTextFile: async (args: Parameters<typeof at.fs.writeTextFile>[0]) => {
        editSameSecond(at.fixture, PLAN_PATH, typed);
        return at.fs.writeTextFile(args);
      },
    };

    await expect(acceptProposal({ fs: typingFirst, openNotes: closed, proposal })).rejects.toThrow(
      'Plan changed since this was proposed; nothing was written.',
    );
    expect(at.fixture.files.get(PLAN_PATH)?.text).toBe(typed);
  });

  it('probe: an accepted edit on a CRLF + BOM note undoes byte for byte', async () => {
    const crlf = String.fromCharCode(0xfeff) + '---\r\nstatus: open\r\n---\r\nIntro.\r\n';
    const at = vaultWithPlan(crlf);
    const proposal = await draftAppend(at);
    const applied = await acceptProposal({ fs: at.fs, openNotes: closed, proposal });
    expect(applied.kind === 'edited' && applied.text).toBe(at.fixture.files.get(PLAN_PATH)?.text);

    await undoProposal({ fs: at.fs, openNotes: closed, applied });

    expect(at.fixture.files.get(PLAN_PATH)?.text).toBe(crlf);
  });

  it('probe: an applied record without `text` (shape before a130f389) is refused, never written through', async () => {
    const at = vaultWithPlan();
    const proposal = await draftAppend(at);
    const applied = await acceptProposal({ fs: at.fs, openNotes: closed, proposal });
    const after = at.fixture.files.get(PLAN_PATH)?.text;
    const older: Record<string, unknown> = { ...applied };
    delete older['text'];

    await expect(
      undoProposal({ fs: at.fs, openNotes: closed, applied: older as unknown as typeof applied }),
    ).rejects.toThrow(/changed since/);
    expect(at.fixture.files.get(PLAN_PATH)?.text).toBe(after);
  });
});
