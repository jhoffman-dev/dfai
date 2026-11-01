import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { readVaultSettings, type MarkdownPort, type VaultFsPort } from '@dfai/application';
import { readAgain, vaultReadKey } from '../reads/query-client.ts';

/** The vault's settings note as the window last read it. */
export interface VaultSettingsRead {
  /** What the note holds; undefined until it has been read, and while it has never read. */
  readonly settings: Readonly<Record<string, unknown>> | undefined;
  /** Why the last read failed; null when it worked, or none has finished. */
  readonly unreadable: string | null;
  /**
   * The last read's answer, a new object for every read that finishes,
   * worked or failed, even one that read the same as before: a setting
   * waiting for the read after its write knows it by this.
   */
  readonly answer: object | null;
  /**
   * The answer in the cache this moment, which may be newer than the one this
   * render was drawn from: a write landing takes it as the read to wait past.
   */
  readonly latestAnswer: () => object | null;
  /** Reads the note again now, dropping a read already under way. */
  readonly readAgain: () => Promise<void>;
}

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * The vault's settings note, read once for every setting the window shows
 * (#293), and again only when it changes: the window's reads say so for a
 * change at its path, from another program or from the app's own writes, or
 * a sync of the index that found it changed (`readsTouchedByPaths`). A read
 * that failed is read again when the index next has news.
 */
export function useVaultSettingsRead({
  fs,
  markdown,
  vaultKey,
}: {
  fs: Pick<VaultFsPort, 'readNotes'>;
  markdown: Pick<MarkdownPort, 'frontmatterProperties' | 'frontmatterProblem'>;
  vaultKey: string | null;
}): VaultSettingsRead {
  const client = useQueryClient();
  const { data, error } = useQuery({
    queryKey: vaultReadKey(vaultKey ?? '', 'settings'),
    queryFn: () => readVaultSettings({ fs, markdown }),
    enabled: vaultKey !== null,
    // Each read is its own answer, so one after a write is told from the one before it.
    structuralSharing: false,
  });
  const again = useCallback(
    () => readAgain(client, vaultReadKey(vaultKey ?? '', 'settings')),
    [client, vaultKey],
  );
  const latestAnswer = useCallback(() => {
    const state = client.getQueryState(vaultReadKey(vaultKey ?? '', 'settings'));
    return state?.error ?? state?.data ?? null;
  }, [client, vaultKey]);
  return {
    settings: vaultKey === null ? undefined : data,
    unreadable: vaultKey === null || error === null ? null : messageOf(error),
    answer: error ?? data ?? null,
    latestAnswer,
    readAgain: again,
  };
}
