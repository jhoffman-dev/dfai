import { noteTitle, saveNoteText } from '../../application/index.ts';
import type { VaultPath } from '../../domain/vault/index.ts';
import { navigate } from '../routing/use-route.ts';
import type { AppContextValue } from '../services.ts';
import { createAutosave, type Autosave } from './autosave.ts';

export interface NoteSaver {
  readonly autosave: Autosave;
  /** The editor opened on `text`: saves are based on it, so a sync's edit underneath is noticed. */
  opened(text: string): void;
}

/**
 * Debounced saves of one note's editor. Each save says which text it was
 * based on; when a sync changed the note underneath, `saveNoteText` keeps
 * both, and the window moves to the copy holding what was typed here.
 */
export function createNoteSaver(app: AppContextValue, path: VaultPath): NoteSaver {
  const { deps, services, actions, ui } = app;
  let basedOnText = services.session.file(path)?.text ?? '';
  const save = async (text: string) => {
    const result = await saveNoteText(deps, { path, text, basedOnText, clock: services.clock });
    basedOnText = text;
    if (result.kind !== 'forked') return;
    ui.setState({
      notice: `“${noteTitle(path)}” changed on another device while you typed. Your text is in “${noteTitle(result.path)}”.`,
    });
    navigate({ kind: 'note', path: result.path }, { replace: true });
  };
  return {
    autosave: createAutosave({ save, onError: actions.report }),
    opened: (text) => {
      basedOnText = text;
    },
  };
}
