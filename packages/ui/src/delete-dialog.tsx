import { linksGoAsLinks } from '@dfai/domain';
import { AlertDialog } from '@base-ui/react/alert-dialog';
import { useReturnFocus, type FocusFallback } from './return-focus.ts';

/** What is about to go to the Trash, as the question names it. */
export interface DeletionSubject {
  /** The name it shows as — a note's title, a folder's name. */
  readonly name: string;
  readonly kind: 'note' | 'folder';
  /** For a folder: how many notes go with it. */
  readonly notes: number;
  /** For a folder: how many other files go with it, or null while they are counted. */
  readonly otherFiles: number | null;
  /** For a folder: the links in it, by their names within it, which go as links. */
  readonly links?: readonly string[];
  /** For a folder: whether it is itself a link, so only the link goes. */
  readonly link?: boolean;
  /** Names of the notes open with typing not yet saved, which would be lost. */
  readonly unsaved: readonly string[];
  /** What stops working once it is gone — a template's uses — said before it goes. */
  readonly consequence?: string | null;
  /** Why it cannot go from here at all — reached through a link — when it cannot. */
  readonly refusal?: string | null;
}

const counted = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

const ONLY_THE_LINK =
  'It is a link: only the link goes to the Trash, and what it points at stays where it is.';

function contentsOf(subject: DeletionSubject): string {
  if (subject.link === true) return ONLY_THE_LINK;
  const links = linksGoAsLinks(subject.links ?? []);
  return links === '' ? filesOf(subject) : `${filesOf(subject)} ${links}`;
}

function filesOf({ notes, otherFiles }: DeletionSubject): string {
  const parts = [
    notes > 0 ? counted(notes, 'note', 'notes') : null,
    otherFiles !== null && otherFiles > 0 ? counted(otherFiles, 'other file', 'other files') : null,
  ].filter((part) => part !== null);
  if (parts.length === 0) return 'It has no notes in it.';
  const goes = parts.length === 1 && (notes === 1 || (notes === 0 && otherFiles === 1));
  return `The ${parts.join(' and ')} in it ${goes ? 'goes' : 'go'} too.`;
}

/**
 * The question asked before anything goes to the Trash.
 *
 * An alert dialog, so it cannot be dismissed by a stray click outside: the
 * answer is Cancel or Move to Trash, and Cancel has the focus. It says what
 * goes — a folder, how many notes it holds — that it can be got back from the
 * Trash, and what unsaved typing would be lost.
 */
export function DeleteDialog({
  subject,
  onConfirm,
  onClose,
  fallbackFocus,
}: {
  subject: DeletionSubject;
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
            {/* Deleting is offered on every platform (#657). TODO(#670): on the web a
                delete is a commit, recovered from the repository's history, and these
                words must not promise a Trash there (ADR-0051). */}
            <AlertDialog.Title className="confirm__title">
              Move “{subject.name}” to the Trash?
            </AlertDialog.Title>
            <AlertDialog.Description className="confirm__body">
              {subject.kind === 'folder' && (subject.refusal ?? null) === null && (
                <>{contentsOf(subject)} </>
              )}
              You can get it back from the Trash in Finder.
            </AlertDialog.Description>
            {(subject.consequence ?? null) !== null && (
              <p className="confirm__warning">{subject.consequence}</p>
            )}
            {(subject.refusal ?? null) !== null && (
              <p className="confirm__warning" role="alert">
                {subject.refusal}
              </p>
            )}
            {subject.unsaved.length > 0 && (
              <p className="confirm__warning" role="alert">
                Unsaved changes to {subject.unsaved.join(', ')} will be lost.
              </p>
            )}
            <div className="confirm__actions">
              {/* First, so it is where the focus starts. */}
              <AlertDialog.Close className="btn btn--secondary">Cancel</AlertDialog.Close>
              {(subject.refusal ?? null) === null && (
                <button type="button" className="btn btn--danger" onClick={onConfirm}>
                  Move to Trash
                </button>
              )}
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
