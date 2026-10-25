// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createVaultPath, type HighlightOpening, type VaultPath } from '@dfai/domain';
import { createRevealStore, requestReveal, useTabReveal } from '../panes/reveals.ts';
import { closePeek, createOverlayStore, openPeek, peekNow } from '../overlay-store.ts';
import { useHeldReveal } from '../reader/held-reveal.ts';
import { clickLink, followLink, openNote, type LinkPlaces } from './open-place.ts';
import {
  closePane,
  createWorkspaceStore,
  loadVault,
  splitPane,
  workspaceNow,
} from './workspace-store.ts';

/*
 * Regression (#506): a block link now reads its note before it opens
 * anything, and `[[…pdf]]` is read before notes are. Where those reads
 * resolve late, or out of order, the click that lands must be the one the
 * person made last, in the place they are still looking at.
 */

const SOURCE = createVaultPath('Library/The Lantern Keepers.md');
const OTHER = createVaultPath('Library/Brightwater Notes.md');
const PLAN = createVaultPath('Plan.md');
const ELSEWHERE = createVaultPath('Elsewhere.md');
const PDF = createVaultPath('Library/the-lantern-keepers.pdf');
const NOTE_NAMED_PDF = createVaultPath('Meetings/Budget review.pdf.md');

/** A read whose answer the test hands over when it chooses. */
function deferred<Value>() {
  let resolve: (value: Value) => void = () => {};
  const promise = new Promise<Value>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** `places` null: the link rules before #506, every link a note. */
function wiring(
  places: LinkPlaces | null,
  notePaths: VaultPath[] = [SOURCE, OTHER, PLAN, ELSEWHERE],
) {
  const store = createWorkspaceStore({ remembered: { read: () => null, write: () => {} } });
  loadVault(store, '/v');
  openNote(store, PLAN);
  return {
    store,
    reveals: createRevealStore(),
    overlays: createOverlayStore(),
    notePaths,
    onProblem: vi.fn(),
    ...(places !== null && { places }),
  };
}

const placesOf = (store: ReturnType<typeof wiring>['store'], pane = 0) =>
  workspaceNow(store).panes[pane]?.tabs.map((tab) => tab.history.current) ?? [];

const flush = () => new Promise((done) => setTimeout(done, 0));

describe('two block links clicked in quick succession in one tab', () => {
  it('ends on the one clicked last, though its note was read first', async () => {
    const slow = deferred<HighlightOpening>();
    const places: LinkPlaces = {
      blockOpening: ({ note, blockId }) =>
        note === SOURCE
          ? slow.promise
          : Promise.resolve({ kind: 'note', note, blockId } satisfies HighlightOpening),
      linkedDocument: async () => null,
    };
    const w = wiring(places);
    const link = (target: string, id: string) =>
      clickLink(w, { pane: 0, target, heading: `#^${id}`, how: 'here', inPeek: false });

    link('The Lantern Keepers', 'k3x9q2'); // read is slow
    link('Brightwater Notes', 'b7c8d9'); // read is quick
    await flush();
    expect(placesOf(w.store)).toEqual([{ kind: 'note', path: OTHER }]);

    slow.resolve({ kind: 'reader', source: 'pdf', document: PDF, highlightId: 'k3x9q2' });
    await flush();
    // The earlier click's late answer must not pull the tab back to the first highlight.
    expect(placesOf(w.store)).toEqual([{ kind: 'note', path: OTHER }]);
  });
});

describe('a block link whose note is read after the person has moved on', () => {
  it('does not take over the pane they have since opened something else in', async () => {
    const slow = deferred<HighlightOpening>();
    const w = wiring({ blockOpening: () => slow.promise, linkedDocument: async () => null });
    clickLink(w, {
      pane: 0,
      target: 'The Lantern Keepers',
      heading: '#^k3x9q2',
      how: 'here',
      inPeek: false,
    });
    // Before the read comes back, they open another note in the same pane.
    followLink(w, { pane: 0, target: 'Elsewhere' });
    await flush();
    expect(placesOf(w.store)).toEqual([{ kind: 'note', path: ELSEWHERE }]);

    slow.resolve({ kind: 'reader', source: 'pdf', document: PDF, highlightId: 'k3x9q2' });
    await flush();
    expect(placesOf(w.store)).toEqual([{ kind: 'note', path: ELSEWHERE }]);
  });

  it('does not open in a pane that was closed, nor in the one that took its number', async () => {
    const slow = deferred<HighlightOpening>();
    const w = wiring({ blockOpening: () => slow.promise, linkedDocument: async () => null });
    splitPane(w.store, 0);
    openNote(w.store, ELSEWHERE);
    clickLink(w, {
      pane: 1,
      target: 'The Lantern Keepers',
      heading: '#^k3x9q2',
      how: 'here',
      inPeek: false,
    });
    closePane(w.store, 1);
    const before = placesOf(w.store, 0);
    slow.resolve({ kind: 'reader', source: 'pdf', document: PDF, highlightId: 'k3x9q2' });
    await flush();
    // The pane the click was made in is gone: nothing else is replaced in its stead.
    expect(placesOf(w.store, 0)).toEqual(before);
  });
});

describe('ordinary links, as before #506', () => {
  it('[[Budget review.pdf]] opened the note named so when no link places were wired (the old rule)', () => {
    const w = wiring(null, [PLAN, NOTE_NAMED_PDF]);
    followLink(w, { pane: 0, target: 'Budget review.pdf' });
    expect(placesOf(w.store)).toEqual([{ kind: 'note', path: NOTE_NAMED_PDF }]);
  });

  it('[[Budget review.pdf]] opens the note named so when the vault holds no PDF of that name', async () => {
    // A note whose title ends in ".pdf" (a meeting about a document, say):
    // `linkedDocument` finds no such file, so the link is read as a note's.
    const w = wiring(
      {
        blockOpening: async ({ note, blockId }) => ({ kind: 'note', note, blockId }),
        linkedDocument: async () => null,
      },
      [PLAN, NOTE_NAMED_PDF],
    );
    followLink(w, { pane: 0, target: 'Budget review.pdf' });
    await vi.waitFor(() =>
      expect(placesOf(w.store)).toEqual([{ kind: 'note', path: NOTE_NAMED_PDF }]),
    );
    expect(w.onProblem).toHaveBeenLastCalledWith(null);
  });

  it('[[Budget review.pdf]] opens the PDF when the vault holds one, though a note is named so too', async () => {
    const w = wiring(
      {
        blockOpening: async ({ note, blockId }) => ({ kind: 'note', note, blockId }),
        linkedDocument: async () => PDF,
      },
      [PLAN, NOTE_NAMED_PDF],
    );
    followLink(w, { pane: 0, target: 'Budget review.pdf' });
    await vi.waitFor(() => expect(placesOf(w.store)).toEqual([{ kind: 'document', path: PDF }]));
  });

  it('[[Missing.pdf]] says neither a PDF nor a note is called so', async () => {
    const w = wiring({
      blockOpening: async () => ({ kind: 'note', note: PLAN, blockId: 'x' }),
      linkedDocument: async () => null,
    });
    followLink(w, { pane: 0, target: 'Missing.pdf' });
    await vi.waitFor(() =>
      expect(w.onProblem).toHaveBeenLastCalledWith('No PDF or note called "Missing.pdf"'),
    );
    expect(placesOf(w.store)).toEqual([{ kind: 'note', path: PLAN }]);
  });

  it('a plain click on [[Budget review.pdf]] peeks the note when no PDF is called so', async () => {
    const w = wiring(
      {
        blockOpening: async () => ({ kind: 'note', note: PLAN, blockId: 'x' }),
        linkedDocument: async () => null,
      },
      [PLAN, NOTE_NAMED_PDF],
    );
    clickLink(w, { pane: 0, target: 'Budget review.pdf', how: 'here', inPeek: false });
    await vi.waitFor(() => expect(peekNow(w.overlays)?.path).toBe(NOTE_NAMED_PDF));
  });
});

describe('a block link read late, from the peek', () => {
  it('does not open once the peek has been left another way', async () => {
    const slow = deferred<HighlightOpening>();
    const w = wiring({ blockOpening: () => slow.promise, linkedDocument: async () => null });
    openPeek(w.overlays, { path: ELSEWHERE, from: null });
    clickLink(w, {
      pane: 0,
      target: 'The Lantern Keepers',
      heading: '#^k3x9q2',
      how: 'here',
      inPeek: true,
    });
    closePeek(w.overlays);
    slow.resolve({ kind: 'reader', source: 'pdf', document: PDF, highlightId: 'k3x9q2' });
    await flush();
    expect(placesOf(w.store)).toEqual([{ kind: 'note', path: PLAN }]);
  });

  it('leaves the peek and opens when it is still the one the click was made in', async () => {
    const slow = deferred<HighlightOpening>();
    const w = wiring({ blockOpening: () => slow.promise, linkedDocument: async () => null });
    openPeek(w.overlays, { path: ELSEWHERE, from: null });
    clickLink(w, {
      pane: 0,
      target: 'The Lantern Keepers',
      heading: '#^k3x9q2',
      how: 'here',
      inPeek: true,
    });
    slow.resolve({ kind: 'reader', source: 'pdf', document: PDF, highlightId: 'k3x9q2' });
    await vi.waitFor(() => expect(placesOf(w.store)).toEqual([{ kind: 'document', path: PDF }]));
    expect(peekNow(w.overlays)).toBeNull();
  });
});

describe('block links opened in new tabs, one after the other', () => {
  it('both open: each is a tab asked for, not a replacement of the other', async () => {
    const slow = deferred<HighlightOpening>();
    const places: LinkPlaces = {
      blockOpening: ({ note, blockId }) =>
        note === SOURCE
          ? slow.promise
          : Promise.resolve({ kind: 'note', note, blockId } satisfies HighlightOpening),
      linkedDocument: async () => null,
    };
    const w = wiring(places);
    const link = (target: string, id: string) =>
      clickLink(w, { pane: 0, target, heading: `#^${id}`, how: 'new-tab', inPeek: false });
    link('The Lantern Keepers', 'k3x9q2');
    link('Brightwater Notes', 'b7c8d9');
    await flush();
    slow.resolve({ kind: 'reader', source: 'pdf', document: PDF, highlightId: 'k3x9q2' });
    await flush();
    expect(placesOf(w.store)).toEqual(
      expect.arrayContaining([
        { kind: 'document', path: PDF },
        { kind: 'note', path: OTHER },
      ]),
    );
  });
});

describe('the highlight a reader tab holds, when the tab moves to another PDF', () => {
  const A = createVaultPath('Library/the-lantern-keepers.pdf');
  const B = createVaultPath('Library/brightwater.pdf');

  it('is not carried to the next document, nor shown again on coming back', () => {
    const reveals = createRevealStore();
    const { result, rerender } = renderHook(
      ({ path }) => useHeldReveal(useTabReveal(reveals, { tab: 'tab-1', path }), path),
      { initialProps: { path: A as VaultPath } },
    );
    requestReveal(reveals, { tab: 'tab-1', path: A, fragment: { kind: 'block', id: 'k3x9q2' } });
    rerender({ path: A });
    expect(result.current).toMatchObject({ id: 'k3x9q2' });

    // The same tab opens B (the container is kept, keyed by tab), then goes back to A.
    rerender({ path: B });
    expect(result.current).toBeNull();
    rerender({ path: A });
    // The ask was spent on A: coming back must not jump and flash it again.
    expect(result.current).toBeNull();
  });
});

/*
 * Verification (#506, PR #522 after 54f53fc3): a `[[…pdf]]` link opens
 * once the vault has been walked, which on a large vault is a quarter of a
 * second or more. Whether the late answer is still wanted must say which
 * vault, which pane, and which peek the click was made in.
 */

function slowPdfWiring() {
  const walk = deferred<VaultPath | null>();
  const places: LinkPlaces = {
    blockOpening: async ({ note, blockId }) => ({ kind: 'note', note, blockId }),
    linkedDocument: () => walk.promise,
  };
  const store = createWorkspaceStore({ remembered: { read: () => null, write: () => {} } });
  loadVault(store, '/vaults/first');
  openNote(store, PLAN);
  return {
    walk,
    linking: {
      store,
      reveals: createRevealStore(),
      overlays: createOverlayStore(),
      notePaths: [PLAN, ELSEWHERE],
      onProblem: vi.fn(),
      places,
    },
  };
}

const everyPlace = (w: ReturnType<typeof slowPdfWiring>) =>
  workspaceNow(w.linking.store).panes.flatMap((pane) =>
    pane.tabs.map((tab) => tab.history.current),
  );

describe('a [[…pdf]] link still being looked up when the vault is switched', () => {
  it('a ⌘-click does not open the first vault’s PDF path in the second vault', async () => {
    const w = slowPdfWiring();
    clickLink(w.linking, {
      pane: 0,
      target: 'the-lantern-keepers.pdf',
      how: 'new-tab',
      inPeek: false,
    });
    loadVault(w.linking.store, '/vaults/second');
    openNote(w.linking.store, PLAN);
    w.walk.resolve(PDF);
    await flush();
    expect(everyPlace(w)).not.toContainEqual({ kind: 'document', path: PDF });
  });

  it('a plain click does not open it either, though the second vault shows a note of the same path', async () => {
    const w = slowPdfWiring();
    clickLink(w.linking, {
      pane: 0,
      target: 'the-lantern-keepers.pdf',
      how: 'here',
      inPeek: false,
    });
    loadVault(w.linking.store, '/vaults/second');
    openNote(w.linking.store, PLAN);
    w.walk.resolve(PDF);
    await flush();
    expect(everyPlace(w)).not.toContainEqual({ kind: 'document', path: PDF });
  });
});

describe('a ⌘-click on [[…pdf]] in the right-hand pane, when the left-hand one is closed', () => {
  it('still opens its tab: the pane it was made in is still there, only renumbered', async () => {
    const w = slowPdfWiring();
    splitPane(w.linking.store, 0);
    openNote(w.linking.store, ELSEWHERE);
    clickLink(w.linking, {
      pane: 1,
      target: 'the-lantern-keepers.pdf',
      how: 'new-tab',
      inPeek: false,
    });
    closePane(w.linking.store, 0);
    w.walk.resolve(PDF);
    await flush();
    expect(everyPlace(w)).toContainEqual({ kind: 'document', path: PDF });
  });
});

describe('a [[…pdf]] link clicked in the peek, the peek closed and opened again on the same note', () => {
  it('does not close the new peek nor replace the pane', async () => {
    const w = slowPdfWiring();
    openPeek(w.linking.overlays, { path: ELSEWHERE, from: null });
    clickLink(w.linking, { pane: 0, target: 'the-lantern-keepers.pdf', how: 'here', inPeek: true });
    closePeek(w.linking.overlays);
    openPeek(w.linking.overlays, { path: ELSEWHERE, from: null });
    w.walk.resolve(PDF);
    await flush();
    expect(everyPlace(w)).toEqual([{ kind: 'note', path: PLAN }]);
    expect(peekNow(w.linking.overlays)?.path).toBe(ELSEWHERE);
  });
});
