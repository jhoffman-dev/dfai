import { describe, expect, it } from 'vitest';
import { createVaultPath, WEB_DEVICE } from '@dfai/domain';
import { inVault, keepRefusedAsCopy, openNote, type OpenNote } from '@dfai/application';
import { remarkMarkdown as markdown } from '../markdown/markdown-port.ts';
import { FakeGitHub, type Received } from './fake-github.test-support.ts';
import { vaultOver } from './github-vault.test-support.ts';

/*
 * Second attack on PR #745 (#665, ADR-0054 decisions 6 and 8): the save made
 * again on a moved head, and the deleted note put back. Nothing another
 * device pushed may be written over, and an edit never loses to a delete.
 */
const NOTE = 'Projects/Plan.md';
const BASE = '# Plan\n\nFirst.\n';
const MINE = '# Plan\n\nMine.\n';

const isCall = (method: string, ending: string) => (request: Received) =>
  request.method === method && request.path.split('?')[0]!.endsWith(ending);

function seeded(files: Record<string, string>) {
  const github = new FakeGitHub({ files });
  const over = vaultOver(github);
  return { github, ...over, app: inVault({ fs: over.fs, vault: over.vault }) };
}
type Seeded = ReturnType<typeof seeded>;

/** Another device's push that changes only the note's mode: same bytes, same blob. */
async function pushModeOfNote(github: FakeGitHub, mode: string): Promise<void> {
  const from = await github.objects.head();
  const entries = new Map(await github.objects.tree((await github.objects.commit(from))!.tree));
  entries.set(NOTE, { ...entries.get(NOTE)!, mode });
  const tree = await github.objects.putTree(entries);
  const to = await github.objects.putCommit({ tree, parents: [from], message: 'Outside' });
  await github.objects.moveHead({ from, to });
}

/** Saves MINE over the note, with `outside` pushed between the save's read and its commit. */
async function saveWithPushBetween(s: Seeded, outside: () => Promise<unknown>) {
  const read = await s.fs.readTextFile(createVaultPath(NOTE));
  s.github.intercept(isCall('POST', '/git/commits'), async (request) => {
    await outside();
    return s.github.respond(request);
  });
  await s.fs.writeTextFile({
    vault: s.vault,
    path: createVaultPath(NOTE),
    contents: MINE,
    expectedModified: read.modified,
  });
}

async function modeOnBranch(github: FakeGitHub, path: string) {
  const commit = await github.objects.commit(await github.objects.head());
  return (await github.objects.tree(commit!.tree))!.get(path)?.mode;
}

async function keep(s: Seeded, note: OpenNote) {
  return keepRefusedAsCopy({
    fs: s.app,
    markdown,
    note,
    doc: markdown.parseBody(MINE).doc,
    device: WEB_DEVICE,
  });
}

async function textsOnBranch(github: FakeGitHub) {
  return Promise.all((await github.paths()).map((path) => github.textAt(path)));
}

describe('attack2 #745: the save made again on a moved head', () => {
  // Observed: the retry checks only the blob sha, then puts the save's file
  // back with the mode read before the other push: 100755 becomes 100644.
  it.fails('keeps a mode the other push gave the note (executable bit)', async () => {
    const s = seeded({ [NOTE]: BASE });
    await saveWithPushBetween(s, () => pushModeOfNote(s.github, '100755'));
    expect(await modeOnBranch(s.github, NOTE)).toBe('100755');
  });

  // Observed: the other device turned the note into a symlink whose target
  // bytes are the old text (same blob); the retry silently replaces the link
  // with a regular file of MINE instead of refusing.
  it.fails('never turns a symlink the other push made back into a file', async () => {
    const s = seeded({ [NOTE]: BASE });
    await saveWithPushBetween(s, () => pushModeOfNote(s.github, '120000'));
    expect(await modeOnBranch(s.github, NOTE)).toBe('120000');
  });
});

describe('attack2 #745: a deleted note put back', () => {
  // Observed: keep throws "a note with that name already exists" every time,
  // so the refused text can never reach the branch: the edit loses to the delete.
  it.fails('deleted, with a case twin now at its path: the edit is kept somewhere, the twin untouched', async () => {
    const s = seeded({ [NOTE]: BASE });
    const note = await openNote({ fs: s.app, markdown, path: createVaultPath(NOTE) });
    await s.github.commitOutside({ [NOTE]: null, 'Projects/plan.md': 'twin\n' });

    await keep(s, note);

    expect(await s.github.textAt('Projects/plan.md')).toBe('twin\n');
    expect(await textsOnBranch(s.github)).toContain(MINE);
  });

  // Observed: keep throws "that is a directory" from reading the note's path.
  it.fails('deleted, with a folder now at its path: the edit is kept somewhere, the folder untouched', async () => {
    const s = seeded({ [NOTE]: BASE });
    const note = await openNote({ fs: s.app, markdown, path: createVaultPath(NOTE) });
    await s.github.commitOutside({ [NOTE]: null, [`${NOTE}/Inner.md`]: 'inner\n' });

    await keep(s, note);

    expect(await s.github.textAt(`${NOTE}/Inner.md`)).toBe('inner\n');
    expect(await textsOnBranch(s.github)).toContain(MINE);
  });
});
