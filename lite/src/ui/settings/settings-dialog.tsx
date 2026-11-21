import { useState, type FormEvent } from 'react';
import type { Settings } from '../../application/index.ts';
import { useApp } from '../services.ts';
import '../shell/dialog.css';

interface RepoForm {
  readonly repository: string;
  readonly branch: string;
  readonly token: string;
}

function formOf(settings: Settings): RepoForm {
  return {
    repository: settings.repo === null ? '' : `${settings.repo.owner}/${settings.repo.name}`,
    branch: settings.repo?.branch ?? 'main',
    token: settings.token ?? '',
  };
}

/** `owner/name` split, or null when it is not that shape. */
function parseRepository(text: string): { owner: string; name: string } | null {
  const match = /^\s*([\w.-]+)\/([\w.-]+)\s*$/.exec(text);
  return match === null ? null : { owner: match[1] ?? '', name: match[2] ?? '' };
}

/** The GitHub repository the vault syncs with, and the token that reaches it. */
export default function SettingsDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  /** After a save: the app re-reads whether a repository is connected. */
  onSaved: (settings: Settings) => void;
}) {
  const { services } = useApp();
  const [form, setForm] = useState(() => formOf(services.settings.load()));
  const [problem, setProblem] = useState<string | null>(null);
  const field = (key: keyof RepoForm) => ({
    value: form[key],
    onChange: (event: { target: { value: string } }) =>
      setForm({ ...form, [key]: event.target.value }),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const blank = form.repository.trim() === '';
    const repo = parseRepository(form.repository);
    if (!blank && repo === null) {
      setProblem('Write the repository as owner/name, for example mara-quill/notes.');
      return;
    }
    const current = services.settings.load();
    const next: Settings = {
      ...current,
      repo: repo === null ? null : { ...repo, branch: form.branch.trim() || 'main' },
      token: form.token.trim() === '' ? null : form.token.trim(),
    };
    services.settings.save(next);
    onSaved(next);
    onClose();
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
        aria-labelledby="settings-title"
        onSubmit={submit}
        onKeyDown={(event) => event.key === 'Escape' && onClose()}
      >
        <h2 id="settings-title" className="dialog-title">
          Settings
        </h2>
        <label className="dialog-field">
          <span>GitHub repository</span>
          <input
            className="text-input"
            placeholder="owner/name"
            autoFocus
            {...field('repository')}
          />
        </label>
        <label className="dialog-field">
          <span>Branch</span>
          <input className="text-input" placeholder="main" {...field('branch')} />
        </label>
        <label className="dialog-field">
          <span>Personal access token</span>
          <input className="text-input" type="password" autoComplete="off" {...field('token')} />
        </label>
        <p className="dialog-hint">
          A fine-grained token with Contents read and write on that one repository. It stays in this
          browser and is sent only to GitHub.
        </p>
        {problem === null ? null : (
          <p className="dialog-hint" role="alert">
            {problem}
          </p>
        )}
        <div className="dialog-actions">
          <button
            type="button"
            className="quiet-button"
            disabled={services.sync === null}
            title={
              services.sync === null ? 'Sync starts once a repository is connected' : undefined
            }
            onClick={() => services.sync?.syncNow()}
          >
            Sync now
          </button>
          <button type="button" className="quiet-button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary-button">
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
