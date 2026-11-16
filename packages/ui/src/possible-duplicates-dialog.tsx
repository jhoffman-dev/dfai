import { Dialog } from '@base-ui/react/dialog';
import type { PillHue } from '@dfai/domain';
import { holdModalLayer } from './modal-layer.ts';
import { delayedSpinner } from './delayed-spinner.tsx';
import { useReturnFocus, type FocusFallback } from './return-focus.ts';
import { TintedPill } from './status-pill.tsx';

/** One of two people who may be one, as a row names them. */
export interface DuplicatePersonView {
  readonly path: string;
  readonly name: string;
  /** The folder their note is in; empty at the top. */
  readonly place: string;
}

/** Why two people may be one, as a chip says it, in the hue it is drawn in. */
export interface DuplicateReasonView {
  readonly text: string;
  readonly hue: PillHue;
  /** What it was found by, read beside the chip: the two addresses, say. */
  readonly detail?: string;
}

/** A pair of people who may be one. */
export interface DuplicatePairView {
  readonly key: string;
  readonly left: DuplicatePersonView;
  readonly right: DuplicatePersonView;
  readonly reasons: readonly DuplicateReasonView[];
}

/** Where the list is. */
export type DuplicatesState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'ready'; readonly pairs: readonly DuplicatePairView[] };

/**
 * The people who may be one person (#464), a pair to a row: who they are,
 * why they look alike, and Merge or Not the same. A pair said not to be one
 * is remembered and leaves the list.
 */
export function PossibleDuplicatesDialog({
  state,
  onOpen,
  onMerge,
  onDismiss,
  onClose,
  fallbackFocus,
}: {
  state: DuplicatesState;
  onOpen: (path: string) => void;
  onMerge: (key: string) => void;
  onDismiss: (key: string) => void;
  onClose: () => void;
  fallbackFocus?: FocusFallback;
}) {
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
          <Dialog.Popup className="palette confirm duplicates" finalFocus={finalFocus}>
            <Dialog.Title className="confirm__title">Possible duplicates</Dialog.Title>
            {state.kind === 'loading' ? (
              delayedSpinner('Looking for people who may be one…')
            ) : state.kind === 'failed' ? (
              <p className="confirm__warning" role="alert">
                {state.message}
              </p>
            ) : state.pairs.length === 0 ? (
              <p className="confirm__body">No two people look alike.</p>
            ) : (
              <ul className="duplicates__list" aria-label="People who may be one">
                {state.pairs.map((pair) => (
                  <PairRow
                    key={pair.key}
                    pair={pair}
                    onOpen={onOpen}
                    onMerge={() => onMerge(pair.key)}
                    onDismiss={() => onDismiss(pair.key)}
                  />
                ))}
              </ul>
            )}
            <div className="confirm__actions">
              <Dialog.Close className="btn btn--secondary">Close</Dialog.Close>
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PairRow({
  pair,
  onOpen,
  onMerge,
  onDismiss,
}: {
  pair: DuplicatePairView;
  onOpen: (path: string) => void;
  onMerge: () => void;
  onDismiss: () => void;
}) {
  const names = `${pair.left.name} and ${pair.right.name}`;
  return (
    <li className="duplicates__pair" aria-label={names}>
      <div className="duplicates__people">
        <Person person={pair.left} onOpen={onOpen} />
        <span className="duplicates__and" aria-hidden="true">
          ↔
        </span>
        <Person person={pair.right} onOpen={onOpen} />
      </div>
      <div className="duplicates__reasons">
        {pair.reasons.map((reason) => (
          <span key={`${reason.text}\u0000${reason.detail ?? ''}`} className="duplicates__reason">
            <TintedPill text={reason.text} color={reason.hue} />
            {reason.detail !== undefined && (
              <span className="duplicates__detail">{reason.detail}</span>
            )}
          </span>
        ))}
      </div>
      <div className="duplicates__actions">
        <button type="button" className="btn btn--secondary btn--sm" onClick={onDismiss}>
          Not the same
        </button>
        <button type="button" className="btn btn--primary btn--sm" onClick={onMerge}>
          Merge…
        </button>
      </div>
    </li>
  );
}

function Person({
  person,
  onOpen,
}: {
  person: DuplicatePersonView;
  onOpen: (path: string) => void;
}) {
  return (
    <button type="button" className="duplicates__person" onClick={() => onOpen(person.path)}>
      <span className="duplicates__name">{person.name}</span>
      {person.place !== '' && <span className="duplicates__place">{person.place}</span>}
    </button>
  );
}
