import { movedPath, type EntryMove, type VaultPath } from '@dfai/domain';

/**
 * The app's overlays, and the rule that only one is ever up.
 *
 * One value rather than a flag each: two overlays at once means two focus
 * traps fighting, and a flag left set under another overlay pops its own open
 * the moment that one closes. The peek is the one layer below them (slice
 * 6b): a note over the panes, which an overlay may open above.
 */
export type Overlay =
  | 'search'
  | 'capture'
  | 'settings'
  | 'new-type'
  | 'new-view'
  | 'new-artifact'
  | 'add-pdf'
  | 'add-epub'
  | 'new-note-menu'
  | 'views-menu'
  | 'open-from-github'
  | 'template-delete'
  | 'template-to-note'
  | PeopleOverlay
  | ExportOverlay
  | QueryPopupOverlay
  | PagesOverlay
  | PageMenuOverlay
  | PanePopupOverlay;

/**
 * What Pages puts up: a row's menu, the section's "+", the folder picker for a
 * move and the question before a delete.
 */
export type PagesOverlay = 'tree-menu' | 'pages-menu' | 'move-picker' | 'delete-dialog';

/** Merging people (#464): the question before a merge, and the list of people who may be one. */
export type PeopleOverlay = 'merge-people' | 'people-duplicates';

/** Exporting notes (#501): the question of how, before the system's save dialog asks where. */
export type ExportOverlay = 'export-notes';

/** A popup on the query page — Save as view, Add to dashboard — by its name. */
export type QueryPopupOverlay = `query-${string}`;

/** A pane's "…" menu. One per pane, told apart by the pane's index. */
export type PageMenuOverlay = `page-menu-${number}`;

export function pageMenuOverlay(pane: number): PageMenuOverlay {
  return `page-menu-${pane}`;
}

/** Any other popup a pane draws — a widget's "…", a view's Filter or Sort — by its name in the pane. */
export type PanePopupOverlay = `pane-${number}-${string}`;

export function panePopupOverlay(pane: number, name: string): PanePopupOverlay {
  return `pane-${pane}-${name}`;
}

/**
 * A table cell's picker — a status's options, a relation's notes (#300) — by
 * its name among the pane's popups: one per pane, as only one cell edits.
 */
export const CELL_PICKER = 'cell-picker';

/** The palettes, Settings, New type, and Pages' picker and delete question. Each is a modal dialog; a menu is not a place, only a choice. */
const MODAL: ReadonlySet<Overlay> = new Set([
  'search',
  'capture',
  'settings',
  'new-type',
  'new-view',
  'new-artifact',
  'add-pdf',
  'add-epub',
  'move-picker',
  'delete-dialog',
  'template-delete',
  'template-to-note',
  'merge-people',
  'people-duplicates',
  'export-notes',
]);

/**
 * What is up once `requested` is asked for while `current` is.
 *
 * A palette holds the screen until it is closed: a shortcut for another overlay
 * pressed inside one is ignored rather than queued, since a queued one would
 * appear unasked later. A menu gives way, closing as the new overlay opens.
 */
export function openOverlay(current: Overlay | null, requested: Overlay): Overlay {
  if (current !== null && holdsTheScreen(current)) return current;
  return requested;
}

/**
 * Whether a palette or dialog is up. While one is, the window's shortcuts that
 * make or open a note — Cmd+N, Shift+Cmd+D, Alt+Cmd+N — do nothing, as a
 * shortcut for another overlay does: acting behind it makes a note the person
 * cannot see being made. Nothing is closed for them either; Escape first, then
 * the shortcut, is the same two presses and says which was meant.
 */
export function holdsTheScreen(current: Overlay | null): boolean {
  return current !== null && MODAL.has(current);
}

/**
 * What is up once `closing` closes. Only that overlay: one that reports closing
 * because another has just replaced it must not close its replacement.
 */
export function closeOverlay(current: Overlay | null, closing: Overlay): Overlay | null {
  return current === closing ? null : current;
}

/** What is typed into the search palette, and which result is chosen. */
export interface PaletteInput {
  readonly query: string;
  /** The chosen row, counting the commands first and then the notes. */
  readonly selected: number;
  /** Archived notes are left out of a search unless this is on (U-22). */
  readonly includeArchived: boolean;
}

export const NO_INPUT: PaletteInput = { query: '', selected: 0, includeArchived: false };

/** The list a peeked note was opened from, and where in it the note shown sits. */
export interface PeekFrom {
  /** What the list is, as the peek's header names it: "Task table". */
  readonly within: string;
  /** Its rows' notes, in the order the view's data drew them when the peek opened. */
  readonly order: readonly VaultPath[];
  readonly index: number;
}

/** The note in the center peek; `from` is null for one opened from no list (a link). */
export interface Peek {
  readonly path: VaultPath;
  readonly from: PeekFrom | null;
}

/**
 * The window's overlay state: the peek, the one overlay up above it, and what
 * the search palette holds. Two levels, never more: the peek, and a menu,
 * picker or palette over it.
 */
export interface OverlayState {
  readonly overlay: Overlay | null;
  readonly palette: PaletteInput;
  readonly peek: Peek | null;
}

export const NO_OVERLAY: OverlayState = { overlay: null, palette: NO_INPUT, peek: null };

/** `requested` asked for, by `openOverlay`'s rule. */
export function withOpened(state: OverlayState, requested: Overlay): OverlayState {
  return { ...state, overlay: openOverlay(state.overlay, requested) };
}

/**
 * `closing` closed, by `closeOverlay`'s rule. The search palette closed forgets
 * what was typed into it, however it closed: it opens empty the next time.
 */
export function withClosed(state: OverlayState, closing: Overlay): OverlayState {
  const overlay = closeOverlay(state.overlay, closing);
  const paletteClosed = state.overlay === 'search' && overlay !== 'search';
  return { ...state, overlay, palette: paletteClosed ? NO_INPUT : state.palette };
}

/** The peek a row of a view asks for: its note, where it sits in the rows it was clicked among. */
export function rowPeek({
  path,
  order,
  within,
}: {
  path: VaultPath;
  order: readonly VaultPath[];
  within: string;
}): Peek {
  const index = order.indexOf(path);
  return { path, from: index === -1 ? null : { within, order, index } };
}

/**
 * The peek opened on `peek`. Refused while anything is up — a menu, a picker,
 * a palette — rather than drawn above it: the peek is the lower layer, and a
 * menu left open under a modal peek could not be reached to close.
 */
export function withPeekOpened(state: OverlayState, peek: Peek): OverlayState {
  return state.overlay === null ? { ...state, peek } : state;
}

/**
 * Another note shown in the peek in place of the one there — a link followed
 * or a search result picked inside it — which comes from no list. Nothing
 * while no peek is up.
 */
export function withPeekReplaced(state: OverlayState, path: VaultPath): OverlayState {
  // A link to the note already shown keeps its place in the rows it steps through.
  if (state.peek === null || state.peek.path === path) return state;
  return { ...state, peek: { path, from: null } };
}

/**
 * The peek on row `index` of the list it was opened from; nothing past
 * either end. A row whose note is no longer `listed` — deleted by another
 * program since the peek opened — is stepped past, on in the same direction.
 */
export function withPeekStepped(
  state: OverlayState,
  index: number,
  listed: (path: VaultPath) => boolean = () => true,
): OverlayState {
  const from = state.peek?.from;
  if (from === undefined || from === null) return state;
  const direction = index < from.index ? -1 : 1;
  let at = index;
  while (from.order[at] !== undefined && !listed(from.order[at] as VaultPath)) at += direction;
  const path = from.order[at];
  if (path === undefined) return state;
  return { ...state, peek: { path, from: { ...from, index: at } } };
}

/** The peek closed. Whatever is up above it is the peek's own, and closes with it. */
export function withPeekClosed(state: OverlayState): OverlayState {
  return state.peek === null ? state : withClosedAbove({ ...state, peek: null });
}

function withClosedAbove(state: OverlayState): OverlayState {
  return state.overlay === null ? state : withClosed(state, state.overlay);
}

/**
 * Whether the window's shortcuts that make, open or arrange notes are held:
 * while a palette or dialog is up (`holdsTheScreen`), and while the peek is,
 * whose note is the one being worked on. ⌘K is not held by either rule.
 */
export function holdsShortcuts(state: Pick<OverlayState, 'overlay' | 'peek'>): boolean {
  return state.peek !== null || holdsTheScreen(state.overlay);
}

/** Where the peeked note sits, as its header says it; null for one opened from no list. */
export function peekPosition(
  peek: Peek | null,
): { index: number; count: number; within: string } | null {
  const from = peek?.from;
  if (from === undefined || from === null) return null;
  return { index: from.index, count: from.order.length, within: from.within };
}

/** The peek after a move or rename: its note, and the rows it steps through, where they went. */
export function peekAfterMove(peek: Peek | null, move: EntryMove): Peek | null {
  if (peek === null) return null;
  const follow = (path: VaultPath) => movedPath(path, move) ?? path;
  const path = follow(peek.path);
  const order = peek.from?.order.map(follow) ?? [];
  const unchanged = path === peek.path && order.every((row, at) => row === peek.from?.order[at]);
  if (unchanged) return peek;
  return { path, from: peek.from === null ? null : { ...peek.from, order } };
}

/** The peek once `gone` are deleted: closed when its note is, else stepping past them. */
export function peekWithout(peek: Peek | null, gone: readonly VaultPath[]): Peek | null {
  if (peek === null) return null;
  const deleted = new Set<string>(gone);
  if (deleted.has(peek.path)) return null;
  const from = peek.from;
  if (from === null || !from.order.some((path) => deleted.has(path))) return peek;
  const order = from.order.filter((path) => !deleted.has(path));
  return { path: peek.path, from: { ...from, order, index: order.indexOf(peek.path) } };
}

/**
 * The overlay the window draws itself: any but the search palette, which
 * watches for itself, so that opening it and typing into it draws nothing
 * else (#261).
 */
export function drawnByWindow(state: OverlayState): Overlay | null {
  return state.overlay === 'search' ? null : state.overlay;
}

/** A new query, with the first result chosen. */
export function withQuery(input: PaletteInput, query: string): PaletteInput {
  return { ...input, query, selected: 0 };
}

/** Archived notes let in or left out, with the first result chosen. */
export function withArchived(input: PaletteInput, includeArchived: boolean): PaletteInput {
  return { ...input, includeArchived, selected: 0 };
}

/** The choice moved `delta` rows through `count`, wrapping at either end. */
export function withMoved(input: PaletteInput, delta: number, count: number): PaletteInput {
  return { ...input, selected: count === 0 ? 0 : (input.selected + delta + count) % count };
}

/** The overlay a pane draws itself — its "…" menu or one of its popups — or null while none of its own is up. */
export function paneOverlayOf(overlay: Overlay | null, pane: number): Overlay | null {
  if (overlay === null) return null;
  return overlay === pageMenuOverlay(pane) || overlay.startsWith(`pane-${pane}-`) ? overlay : null;
}
