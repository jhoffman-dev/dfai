import { vaultFsContract } from '@dfai/application/testing/vault-fs-contract';
import { SESSION_VAULT, sessionVaultFs } from './session-vault.ts';

// The host's contract, which the GitHub vault (#664) is to run too.
vaultFsContract('the web stub’s session vault', (seed) => ({
  fs: sessionVaultFs(seed),
  vault: SESSION_VAULT,
}));
