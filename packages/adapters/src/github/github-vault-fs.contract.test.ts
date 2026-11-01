import { vaultFsContract } from '@dfai/application/testing/vault-fs-contract';
import { FakeGitHub } from './fake-github.test-support.ts';
import { vaultOver } from './github-vault.test-support.ts';

// The host's 20 cases (#689), against the GitHub API's stand-in (#664).
vaultFsContract('the GitHub vault', (seed) => {
  const { fs, vault } = vaultOver(new FakeGitHub({ files: seed }));
  return { fs, vault };
});
