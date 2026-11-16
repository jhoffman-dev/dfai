import { useState } from 'react';
import { Dialog } from './dialog.tsx';
import { viewIcon, type NewViewRequest, type ViewLayout } from '@dfai/domain';
import { Icon, sidebarGlyph } from './icon.tsx';
import { isImeKey } from './ime.ts';
import { KeyHints } from './key-hints.tsx';
import { useReturnFocus, type FocusFallback } from './return-focus.ts';

const HINTS = [
  ['↵', 'to create'],
  ['esc', 'to close'],
] as const;

/** A choice in one of the dialog's lists. */
export interface NewViewChoice<Value extends string = string> {
  readonly value: Value;
  readonly label: string;
}

/**
 * Making a view: its name, the type whose notes it lists, and how it draws
 * them. Whether that can be made is decided elsewhere and comes back as
 * `problems`, shown once there is a name to judge or Create was pressed.
 */
export function NewViewDialog({
  request,
  types,
  layouts,
  problems,
  onChange,
  onCreate,
  onClose,
  fallbackFocus,
}: {
  request: NewViewRequest;
  types: readonly NewViewChoice[];
  layouts: readonly NewViewChoice<ViewLayout>[];
  /** What stops the view being made, in words; the write's own refusal among them. */
  problems: readonly string[];
  onChange: (request: NewViewRequest) => void;
  onCreate: () => void;
  onClose: () => void;
  fallbackFocus?: FocusFallback;
}) {
  const finalFocus = useReturnFocus(fallbackFocus);
  const [tried, setTried] = useState(false);
  const shown = tried || request.name.trim() !== '' ? problems : [];
  const submit = () => {
    setTried(true);
    if (problems.length === 0) onCreate();
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
          <Dialog.Popup className="palette new-type new-view" finalFocus={finalFocus}>
            <Dialog.Title className="new-type__title">New view</Dialog.Title>
            <div className="palette__field">
              <Icon
                name={sidebarGlyph(viewIcon(request.layout))}
                size={19}
                className="palette__field-icon"
              />
              <input
                className="palette__input"
                type="text"
                aria-label="View name"
                placeholder="Open tasks, This week…"
                value={request.name}
                aria-invalid={shown.length > 0}
                aria-describedby={shown.length === 0 ? undefined : 'new-view-problems'}
                onChange={(event) => onChange({ ...request, name: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !isImeKey(event)) submit();
                }}
              />
            </div>
            <label className="new-view__field">
              <span className="new-type__legend">Type</span>
              <span className="select">
                <select
                  className="field select__control"
                  aria-label="Type"
                  value={request.type}
                  onChange={(event) => onChange({ ...request, type: event.target.value })}
                >
                  {request.type === '' && <option value="">Choose a type</option>}
                  {types.map((type) => (
                    <option key={type.value} value={type.value}>
                      {type.label}
                    </option>
                  ))}
                </select>
              </span>
            </label>
            <fieldset className="new-view__layouts">
              <legend className="new-type__legend">Layout</legend>
              {layouts.map((layout) => (
                <button
                  key={layout.value}
                  type="button"
                  className="new-view__layout"
                  aria-pressed={request.layout === layout.value}
                  onClick={() => onChange({ ...request, layout: layout.value })}
                >
                  <Icon name={sidebarGlyph(viewIcon(layout.value))} size={16} />
                  {layout.label}
                </button>
              ))}
            </fieldset>
            {shown.length > 0 && (
              <ul className="new-view__problems" id="new-view-problems" role="alert">
                {shown.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            )}
            <div className="new-type__actions">
              <button type="button" className="btn btn--ghost" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={tried && problems.length > 0}
                onClick={submit}
              >
                Create view
              </button>
            </div>
            <KeyHints hints={HINTS} />
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
