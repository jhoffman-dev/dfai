import { describe, expect, it } from 'vitest';
import { FAKE_VAULT, FakeGitHub } from './fake-github.test-support.ts';
import { vaultOver } from './github-vault.test-support.ts';
import { findGitHubVault, gitHubVaultKey } from './github-vault-repository.ts';

/** ADR-0052: the vault is the one repository the App's installation reaches, or none is opened. */
describe('finding the vault on GitHub', () => {
  const other = { owner: 'mara-quill', repo: 'larkspur-payroll', branch: 'main' };

  it('is the one repository the installation reaches, on its default branch', async () => {
    const { api } = vaultOver(
      new FakeGitHub({ files: {}, reached: [{ ...FAKE_VAULT, branch: 'notes' }] }),
    );
    expect(await findGitHubVault(api)).toEqual({ ...FAKE_VAULT, branch: 'notes' });
    expect(gitHubVaultKey(FAKE_VAULT)).toBe('github:mara-quill/larkspur-vault#main');
  });

  it('is refused when the installation reaches more than the vault, or nothing', async () => {
    await expect(
      findGitHubVault(vaultOver(new FakeGitHub({ files: {}, reached: [FAKE_VAULT, other] })).api),
    ).rejects.toThrow('more than one repository');
    await expect(
      findGitHubVault(vaultOver(new FakeGitHub({ files: {}, reached: [] })).api),
    ).rejects.toThrow('no repository');
  });

  it('is refused when the App is installed nowhere, or more than once', async () => {
    for (const [installations, said] of [
      [[], 'not installed'],
      [[{ id: 7 }, { id: 8 }], 'more than once'],
    ] as const) {
      const github = new FakeGitHub({ files: {} });
      github.intercept(
        (request) => request.path === '/user/installations',
        () => new Response(JSON.stringify({ total_count: installations.length, installations })),
      );
      await expect(findGitHubVault(vaultOver(github).api)).rejects.toThrow(said);
    }
  });

  it('refuses an installation listing it cannot read', async () => {
    const github = new FakeGitHub({ files: {} });
    github.intercept(
      (request) => request.path.startsWith('/user/installations/7/'),
      () => new Response(JSON.stringify({ total_count: 1, repositories: [{ name: 'x' }] })),
    );
    await expect(findGitHubVault(vaultOver(github).api)).rejects.toThrow('cannot read');
  });
});
