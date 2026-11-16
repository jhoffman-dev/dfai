import { useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { holdModalLayer } from './modal-layer.ts';
import { Icon } from './icon.tsx';
import { isImeKey } from './ime.ts';
import { Key, KeyHints } from './key-hints.tsx';
import { useReturnFocus, type FocusFallback } from './return-focus.ts';

const HINTS = [
  ['↑ ↓', 'to move'],
  ['↵', 'to move it there'],
  ['esc', 'to close'],
] as const;

/** A folder the picker offers, as it should be read. */
export interface MoveDestination {
  readonly path: string;
  /** "Pages" for the top level, otherwise the folder's name. */
  readonly name: string;
  /** Where the folder sits, for telling two of the same name apart; empty at the top. */
  readonly place: string;
}

/**
 * Where to move a note or a folder, chosen from the keyboard like a search.
 *
 * Laid out as the search palette is, and mounted only while it is open: the
 * list is the folders that would accept the move, so every row is a real
 * answer. Typing narrows it by name or by place.
 */
export function MovePicker({
  subject,
  destinations,
  onPick,
  onClose,
  fallbackFocus,
}: {
  /** The name of what is being moved, for the title. */
  subject: string;
  destinations: readonly MoveDestination[];
  onPick: (path: string) => void;
  onClose: () => void;
  fallbackFocus?: FocusFallback;
}) {
  const finalFocus = useReturnFocus(fallbackFocus);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const wanted = query.trim().toLowerCase();
  const shown = destinations.filter((each) =>
    `${each.place} ${each.name}`.toLowerCase().includes(wanted),
  );
  const at = Math.min(selected, Math.max(0, shown.length - 1));
  const pick = (destination: MoveDestination | undefined) => {
    if (destination !== undefined) onPick(destination.path);
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal ref={holdModalLayer}>
        <Dialog.Viewport className="palette__backdrop">
          <Dialog.Popup
            className="palette"
            finalFocus={finalFocus}
            aria-label={`Move ${subject} to…`}
          >
            <div className="palette__field">
              <Icon name="folder" size={19} className="palette__field-icon" />
              <input
                className="palette__input"
                type="search"
                placeholder={`Move ${subject} to…`}
                aria-label="Find a folder"
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
              <p className="palette__empty">
                {destinations.length === 0
                  ? 'There is nowhere else to put it.'
                  : 'No folder matches.'}
              </p>
            ) : (
              <ul className="palette__hits" role="listbox" aria-label="Folders">
                {shown.map((destination, index) => (
                  <li key={destination.path}>
                    <Destination
                      destination={destination}
                      selected={index === at}
                      onPick={() => pick(destination)}
                    />
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

function Destination({
  destination,
  selected,
  onPick,
}: {
  destination: MoveDestination;
  selected: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className={selected ? 'palette__hit palette__hit--on' : 'palette__hit'}
      onMouseDown={(event) => {
        event.preventDefault();
        onPick();
      }}
    >
      <span className="palette__kind">
        <Icon name="folder" size={16} />
      </span>
      <span className="palette__text">
        <span className="palette__title">{destination.name}</span>
        {destination.place !== '' && (
          <span className="palette__detail">
            <span className="palette__place">{destination.place}</span>
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
