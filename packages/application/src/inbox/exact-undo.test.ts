/**
 * #911 review, item 2: an exact undo puts back the other notes a filing
 * rewrote, then the item's text where it is, then moves it back — each write
 * held to the text it replaces. Refused at the first write, nothing is
 * touched; stopped later, it says what is done and what is left, and undoing
 * again finishes it. Over the in-memory vault with a real SQL index. All
 * names are made up.
 */
import { describe, expect, it } from 'vitest';
import { createVaultPath } from '@dfai/domain';
import { automationVault } from '../testing/automation-vault.ts';
import { clarifyInboxItem, ClarifyRefusedError } from './clarify-inbox-item.ts';
import { PartlyUndoneError, undoExactly } from './exact-undo.ts';

const json = (frontmatter: object, body = '') =>
  `---\n${JSON.stringify(frontmatter)}\n---\n${body}`;
const ITEM = 'Inbox/Renew X.md';
const NOTES = {
  'Projects/P.md': json({ type: 'project', para: 'project' }),
  [ITEM]: 'Renew it.\n',
  'Notes/Week.md': 'See [[Inbox/Renew X|the renewal]].\n',
  'Notes/Month.md': 'Also [[Inbox/Renew X]].\n',
};

async function filed() {
  const vault = automationVault({ today: '2026-11-17', notes: NOTES });
  const notePaths = () => [...vault.files.keys()].map(createVaultPath);
  const outcome = await clarifyInboxItem({
    ports: vault.ports,
    path: createVaultPath(ITEM),
    clarification: { project: createVaultPath('Projects/P.md') },
    notePaths: notePaths(),
    today: '2026-11-17',
    expectedText: NOTES[ITEM],
  });
  expect(outcome.undo.relinked?.map((note) => note.path)).toEqual([
    'Notes/Month.md',
    'Notes/Week.md',
  ]);
  const write = vault.ports.fs.writeTextFile;
  const move = vault.ports.fs.moveEntry;
  let refuse: string | null = null;
  let refuseMove = false;
  vault.ports.fs.writeTextFile = async (each) => {
    if (each.path === refuse) throw new Error('the disk refused it');
    return write(each);
  };
  vault.ports.fs.moveEntry = async (each) => {
    if (refuseMove) throw new Error('the disk refused the move');
    return move(each);
  };
  const undo = () =>
    undoExactly({ ports: vault.ports, undo: outcome.undo, notePaths: notePaths() });
  return {
    vault,
    outcome,
    undo,
    refuseWriteOf: (path: string | null) => void (refuse = path),
    refuseMoves: (on: boolean) => void (refuseMove = on),
  };
}

const asBefore = (files: ReadonlyMap<string, string>) =>
  expect(new Map(files)).toEqual(new Map(Object.entries(NOTES)));

describe('undoExactly', () => {
  it('puts every note back, then the item, byte for byte', async () => {
    const v = await filed();
    expect(await v.undo()).toEqual({ keptEdit: false });
    asBefore(v.vault.files);
  });

  it('refuses, touching nothing, when its first write is refused', async () => {
    const v = await filed();
    const after = new Map(v.vault.files);
    v.refuseWriteOf('Notes/Month.md');
    const undoing = v.undo();
    await expect(undoing).rejects.toBeInstanceOf(ClarifyRefusedError);
    await expect(undoing).rejects.not.toBeInstanceOf(PartlyUndoneError);
    expect(new Map(v.vault.files)).toEqual(after);
  });

  it('says what is left when a later note is refused, and undoing again finishes', async () => {
    const v = await filed();
    v.refuseWriteOf('Notes/Week.md');
    const undoing = v.undo();
    await expect(undoing).rejects.toThrow(
      new PartlyUndoneError({
        done: ['Month is as it was.'],
        left: [`Week still links to ${v.outcome.undo.to}.`],
        itemAt: v.outcome.undo.to,
      }),
    );
    expect(v.vault.files.get('Notes/Month.md')).toBe(NOTES['Notes/Month.md']);
    v.refuseWriteOf(null);
    await v.undo();
    asBefore(v.vault.files);
  });

  it('says what is left when the item’s own text is refused, and undoing again finishes', async () => {
    const v = await filed();
    v.refuseWriteOf(v.outcome.undo.to);
    await expect(v.undo()).rejects.toThrow(
      /^Partly undone: Renew X still says what the row wrote\./u,
    );
    v.refuseWriteOf(null);
    await v.undo();
    asBefore(v.vault.files);
  });

  it('says where the item still is when the move back is refused, and undoing again finishes', async () => {
    const v = await filed();
    v.refuseMoves(true);
    const undoing = v.undo();
    await expect(undoing).rejects.toThrow(
      `Partly undone: Renew X is still at ${v.outcome.undo.to}. Undo again to finish.`,
    );
    expect(v.vault.files.get(v.outcome.undo.to)).toBe(NOTES[ITEM]);
    v.refuseMoves(false);
    await v.undo();
    asBefore(v.vault.files);
  });

  it('refuses, touching nothing, once a rewritten note was edited, and once the item was', async () => {
    const v = await filed();
    v.vault.files.set('Notes/Week.md', 'Mine now.\n');
    const after = new Map(v.vault.files);
    await expect(v.undo()).rejects.toThrow('Week was changed since, so nothing was undone.');
    v.vault.files.set(v.outcome.undo.to, 'Edited.\n');
    await expect(v.undo()).rejects.toThrow('It was changed since, so it was left as it is.');
    expect(new Map(v.vault.files)).toEqual(new Map([...after, [v.outcome.undo.to, 'Edited.\n']]));
  });

  it('moves an edited item back as it is, its edit kept, when asked to keep it', async () => {
    const v = await filed();
    v.vault.files.set(v.outcome.undo.to, 'Edited.\n');
    const kept = await undoExactly({
      ports: v.vault.ports,
      undo: v.outcome.undo,
      notePaths: [...v.vault.files.keys()].map(createVaultPath),
      keepItemEdit: true,
    });
    expect(kept).toEqual({ keptEdit: true });
    expect(v.vault.files.get(ITEM)).toBe('Edited.\n');
    expect(v.vault.files.get('Notes/Week.md')).toBe(NOTES['Notes/Week.md']);
  });
});
