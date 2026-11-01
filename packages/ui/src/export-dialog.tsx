import { useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { EXPORT_FORMATS, type ExportFormat } from '@dfai/domain';
import { useReturnFocus, type FocusFallback } from './return-focus.ts';

/** Where the export question is: asking how, making the export, or saying why it could not. */
export type ExportDialogState =
  | { readonly kind: 'choosing' }
  | { readonly kind: 'working'; readonly format: ExportFormat }
  | { readonly kind: 'failed'; readonly problem: string; readonly fix: string | null };

/** What the person chose. */
export interface ExportChoice {
  readonly format: ExportFormat;
  /** Standalone Markdown only: whether its properties come along as frontmatter. */
  readonly keepFrontmatter: boolean;
}

const FORMATS: readonly { value: ExportFormat; label: string; tag: string; hint: string }[] = [
  {
    value: 'markdown',
    label: 'Markdown, as is',
    tag: '.md',
    hint: 'The file exactly as it is, with its pictures in a folder beside it.',
  },
  {
    value: 'standalone',
    label: 'Markdown, standalone',
    tag: '.md',
    hint: 'Reads anywhere: links become plain text (or links to notes exported with it), embeds are written in, pictures copied.',
  },
  {
    value: 'pdf',
    label: 'PDF',
    tag: '.pdf',
    hint: 'As the note reads in the app: title, properties, body, tables and pictures, on letter pages.',
  },
  {
    value: 'google-doc',
    label: 'Google Doc',
    tag: 'Docs',
    hint: 'A Doc in your Google Drive, in its exports folder. Asks once to let the app make files there.',
  },
];

const WORKING: Readonly<Record<ExportFormat, string>> = {
  markdown: 'Exporting…',
  standalone: 'Exporting…',
  pdf: 'Making the PDF…',
  'google-doc': 'Making the Google Doc… finish signing in in your browser if it asks.',
};

/**
 * Exporting notes (#501): one note, or several chosen in a view, as
 * Markdown (as is, or standalone), a PDF or a Google Doc. Where the files go
 * is asked next, by the system's own save dialog; a Doc goes to Drive.
 */
export function ExportDialog({
  subject,
  state,
  onExport,
  onClose,
  fallbackFocus,
  formats = EXPORT_FORMATS,
}: {
  /** What is exported, for the title: a note's title, or "3 notes". */
  subject: string;
  state: ExportDialogState;
  onExport: (choice: ExportChoice) => void;
  onClose: () => void;
  fallbackFocus?: FocusFallback;
  /** The formats offered here, Markdown first; left out, every one. */
  formats?: readonly ExportFormat[];
}) {
  const finalFocus = useReturnFocus(fallbackFocus);
  const [format, setFormat] = useState<ExportFormat>('markdown');
  const options = FORMATS.filter((option) => formats.includes(option.value));
  const [keepFrontmatter, setKeepFrontmatter] = useState(true);
  const working = state.kind === 'working';
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !working) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Viewport className="palette__backdrop">
          <Dialog.Popup className="palette confirm export" finalFocus={finalFocus}>
            <Dialog.Title className="confirm__title">Export {subject}</Dialog.Title>
            <fieldset className="export__formats" disabled={working}>
              <legend className="export__legend">Format</legend>
              {options.map((option) => (
                <label key={option.value} className="export__format">
                  <input
                    type="radio"
                    name="export-format"
                    value={option.value}
                    checked={format === option.value}
                    onChange={() => setFormat(option.value)}
                  />
                  <span className="export__format-text">
                    <span className="export__format-label">
                      {option.label}{' '}
                      <span className={`export__tag export__tag--${option.value}`}>
                        {option.tag}
                      </span>
                    </span>
                    <span className="export__hint">{option.hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            {format === 'standalone' && (
              <label className="export__option">
                <input
                  type="checkbox"
                  checked={keepFrontmatter}
                  disabled={working}
                  onChange={(event) => setKeepFrontmatter(event.target.checked)}
                />
                Keep the properties as frontmatter
              </label>
            )}
            {state.kind === 'failed' && (
              <div className="confirm__warning" role="alert">
                <p>{state.problem}</p>
                {state.fix !== null && <p>{state.fix}</p>}
              </div>
            )}
            <Dialog.Description className="confirm__body">
              {working
                ? WORKING[state.format]
                : 'Exporting reads your notes and never changes them.'}
            </Dialog.Description>
            <div className="confirm__actions">
              <Dialog.Close className="btn btn--secondary" disabled={working}>
                Cancel
              </Dialog.Close>
              <button
                type="button"
                className="btn btn--primary"
                disabled={working}
                onClick={() => onExport({ format, keepFrontmatter })}
              >
                {working ? 'Exporting…' : 'Export…'}
              </button>
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
