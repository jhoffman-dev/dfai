import { useState } from 'react';
import { Dialog } from './dialog.tsx';
import { placeCrumb, type NoteSuggestion } from '@dfai/domain';
import { Icon } from './icon.tsx';
import { isImeKey } from './ime.ts';
import { Key, KeyHints } from './key-hints.tsx';

const HINTS = [
  ['↑ ↓', 'to move'],
  ['↵', 'to link it'],
  ['esc', 'to close'],
] as const;

/**
 * Which note to link to, chosen from the keyboard like a search.
 *
 * The same palette as search and "Move to…", listing what `[[` would offer —
 * the same ranking, so a note is found here exactly as it is found while
 * typing a link. Mounted only while it is open.
 */
export function LinkPicker({
  suggestNotes,
  onPick,
  onClose,
}: {
  suggestNotes: (query: string) => NoteSuggestion[];
  /** Called with what the link is written as — the note's name. */
  onPick: (target: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const shown = suggestNotes(query);
  const at = Math.min(selected, Math.max(0, shown.length - 1));
  const pick = (note: NoteSuggestion | undefined) => {
    if (note !== undefined) onPick(note.target);
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Viewport className="palette__backdrop">
          <Dialog.Popup className="palette" aria-label="Link to a note">
            <div className="palette__field">
              <Icon name="link" size={19} className="palette__field-icon" />
              <input
                className="palette__input"
                type="search"
                placeholder="Link to…"
                aria-label="Find a note to link to"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setSelected(0);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    setSelected(Math.min(at + 1, shown.length - 1));
                  } else if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    setSelected(Math.max(at - 1, 0));
                  } else if (event.key === 'Enter' && !isImeKey(event)) {
                    event.preventDefault();
                    pick(shown[at]);
                  }
                }}
              />
              <span aria-hidden="true">
                <Key>esc</Key>
              </span>
            </div>

            {shown.length === 0 ? (
              <p className="palette__empty">No note matches.</p>
            ) : (
              <ul className="palette__hits" role="listbox" aria-label="Notes">
                {shown.map((note, index) => (
                  <li key={note.path}>
                    <Choice note={note} selected={index === at} onPick={() => pick(note)} />
                  </li>
                ))}
              </ul>
            )}
            <KeyHints hints={HINTS} />
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Choice({
  note,
  selected,
  onPick,
}: {
  note: NoteSuggestion;
  selected: boolean;
  onPick: () => void;
}) {
  const place = placeCrumb(note.path).parent;
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className={selected ? 'palette__hit palette__hit--on' : 'palette__hit'}
      onMouseDown={(event) => {
        // Before the field's blur, so the dialog is still there to answer.
        event.preventDefault();
        onPick();
      }}
    >
      <span className="palette__kind">
        <Icon name="doc" size={16} />
      </span>
      <span className="palette__text">
        <span className="palette__title">{note.target}</span>
        {place !== '' && (
          <span className="palette__detail">
            <span className="palette__place">{place}</span>
          </span>
        )}
      </span>
      {selected && (
        <span className="palette__enter" aria-hidden="true">
          <Key>↵</Key>
        </span>
      )}
    </button>
  );
}
