import { useState, type ReactNode } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { Icon } from './icon.tsx';
import { isImeKey } from './ime.ts';
import { KeyHints } from './key-hints.tsx';
import { useReturnFocus, type FocusFallback } from './return-focus.ts';

const HINTS = [
  ['↵', 'to add, and add another'],
  ['esc', 'to close'],
] as const;

/**
 * Write a line, get a task.
 *
 * Deliberately one field and nothing else: capture has to be faster than the
 * thought it is capturing, or it does not get used.
 *
 * Focus trapping, focus restoration, Escape, the scroll lock and the portal are
 * Base UI's — see ADR-0015. Enter is ours, because Enter here means "capture and
 * stay", which is not a dialog behaviour.
 */
export function CapturePalette({
  destination,
  onCapture,
  onClose,
  fallbackFocus,
  children = null,
}: {
  /** What it will make, so it is clear before pressing Enter. */
  destination: string;
  onCapture: (name: string) => void;
  onClose: () => void;
  /** Where focus goes on close if what opened the palette has gone. */
  fallbackFocus?: FocusFallback;
  /** What a paste into the field offered — a Slack message to save (#105) — drawn under it. */
  children?: ReactNode;
}) {
  const finalFocus = useReturnFocus(fallbackFocus);
  const [name, setName] = useState('');

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Viewport className="palette__backdrop">
          <Dialog.Popup className="palette" finalFocus={finalFocus} aria-label="Capture a task">
            <div className="palette__field">
              <Icon name="task" size={19} className="palette__field-icon" />
              <input
                className="palette__input"
                type="text"
                aria-label="What needs doing"
                placeholder="What needs doing?"
                // The app offers to save a pasted Slack message link from here (#105).
                data-paste-offers=""
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || isImeKey(event)) return;
                  if (name.trim() === '') {
                    onClose();
                    return;
                  }
                  onCapture(name.trim());
                  setName('');
                }}
              />
            </div>
            <p className="palette__hint">
              Each one becomes <span className="palette__destination">{destination}</span>.
            </p>
            {children}
            <KeyHints hints={HINTS} />
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
