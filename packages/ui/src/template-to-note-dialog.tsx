import { AlertDialog } from './dialog.tsx';
import { useReturnFocus, type FocusFallback } from './return-focus.ts';

/**
 * The question before a template becomes one of the vault's notes: where it
 * goes, that it goes as it is, and what stops being made from it. An alert
 * dialog, like the one before a delete, so Cancel has the focus and a stray
 * click outside answers nothing.
 */
export function TemplateToNoteDialog({
  name,
  consequence,
  unsaved,
  onConfirm,
  onClose,
  fallbackFocus,
}: {
  /** The template's name, which the note keeps. */
  name: string;
  /** What starts with nothing once it is no longer a template, or null. */
  consequence: string | null;
  /** Whether a pane holds typing in it not yet saved, which is saved first. */
  unsaved: boolean;
  onConfirm: () => void;
  onClose: () => void;
  fallbackFocus?: FocusFallback;
}) {
  const finalFocus = useReturnFocus(fallbackFocus);
  return (
    <AlertDialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Viewport className="palette__backdrop">
          <AlertDialog.Popup className="palette confirm" finalFocus={finalFocus}>
            <AlertDialog.Title className="confirm__title">Make “{name}” a note?</AlertDialog.Title>
            <AlertDialog.Description className="confirm__body">
              It moves out of the templates to the top of the vault, exactly as it is
              {unsaved ? ', with what you have typed saved first' : ''}. Links to “{name}” reach it
              again.
            </AlertDialog.Description>
            {consequence !== null && <p className="confirm__warning">{consequence}</p>}
            <div className="confirm__actions">
              {/* First, so it is where the focus starts. */}
              <AlertDialog.Close className="btn btn--secondary">Cancel</AlertDialog.Close>
              <button type="button" className="btn btn--primary" onClick={onConfirm}>
                Move to notes
              </button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
