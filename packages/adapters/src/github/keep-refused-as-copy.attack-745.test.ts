import { describe, expect, it } from 'vitest';
import { createVaultPath, WEB_DEVICE } from '@dfai/domain';
import {
  inVault,
  isStaleWriteRefusal,
  keepRefusedAsCopy,
  openNote,
  saveNote,
  type OpenNote,
} from '@dfai/application';
import { remarkMarkdown as markdown } from '../markdown/markdown-port.ts';
import { FakeGitHub } from './fake-github.test-support.ts';
import { vaultOver } from './github-vault.test-support.ts';

/*
 * Attack on PR #745 (#665): keepRefusedAsCopy against the GitHub stand-in.
 * Every typed version must end up on the branch, or the call must fail
 * without writing anything.
 */
const NOTE = 'Projects/Plan.md';
const BASE = '# Plan\n\nFirst.\n';
const MINE = '# Plan\n\nMine.\n';

function seeded(files: Record<string, string>) {
  const github = new FakeGitHub({ files });
  const { fs: host, vault } = vaultOver(github);
  return { github, fs: inVault({ fs: host, vault }) };
}

async function keep(fs: ReturnType<typeof seeded>['fs'], note: OpenNote, body: string) {
  return keepRefusedAsCopy({
    fs,
    markdown,
    note,
    doc: markdown.parseBody(body).doc,
    device: WEB_DEVICE,
  });
}

describe('attack #745: keepRefusedAsCopy over the GitHub API', () => {
  it('the newer version deleted on the remote: mine is still kept on the branch', async () => {
    const { github, fs } = seeded({ [NOTE]: BASE, 'Projects/Other.md': 'other\n' });
    const note = await openNote({ fs, markdown, path: createVaultPath(NOTE) });
    await github.commitOutside({ [NOTE]: null });

    // Observed: throws "no such entry" from readTextFile, although
    // copyOfRefusedWrite documents `newer: null` "when it is gone".
    await keep(fs, note, MINE);

    const texts = await Promise.all((await github.paths()).map((p) => github.textAt(p)));
    expect(texts).toContain(MINE);
  });

  it('newer equal to mine: no copy, and the note on the branch holds my text', async () => {
    const { github, fs } = seeded({ [NOTE]: BASE });
    const note = await openNote({ fs, markdown, path: createVaultPath(NOTE) });
    await github.commitOutside({ [NOTE]: MINE });

    expect(await keep(fs, note, MINE)).toBeNull();
    expect(await github.textAt(NOTE)).toBe(MINE);
  });

  it('a Unicode-decomposed twin of the copy’s name is not landed on', async () => {
    const cafe = 'Projects/Café.md';
    const twin = 'Projects/Café (conflict from DFAI web).md';
    const { github, fs } = seeded({ [cafe]: BASE, [twin]: 'twin\n' });
    const note = await openNote({ fs, markdown, path: createVaultPath(cafe) });
    await github.commitOutside({ [cafe]: '# Plan\n\nTheirs.\n' });

    const copy = await keep(fs, note, MINE);

    expect(copy).toBe('Projects/Café (conflict from DFAI web) 2.md');
    expect(await github.textAt(twin)).toBe('twin\n');
    expect(await github.textAt(copy!)).toBe(MINE);
  });

  it('the head moves under the copy’s commit: a stale refusal, nothing written', async () => {
    const { github, fs } = seeded({ [NOTE]: BASE, 'Projects/Other.md': 'other\n' });
    const note = await openNote({ fs, markdown, path: createVaultPath(NOTE) });
    await github.commitOutside({ [NOTE]: '# Plan\n\nTheirs.\n' });
    await expect(
      saveNote({ fs, markdown, note, doc: markdown.parseBody(MINE).doc }),
    ).rejects.toSatisfy(isStaleWriteRefusal);
    github.intercept(
      (request) => request.method === 'PATCH' && request.path.includes('/git/refs/'),
      async (request) => {
        await github.commitOutside({ 'Projects/Other.md': 'other, moved on\n' });
        return github.respond(request);
      },
    );
    const before = await github.paths();

    await expect(keep(fs, note, MINE)).rejects.toSatisfy(isStaleWriteRefusal);

    expect(await github.paths()).toEqual(before);
    expect(await github.textAt(NOTE)).toBe('# Plan\n\nTheirs.\n');
    // And a second try, as the pane offers, lands it.
    const copy = await keep(fs, note, MINE);
    expect(await github.textAt(copy!)).toBe(MINE);
  });
});
