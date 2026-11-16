import { useEffect, useRef, useState } from 'react';
import { Dialog } from './dialog.tsx';
import { delayedSpinner } from './delayed-spinner.tsx';
import { Icon } from './icon.tsx';
import { isImeKey } from './ime.ts';
import { Key } from './key-hints.tsx';
import { useReturnFocus, type FocusFallback } from './return-focus.ts';

/** A person the merge can keep, as the picker lists them. */
export interface MergePersonChoice {
  readonly path: string;
  readonly name: string;
  /** The folder their note is in, to tell two of one name apart; empty at the top. */
  readonly place: string;
}

/** A value the kept person keeps although a merged one says otherwise. */
export interface MergeConflictView {
  readonly key: string;
  readonly kept: string;
  readonly other: string;
  /** The merged person who says otherwise. */
  readonly from: string;
}

/** What a merge would do, in the words the question shows. */
export interface MergePreviewView {
  readonly keep: string;
  readonly merge: readonly string[];
  /** Notes other than the kept one whose links change. */
  readonly notes: number;
  readonly links: number;
  readonly conflicts: readonly MergeConflictView[];
  readonly aliasesAdded: readonly string[];
  readonly emailsAdded: readonly string[];
  /** How many merged people's text is added under a heading. */
  readonly bodies: number;
}

/** Where the merge question is. */
export type MergeDialogState =
  | { readonly kind: 'picking'; readonly choices: readonly MergePersonChoice[] }
  | { readonly kind: 'checking' }
  | { readonly kind: 'previewed'; readonly preview: MergePreviewView }
  | { readonly kind: 'merging'; readonly preview: MergePreviewView }
  | { readonly kind: 'refused'; readonly message: string };

const counted = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

const listed = (names: readonly string[]) =>
  names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;

/**
 * Merging people into one (#464): pick the person to keep, when it is not
 * known yet, then see what the merge does — how many notes and links change,
 * what the kept person gains, which values differ and stay as they are —
 * before anything is written. The merged people go to the Trash, so the
 * question says they can be got back.
 */
export function MergePeopleDialog({
  subject,
  state,
  onPick,
  onSwap,
  onConfirm,
  onClose,
  fallbackFocus,
}: {
  /** Who is being merged, for the picker's title: the person whose page asked. */
  subject: string;
  state: MergeDialogState;
  onPick: (path: string) => void;
  /** Given, the question offers to keep the other person instead. */
  onSwap?: () => void;
  onConfirm: () => void;
  onClose: () => void;
  fallbackFocus?: FocusFallback;
}) {
  const finalFocus = useReturnFocus(fallbackFocus);
  const label = state.kind === 'picking' ? `Merge ${subject} into…` : 'Merge people';
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Viewport className="palette__backdrop">
          <Dialog.Popup
            className={state.kind === 'picking' ? 'palette' : 'palette confirm merge'}
            finalFocus={finalFocus}
            aria-label={label}
          >
            {state.kind === 'picking' ? (
              <PersonPicker subject={subject} choices={state.choices} onPick={onPick} />
            ) : state.kind === 'checking' ? (
              delayedSpinner('Working out the merge…')
            ) : state.kind === 'refused' ? (
              <Refused message={state.message} />
            ) : (
              <Preview
                preview={state.preview}
                merging={state.kind === 'merging'}
                onConfirm={onConfirm}
                {...(onSwap !== undefined && { onSwap })}
              />
            )}
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Refused({ message }: { message: string }) {
  return (
    <>
      <Dialog.Title className="confirm__title">These people can’t be merged</Dialog.Title>
      <p className="confirm__warning" role="alert">
        {message}
      </p>
      <div className="confirm__actions">
        <Dialog.Close className="btn btn--secondary">Close</Dialog.Close>
      </div>
    </>
  );
}

function Preview({
  preview,
  merging,
  onSwap,
  onConfirm,
}: {
  preview: MergePreviewView;
  merging: boolean;
  onSwap?: () => void;
  onConfirm: () => void;
}) {
  const merged = listed(preview.merge);
  return (
    <>
      <Dialog.Title className="confirm__title">
        Merge {merged} into {preview.keep}?
      </Dialog.Title>
      <ul className="merge__summary" aria-label="What the merge changes">
        <li>
          {preview.links === 0
            ? `No other note links to ${merged}.`
            : `${counted(preview.links, 'link', 'links')} in ${counted(preview.notes, 'note', 'notes')} will open ${preview.keep}.`}
        </li>
        {preview.aliasesAdded.length > 0 && (
          <li>
            Adds {counted(preview.aliasesAdded.length, 'alias', 'aliases')}:{' '}
            {preview.aliasesAdded.join(', ')}.
          </li>
        )}
        {preview.emailsAdded.length > 0 && (
          <li>
            Adds {counted(preview.emailsAdded.length, 'email', 'emails')}:{' '}
            {preview.emailsAdded.join(', ')}.
          </li>
        )}
        {preview.bodies > 0 && (
          <li>
            Adds the text of {counted(preview.bodies, 'note', 'notes')} at the end, under “Merged
            from…”.
          </li>
        )}
      </ul>
      {preview.conflicts.length > 0 && (
        <section className="merge__conflicts" aria-label="Values kept as they are">
          <p className="confirm__body">{preview.keep} keeps its own value for:</p>
          <ul>
            {preview.conflicts.map((conflict) => (
              <li key={`${conflict.from}\u0000${conflict.key}`}>
                <span className="merge__key">{conflict.key}</span> {conflict.kept}{' '}
                <span className="merge__other">
                  (not {conflict.other}, from {conflict.from})
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <Dialog.Description className="confirm__body">
        {merged} {preview.merge.length === 1 ? 'goes' : 'go'} to the Trash. You can get{' '}
        {preview.merge.length === 1 ? 'it' : 'them'} back from the Trash in Finder.
      </Dialog.Description>
      <div className="confirm__actions">
        <Dialog.Close className="btn btn--secondary">Cancel</Dialog.Close>
        {onSwap !== undefined && (
          <button type="button" className="btn btn--secondary" onClick={onSwap} disabled={merging}>
            Keep {merged} instead
          </button>
        )}
        <button type="button" className="btn btn--primary" onClick={onConfirm} disabled={merging}>
          {merging ? 'Merging…' : 'Merge'}
        </button>
      </div>
    </>
  );
}

function PersonPicker({
  subject,
  choices,
  onPick,
}: {
  subject: string;
  choices: readonly MergePersonChoice[];
  onPick: (path: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const field = useRef<HTMLInputElement>(null);
  // The picker comes up after the people are read, inside a dialog already
  // open: the field takes the focus then, so typing a name goes straight in.
  useEffect(() => field.current?.focus(), []);
  const wanted = query.trim().toLowerCase();
  const shown = choices.filter((each) =>
    `${each.place} ${each.name}`.toLowerCase().includes(wanted),
  );
  const at = Math.min(selected, Math.max(0, shown.length - 1));
  const pick = (choice: MergePersonChoice | undefined) => {
    if (choice !== undefined) onPick(choice.path);
  };
  return (
    <>
      <div className="palette__field">
        <Icon name="person" size={19} className="palette__field-icon" />
        <input
          ref={field}
          className="palette__input"
          type="search"
          placeholder={`Merge ${subject} into…`}
          aria-label="Find the person to keep"
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
          {choices.length === 0 ? 'There is no one else to merge into.' : 'No person matches.'}
        </p>
      ) : (
        <ul className="palette__hits" role="listbox" aria-label="People">
          {shown.map((choice, index) => (
            <li key={choice.path}>
              <button
                type="button"
                role="option"
                aria-selected={index === at}
                className={index === at ? 'palette__hit palette__hit--on' : 'palette__hit'}
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(choice);
                }}
              >
                <span className="palette__kind">
                  <Icon name="person" size={16} />
                </span>
                <span className="palette__text">
                  <span className="palette__title">{choice.name}</span>
                  {choice.place !== '' && (
                    <span className="palette__detail">
                      <span className="palette__place">{choice.place}</span>
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
