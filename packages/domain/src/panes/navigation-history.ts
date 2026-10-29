import type { GraphScope } from '../graph/graph-scope.ts';
import { movedPath, type EntryMove } from '../vault/vault-moves.ts';
import type { VaultPath } from '../vault/vault-path.ts';

/**
 * Something a pane can be showing, and so be taken back to: a note (which is
 * also how a view, a dashboard or a source is opened), or one of the pages
 * that take the main area over — a type, the graph, the query page, the tags
 * (with the tag whose notes are listed, if one is), the Library and All
 * highlights (#507), and Ask (#37).
 */
export type NavigationPlace =
  | { readonly kind: 'note'; readonly path: VaultPath }
  | { readonly kind: 'type'; readonly name: string }
  | { readonly kind: 'graph'; readonly scope: GraphScope }
  | { readonly kind: 'query' }
  | { readonly kind: 'tags'; readonly tag: string | null }
  | { readonly kind: 'archive' }
  | { readonly kind: 'inbox' }
  | { readonly kind: 'review' }
  | { readonly kind: 'today' }
  | { readonly kind: 'automations' }
  | { readonly kind: 'activity' }
  | { readonly kind: 'templates' }
  | { readonly kind: 'terms' }
  /** The Skills page (#169, ADR-0050). */
  | { readonly kind: 'skills' }
  | { readonly kind: 'library' }
  | { readonly kind: 'highlights' }
  | { readonly kind: 'ask' }
  /** A PDF open in the reader (#504), by the file's own path. */
  | { readonly kind: 'document'; readonly path: VaultPath };

/** A place that is a page rather than a note: what a tab draws without an editor. */
export type PagePlace = Exclude<NavigationPlace, { kind: 'note' }>;

/**
 * One pane's Back and Forward, as a browser keeps them.
 *
 * `current` is null while the pane shows nothing it could return to — before
 * anything is opened, or after the note it showed was deleted — and Back then
 * goes to the last place before it.
 */
export interface NavigationHistory {
  /** Oldest first; the last is where Back goes. */
  readonly back: readonly NavigationPlace[];
  readonly current: NavigationPlace | null;
  /** Nearest first; the first is where Forward goes. */
  readonly forward: readonly NavigationPlace[];
}

export const NO_HISTORY: NavigationHistory = { back: [], current: null, forward: [] };

/** How many places Back remembers; older ones are forgotten first. */
export const HISTORY_LIMIT = 50;

/** Whether two places are the same page, so revisiting one is not a step. */
export function samePlace(left: NavigationPlace, right: NavigationPlace): boolean {
  switch (left.kind) {
    case 'note':
      return right.kind === 'note' && right.path === left.path;
    case 'type':
      return right.kind === 'type' && right.name === left.name;
    case 'graph':
      return right.kind === 'graph' && sameScope(left.scope, right.scope);
    case 'query':
      return right.kind === 'query';
    case 'tags':
      return right.kind === 'tags' && right.tag === left.tag;
    case 'archive':
      return right.kind === 'archive';
    case 'inbox':
      return right.kind === 'inbox';
    case 'review':
      return right.kind === 'review';
    case 'today':
      return right.kind === 'today';
    case 'automations':
      return right.kind === 'automations';
    case 'activity':
      return right.kind === 'activity';
    case 'templates':
      return right.kind === 'templates';
    case 'terms':
      return right.kind === 'terms';
    case 'skills':
      return right.kind === 'skills';
    case 'library':
      return right.kind === 'library';
    case 'highlights':
      return right.kind === 'highlights';
    case 'ask':
      return right.kind === 'ask';
    case 'document':
      return right.kind === 'document' && right.path === left.path;
  }
}

function sameScope(left: GraphScope, right: GraphScope): boolean {
  if (left.kind === 'vault' || right.kind === 'vault') return left.kind === right.kind;
  return left.path === right.path && left.depth === right.depth;
}

/**
 * Records that the pane now shows `place`. Opening something new forgets
 * whatever Forward held, as a browser does; showing the place already current
 * is not a step, and hands back the same history.
 */
export function visit(history: NavigationHistory, place: NavigationPlace): NavigationHistory {
  const { current } = history;
  if (current !== null && samePlace(current, place)) return history;
  const back = current === null ? history.back : [...history.back, current];
  return { back: back.slice(-HISTORY_LIMIT), current: place, forward: [] };
}

/** One step back, or the same history when there is nowhere to go. */
export function goBack(history: NavigationHistory): NavigationHistory {
  const target = backPlace(history);
  if (target === null) return history;
  const forward =
    history.current === null ? history.forward : [history.current, ...history.forward];
  return { back: history.back.slice(0, -1), current: target, forward };
}

/** One step forward, or the same history when there is nowhere to go. */
export function goForward(history: NavigationHistory): NavigationHistory {
  const target = forwardPlace(history);
  if (target === null) return history;
  const back = history.current === null ? history.back : [...history.back, history.current];
  return { back: back.slice(-HISTORY_LIMIT), current: target, forward: history.forward.slice(1) };
}

/** Where Back would go, or null when it is disabled. */
export function backPlace(history: NavigationHistory): NavigationPlace | null {
  return history.back.at(-1) ?? null;
}

/** Where Forward would go, or null when it is disabled. */
export function forwardPlace(history: NavigationHistory): NavigationPlace | null {
  return history.forward[0] ?? null;
}

/**
 * Forgets every place that shows a note which is gone — the note itself, or a
 * graph centred on it — so Back and Forward never lead to a deleted note. Two
 * places left side by side that are the same page become one step.
 */
export function forgetNotes(
  history: NavigationHistory,
  gone: (path: VaultPath) => boolean,
): NavigationHistory {
  const kept = (place: NavigationPlace) => {
    const path = placePath(place);
    return path === null || !gone(path);
  };
  const current = history.current !== null && kept(history.current) ? history.current : null;
  const back = withoutRepeats(history.back.filter(kept));
  const forward = withoutRepeats(history.forward.filter(kept));
  const nextBack = current !== null && endsWith(back, current) ? back.slice(0, -1) : back;
  const nextForward = current !== null && startsWith(forward, current) ? forward.slice(1) : forward;
  if (
    current === history.current &&
    nextBack.length === history.back.length &&
    nextForward.length === history.forward.length
  ) {
    return history;
  }
  return { back: nextBack, current, forward: nextForward };
}

/**
 * Follows a move or a rename: every place on a moved note is where it went.
 * The same history when no place was on it.
 */
export function followMoveInHistory(
  history: NavigationHistory,
  move: EntryMove,
): NavigationHistory {
  let followed = false;
  const follow = (place: NavigationPlace): NavigationPlace => {
    if (place.kind === 'note' || place.kind === 'document') {
      const to = movedPath(place.path, move);
      if (to === null) return place;
      followed = true;
      return { kind: place.kind, path: to };
    }
    if (place.kind === 'graph' && place.scope.kind === 'note') {
      const to = movedPath(place.scope.path, move);
      if (to === null) return place;
      followed = true;
      return { kind: 'graph', scope: { ...place.scope, path: to } };
    }
    return place;
  };
  const next = {
    back: history.back.map(follow),
    current: history.current === null ? null : follow(history.current),
    forward: history.forward.map(follow),
  };
  return followed ? next : history;
}

/** The note (or document) a place shows, if it shows one. */
function placePath(place: NavigationPlace): VaultPath | null {
  if (place.kind === 'note' || place.kind === 'document') return place.path;
  if (place.kind === 'graph' && place.scope.kind === 'note') return place.scope.path;
  return null;
}

function withoutRepeats(places: readonly NavigationPlace[]): NavigationPlace[] {
  return places.filter(
    (place, at) => at === 0 || !samePlace(places[at - 1] as NavigationPlace, place),
  );
}

function endsWith(places: readonly NavigationPlace[], place: NavigationPlace): boolean {
  const last = places.at(-1);
  return last !== undefined && samePlace(last, place);
}

function startsWith(places: readonly NavigationPlace[], place: NavigationPlace): boolean {
  const first = places[0];
  return first !== undefined && samePlace(first, place);
}
