import {
  createNoteFromLink,
  createQuickNote,
  deleteNote,
  renameNote,
  reorderFavorite,
  tagKey,
  toggleFavoriteNote,
  type RenameResult,
  type SettingsStore,
  type UiPrefs,
  type VaultDeps,
} from '../../application/index.ts';
import type { VaultPath } from '../../domain/vault/index.ts';
import { navigate } from '../routing/use-route.ts';
import type { UiStore } from './ui-store.ts';

/**
 * What a click or a key asks of the vault, in one place: each calls the
 * use-case, then moves the window to show the result. No rule lives here;
 * the use-cases decide, this only routes their answers.
 */
export interface NoteActions {
  openNote(path: VaultPath): void;
  /**
   * A new `Untitled` note (in the Inbox unless a folder is given), open with
   * the caret in it. `replace` swaps the history entry (for `#/new`).
   */
  newNote(options?: { folder?: VaultPath; replace?: boolean }): Promise<void>;
  /** Opens the note a link names, making it first if no note answers. */
  followLink(target: string): Promise<void>;
  openTag(name: string): void;
  toggleFavorite(path: VaultPath): Promise<void>;
  moveFavorite(path: VaultPath, index: number): Promise<void>;
  rename(from: VaultPath, to: VaultPath, options?: { open: boolean }): Promise<RenameResult>;
  remove(path: VaultPath, options?: { wasOpen: boolean }): Promise<void>;
  /** Opens a note with its title ready to rename. */
  startRename(path: VaultPath): void;
  updatePrefs(patch: Partial<UiPrefs>): void;
  /** Rendered view or editor, remembered on this device for the next note opened. */
  togglePreview(): void;
  /** Shows `error`'s message as a notice: for a promise nobody else awaits. */
  report(error: unknown): void;
}

export function createNoteActions({
  deps,
  ui,
  settings,
}: {
  deps: VaultDeps;
  ui: UiStore;
  settings: SettingsStore;
}): NoteActions {
  const notice = (message: string) => ui.setState({ notice: message });
  const report = (error: unknown) =>
    notice(error instanceof Error ? error.message : 'Something went wrong.');
  const updatePrefs = (patch: Partial<UiPrefs>) => {
    const current = settings.load();
    settings.save({ ...current, ui: { ...current.ui, ...patch } });
  };

  return {
    openNote: (path) => navigate({ kind: 'note', path }),
    async newNote({ folder, replace = false } = {}) {
      const path = await createQuickNote(deps, folder === undefined ? {} : { folder });
      ui.setState({ pendingFocus: { path, target: 'editor' }, preview: false });
      navigate({ kind: 'note', path }, { replace });
    },
    async followLink(target) {
      const result = await createNoteFromLink(deps, { target });
      if (result.kind === 'refused') notice(result.reason);
      else navigate({ kind: 'note', path: result.path });
    },
    openTag: (name) => navigate({ kind: 'tags', tag: tagKey(name) }),
    toggleFavorite: (path) => toggleFavoriteNote(deps, { path }),
    moveFavorite: (path, index) => reorderFavorite(deps, { path, index }),
    async rename(from, to, { open } = { open: false }) {
      const result = await renameNote(deps, { from, to });
      if (result.kind === 'refused') notice(result.reason);
      else if (open) navigate({ kind: 'note', path: result.path }, { replace: true });
      return result;
    },
    async remove(path, { wasOpen } = { wasOpen: false }) {
      await deleteNote(deps, { path });
      if (wasOpen) navigate({ kind: 'home' }, { replace: true });
    },
    startRename(path) {
      ui.setState({ pendingFocus: { path, target: 'title' } });
      navigate({ kind: 'note', path });
    },
    updatePrefs,
    togglePreview() {
      const preview = !ui.getState().preview;
      ui.setState({ preview });
      updatePrefs({ preview });
    },
    report,
  };
}
