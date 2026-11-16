import { useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { holdModalLayer } from '../modal-layer.ts';
import { useReturnFocus, type FocusFallback } from '../return-focus.ts';

/**
 * Open a vault from GitHub (U-29): the repository's address, then the folder
 * to put it in. The copy is made with the GitHub login already on this Mac.
 */
export function OpenFromGitHubDialog({
  busy,
  problem,
  onOpen,
  onClose,
  fallbackFocus,
}: {
  busy: boolean;
  /** Why the last try failed. */
  problem: string | null;
  onOpen: (url: string) => void;
  onClose: () => void;
  fallbackFocus?: FocusFallback;
}) {
  const [url, setUrl] = useState('');
  const finalFocus = useReturnFocus(fallbackFocus);
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal ref={holdModalLayer}>
        <Dialog.Viewport className="palette__backdrop">
          <Dialog.Popup className="palette confirm" finalFocus={finalFocus}>
            <Dialog.Title className="confirm__title">Open a vault from GitHub</Dialog.Title>
            <Dialog.Description className="confirm__body">
              Paste the repository’s address, then choose the folder to put the vault in. DFAI
              copies it there and opens it, using the GitHub login already on this Mac.
            </Dialog.Description>
            <form
              className="sync-form sync-form--dialog"
              onSubmit={(event) => {
                event.preventDefault();
                onOpen(url);
              }}
            >
              <input
                className="field sync-form__field"
                aria-label="Repository address"
                placeholder="git@github.com:you/notes.git"
                spellCheck={false}
                autoComplete="off"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
              {problem !== null && (
                <p className="settings__problem" role="alert">
                  {problem}
                </p>
              )}
              <div className="confirm__actions">
                <Dialog.Close className="btn btn--secondary">Cancel</Dialog.Close>
                <button
                  className="btn btn--primary"
                  type="submit"
                  disabled={busy || url.trim() === ''}
                >
                  {busy ? 'Copying…' : 'Choose folder…'}
                </button>
              </div>
            </form>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
