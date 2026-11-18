/**
 * #911 review, item 1: filing a note out of the Inbox rewrites other notes'
 * links to it, and the Inbox's undo moved it back rewriting links again —
 * which is not the same as putting those notes back. A bare `[[Renew X]]`
 * whose title a task shares came back as `[[Inbox/Renew X]]`. Clarifying now
 * records each other note it rewrote, with its text before and after; an
 * undo asked to be exact puts exactly those back and rewrites nothing else.
 *
 * Also item 3: a clarification given the text it was checked against refuses,
 * before writing anything, when the note says anything else.
 *
 * Over the in-memory vault with a real SQL index. All names are made up.
 */
import { describe, expect, it } from 'vitest';
import { createVaultPath, type Clarification } from '@dfai/domain';
import { automationVault } from '../testing/automation-vault.ts';
import {
  clarifyInboxItem,
  ClarifyRefusedError,
  undoClarifyInboxItem,
} from './clarify-inbox-item.ts';

const json = (frontmatter: object, body = '') =>
  `---\n${JSON.stringify(frontmatter)}\n---\n${body}`;
const ITEM = 'Inbox/Renew X.md';
const WEEK = 'Notes/Week.md';
const PROJECT = createVaultPath('Projects/P.md');
const NOTES = {
  'Projects/P.md': json({ type: 'project', para: 'project' }),
  'Tasks/Renew X.md': json({ type: 'task', status: 'next-action' }),
  [ITEM]: 'Renew it.\n',
  [WEEK]: 'See [[Renew X]], and [[Inbox/Renew X|the renewal]].\n',
};

function setUp() {
  const vault = automationVault({ today: '2026-11-17', notes: NOTES });
  const notePaths = () => [...vault.files.keys()].map(createVaultPath);
  const file = (clarification: Clarification = { project: PROJECT }, expectedText?: string) =>
    clarifyInboxItem({
      ports: vault.ports,
      path: createVaultPath(ITEM),
      clarification,
      notePaths: notePaths(),
      today: '2026-11-17',
      ...(expectedText !== undefined && { expectedText }),
    });
  return { vault, notePaths, file };
}

describe('clarifyInboxItem: the other notes a filing rewrites', () => {
  it('records each, with its text before and after', async () => {
    const { vault, file } = setUp();
    const outcome = await file();
    expect(outcome.undo.relinked).toEqual([
      { path: WEEK, before: NOTES[WEEK], after: vault.files.get(WEEK) },
    ]);
    expect(vault.files.get(WEEK)).not.toBe(NOTES[WEEK]);
  });

  it('an exact undo puts every note back byte for byte, the bare link to a shared title included', async () => {
    const { vault, file, notePaths } = setUp();
    const outcome = await file();
    await undoClarifyInboxItem({
      ports: vault.ports,
      undo: outcome.undo,
      notePaths: notePaths(),
      exact: true,
    });
    expect(new Map(vault.files)).toEqual(new Map(Object.entries(NOTES)));
  });

  it('an exact undo refuses, naming the note, and changes nothing, once a rewritten note was edited', async () => {
    const { vault, file, notePaths } = setUp();
    const outcome = await file();
    vault.files.set(WEEK, `${vault.files.get(WEEK)!}Mine.\n`);
    const after = new Map(vault.files);
    const undoing = undoClarifyInboxItem({
      ports: vault.ports,
      undo: outcome.undo,
      notePaths: notePaths(),
      exact: true,
    });
    await expect(undoing).rejects.toThrow(
      new ClarifyRefusedError('Week was changed since, so nothing was undone.'),
    );
    expect(new Map(vault.files)).toEqual(after);
  });
});

describe('clarifyInboxItem: held to the text it was checked against', () => {
  it('refuses before writing anything when the note says anything else', async () => {
    const { vault, file } = setUp();
    vault.files.set(ITEM, json({ due: '2026-12-01' }, 'Renew it.\n'));
    const before = new Map(vault.files);
    await expect(file({ asTask: true, project: PROJECT }, NOTES[ITEM])).rejects.toThrow(
      new ClarifyRefusedError('It changed since it was checked, so nothing was written.'),
    );
    expect(new Map(vault.files)).toEqual(before);
    expect(vault.log).toEqual([]);
  });

  it('clarifies as before when the note says exactly that', async () => {
    const plain = setUp();
    const held = setUp();
    const without = await plain.file({ asTask: true, project: PROJECT });
    const withText = await held.file({ asTask: true, project: PROJECT }, NOTES[ITEM]);
    expect(withText).toEqual(without);
    expect(new Map(held.vault.files)).toEqual(new Map(plain.vault.files));
  });
});
