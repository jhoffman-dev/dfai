import { useState, type FormEvent } from 'react';
import type { VaultPath } from '../../domain/vault/index.ts';
import { useApp } from '../services.ts';

/** Asks for a folder's new path; every note in it moves, and links follow. */
export function RenameFolderDialog({ path, onClose }: { path: VaultPath; onClose: () => void }) {
  const { actions } = useApp();
  const [to, setTo] = useState(path);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const target = to.trim().replace(/^\/+|\/+$/g, '');
    onClose();
    if (target !== path) actions.renameFolder(path, target).catch(actions.report);
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
        aria-labelledby="rename-folder-title"
        onSubmit={submit}
        onKeyDown={(event) => event.key === 'Escape' && onClose()}
      >
        <h2 id="rename-folder-title" className="dialog-title">
          Rename folder
        </h2>
        <label className="dialog-field">
          <span>Folder</span>
          <input
            className="text-input"
            value={to}
            autoFocus
            onChange={(event) => setTo(event.target.value)}
          />
        </label>
        <p className="dialog-hint">Every note in it moves, and links to them are rewritten.</p>
        <div className="dialog-actions">
          <button type="button" className="quiet-button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary-button">
            Rename
          </button>
        </div>
      </form>
    </div>
  );
}
