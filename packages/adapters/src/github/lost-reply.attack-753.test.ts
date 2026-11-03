import { VaultUnreachableError } from '@dfai/application';
import { createVaultPath as p } from '@dfai/domain';
import { describe, expect, it } from 'vitest';
import { FakeGitHub, type Received } from './fake-github.test-support.ts';
import { vaultOver } from './github-vault.test-support.ts';

/*
 * Review of PR #753: a save whose commit landed but whose answer was lost
 * (the connection dropped after the ref moved) is sent again by the queue,
 * held to the version it started from. It is already there, so it lands:
 * no conflict, and no copy of the note made of itself.
 */
const isRefUpdate = (request: Received) =>
  request.method === 'PATCH' && request.path.includes('/git/refs/');

describe('a save sent again after its answer was lost', () => {
  it('lands as the version already there, making no second commit', async () => {
    const github = new FakeGitHub({ files: { 'Plan.md': '# Plan\n' } });
    const { fs, vault } = vaultOver(github);
    const read = await fs.readTextFile(p('Plan.md'));
    github.intercept(isRefUpdate, async (request) => {
      await github.respond(request);
      throw new TypeError('Load failed');
    });
    const asked = {
      vault,
      path: p('Plan.md'),
      contents: '# Plan\n\nSaved offline.\n',
      expectedModified: read.modified,
      expectedText: read.text,
    };
    await expect(fs.writeTextFile(asked)).rejects.toBeInstanceOf(VaultUnreachableError);
    expect(await github.textAt('Plan.md')).toBe(asked.contents);
    const commits = (await github.commits()).length;

    const again = await fs.writeTextFile(asked);
    expect(again).toBe((await fs.readTextFile(p('Plan.md'))).modified);
    expect((await github.commits()).length).toBe(commits);
  });

  it('still refuses a save of other text over a note that moved', async () => {
    const github = new FakeGitHub({ files: { 'Plan.md': '# Plan\n' } });
    const { fs, vault } = vaultOver(github);
    const read = await fs.readTextFile(p('Plan.md'));
    await github.commitOutside({ 'Plan.md': '# Plan\n\nThe Mac’s.\n' });
    const saving = fs.writeTextFile({
      vault,
      path: p('Plan.md'),
      contents: '# Plan\n\nMine.\n',
      expectedModified: read.modified,
    });
    await expect(saving).rejects.toThrow('the note changed on disk since it was opened');
  });
});
