import { useMemo, useState, type FormEvent } from 'react';
import { folderOf, joinPath, noteTitle } from '../../application/index.ts';
import type { FolderNode, VaultPath } from '../../domain/vault/index.ts';
import { useApp } from '../services.ts';
import { useVault } from '../state/vault-store.ts';

function folderPaths(folder: FolderNode): VaultPath[] {
  return folder.folders.flatMap((child) => [child.path, ...folderPaths(child)]);
}

/** Asks which folder a note moves to: an existing one, or a new path typed in. */
export function MoveDialog({ path, onClose }: { path: VaultPath; onClose: () => void }) {
  const { actions } = useApp();
  const tree = useVault((vault) => vault.tree);
  const folders = useMemo(() => folderPaths(tree), [tree]);
  const [folder, setFolder] = useState(folderOf(path));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const target = folder.trim().replace(/^\/+|\/+$/g, '');
    const to = joinPath(target, `${noteTitle(path)}.md`);
    onClose();
    if (to !== path) actions.rename(path, to, { open: false }).catch(actions.report);
  };

  return (
    <div
      className="dialog-scrim"
      onPointerDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="move-title"
        onSubmit={submit}
        onKeyDown={(event) => event.key === 'Escape' && onClose()}
      >
        <h2 id="move-title" className="dialog-title">
          Move “{noteTitle(path)}”
        </h2>
        <label className="dialog-field">
          <span>Folder (empty for the top of the vault)</span>
          <input
            className="text-input"
            list="move-folders"
            value={folder}
            autoFocus
            onChange={(event) => setFolder(event.target.value)}
          />
        </label>
        <datalist id="move-folders">
          {folders.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
        <div className="dialog-actions">
          <button type="button" className="quiet-button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary-button">
            Move
          </button>
        </div>
      </form>
    </div>
  );
}
