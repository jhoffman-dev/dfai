import { useCallback, useEffect, useState } from 'react';
import type { GitHubRepository, SyncPhase, VaultPath } from '@dfai/domain';
import {
  inspectSync,
  listGitHubRepositories,
  readVaultSettings,
  setUpSync,
  type ActivityRecorder,
  type Clock,
  type GitFoldersPort,
  type GitHubPort,
  type GitPort,
  type MarkdownPort,
  type SyncFilesPort,
  type SyncRemoteChoice,
  type SyncSetup,
  type VaultFsPort,
} from '@dfai/application';
import { errorMessage } from '../query/error-message.ts';
import { vaultSettingsWriter } from '../settings/vault-settings-writer.ts';
import type { PullRecorder } from './use-pulled-files.ts';
import { phaseOf, type Exclusive, type ThisMac } from './use-sync-runs.ts';

export interface SetUpContext {
  readonly git: GitPort | null;
  readonly files: SyncFilesPort | null;
  readonly thisMac: ThisMac | null;
  readonly vaultKey: string | null;
  readonly folders: GitFoldersPort;
  readonly fs: VaultFsPort;
  readonly markdown: MarkdownPort;
  readonly clock: Pick<Clock, 'now' | 'localNow'>;
  readonly activity: { inVault(vault: string): ActivityRecorder };
  readonly flushAll: () => Promise<void>;
  readonly setSetup: (setup: SyncSetup | null) => void;
  readonly setPhase: (phase: SyncPhase) => void;
  readonly exclusive: Exclusive;
  /** Told how the vault stands once set up: one that now syncs waits for its first sync or look. */
  readonly pulls: Pick<PullRecorder, 'inspected'>;
}

/**
 * Setting up sync from Settings, and why it last failed. It waits for any
 * sync under way and runs as the one git run of the vault, so a vault switch
 * waits for it too (A29-01).
 */
export function useSetUp(context: SetUpContext) {
  const { git, files, thisMac, vaultKey, folders, fs, markdown, clock, activity } = context;
  const { flushAll, setSetup, setPhase, exclusive, pulls } = context;
  const [problem, setProblem] = useState<string | null>(null);
  // Why the last vault could not be set up says nothing about the next one.
  useEffect(() => setProblem(null), [vaultKey]);
  const setUp = useCallback(
    (remote: SyncRemoteChoice) => {
      if (git === null || files === null || vaultKey === null || thisMac === null) return;
      setProblem(null);
      setPhase({ kind: 'syncing' });
      const ports = {
        ...{ git, files, folders, fs, markdown, unsaved: { flushAll } },
        activity: activity.inVault(vaultKey),
        settings: vaultSettingsWriter({ fs, markdown }),
        readSettings: () => readVaultSettings({ fs, markdown }),
        readSettingsCopy: (path: VaultPath) => readVaultSettings({ fs, markdown, path }),
      };
      const reread = () => inspectSync({ git, folders, fs, markdown, vaultRoot: vaultKey });
      // A vault that syncs now waits, like any other, for its first sync or look to complete.
      const settle = (setup: SyncSetup) => {
        pulls.inspected(vaultKey, setup.kind === 'set-up');
        setSetup(setup);
      };
      const setUpNow = () =>
        setUpSync({ ports, vaultRoot: vaultKey, remote, mac: thisMac, clock })
          .then(async (report) => {
            settle(await reread());
            setPhase({ kind: 'synced', report });
          })
          .catch(async (cause: unknown) => {
            setProblem(errorMessage(cause));
            const setup = await reread().catch(() => ({ kind: 'not-set-up' }) as const);
            settle(setup);
            setPhase(phaseOf(setup));
          });
      if (exclusive.open()) void exclusive.start('set-up', setUpNow);
    },
    [
      git,
      files,
      vaultKey,
      thisMac,
      folders,
      fs,
      markdown,
      flushAll,
      activity,
      clock,
      setSetup,
      setPhase,
      exclusive,
      pulls,
    ],
  );
  return { setUp, problem };
}

/** The picker's list of the person's GitHub repositories, as it loads. */
export type RepositoryList =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly repositories: readonly GitHubRepository[] }
  | { readonly kind: 'failed'; readonly problem: string };

/** The person's GitHub repositories, read when the picker asks. */
export function useRepositories(github: GitHubPort) {
  const [list, setList] = useState<RepositoryList>({ kind: 'idle' });
  const load = useCallback(() => {
    setList({ kind: 'loading' });
    listGitHubRepositories({ github }).then(
      (repositories) => setList({ kind: 'ready', repositories }),
      (cause: unknown) => setList({ kind: 'failed', problem: errorMessage(cause) }),
    );
  }, [github]);
  return { list, load };
}
