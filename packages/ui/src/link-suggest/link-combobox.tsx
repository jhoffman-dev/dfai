import { useId, useRef, useState } from 'react';
import { isImeKey } from '../ime.ts';
import type { RelationChoice } from '../properties-panel.tsx';
import { LinkSuggestions, type CreateLink, type ListKeys } from './link-suggestions.tsx';

/**
 * A link or relation field that suggests notes as you type (#465): the one
 * picker for a relation everywhere a link is set outside the editor — the
 * properties panel, the right sidebar and the peek, a table's cell, quick
 * add and the Inbox. An ARIA combobox over `LinkSuggestions`.
 *
 * It opens as it takes the focus, is clicked or is typed in, and only then
 * asks for what it offers (`onOpen`): a field nobody opens reads nothing.
 * Esc with something typed takes it back and closes the list, and only the
 * list; with nothing typed — or a second Esc — it is the page's as well.
 * Picking hands the note over (`onPick`) — how it is written is the
 * caller's, as it was for the select this replaces — and empties the field.
 * Leaving the field takes back what was typed, unless the caller follows it
 * (`onTyped`): then it stays, for the caller to refuse a save over (#823).
 * Blanks alone are nothing typed: left, or passed by Enter, the field shows
 * what it holds again — clearing it takes back the text, never the link, so
 * the field never shows empty over a link a save would write.
 */
export function LinkCombobox({
  id,
  label,
  placeholder,
  current,
  choices,
  creates,
  onPick,
  onCreate,
  onOpen,
  initialTyped,
  onTyped,
  disabled = false,
  field,
  className = 'link-combo__input',
}: {
  id?: string;
  /** What the field is called, where no `<label>` names it by `id`: "File Weekly review under". */
  label?: string;
  placeholder: string;
  /** What the field holds now, shown while nothing is being typed: a project's title. */
  current?: string;
  /** The notes it may link, before any typing narrows them. */
  choices: readonly RelationChoice[];
  /** The types a note may be made of from what is typed. */
  creates?: readonly string[];
  onPick: (choice: RelationChoice) => void;
  /** Makes a note of `target` called `name` and links it; rejects with why not. */
  onCreate?: (request: CreateLink) => Promise<void>;
  /** The list is opening: what it offers may be gathered only now. */
  onOpen?: () => void;
  /** What the caller kept typed while the field was not drawn — a row scrolled away: shown as it returns. */
  initialTyped?: string;
  /** What is typed and not picked, as it changes; null when nothing is. Given, leaving keeps it. */
  onTyped?: (typed: string | null) => void;
  disabled?: boolean;
  /** Which picker a triage key opens: named so the key finds it. */
  field?: string;
  className?: string;
}) {
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const keys = useRef<ListKeys | null>(null);
  const [open, setOpen] = useState(false);
  /** What is typed; null while nothing is, and the field shows what it holds. */
  const [typed, setTypedHere] = useState<string | null>(initialTyped ?? null);
  const blank = typed === null || typed.trim() === '';
  const setTyped = (next: string | null) => {
    setTypedHere(next);
    onTyped?.(next === null || next.trim() === '' ? null : next);
  };

  const show = () => {
    if (open || disabled) return;
    onOpen?.();
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    setTyped(null);
    keys.current = null;
  };

  return (
    <span className="link-combo" data-open={open ? '' : undefined}>
      <input
        ref={input}
        id={id}
        className={className}
        role="combobox"
        {...(label !== undefined && { 'aria-label': label })}
        aria-autocomplete="list"
        aria-expanded={open}
        {...(open && { 'aria-controls': listId })}
        {...(field !== undefined && { 'data-field': field })}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        disabled={disabled}
        value={typed ?? current ?? ''}
        // As wide as what it shows, so a relation's chip hugs its prompt as the select did.
        // As wide as its prompt or what it holds, and no wider as you type.
        size={Math.max(MIN_SIZE, placeholder.length, (current ?? '').length) + 1}
        onFocus={(event) => {
          // What it holds is selected, so typing replaces it.
          if (current !== undefined) event.currentTarget.select();
          keepInView(event.currentTarget);
          show();
        }}
        onClick={show}
        onBlur={() => {
          if (onTyped === undefined || blank) close();
          else setOpen(false);
        }}
        onChange={(event) => {
          setTyped(event.target.value);
          show();
        }}
        onKeyDown={(event) => {
          if (isImeKey(event)) return;
          if (event.key === 'Escape' && open) {
            // With something typed, Esc takes it back and closes the list, not the
            // popover or the row it is in; with nothing typed, it is theirs too.
            if (typed !== null) {
              event.preventDefault();
              event.stopPropagation();
            }
            close();
            return;
          }
          if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            show();
            return;
          }
          // Enter the list will not take goes to the page, which may save: the field shows what it holds first.
          if (event.key === 'Enter' && typed !== null && blank) setTyped(null);
          if (open) keys.current?.(event);
        }}
      />
      {open && (
        <LinkSuggestions
          listId={listId}
          inputRef={input}
          keysRef={keys}
          query={typed ?? ''}
          choices={choices}
          {...(creates !== undefined && { creates })}
          onPick={(choice) => {
            close();
            onPick(choice);
          }}
          {...(onCreate !== undefined && {
            onCreate: (request: CreateLink) => onCreate(request).then(close),
          })}
        />
      )}
    </span>
  );
}

/** The fewest characters a link field is wide enough for. */
const MIN_SIZE = 8;

/**
 * Brings a field the keyboard focused into view. WebKit leaves a text field
 * that Shift+Tab reaches in a row the Inbox's list has only just placed out
 * of sight, as it does not a button (#247); jsdom has no scrollIntoView.
 */
function keepInView(field: HTMLInputElement) {
  if (typeof field.scrollIntoView === 'function') field.scrollIntoView({ block: 'nearest' });
}
