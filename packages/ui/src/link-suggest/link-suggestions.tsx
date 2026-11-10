import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import {
  createVaultPath,
  linkMatchOf,
  newLinkName,
  placeCrumb,
  rankLinkChoices,
  relationGroupLabel,
  relationHue,
  type LinkSuggestion,
} from '@dfai/domain';
import { Icon } from '../icon.tsx';
import { isImeKey } from '../ime.ts';
import { useNoteNames } from '../note-names.tsx';
import type { RelationChoice } from '../properties-panel.tsx';
import { useLinkHints } from './link-hints.tsx';

/** A note to make from what was typed, of one of the types the field points at. */
export interface CreateLink {
  readonly target: string;
  readonly name: string;
}

/** The open list's answer to a key on the field it hangs from: whether it took the key. */
export type ListKeys = (event: KeyboardEvent<HTMLInputElement>) => boolean;

/** Offer every note there is: `[[` typed in a plain text field, which keeps to no type. */
export const EVERY_NOTE = 'every note';

type Row =
  | { readonly kind: 'note'; readonly suggestion: LinkSuggestion<RelationChoice> }
  | { readonly kind: 'create'; readonly target: string };

/**
 * The suggestions under a link field while it is open (#465): the notes that
 * meet what was typed, ranked by `rankLinkChoices` — aliases and use read
 * from the app only now, as the list opens — then "Create <type> '<typed>'"
 * when no note is called that. Each row says the note's title, the alias it
 * matched by, its type in that type's hue, and its folder.
 *
 * The focus never leaves the field: the field hands its keys here (`keysRef`)
 * and the active row is named on it as its active descendant. ↑ ↓ move, ↵
 * picks, Tab takes the active row once something is typed; none of them
 * while an input method is composing.
 */
export function LinkSuggestions({
  listId,
  inputRef,
  keysRef,
  query,
  choices,
  creates = NO_TYPES,
  onPick,
  onCreate,
}: {
  listId: string;
  inputRef: RefObject<HTMLInputElement | null>;
  /** Where the field finds the list's answer to its keys. */
  keysRef: RefObject<ListKeys | null>;
  query: string;
  choices: readonly RelationChoice[] | typeof EVERY_NOTE;
  /** The types a note can be made of here; none, and nothing is offered to be made. */
  creates?: readonly string[];
  onPick: (choice: RelationChoice) => void;
  onCreate?: (request: CreateLink) => Promise<void>;
}) {
  const source = useLinkHints();
  const { want } = source;
  useEffect(want, [want]);
  const rows = useRows({ query, choices, creates, offersCreate: onCreate !== undefined });
  const active = useActiveRow(rows, query);
  const making = useMaking(onCreate);
  const choose = (row: Row) => {
    if (row.kind === 'note') onPick(row.suggestion.choice);
    else making.create({ target: row.target, name: query.trim() });
  };
  const onKey: ListKeys = (event) => {
    if (isImeKey(event) || making.busy) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      active.step(event.key === 'ArrowDown' ? 1 : -1);
      return true;
    }
    const row = rows[active.at];
    // Tab takes a note that is there, never "Create": a typo then Tab makes nothing.
    const takes =
      event.key === 'Enter' || (event.key === 'Tab' && query.trim() !== '' && row?.kind === 'note');
    if (!takes || row === undefined) return false;
    event.preventDefault();
    event.stopPropagation();
    choose(row);
    return true;
  };
  // Handed to the field after each render, so its keys meet the rows as drawn.
  useLayoutEffect(() => {
    keysRef.current = onKey;
    return () => {
      keysRef.current = null;
    };
  });
  const activeId = active.at < 0 ? null : `${listId}-${active.at}`;
  useActiveDescendant(inputRef, activeId);
  const listRef = useRef<HTMLUListElement>(null);
  usePlacedUnder(inputRef, listRef);
  useActiveInView(listRef, activeId);

  const problem = making.problem ?? source.problem;
  if (rows.length === 0 && problem === null) return null;
  return (
    <ul
      ref={listRef}
      id={listId}
      role="listbox"
      aria-label="Suggested notes"
      className="link-suggest"
    >
      {rows.map((row, index) => (
        <li
          key={keyOf(row)}
          id={`${listId}-${index}`}
          role="option"
          aria-label={row.kind === 'note' ? spokenName(row.suggestion) : undefined}
          aria-selected={index === active.at}
          aria-disabled={(row.kind === 'create' && making.busy) || undefined}
          className={
            index === active.at ? 'link-suggest__row link-suggest__row--on' : 'link-suggest__row'
          }
          // Before the field's blur, which would close the list under the pointer.
          onMouseDown={(event) => event.preventDefault()}
          // One highlight: the row under the pointer is the row ↵ would take.
          onMouseEnter={() => active.point(row)}
          onClick={() => {
            if (!making.busy) choose(row);
          }}
        >
          {row.kind === 'note' ? (
            <SuggestedNote suggestion={row.suggestion} />
          ) : (
            <span className="link-suggest__create">
              <Icon name="plus" size={14} />
              Create {row.target} ‘{query.trim()}’
            </span>
          )}
        </li>
      ))}
      {problem !== null && (
        <li className="link-suggest__problem" role="alert">
          {problem}
        </li>
      )}
    </ul>
  );
}

/**
 * The rows the list offers: the notes that meet the query, ranked, then a
 * "Create" per type — only when no note anywhere in the vault is already
 * called what was typed, linked here or not, of this type or another (#469):
 * the picker is handed only the notes it may still link, so it alone cannot
 * tell.
 */
function useRows({
  query,
  choices,
  creates,
  offersCreate,
}: {
  query: string;
  choices: readonly RelationChoice[] | typeof EVERY_NOTE;
  creates: readonly string[];
  offersCreate: boolean;
}): readonly Row[] {
  const source = useLinkHints();
  const names = useNoteNames();
  const offered = choices === EVERY_NOTE ? (source.notes ?? NO_CHOICES) : choices;
  const ranked = useMemo(
    () => rankLinkChoices({ query, choices: offered, hints: source.hints }),
    [query, offered, source.hints],
  );
  // Any note answers: one this picker offers, one it may not (linked already, of
  // another type, archived) by its link, or by its title from the vault's notes.
  const answers = (name: string) =>
    names.opens(`[[${name}]]`) !== null ||
    [...offered, ...(source.notes ?? NO_CHOICES)].some(
      (note) => linkMatchOf(note.title, name) === 'exact',
    );
  const made = offersCreate ? newLinkName(query, answers) : null;
  const makes = made !== null && 'name' in made ? creates : NO_TYPES;
  return [
    ...ranked.map((suggestion) => ({ kind: 'note' as const, suggestion })),
    ...makes.map((target) => ({ kind: 'create' as const, target })),
  ];
}

const keyOf = (row: Row): string =>
  row.kind === 'note' ? row.suggestion.choice.path : `create:${row.target}`;

/**
 * Which row ↵ takes: the one the person moved to, followed by the note it
 * is, not its place — the rows reorder as the hints land, and ↵ must still
 * take the note that was highlighted (#469). Until they move: the best match
 * once something is typed, none before. ↓ from none is the first row, ↑ the
 * last; both wrap.
 */
function useActiveRow(rows: readonly Row[], query: string) {
  const [moved, setMoved] = useState<{ query: string; key: string } | null>(null);
  const followed = moved?.query === query ? rows.findIndex((row) => keyOf(row) === moved.key) : -1;
  const at = followed >= 0 ? followed : query.trim() === '' || rows.length === 0 ? -1 : 0;
  const goTo = (index: number) => {
    const row = rows[index];
    if (row !== undefined) setMoved({ query, key: keyOf(row) });
  };
  return {
    at,
    step: (by: 1 | -1) => {
      if (rows.length === 0) return;
      goTo(at < 0 ? (by === 1 ? 0 : rows.length - 1) : (at + by + rows.length) % rows.length);
    },
    point: (row: Row) => setMoved({ query, key: keyOf(row) }),
  };
}

/** Keeps the active row in sight as ↑ and ↓ move past the rows the list shows. */
function useActiveInView(listRef: RefObject<HTMLUListElement | null>, activeId: string | null) {
  useLayoutEffect(() => {
    if (activeId === null) return;
    const row = listRef.current?.ownerDocument.getElementById(activeId);
    // jsdom has no scrollIntoView, hence the guard.
    if (row !== null && row !== undefined && typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ block: 'nearest' });
    }
  }, [listRef, activeId]);
}

function SuggestedNote({ suggestion }: { suggestion: LinkSuggestion<RelationChoice> }) {
  const { choice, alias } = suggestion;
  return (
    <>
      <span className="link-suggest__title">{choice.title}</span>
      {alias !== null && <span className="link-suggest__alias">{alias}</span>}
      <span className="link-suggest__where">
        {choice.type !== undefined && (
          <span className="link-suggest__type" data-hue={relationHue({ key: choice.type })}>
            {relationGroupLabel(choice.type)}
          </span>
        )}
        <span className="link-suggest__folder">
          {placeCrumb(createVaultPath(choice.path)).parent}
        </span>
      </span>
    </>
  );
}

/** What a screen reader says for a note offered: "Mara Quill, also MQ, person, People". */
function spokenName({ choice, alias }: LinkSuggestion<RelationChoice>): string {
  return [
    choice.title,
    alias === null ? null : `also ${alias}`,
    choice.type === undefined ? null : relationGroupLabel(choice.type),
    placeCrumb(createVaultPath(choice.path)).parent,
  ]
    .filter((part) => part !== null)
    .join(', ');
}

/** A note being made from the list: whether one is, and why the last could not be. */
function useMaking(onCreate: ((request: CreateLink) => Promise<void>) | undefined) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Read as the key lands, before a render: a second ↵ would make a second note.
  const making = useRef(false);
  return {
    busy,
    problem,
    create: (request: CreateLink) => {
      if (onCreate === undefined || making.current) return;
      making.current = true;
      setBusy(true);
      setProblem(null);
      onCreate(request).then(
        () => {
          making.current = false;
          setBusy(false);
        },
        (cause: unknown) => {
          making.current = false;
          setBusy(false);
          setProblem(cause instanceof Error ? cause.message : String(cause));
        },
      );
    },
  };
}

/**
 * Names the active row on the field, as ARIA's combobox has it. Set on the
 * element here rather than rendered by the field, which does not know the
 * rows; the field never renders the attribute itself, so nothing contends.
 */
function useActiveDescendant(input: RefObject<HTMLInputElement | null>, id: string | null) {
  useLayoutEffect(() => {
    const field = input.current;
    if (field === null) return;
    if (id === null) field.removeAttribute('aria-activedescendant');
    else field.setAttribute('aria-activedescendant', id);
    return () => field.removeAttribute('aria-activedescendant');
  }, [input, id]);
}

/** The gap between the field and its list, in pixels. */
const GAP = 4;

/**
 * Places the list under its field on the window — above it when the window
 * has no room below — so no scrolling sheet or table row it sits in cuts it
 * off: an Inbox row's list once showed two notes of five. Fixed, then put
 * right by however far an ancestor that holds fixed things (a transformed
 * popover) moved it. Written on the element, not rendered: nothing draws
 * again as the page scrolls under an open list.
 *
 * Placed again as the page scrolls, the window resizes, or anything holding
 * the field changes size: a row above it that grows on a re-read moves the
 * field with no scroll, and a list left where it was jumps back under the
 * field at the next render — between a click's press and its release (#823).
 */
function usePlacedUnder(
  inputRef: RefObject<HTMLInputElement | null>,
  listRef: RefObject<HTMLUListElement | null>,
) {
  // Each render: what the list holds sets how tall it is, and so where it goes.
  useLayoutEffect(() => placeUnder(inputRef.current, listRef.current));
  useLayoutEffect(() => {
    const again = () => placeUnder(inputRef.current, listRef.current);
    window.addEventListener('scroll', again, true);
    window.addEventListener('resize', again);
    const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(again);
    for (let holder = inputRef.current?.parentElement; holder; holder = holder.parentElement) {
      resized?.observe(holder);
    }
    return () => {
      window.removeEventListener('scroll', again, true);
      window.removeEventListener('resize', again);
      resized?.disconnect();
    };
  }, [inputRef, listRef]);
}

function placeUnder(field: HTMLInputElement | null, list: HTMLUListElement | null) {
  if (field === null || list === null) return;
  list.style.position = 'fixed';
  const spot = placeOf(field.getBoundingClientRect(), list);
  list.style.maxHeight = `${spot.height}px`;
  list.style.top = `${spot.top}px`;
  list.style.left = `${spot.left}px`;
  const landed = list.getBoundingClientRect();
  list.style.top = `${2 * spot.top - landed.top}px`;
  list.style.left = `${2 * spot.left - landed.left}px`;
}

/** The tallest the list is drawn, as the stylesheet has it. */
const MOST_TALL = 280;

/**
 * Where the list goes for a field at `under`: below it, or above when there
 * is more room above; no taller than the room on that side; and moved left
 * as far as it must to stay inside the window, never past its left edge.
 */
function placeOf(under: DOMRect, list: HTMLElement): { top: number; left: number; height: number } {
  const roomBelow = window.innerHeight - under.bottom - 2 * GAP;
  const roomAbove = under.top - 2 * GAP;
  const wanted = Math.min(list.scrollHeight || MOST_TALL, MOST_TALL);
  const below = roomBelow >= wanted || roomBelow >= roomAbove;
  const height = Math.max(0, Math.min(MOST_TALL, below ? roomBelow : roomAbove));
  const tall = Math.min(wanted, height);
  const top = below ? under.bottom + GAP : under.top - GAP - tall;
  const wide = list.getBoundingClientRect().width;
  const left = Math.max(GAP, Math.min(under.left, window.innerWidth - GAP - wide));
  return { top, left, height };
}

const NO_TYPES: readonly string[] = [];
const NO_CHOICES: readonly RelationChoice[] = [];
