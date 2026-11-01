import { useCallback, useState } from 'react';
import { createVaultPath, type VaultPath } from '@dfai/domain';

/**
 * Opens a past chat, from Ask's recent questions or the sidebar's Past chats.
 * One that cannot be opened — its note deleted underneath — is said, and the
 * list read again so the row goes. Never silently.
 */
export function usePickChat({
  open,
  refresh,
}: {
  open: (path: VaultPath) => Promise<void>;
  refresh: () => void;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const onPick = useCallback(
    (path: string) => {
      setProblem(null);
      open(createVaultPath(path)).catch((error: unknown) => {
        const why = error instanceof Error ? error.message : String(error);
        setProblem(`That chat could not be opened: ${why}`);
        refresh();
      });
    },
    [open, refresh],
  );
  const clear = useCallback(() => setProblem(null), []);
  return { onPick, problem, clear };
}
