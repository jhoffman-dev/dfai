import { useCallback, useEffect, useRef } from 'react';
import {
  createVaultPath,
  imageMimeType,
  imageSourceCandidates,
  resolveImageSource,
  type VaultPath,
} from '@dfai/domain';
import type { VaultFsPort } from '@dfai/application';

/**
 * Turns a markdown image source into something the editor can display.
 *
 * Vault images are fetched through the host and wrapped in object URLs, which are
 * released when the note changes so a long session does not accumulate them.
 */
export function useImages({
  fs,
  notePath,
}: {
  fs: VaultFsPort;
  notePath: VaultPath | null;
}): (src: string) => Promise<string | null> {
  const load = useVaultImages({ fs, resetKey: notePath });
  return useCallback(
    async (src: string) => (notePath === null ? null : load({ path: notePath, src })),
    [load, notePath],
  );
}

/**
 * The same, for images written in any of several notes — a feed's bodies, a
 * gallery's covers. Each is resolved against the note it was written in, and
 * every object URL is released when `resetKey` changes or the view goes.
 */
export function useVaultImages({
  fs,
  resetKey,
  vaultOnly = false,
}: {
  fs: VaultFsPort;
  resetKey: unknown;
  /** Read only what the vault holds: a source off the vault is shown as missing, never fetched. */
  vaultOnly?: boolean;
}): (args: { path: string; src: string }) => Promise<string | null> {
  const urls = useRef<string[]>([]);

  const release = useCallback(() => {
    for (const url of urls.current) URL.revokeObjectURL(url);
    urls.current = [];
  }, []);

  useEffect(() => release, [resetKey, release]);

  return useCallback(
    async ({ path, src }: { path: string; src: string }) => {
      const notePath = createVaultPath(path);
      const source = resolveImageSource({ src, notePath });
      if (source.kind === 'external') return vaultOnly ? null : source.url;
      if (source.kind === 'unresolved') return null;

      // Beside the note first, then from the vault root: the first file there wins.
      for (const candidate of imageSourceCandidates({ src, notePath })) {
        try {
          const bytes = await fs.readBinaryFile(candidate);
          const url = URL.createObjectURL(new Blob([bytes], { type: imageMimeType(candidate) }));
          urls.current.push(url);
          return url;
        } catch {
          // Not there or unreadable: try the next place it could be.
        }
      }
      // A missing image shows as missing rather than failing the note.
      return null;
    },
    [fs, vaultOnly],
  );
}
