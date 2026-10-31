import { parseRememberedWorkspace, rememberWorkspace } from '@dfai/domain';
import type { RememberedWorkspaces } from './workspace-store.ts';

/** One key per vault, so two vaults' tabs never read as each other's. */
const keyFor = (vaultKey: string) => `atlas.workspace:${vaultKey}`;

/** Where the split alone was kept before there were tabs; read once more, then left behind. */
const SPLIT_KEY = 'atlas.panes';

/**
 * The window's tabs, kept in `localStorage` (tab-model.md §2): per viewer,
 * never in the vault, never in Rust, and holding places only — nothing a
 * secret could sit in.
 *
 * Every access is guarded, as the theme's store and the sidebar's are: the
 * accessor itself throws in a private window and wherever site data is
 * blocked, and a read can come back empty or stale at any time. None of
 * that is an error worth showing — the window opens on one empty tab, which
 * is what a first run does. A vault with no tabs remembered yet reads the
 * split it had before tabs, which the domain upgrades to one tab per pane.
 */
export const browserWorkspaceStore: RememberedWorkspaces = {
  read: (vaultKey) => {
    try {
      const stored = window.localStorage.getItem(keyFor(vaultKey));
      if (stored !== null) return parseRememberedWorkspace(JSON.parse(stored), vaultKey);
      const split = window.localStorage.getItem(SPLIT_KEY);
      return split === null ? null : parseRememberedWorkspace(JSON.parse(split), vaultKey);
    } catch {
      return null;
    }
  },
  write: ({ vaultKey, workspace }) => {
    try {
      window.localStorage.setItem(
        keyFor(vaultKey),
        JSON.stringify(rememberWorkspace({ workspace, vaultKey })),
      );
    } catch {
      // Safe to ignore: the tabs still hold for this session, they just will
      // not be there next time.
    }
  },
};
