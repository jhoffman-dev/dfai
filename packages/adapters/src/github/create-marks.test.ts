import { createVaultPath as p } from '@dfai/domain';
import { VaultAccessError, VaultUnreachableError } from '@dfai/application';
import { describe, expect, it } from 'vitest';
import { FakeGitHub, type Received } from './fake-github.test-support.ts';
import { GITHUB_MALFORMED, GitHubRefusedError } from './github-api.ts';
import { CREATE_MARK_TRAILER } from './github-vault-fs.ts';
import { vaultOver } from './github-vault.test-support.ts';

/*
 * The marks queued creates carry on GitHub (#773, attack #778): a create's
 * commit carries its mark as a trailer, and the mark on the newest commit
 * to change a path is read back, so the web knows a create whose answer was
 * lost from another device's note of the same name and text.
 */

const isCommitsCall = (request: Received) =>
  request.method === 'GET' && request.path.split('?')[0]!.endsWith('/commits');

function seeded(files: Record<string, string> = { 'Welcome.md': 'hello' }) {
  const github = new FakeGitHub({ files });
  return { github, ...vaultOver(github) };
}

describe('GitHub vault: create marks', () => {
  it('commits a create’s mark as a trailer, and reads it back as the newest change at the path', async () => {
    const { github, fs, vault } = seeded();
    await fs.createNote({ vault, path: p('X.md'), contents: 'Buy milk', mark: 'mark-1' });
    expect((await github.history())[0]).toBe(`Create X.md\n\n${CREATE_MARK_TRAILER}: mark-1`);
    expect(await fs.markAt(p('X.md'))).toBe('mark-1');
  });

  it('asks for the newest commit to change the path on the vault’s branch only', async () => {
    const { github, fs, vault } = seeded({ 'Inbox/Welcome.md': 'hello' });
    await fs.createNote({ vault, path: p('Inbox/X y.md'), contents: 'A', mark: 'mark-1' });
    await expect(fs.markAt(p('Inbox/X y.md'))).resolves.toBe('mark-1');
    expect(github.sentCalls().filter((call) => call.startsWith('GET /commits'))).toEqual([
      'GET /commits?sha=main&path=Inbox%2FX%20y.md&per_page=1',
    ]);
  });

  it('reads no mark once another device changed the note, even back to the same text', async () => {
    const { github, fs, vault } = seeded();
    await fs.createNote({ vault, path: p('X.md'), contents: 'A', mark: 'mark-1' });
    await github.commitOutside({ 'X.md': 'B' });
    await github.commitOutside({ 'X.md': 'A' });
    expect(await github.textAt('X.md')).toBe('A');
    expect(await fs.markAt(p('X.md'))).toBeNull();
  });

  it('reads the create’s mark past commits to other notes', async () => {
    const { github, fs, vault } = seeded();
    await fs.createNote({ vault, path: p('X.md'), contents: 'A', mark: 'mark-1' });
    await github.commitOutside({ 'Other.md': 'elsewhere' });
    expect(await fs.markAt(p('X.md'))).toBe('mark-1');
  });

  it('reads no mark for a note made with none, nor for a path no commit changed', async () => {
    const { github, fs, vault } = seeded();
    await fs.createNote({ vault, path: p('X.md'), contents: 'A' });
    expect((await github.history())[0]).toBe('Create X.md');
    expect(await fs.markAt(p('X.md'))).toBeNull();
    expect(await fs.markAt(p('Welcome.md'))).toBeNull();
    expect(await fs.markAt(p('Never.md'))).toBeNull();
  });

  it('refuses a mark that could add a line to the message, committing nothing', async () => {
    const { github, fs, vault } = seeded();
    const head = await github.headSha();
    for (const mark of ['mark-1\nDFAI-Create: mark-2', 'a b', ''])
      await expect(fs.createNote({ vault, path: p('X.md'), contents: 'A', mark })).rejects.toThrow(
        VaultAccessError,
      );
    expect(await github.headSha()).toBe(head);
    expect(await github.paths()).toEqual(['Welcome.md']);
  });

  it('reads the mark a commit message carries as its last such trailer, ignoring one malformed', async () => {
    const { github, fs } = seeded();
    github.intercept(isCommitsCall, async () =>
      Response.json([
        {
          sha: 'a'.repeat(40),
          commit: { message: `Create X.md\n\n${CREATE_MARK_TRAILER}: bad mark` },
        },
      ]),
    );
    expect(await fs.markAt(p('X.md'))).toBeNull();
    github.intercept(isCommitsCall, async () =>
      Response.json([
        {
          sha: 'a'.repeat(40),
          commit: {
            message: `Merge\n\n${CREATE_MARK_TRAILER}: mark-1\n${CREATE_MARK_TRAILER}: mark-2`,
          },
        },
      ]),
    );
    expect(await fs.markAt(p('X.md'))).toBe('mark-2');
  });

  it('refuses a malformed commit listing rather than reading no mark from it', async () => {
    const { github, fs } = seeded();
    for (const answer of [{}, [{ sha: 'a'.repeat(40) }], [{ commit: { message: 7 } }]]) {
      github.intercept(isCommitsCall, async () => Response.json(answer));
      await expect(fs.markAt(p('X.md'))).rejects.toThrow(GITHUB_MALFORMED);
    }
  });

  it('passes on GitHub refusing or failing, and the network gone, never as no mark', async () => {
    const { github, fs } = seeded();
    github.intercept(isCommitsCall, async () =>
      Response.json({ message: 'Resource not accessible by integration' }, { status: 403 }),
    );
    const denied = await fs.markAt(p('X.md')).catch((error: unknown) => error);
    expect(denied).toBeInstanceOf(GitHubRefusedError);
    expect((denied as GitHubRefusedError).status).toBe(403);
    github.intercept(isCommitsCall, async () => Response.json({ message: 'bad' }, { status: 502 }));
    const failing = await fs.markAt(p('X.md')).catch((error: unknown) => error);
    expect((failing as GitHubRefusedError).status).toBe(502);
    github.intercept(isCommitsCall, async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(fs.markAt(p('X.md'))).rejects.toBeInstanceOf(VaultUnreachableError);
  });

  it('times out a commit listing that never answers as the network gone', async () => {
    const github = new FakeGitHub({ files: { 'Welcome.md': 'hello' } });
    const fire: (() => void)[] = [];
    const { fs } = vaultOver(github, {
      timeout: () => new Promise<void>((resolve) => fire.push(resolve)),
    });
    github.hang(isCommitsCall);
    const asked = fs.markAt(p('X.md'));
    await expect.poll(() => fire.length).toBeGreaterThan(0);
    fire.forEach((timeout) => timeout());
    await expect(asked).rejects.toBeInstanceOf(VaultUnreachableError);
  });

  it('refuses a path no vault path may be before asking GitHub', async () => {
    const { github, fs } = seeded();
    await expect(fs.markAt('.git/config' as never)).rejects.toThrow(VaultAccessError);
    expect(github.sentCalls().some((call) => call.startsWith('GET /commits'))).toBe(false);
  });
});
