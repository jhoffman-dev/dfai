import {
  linkFragment,
  namesDocument,
  placeOfFile,
  resolveWikiLinkTarget,
  SOURCE_KIND_NAMES,
  type HighlightOpening,
  type NavigationPlace,
  type TabId,
  type VaultPath,
} from '@dfai/domain';
import type { HighlightPlaceOpener } from '@dfai/application';
import type { OpenHow } from '@dfai/ui';
import { requestReveal, type RevealStore } from '../panes/reveals.ts';
import {
  closePeek,
  openPeek,
  peekNow,
  peekOpening,
  replacePeek,
  type OverlayStore,
} from '../overlay-store.ts';
import {
  focusPane,
  openInPane,
  openPlace,
  workspaceNow,
  type WorkspaceStore,
} from './workspace-store.ts';

/**
 * Opens a note from outside the panes — the sidebar, search, a new note —
 * where the click asked: here, in a new tab, or in a split. The one rule
 * every open follows is the domain's (`openInActiveTab`): here means where
 * you are working.
 */
export function openNote(store: WorkspaceStore, path: VaultPath, how: OpenHow = 'here'): void {
  // A PDF or an EPUB in Pages or search opens in its reader (#504, #505), not as a note.
  openPlace(store, placeOfFile(path), how);
}

/**
 * Opens the PDF or EPUB at `path` in its reader, where asked, brought to
 * highlight `highlightId` and flashing it once the reader has placed it
 * (#504, #505); no
 * highlight opens it at its start. What a transcluded highlight's click
 * calls (#506).
 */
export function openDocumentAt(
  { store, reveals }: { store: WorkspaceStore; reveals: RevealStore },
  {
    path,
    highlightId,
    how = 'here',
  }: { path: VaultPath; highlightId: string | null; how?: OpenHow },
): void {
  openPlace(store, { kind: 'document', path }, how);
  if (highlightId !== null) revealInFocused({ store, reveals }, { path, blockId: highlightId });
}

/** Opens note `path` where asked, brought to block `blockId`, as a link to it does. */
function openNoteAt(
  { store, reveals }: { store: WorkspaceStore; reveals: RevealStore },
  { path, blockId, how }: { path: VaultPath; blockId: string; how: OpenHow },
): void {
  openPlace(store, { kind: 'note', path }, how);
  revealInFocused({ store, reveals }, { path, blockId });
}

function revealInFocused(
  { store, reveals }: { store: WorkspaceStore; reveals: RevealStore },
  { path, blockId }: { path: VaultPath; blockId: string },
): void {
  const ws = workspaceNow(store);
  const shown = ws.panes[ws.focused];
  if (shown === undefined) return;
  requestReveal(reveals, { tab: shown.active, path, fragment: { kind: 'block', id: blockId } });
}

/**
 * Opens a highlight's place from outside a note's links — a library or
 * all-highlights row (#507) — where the click asked: the reader at it, or
 * its note at the block. Handed to `openHighlightPlace`, which says which.
 */
export function highlightPlaceOpener(
  opening: { store: WorkspaceStore; reveals: RevealStore },
  how: OpenHow = 'here',
): HighlightPlaceOpener {
  return {
    openDocument: ({ path, highlightId }) => openDocumentAt(opening, { path, highlightId, how }),
    openNote: ({ path, blockId }) => openNoteAt(opening, { path, blockId, how }),
  };
}

/**
 * Where a link leads when that takes reading a file to know (#506): a block
 * that is a highlight opens its document's reader, and `[[…pdf]]` or
 * `[[…epub]]` names a document rather than a note. Left out, every link opens a note, as before.
 */
export interface LinkPlaces {
  /** Where following block `blockId` of `note` leads (`whereHighlightOpens`). */
  readonly blockOpening: (args: { note: VaultPath; blockId: string }) => Promise<HighlightOpening>;
  /** The document a `[[…pdf]]` or `[[…epub]]` link names (`linkedDocument`), or null when it names none. */
  readonly linkedDocument: (target: string) => Promise<VaultPath | null>;
}

/**
 * Opens a note at one of its blocks, where asked, as following
 * `[[Note#^id]]` does: a highlight's row in All highlights, or its hit in
 * search (#507). The block is brought into view in the tab it opened in.
 */
export function openNoteAtBlock(
  { store, reveals }: { store: WorkspaceStore; reveals: RevealStore },
  { path, block, how = 'here' }: { path: VaultPath; block: string; how?: OpenHow },
): void {
  openPlace(store, { kind: 'note', path }, how);
  const ws = workspaceNow(store);
  const shown = ws.panes[ws.focused];
  if (shown !== undefined) {
    requestReveal(reveals, { tab: shown.active, path, fragment: { kind: 'block', id: block } });
  }
}

/** What following a link needs beside the store. */
export interface LinkFollowing {
  readonly store: WorkspaceStore;
  readonly reveals: RevealStore;
  readonly notePaths: readonly VaultPath[];
  /** Told the problem with a link that leads nowhere, or null once one leads somewhere. */
  readonly onProblem: (message: string | null) => void;
  readonly places?: LinkPlaces;
}

/**
 * Follows a wiki link in the pane it was clicked in, never the other one:
 * a link opens where you are reading, so the note beside it is still there
 * to be read against. ⌘-click opens it in a new tab beside this one and
 * ⌘⇧-click beside, in a split, as a sidebar row does (tab-model.md §5.2).
 * `[[Note#^id]]` and `[[Note#Heading]]` open the note there (P26-03);
 * `[[#^id]]`, naming no note, is a place in the note it is in.
 */
export function followLink(
  following: LinkFollowing,
  {
    pane,
    target,
    heading = null,
    how = 'here',
  }: { pane: number; target: string; heading?: string | null; how?: OpenHow },
): void {
  const fragment = heading === null ? null : linkFragment({ heading });
  const current = beginClick(following, { pane, how, inPeek: false });
  const open = (linked: Linked) => {
    const paneNow = current();
    if (paneNow !== null) openLinked(following, { pane: paneNow, linked, how });
  };
  const asNote = () => {
    const here = placeIn(following.store, pane);
    const resolved = linkedNote(following, {
      target,
      fragment,
      here: here?.kind === 'note' ? here.path : null,
    });
    if (resolved !== null) openNoteLinked(following, { path: resolved, fragment, open });
  };
  if (!followedLater(following, { target, fragment, open, current, otherwise: asNote })) asNote();
}

type Fragment = ReturnType<typeof linkFragment>;

/** Where a followed link leads: a page, and the place in it to bring into view. */
interface Linked {
  readonly place: Extract<NavigationPlace, { kind: 'note' | 'document' }>;
  readonly fragment: Fragment | null;
}

/** Opens a linked page in a pane, where the click asked, at its fragment when it names one. */
function openLinked(
  { store, reveals }: Pick<LinkFollowing, 'store' | 'reveals'>,
  { pane, linked, how }: { pane: number; linked: Linked; how: OpenHow },
): void {
  const { place, fragment } = linked;
  if (how === 'here') openInPane(store, { pane, place });
  else {
    // The new tab goes beside the tab the link was clicked in, so that pane takes the focus first.
    focusPane(store, pane);
    openPlace(store, place, how);
  }
  if (fragment === null) return;
  const ws = workspaceNow(store);
  const shown = ws.panes[ws.focused];
  if (shown !== undefined) {
    requestReveal(reveals, { tab: shown.active, path: place.path, fragment });
  }
}

/**
 * Opens the note a link resolved to, at its fragment — or, for a block that
 * is a highlight of a source with a reader, that reader at the highlight
 * (#506), once its note has been read to know which.
 */
function openNoteLinked(
  { places, onProblem }: Pick<LinkFollowing, 'places' | 'onProblem'>,
  {
    path,
    fragment,
    open,
  }: { path: VaultPath; fragment: Fragment | null; open: (linked: Linked) => void },
): void {
  const inNote: Linked = { place: { kind: 'note', path }, fragment };
  if (places === undefined || fragment?.kind !== 'block') {
    open(inNote);
    return;
  }
  places
    .blockOpening({ note: path, blockId: fragment.id })
    .then((opening) => open(linkedOf(opening)))
    .catch((error: unknown) => onProblem(`The link could not be followed: ${messageOf(error)}`));
}

/** The page and place a highlight's opening names. */
function linkedOf(opening: HighlightOpening): Linked {
  return opening.kind === 'reader'
    ? {
        place: { kind: 'document', path: opening.document },
        fragment: { kind: 'block', id: opening.highlightId },
      }
    : {
        place: { kind: 'note', path: opening.note },
        fragment: { kind: 'block', id: opening.blockId },
      };
}

/**
 * Follows `[[…pdf]]` or `[[…epub]]` to its reader (#506) once the document it
 * names is known, and says so: true when the link is one that may name a
 * document, and is being followed. A name no document of the vault has may
 * still be a note's — a note called "Budget review.pdf" — so `otherwise`
 * follows it as a note link.
 * Dropped, as any late answer is, once `current` says the click is stale.
 */
function followedLater(
  { places, onProblem }: Pick<LinkFollowing, 'places' | 'onProblem'>,
  {
    target,
    fragment,
    open,
    current,
    otherwise,
  }: {
    target: string;
    fragment: Fragment | null;
    open: (linked: Linked) => void;
    current: () => number | null;
    otherwise: () => void;
  },
): boolean {
  if (places === undefined || namesDocument(target) === null) return false;
  places
    .linkedDocument(target)
    .then((document) => {
      if (current() === null) return;
      if (document === null) otherwise();
      else {
        onProblem(null);
        open({ place: { kind: 'document', path: document }, fragment });
      }
    })
    .catch((error: unknown) => {
      if (current() !== null) onProblem(`The link could not be followed: ${messageOf(error)}`);
    });
  return true;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The note a link leads to, told to `onProblem` either way; null when it
 * leads nowhere. A link naming no note — `[[#Goals]]` — is a place in the
 * note it is written in, `here`.
 */
function linkedNote(
  { notePaths, onProblem, places }: Pick<LinkFollowing, 'notePaths' | 'onProblem' | 'places'>,
  { target, fragment, here }: { target: string; fragment: Fragment | null; here: VaultPath | null },
): VaultPath | null {
  const resolved =
    target.trim() === '' && fragment !== null ? here : resolveWikiLinkTarget(target, notePaths);
  // With the document rules wired, a `.pdf` or `.epub` link has already missed a file by now.
  const kind = places === undefined ? null : namesDocument(target);
  const called = kind === null ? 'note' : `${SOURCE_KIND_NAMES[kind]} or note`;
  onProblem(resolved === null ? `No ${called} called "${target}"` : null);
  return resolved;
}

/** What a link clicked in a pane or in the peek needs: following's, and the peek's layer. */
export interface LinkPeeking extends LinkFollowing {
  readonly overlays: OverlayStore;
  /**
   * Leaves the peek before the page opens: writes what was typed in it,
   * closes it, then runs `open`. Left out, the peek just closes.
   */
  readonly leavePeek?: (open: () => void) => void;
}

/**
 * A link clicked in a pane or in the peek (slice 6b). A plain click on a
 * link to a note peeks it: over the pane, or, inside the peek, in place of
 * the note it shows. A ⌘-click or ⌘⇧-click, a link to a heading or a block,
 * and the link menu's Open — which names no `how` — open the note's page in
 * the pane as `followLink` does; from inside the peek they leave it first.
 * Inside the peek, a link is read against the peeked note: `[[#Goals]]` is
 * its own heading, not the pane's.
 */
export function clickLink(
  peeking: LinkPeeking,
  {
    pane,
    target,
    heading = null,
    how,
    inPeek,
  }: { pane: number; target: string; heading?: string | null; how?: OpenHow; inPeek: boolean },
): void {
  const fragment = heading === null ? null : linkFragment({ heading });
  const current = beginClick(peeking, {
    pane,
    how: how ?? 'here',
    inPeek,
    overlays: peeking.overlays,
  });
  const open = (linked: Linked) => {
    const paneNow = current();
    if (paneNow === null) return;
    const opening = () => openLinked(peeking, { pane: paneNow, linked, how: how ?? 'here' });
    if (!inPeek) opening();
    else if (peeking.leavePeek !== undefined) peeking.leavePeek(opening);
    else {
      closePeek(peeking.overlays);
      opening();
    }
  };
  const asNote = () => {
    const here = inPeek
      ? (peekNow(peeking.overlays)?.path ?? null)
      : notePathIn(peeking.store, pane);
    const path = linkedNote(peeking, { target, fragment, here });
    if (path === null) return;
    if (how === 'here' && heading === null) {
      if (inPeek) replacePeek(peeking.overlays, path);
      else openPeek(peeking.overlays, { path, from: null });
      return;
    }
    openNoteLinked(peeking, { path, fragment, open });
  };
  if (!followedLater(peeking, { target, fragment, open, current, otherwise: asNote })) asNote();
}

function notePathIn(store: WorkspaceStore, pane: number): VaultPath | null {
  const place = placeIn(store, pane);
  return place?.kind === 'note' ? place.path : null;
}

function placeIn(store: WorkspaceStore, pane: number): NavigationPlace | null {
  return tabIn(store, pane)?.place ?? null;
}

function tabIn(
  store: WorkspaceStore,
  pane: number,
): { id: TabId; place: NavigationPlace | null } | null {
  const held = workspaceNow(store).panes[pane];
  const tab = held?.tabs.find((candidate) => candidate.id === held.active);
  return tab === undefined ? null : { id: tab.id, place: tab.history.current };
}

/** The latest click made on each surface — a pane, or the peek — of each workspace. */
const latestClicks = new WeakMap<WorkspaceStore, Map<string, number>>();
let clicksMade = 0;

/**
 * Notes a click on a link, and returns where its answer may still open: the
 * pane's place now, or null once the answer is no longer wanted. A link
 * whose target takes a read to know (#506) opens later, and by then the
 * person may have clicked again or moved on. A late answer is dropped once
 * another vault is open, unless it is still the latest click on its surface
 * and the tab (or the opening of the peek) it was made in still shows what it
 * showed. A ⌘-click opens a tab of its own, so only needs its pane still
 * there — found by its key, as a pane closed before it renumbers it — and two
 * in a row both open.
 */
function beginClick(
  { store }: Pick<LinkFollowing, 'store'>,
  {
    pane,
    how,
    inPeek,
    overlays,
  }: { pane: number; how: OpenHow; inPeek: boolean; overlays?: OverlayStore },
): () => number | null {
  const { vault, paneKeys } = store.getState();
  const key = paneKeys[pane];
  const surface = inPeek ? 'peek' : `pane ${key}`;
  const clicks = latestClicks.get(store) ?? new Map<string, number>();
  latestClicks.set(store, clicks);
  clicksMade += 1;
  const click = clicksMade;
  clicks.set(surface, click);
  const tab = tabIn(store, pane);
  const peeked = inPeek && overlays !== undefined ? peekShown(overlays) : null;
  const stillWanted = (paneNow: number): boolean => {
    const now = tabIn(store, paneNow);
    if (now === null || tab === null) return false;
    if (inPeek) {
      const peek = overlays === undefined ? null : peekShown(overlays);
      return clicks.get(surface) === click && samePeek(peek, peeked);
    }
    if (how !== 'here') return true;
    return clicks.get(surface) === click && now.id === tab.id && samePlace(now.place, tab.place);
  };
  return () => {
    const state = store.getState();
    if (state.vault !== vault || key === undefined) return null;
    const paneNow = state.paneKeys.indexOf(key);
    return paneNow !== -1 && stillWanted(paneNow) ? paneNow : null;
  };
}

/** The peek that is up, by which opening it is and the note it shows. */
function peekShown(overlays: OverlayStore): { opening: number; path: VaultPath } | null {
  const peek = peekNow(overlays);
  return peek === null ? null : { opening: peekOpening(overlays), path: peek.path };
}

const samePeek = (
  a: { opening: number; path: VaultPath } | null,
  b: { opening: number; path: VaultPath } | null,
): boolean => a?.opening === b?.opening && a?.path === b?.path;

/** Places are plain data, so they are the same when they say the same. */
const samePlace = (a: NavigationPlace | null, b: NavigationPlace | null): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
