import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { folderOf, joinPath, noteTitle } from '../../application/index.ts';
import type { VaultPath } from '../../domain/vault/index.ts';
import { useApp } from '../services.ts';
import { useUi } from '../state/ui-store.ts';

/**
 * The note's title, which is its file name, edited in place. Enter or
 * leaving the field renames the file (and every link to it); Escape undoes.
 */
export function NoteTitle({
  path,
  beforeRename,
}: {
  path: VaultPath;
  /** Runs first, so nothing typed is still waiting to be saved under the old name. */
  beforeRename: () => Promise<void>;
}) {
  const { actions, ui } = useApp();
  const [name, setName] = useState(() => noteTitle(path));
  const input = useRef<HTMLInputElement>(null);
  const wantsFocus = useUi(
    (state) => state.pendingFocus?.path === path && state.pendingFocus.target === 'title',
  );

  useEffect(() => {
    if (!wantsFocus) return;
    input.current?.focus();
    input.current?.select();
    ui.setState({ pendingFocus: null });
  }, [wantsFocus, ui]);

  const commit = async () => {
    const wanted = name.trim();
    if (wanted === noteTitle(path)) return;
    if (wanted === '') {
      setName(noteTitle(path));
      return;
    }
    await beforeRename();
    const result = await actions.rename(path, joinPath(folderOf(path), `${wanted}.md`), {
      open: true,
    });
    if (result.kind === 'refused') setName(noteTitle(path));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.currentTarget.blur();
    } else if (event.key === 'Escape') {
      setName(noteTitle(path));
      requestAnimationFrame(() => input.current?.blur());
    }
  };

  return (
    <input
      ref={input}
      className="note-title"
      aria-label="Note title"
      value={name}
      spellCheck={false}
      onChange={(event) => setName(event.target.value)}
      onBlur={() => void commit().catch(actions.report)}
      onKeyDown={onKeyDown}
    />
  );
}
