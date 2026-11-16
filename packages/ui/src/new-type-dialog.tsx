import { useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import type { SidebarIcon } from '@dfai/domain';
import { holdModalLayer } from './modal-layer.ts';
import { Icon, sidebarGlyph } from './icon.tsx';
import { isImeKey } from './ime.ts';
import { KeyHints } from './key-hints.tsx';
import { useReturnFocus, type FocusFallback } from './return-focus.ts';

const HINTS = [
  ['↵', 'to create'],
  ['esc', 'to close'],
] as const;

/**
 * Making a new type: what to call it, and which glyph it wears.
 *
 * The name is all it needs; whether the name is usable is decided elsewhere
 * and comes back as `error`. The icon is optional — left unchosen, the type is
 * drawn with the one its name suggests.
 */
export function NewTypeDialog({
  icons,
  error,
  onCreate,
  onClose,
  fallbackFocus,
}: {
  /** The glyphs a type may choose from. */
  icons: readonly SidebarIcon[];
  /** Why the last attempt was refused, shown under the field. */
  error: string | null;
  onCreate: (args: { label: string; icon: SidebarIcon | null }) => void;
  onClose: () => void;
  fallbackFocus?: FocusFallback;
}) {
  const finalFocus = useReturnFocus(fallbackFocus);
  const [label, setLabel] = useState('');
  const [icon, setIcon] = useState<SidebarIcon | null>(null);
  const submit = () => {
    if (label.trim() !== '') onCreate({ label: label.trim(), icon });
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
          <Dialog.Popup className="palette new-type" finalFocus={finalFocus}>
            <Dialog.Title className="new-type__title">New type</Dialog.Title>
            <div className="palette__field">
              <Icon name={sidebarGlyph(icon ?? 'doc')} size={19} className="palette__field-icon" />
              <input
                className="palette__input"
                type="text"
                aria-label="Type name"
                placeholder="Book, Project, Recipe…"
                value={label}
                aria-invalid={error !== null}
                aria-describedby={error === null ? undefined : 'new-type-error'}
                onChange={(event) => setLabel(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !isImeKey(event)) submit();
                }}
              />
            </div>
            {error !== null && (
              <p className="new-type__error" id="new-type-error" role="alert">
                {error}
              </p>
            )}
            <fieldset className="new-type__icons">
              <legend className="new-type__legend">Icon</legend>
              {icons.map((choice) => (
                <button
                  key={choice}
                  type="button"
                  className="new-type__icon"
                  aria-pressed={icon === choice}
                  aria-label={`${choice} icon`}
                  title={choice}
                  onClick={() => setIcon(icon === choice ? null : choice)}
                >
                  <Icon name={sidebarGlyph(choice)} size={17} />
                </button>
              ))}
            </fieldset>
            <div className="new-type__actions">
              <button type="button" className="btn btn--ghost" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={label.trim() === ''}
                onClick={submit}
              >
                Create type
              </button>
            </div>
            <KeyHints hints={HINTS} />
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
