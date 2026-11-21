/**
 * #911 review: an exact undo puts back the other notes a filing rewrote, then
 * the item's text where it is, then moves it back — each write through the
 * one guarded path, held to the text it replaces. Refused at the first write,
 * nothing is touched; stopped later, it says what is done and what is left,
 * and undoing again finishes it — a note it already put back is never
 * touched again, whatever it says since. Over the in-memory vault with a
 * real SQL index. All names are made up.
 */
import { describe, expect, it } from 'vitest';
import { createVaultPath, type AssistIntent, type VaultPath } from '@dfai/domain';
import { automationVault } from '../testing/automation-vault.ts';
import { assistVault, guardedWrites } from './assist-guard.ts';
import { clarifyInboxItem } from './clarify-inbox-item.ts';
import {
  PartlyUndoneError,
  undoExactly,
  UndoRefusedError,
  type AssistItemUndo,
} from './exact-undo.ts';

const json = (frontmatter: object, body = '') =>
  `---\n${JSON.stringify(frontmatter)}\n---\n${body}`;
const ITEM = 'Inbox/Renew X.md';
const NOTES = {
  'Projects/P.md': json({ type: 'project', para: 'project' }),
  [ITEM]: 'Renew it.\n',
  'Notes/Week.md': 'See [[Inbox/Renew X|the renewal]].\n',
  'Notes/Month.md': 'Also [[Inbox/Renew X]].\n',
};

/** Files the item through the guard, as a row does, and hands back its exact undo and the vault. */
async function filed() {
  const vault = automationVault({ today: '2026-11-17', notes: NOTES });
  const notePaths = () => [...vault.files.keys()].map(createVaultPath);
  const marks: AssistIntent[] = [];
  const mark = async (about: AssistIntent) => void marks.push(about);
  const items = new Set<VaultPath>([createVaultPath(ITEM)]);
  const guard = guardedWrites(vault.ports, {
    known: new Map([[createVaultPath(ITEM), NOTES[ITEM]]]),
    items,
    mark,
  });
  const outcome = await clarifyInboxItem({
    ports: guard.ports,
    path: createVaultPath(ITEM),
    clarification: { project: createVaultPath('Projects/P.md') },
    notePaths: notePaths(),
    today: '2026-11-17',
  });
  const to = outcome.path;
  const undo: AssistItemUndo = {
    from: createVaultPath(ITEM),
    to,
    before: NOTES[ITEM],
    after: guard.knows(to)!,
    relinked: guard.rewrites().filter((note) => !items.has(note.path)),
  };
  expect(undo.relinked.map((note) => note.path)).toEqual(['Notes/Month.md', 'Notes/Week.md']);
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
  const run = (
    extra: { restored?: readonly VaultPath[]; itemRestored?: boolean; keepItemEdit?: boolean } = {},
  ) => undoExactly({ vault: assistVault(vault.ports), undo, notePaths: notePaths(), mark, ...extra });
  return {
    vault,
    undo,
    marks,
    run,
    refuseWriteOf: (path: string | null) => void (refuse = path),
    refuseMoves: (on: boolean) => void (refuseMove = on),
  };
}

const asBefore = (files: ReadonlyMap<string, string>) =>
  expect(new Map(files)).toEqual(new Map(Object.entries(NOTES)));

/** The progress a stopped undo carried, to hand to the next try. */
async function stopped(undoing: Promise<unknown>) {
  const error = await undoing.then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(PartlyUndoneError);
  return (error as PartlyUndoneError).progress;
}

describe('undoExactly', () => {
  it('puts every note back, then the item, byte for byte, each write logged before it is made', async () => {
    const v = await filed();
    v.marks.length = 0;
    expect(await v.run()).toEqual({ keptEdit: false, kept: [] });
    asBefore(v.vault.files);
    expect(v.marks.map((about) => about.doing)).toEqual(['relink', 'relink', 'write', 'move']);
  });

  it('refuses, touching nothing, when its first write is refused', async () => {
    const v = await filed();
    const after = new Map(v.vault.files);
    v.refuseWriteOf('Notes/Month.md');
    const undoing = v.run();
    await expect(undoing).rejects.toBeInstanceOf(UndoRefusedError);
    expect(new Map(v.vault.files)).toEqual(after);
  });

  it('says what is left when a later note is refused, and undoing again finishes', async () => {
    const v = await filed();
    v.refuseWriteOf('Notes/Week.md');
    const progress = await stopped(v.run());
    expect(progress).toEqual({
      done: ['Month is as it was.'],
      left: [`Week still links to ${v.undo.to}.`],
      itemAt: v.undo.to,
      restored: ['Notes/Month.md'],
      itemRestored: false,
    });
    v.refuseWriteOf(null);
    await v.run(progress);
    asBefore(v.vault.files);
  });

  it('finishes after a note it already put back was edited, leaving that edit as it is', async () => {
    const v = await filed();
    v.refuseWriteOf('Notes/Week.md');
    const progress = await stopped(v.run());
    v.vault.files.set('Notes/Month.md', 'Mine now.\n');
    v.refuseWriteOf(null);
    await v.run(progress);
    expect(v.vault.files.get('Notes/Month.md')).toBe('Mine now.\n');
    expect(v.vault.files.get('Notes/Week.md')).toBe(NOTES['Notes/Week.md']);
    expect(v.vault.files.get(ITEM)).toBe(NOTES[ITEM]);
  });

  it('says what is left when the item’s own text is refused, and undoing again finishes', async () => {
    const v = await filed();
    v.refuseWriteOf(v.undo.to);
    const progress = await stopped(v.run());
    v.refuseWriteOf(null);
    await v.run(progress);
    asBefore(v.vault.files);
  });

  it('says where the item still is when the move back is refused, and undoing again finishes', async () => {
    const v = await filed();
    v.refuseMoves(true);
    const progress = await stopped(v.run());
    expect(progress.left).toEqual([`Renew X is still at ${v.undo.to}.`]);
    expect(v.vault.files.get(v.undo.to)).toBe(NOTES[ITEM]);
    v.refuseMoves(false);
    await v.run(progress);
    asBefore(v.vault.files);
  });

  it('refuses, touching nothing, once a rewritten note was edited, and once the item was', async () => {
    const v = await filed();
    v.vault.files.set('Notes/Week.md', 'Mine now.\n');
    const after = new Map(v.vault.files);
    await expect(v.run()).rejects.toThrow('Week was changed since, so nothing was undone.');
    v.vault.files.set(v.undo.to, 'Edited.\n');
    await expect(v.run()).rejects.toThrow('It was changed since, so it was left as it is.');
    expect(new Map(v.vault.files)).toEqual(new Map([...after, [v.undo.to, 'Edited.\n']]));
  });

  it('moves an edited item back as it is, its edit kept, when asked to keep it', async () => {
    const v = await filed();
    v.vault.files.set(v.undo.to, 'Edited.\n');
    expect(await v.run({ keepItemEdit: true })).toEqual({ keptEdit: true, kept: [] });
    expect(v.vault.files.get(ITEM)).toBe('Edited.\n');
    expect(v.vault.files.get('Notes/Week.md')).toBe(NOTES['Notes/Week.md']);
  });
});
