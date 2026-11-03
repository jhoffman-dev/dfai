import {
  VaultAccessError,
  type HostVaultFsPort,
  type VaultLocation,
  type VaultLocationStore,
  type VaultPickerPort,
} from '@dfai/application';
import type { GitHubApi } from './github-api.ts';
import { gitBranch, type GitHubVaultRepository } from './git-branch.ts';
import { gitHubVaultFs } from './github-vault-fs.ts';
import { findGitHubVault, gitHubVaultKey } from './github-vault-repository.ts';

/** Where the vault found at sign-in is remembered, so a reload with no network still opens it. */
export const REMEMBERED_VAULT_KEY = 'dfai.github-vault';

const locationOf = (where: GitHubVaultRepository): VaultLocation => ({
  absolutePath: gitHubVaultKey(where),
  name: where.repo,
});

function isRepository(value: unknown): value is GitHubVaultRepository {
  if (typeof value !== 'object' || value === null) return false;
  const { owner, repo, branch } = value as Record<string, unknown>;
  return typeof owner === 'string' && typeof repo === 'string' && typeof branch === 'string';
}

/** The repository found at sign-in, kept in `storage`; anything else there is no repository. */
export function rememberedGitHubVault(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
) {
  return {
    read(): GitHubVaultRepository | null {
      const held = storage.getItem(REMEMBERED_VAULT_KEY);
      if (held === null) return null;
      try {
        const parsed: unknown = JSON.parse(held);
        return isRepository(parsed) ? parsed : null;
      } catch {
        // Not JSON: not something this wrote, so there is no vault remembered.
        return null;
      }
    },
    write: (where: GitHubVaultRepository) =>
      storage.setItem(REMEMBERED_VAULT_KEY, JSON.stringify(where)),
    forget: () => storage.removeItem(REMEMBERED_VAULT_KEY),
  };
}

export type RememberedGitHubVault = ReturnType<typeof rememberedGitHubVault>;

const FS_CALLS = [
  'listDirectory',
  'listNotes',
  'listFiles',
  'readNotes',
  'readTextFile',
  'readBinaryFile',
  'createNote',
  'createFolder',
  'moveEntry',
  'trashEntry',
  'writeTextFile',
  'writeBinaryFile',
] as const satisfies readonly (keyof HostVaultFsPort)[];

/**
 * The web build's vault (#667): the one repository the DFAI App reaches
 * (ADR-0052), found once at sign-in and remembered, and read and written as
 * {@link gitHubVaultFs}. There is nothing to pick: the store answers the
 * remembered vault, or finds it the first time.
 */
export function gitHubVaultPorts({
  api,
  remembered,
}: {
  api: GitHubApi;
  remembered: RememberedGitHubVault;
}): { fs: HostVaultFsPort; picker: VaultPickerPort; store: VaultLocationStore } {
  const picker: VaultPickerPort = {
    pickDirectory: async () => {
      const where = await findGitHubVault(api);
      remembered.write(where);
      return locationOf(where);
    },
  };
  let open: { key: string; fs: HostVaultFsPort } | null = null;
  const fsNow = (): HostVaultFsPort => {
    const where = remembered.read();
    if (where === null) throw new VaultAccessError('no vault is open');
    const key = gitHubVaultKey(where);
    if (open?.key !== key)
      open = { key, fs: gitHubVaultFs({ branch: gitBranch(api, where), vault: key }) };
    return open.fs;
  };
  // Each call goes to the vault remembered at the time it is made.
  const fs = Object.fromEntries(
    FS_CALLS.map((call) => [
      call,
      (...args: unknown[]) =>
        Promise.resolve().then(() => (fsNow()[call] as (...given: unknown[]) => unknown)(...args)),
    ]),
  ) as unknown as HostVaultFsPort;
  return {
    fs,
    picker,
    store: {
      read: async () => {
        const where = remembered.read();
        return where === null ? picker.pickDirectory() : locationOf(where);
      },
      // The picker remembered the repository it found; the location is only its name.
      write: async () => {},
    },
  };
}
