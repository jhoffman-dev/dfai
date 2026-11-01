import {
  awaitsOwnRefresh,
  outsideChanges,
  type OwnWrites,
  type VaultFsPort,
  type VaultWatchPort,
} from '@dfai/application';
import { useVaultWatch } from './use-vault-watch.ts';

/** The longest a report waits for the app's own refresh before it is judged anyway. */
export const LONGEST_WAIT_FOR_REFRESH_MS = 2_000;

const afterLongestWait = () =>
  new Promise<void>((resolve) => setTimeout(resolve, LONGEST_WAIT_FOR_REFRESH_MS));

/**
 * Runs `onChange` with the paths the watcher reports that something other
 * than this app changed: the echo of the app's own writes, kept in
 * `ownWrites`, is dropped, since the app refreshed for those when it made
 * them (#254). A report with nothing else in it asks for nothing.
 */
export function useOutsideChanges({
  watch,
  vaultKey,
  fs,
  ownWrites,
  settled = () => Promise.resolve(),
  giveUp = afterLongestWait,
  onChange,
}: {
  watch: VaultWatchPort;
  vaultKey: string | null;
  /** The open vault's files, read to tell an echo from a change. */
  fs: Pick<VaultFsPort, 'readNotes' | 'listDirectory'>;
  ownWrites: OwnWrites;
  /**
   * Resolves once the refreshes already asked have run. A report naming a
   * write of the app's that no refresh has taken in yet is judged after them,
   * so a busy window waits a little rather than walking the vault twice. Any
   * other report is judged at once: another program's change never waits.
   */
  settled?: () => Promise<unknown>;
  /** Resolves when a report has waited for `settled` long enough: a sync that never ends holds nothing. */
  giveUp?: () => Promise<unknown>;
  onChange: (paths: readonly string[]) => void;
}): void {
  useVaultWatch({
    watch,
    vaultKey,
    onChange: (paths) => {
      if (vaultKey === null) return;
      const waitFor = awaitsOwnRefresh({ ownWrites, vault: vaultKey, paths })
        ? // A refresh that failed has its own say; the report is judged all the same.
          Promise.race([settled().catch(() => undefined), giveUp()])
        : Promise.resolve();
      void waitFor
        .then(() => outsideChanges({ fs, ownWrites, vault: vaultKey, paths }))
        .then(
          (outside) => {
            if (outside.length > 0) onChange(outside);
          },
          // Nothing could be told apart, so every path is treated as a change.
          () => onChange(paths),
        );
    },
  });
}
