import {
  VaultAccessError,
  VaultUnreachableError,
  type HostVaultFsPort,
  type VaultLocation,
  type VaultLocationStore,
  type VaultPickerPort,
} from '@dfai/application';
import type { GitHubApi } from './github-api.ts';
import { gitBranch, type GitHubVaultRepository } from './git-branch.ts';
import { gitHubVaultFs } from './github-vault-fs.ts';
import { findGitHubVault, gitHubLogin, gitHubVaultKey } from './github-vault-repository.ts';

/** Where the vault found at sign-in is remembered, so a reload with no network still opens it. */
export const REMEMBERED_VAULT_KEY = 'dfai.github-vault';

/** The vault found at sign-in, and the login it was found for: whose this device's data is. */
export type RememberedVault = GitHubVaultRepository & { readonly login: string };

const locationOf = (where: GitHubVaultRepository): VaultLocation => ({
  absolutePath: gitHubVaultKey(where),
  name: where.repo,
});

function isRemembered(value: unknown): value is RememberedVault {
  if (typeof value !== 'object' || value === null) return false;
  const { owner, repo, branch, login } = value as Record<string, unknown>;
  return [owner, repo, branch, login].every((part) => typeof part === 'string');
}

/** The repository found at sign-in, kept in `storage`; anything else there is no repository. */
export function rememberedGitHubVault(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
) {
  return {
    read(): RememberedVault | null {
      const held = storage.getItem(REMEMBERED_VAULT_KEY);
      if (held === null) return null;
      try {
        const parsed: unknown = JSON.parse(held);
        return isRemembered(parsed) ? parsed : null;
      } catch {
        // Not JSON: not something this wrote, so there is no vault remembered.
        return null;
      }
    },
    write: (where: RememberedVault) => storage.setItem(REMEMBERED_VAULT_KEY, JSON.stringify(where)),
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
 * (ADR-0052), found once at sign-in and remembered with the login it was
 * found for, and read and written as {@link gitHubVaultFs}. There is nothing
 * to pick: the store answers the remembered vault, or finds it the first
 * time. Each time it is asked, it checks who is signed in first: another
 * login than the remembered one is handed to `beforeOpen`, which lets the
 * previous account go (or refuses, and nothing opens). With no network,
 * the remembered vault opens as it is.
 */
export function gitHubVaultPorts({
  api,
  remembered,
  beforeOpen,
}: {
  api: GitHubApi;
  remembered: RememberedGitHubVault;
  /** Called before another login opens anything, with the account the device's data is for. */
  beforeOpen: (previous: RememberedVault, login: string) => Promise<void>;
}): {
  fs: HostVaultFsPort;
  picker: VaultPickerPort;
  store: VaultLocationStore;
  /** Settles once the store has first said which vault is open, after the account check. */
  opened: Promise<void>;
  /** The login GitHub said is signed in, once the account check let it open; null until then. */
  signedIn: () => string | null;
} {
  const found = async (login: string) => {
    const where = await findGitHubVault(api);
    remembered.write({ ...where, login });
    return locationOf(where);
  };
  const picker: VaultPickerPort = { pickDirectory: async () => found(await gitHubLogin(api)) };
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
  let settleOpened: () => void = () => {};
  const opened = new Promise<void>((resolve) => (settleOpened = resolve));
  let confirmed: string | null = null;
  const read = async (): Promise<VaultLocation | null> => {
    const kept = remembered.read();
    const login = await signedInAs(api, kept);
    if (login === null) return kept === null ? null : locationOf(kept);
    if (kept !== null && kept.login !== login) await beforeOpen(kept, login);
    const still = remembered.read();
    const location =
      still !== null && still.login === login ? locationOf(still) : await found(login);
    confirmed = login;
    return location;
  };
  return {
    fs,
    picker,
    opened,
    signedIn: () => confirmed,
    store: {
      read: () => read().finally(settleOpened),
      // The picker remembered the repository it found; the location is only its name.
      write: async () => {},
    },
  };
}

/** Who is signed in, or null when that cannot be asked with no network and a vault is kept to open. */
async function signedInAs(api: GitHubApi, kept: RememberedVault | null): Promise<string | null> {
  try {
    return await gitHubLogin(api);
  } catch (error) {
    if (error instanceof VaultUnreachableError && kept !== null) return null;
    throw error;
  }
}
