import { useRef, useState, type DragEvent } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import type { DocumentKind } from '@dfai/domain';
import { Icon } from '../icon.tsx';
import { useReturnFocus, type FocusFallback } from '../return-focus.ts';

/*
 * Adding PDFs (#504) or EPUBs (#505) to the library: drop them here or pick
 * them. Each is copied into the vault and given its literature note; the
 * files picked are only read. What is refused, and why, is the caller's to
 * say.
 */

/** What the dialog calls each kind of document, and the files its picker offers. */
const COPY: Readonly<
  Record<DocumentKind, { readonly name: string; readonly article: string; readonly accept: string }>
> = {
  pdf: { name: 'PDF', article: 'a PDF', accept: '.pdf,application/pdf' },
  epub: { name: 'EPUB', article: 'an EPUB', accept: '.epub,application/epub+zip' },
};

export interface AddDocumentDialogProps {
  /** Which kind of document it adds. */
  readonly kind: DocumentKind;
  /** The folder the copies go in, as the dialog says it. */
  readonly folder: string;
  readonly adding: boolean;
  readonly error: string | null;
  readonly onFiles: (files: File[]) => void;
  readonly onClose: () => void;
  readonly fallbackFocus?: FocusFallback;
}

export function AddDocumentDialog({
  kind,
  folder,
  adding,
  error,
  onFiles,
  onClose,
  fallbackFocus,
}: AddDocumentDialogProps) {
  const copy = COPY[kind];
  const finalFocus = useReturnFocus(fallbackFocus);
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files');
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Viewport className="palette__backdrop">
          <Dialog.Popup className="palette new-type add-pdf" finalFocus={finalFocus}>
            <Dialog.Title className="new-type__title">Add {copy.name} to Library</Dialog.Title>
            <div
              className={over ? 'file-drop file-drop--over' : 'file-drop'}
              role="group"
              aria-label={`Drop ${copy.name}s here`}
              onDragOver={(event) => {
                if (adding || !hasFiles(event)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'copy';
                setOver(true);
              }}
              onDragLeave={() => setOver(false)}
              onDrop={(event) => {
                if (adding || !hasFiles(event)) return;
                event.preventDefault();
                setOver(false);
                const dropped = [...event.dataTransfer.files];
                if (dropped.length > 0) onFiles(dropped);
              }}
            >
              <Icon name="book" size={22} className="file-drop__icon" />
              <div className="file-drop__text">
                Drop {copy.article} here. A copy goes into {folder} with a literature note for its
                highlights; the file you picked is left as it is.
              </div>
              <div className="file-drop__actions">
                <button
                  type="button"
                  className="btn btn--secondary"
                  disabled={adding}
                  onClick={() => input.current?.click()}
                >
                  {adding ? 'Adding…' : `Choose ${copy.name}…`}
                </button>
              </div>
              <input
                ref={input}
                className="file-drop__input"
                type="file"
                accept={copy.accept}
                multiple
                aria-label={`Choose ${copy.name}`}
                onChange={(event) => {
                  const picked = [...(event.target.files ?? [])];
                  // Cleared, so choosing the same file again still counts as a choice.
                  event.target.value = '';
                  if (picked.length > 0) onFiles(picked);
                }}
              />
            </div>
            {error !== null && (
              <p className="new-type__error" role="alert">
                {error}
              </p>
            )}
            <div className="new-type__actions">
              <button type="button" className="btn btn--ghost" onClick={onClose}>
                Close
              </button>
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
