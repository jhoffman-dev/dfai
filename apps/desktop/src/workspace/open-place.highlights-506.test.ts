import { describe, expect, it, vi } from 'vitest';
import { createVaultPath, type HighlightOpening, type VaultPath } from '@dfai/domain';
import { openHighlightPlace } from '@dfai/application';
import { createRevealStore } from '../panes/reveals.ts';
import { createOverlayStore, openPeek, peekNow } from '../overlay-store.ts';
import {
  clickLink,
  followLink,
  highlightPlaceOpener,
  openNote,
  type LinkPlaces,
} from './open-place.ts';
import { createWorkspaceStore, loadVault, splitPane, workspaceNow } from './workspace-store.ts';

/*
 * A link to a highlight opens where the highlight lives (#506): a PDF's in
 * its reader at the highlight, anything else in its note at the block; and
 * `[[…pdf]]` opens the PDF. Where each leads is the application's answer,
 * faked here; what is tested is that the panes open it where the click asked.
 */

const SOURCE = createVaultPath('Library/The Lantern Keepers.md');
const KINDLE = createVaultPath('Library/Brightwater.md');
const PLAN = createVaultPath('Plan.md');
const PDF = createVaultPath('Library/the-lantern-keepers.pdf');

/** Every highlight of SOURCE opens the PDF; any other block opens its note. */
const places = (): LinkPlaces & { linkedDocument: ReturnType<typeof vi.fn> } => ({
  blockOpening: async ({ note, blockId }): Promise<HighlightOpening> =>
    note === SOURCE
      ? { kind: 'reader', source: 'pdf', document: PDF, highlightId: blockId }
      : { kind: 'note', note, blockId },
  linkedDocument: vi.fn(async (target: string) => (target.endsWith('.pdf') ? PDF : null)),
});

function wiring() {
  const store = createWorkspaceStore({ remembered: { read: () => null, write: () => {} } });
  loadVault(store, '/v');
  openNote(store, PLAN);
  return {
    store,
    reveals: createRevealStore(),
    overlays: createOverlayStore(),
    notePaths: [SOURCE, KINDLE, PLAN],
    onProblem: vi.fn(),
    places: places(),
  };
}

const placesOf = (store: ReturnType<typeof wiring>['store'], pane = 0) =>
  workspaceNow(store).panes[pane]?.tabs.map((tab) => tab.history.current) ?? [];

const revealOfFocused = (w: ReturnType<typeof wiring>) => {
  const ws = workspaceNow(w.store);
  return w.reveals.getState().byTab.get(ws.panes[ws.focused]?.active ?? '');
};

describe('a link to a highlight', () => {
  it("opens a PDF's highlight in the reader, here, at the highlight", async () => {
    const w = wiring();
    clickLink(w, {
      pane: 0,
      target: 'The Lantern Keepers',
      heading: '#^k3x9q2',
      how: 'here',
      inPeek: false,
    });
    await vi.waitFor(() => expect(placesOf(w.store)).toEqual([{ kind: 'document', path: PDF }]));
    expect(revealOfFocused(w)).toMatchObject({
      path: PDF,
      reveal: { fragment: { kind: 'block', id: 'k3x9q2' } },
    });
  });

  it('opens it in a new tab beside on ⌘-click, and in the other pane on ⌘⇧-click', async () => {
    const w = wiring();
    clickLink(w, {
      pane: 0,
      target: 'The Lantern Keepers',
      heading: '#^k3x9q2',
      how: 'new-tab',
      inPeek: false,
    });
    await vi.waitFor(() =>
      expect(placesOf(w.store)).toEqual([
        { kind: 'note', path: PLAN },
        { kind: 'document', path: PDF },
      ]),
    );
    clickLink(w, {
      pane: 0,
      target: 'The Lantern Keepers',
      heading: '#^k3x9q2',
      how: 'split',
      inPeek: false,
    });
    await vi.waitFor(() => expect(workspaceNow(w.store).panes).toHaveLength(2));
    expect(placesOf(w.store, 1)).toEqual([{ kind: 'document', path: PDF }]);
  });

  it('opens a Kindle highlight in its note at the block', async () => {
    const w = wiring();
    followLink(w, { pane: 0, target: 'Brightwater', heading: '#^kd0041' });
    await vi.waitFor(() => expect(placesOf(w.store)).toEqual([{ kind: 'note', path: KINDLE }]));
    expect(revealOfFocused(w)).toMatchObject({
      path: KINDLE,
      reveal: { fragment: { kind: 'block', id: 'kd0041' } },
    });
  });

  it("opens a highlight's own block, clicked in its literature note, in the reader", async () => {
    const w = wiring();
    openNote(w.store, SOURCE);
    clickLink(w, { pane: 0, target: '', heading: '#^k3x9q2', how: 'here', inPeek: false });
    await vi.waitFor(() => expect(placesOf(w.store)).toEqual([{ kind: 'document', path: PDF }]));
  });

  it('opens from the peek in the pane, leaving the peek, once it is known where', async () => {
    const w = wiring();
    openPeek(w.overlays, { path: SOURCE, from: null });
    const left: Array<() => void> = [];
    clickLink(
      { ...w, leavePeek: (open) => left.push(open) },
      { pane: 0, target: '', heading: '#^k3x9q2', how: 'here', inPeek: true },
    );
    await vi.waitFor(() => expect(left).toHaveLength(1));
    left[0]?.();
    expect(placesOf(w.store)).toEqual([{ kind: 'document', path: PDF }]);
    expect(peekNow(w.overlays)?.path).toBe(SOURCE);
  });

  it('opens a heading of a literature note in the note, asking nothing', () => {
    const w = wiring();
    const blockOpening = vi.fn(w.places.blockOpening);
    followLink(
      { ...w, places: { ...w.places, blockOpening } },
      {
        pane: 0,
        target: 'The Lantern Keepers',
        heading: '#Chapter One',
      },
    );
    expect(placesOf(w.store)).toEqual([{ kind: 'note', path: SOURCE }]);
    expect(blockOpening).not.toHaveBeenCalled();
  });

  it('says so when where it leads could not be found out, and opens nothing', async () => {
    const w = wiring();
    const failing: LinkPlaces = {
      ...w.places,
      blockOpening: async () => {
        throw new Error('the disk went away');
      },
    };
    followLink(
      { ...w, places: failing },
      { pane: 0, target: 'The Lantern Keepers', heading: '#^k3x9q2' },
    );
    await vi.waitFor(() =>
      expect(w.onProblem).toHaveBeenCalledWith(
        'The link could not be followed: the disk went away',
      ),
    );
    expect(placesOf(w.store)).toEqual([{ kind: 'note', path: PLAN }]);
  });
});

describe('a link to a PDF', () => {
  it('opens the PDF it names in the reader, here, from a pane or the peek', async () => {
    const w = wiring();
    followLink(w, { pane: 0, target: 'the-lantern-keepers.pdf' });
    await vi.waitFor(() => expect(placesOf(w.store)).toEqual([{ kind: 'document', path: PDF }]));
    expect(w.onProblem).toHaveBeenLastCalledWith(null);
  });

  it('opens on a plain click rather than peeking: a PDF is no note to peek', async () => {
    const w = wiring();
    clickLink(w, {
      pane: 0,
      target: 'Library/the-lantern-keepers.pdf',
      how: 'here',
      inPeek: false,
    });
    await vi.waitFor(() => expect(placesOf(w.store)).toEqual([{ kind: 'document', path: PDF }]));
    expect(peekNow(w.overlays)).toBeNull();
  });

  it('follows [[…epub]] to its reader, and says when the EPUB it names is not to be found (#505)', async () => {
    const w = wiring();
    const book = createVaultPath('Library/fables.epub');
    w.places.linkedDocument.mockResolvedValueOnce(book);
    followLink(w, { pane: 0, target: 'fables.epub' });
    await vi.waitFor(() => expect(placesOf(w.store)).toEqual([{ kind: 'document', path: book }]));
    w.places.linkedDocument.mockResolvedValueOnce(null);
    followLink(w, { pane: 0, target: 'missing.epub' });
    await vi.waitFor(() =>
      expect(w.onProblem).toHaveBeenCalledWith('No EPUB or note called "missing.epub"'),
    );
  });

  it('says when the PDF it names is not to be found', async () => {
    const w = wiring();
    w.places.linkedDocument.mockResolvedValueOnce(null);
    followLink(w, { pane: 0, target: 'missing.pdf' });
    await vi.waitFor(() =>
      expect(w.onProblem).toHaveBeenCalledWith('No PDF or note called "missing.pdf"'),
    );
    expect(placesOf(w.store)).toEqual([{ kind: 'note', path: PLAN }]);
  });

  it('opens at the highlight a `#^id` names, as a link to a block does', async () => {
    const w = wiring();
    followLink(w, { pane: 0, target: 'the-lantern-keepers.pdf', heading: '#^k3x9q2' });
    await vi.waitFor(() => expect(placesOf(w.store)).toEqual([{ kind: 'document', path: PDF }]));
    expect(revealOfFocused(w)?.path).toBe(PDF);
    expect(revealOfFocused(w)?.reveal.fragment).toEqual({ kind: 'block', id: 'k3x9q2' });
  });

  it('opens at the page a `#page=3` names', async () => {
    const w = wiring();
    followLink(w, { pane: 0, target: 'the-lantern-keepers.pdf', heading: '#page=3' });
    await vi.waitFor(() => expect(placesOf(w.store)).toEqual([{ kind: 'document', path: PDF }]));
    expect(revealOfFocused(w)?.reveal.fragment).toEqual({ kind: 'heading', heading: 'page=3' });
  });

  it('is a note link as before when no places are wired', () => {
    const { store, reveals, notePaths, onProblem } = wiring();
    const w = { store, reveals, notePaths, onProblem };
    followLink(w, { pane: 0, target: 'the-lantern-keepers.pdf' });
    expect(w.onProblem).toHaveBeenCalledWith('No note called "the-lantern-keepers.pdf"');
  });
});

describe("a highlight opened from a view's row (#507)", () => {
  const ports = (text: Record<string, string>) => ({
    fs: {
      readTextFile: async (path: VaultPath) => {
        const found = text[path];
        if (found === undefined) throw new Error(`no note ${path}`);
        return { text: found, modified: 1 };
      },
    },
    markdown: { frontmatterProperties: () => ({}), noteBlocks: () => ({ quotes: [], hidden: [] }) },
  });

  it('opens where the click asked: a note at the block in a new tab', async () => {
    const w = wiring();
    splitPane(w.store);
    const opened = await openHighlightPlace(
      { ...ports({ [KINDLE]: 'Brightwater' }), opener: highlightPlaceOpener(w, 'new-tab') },
      { note: KINDLE, highlightId: 'kd0041' },
    );
    expect(opened.kind).toBe('note');
    expect(placesOf(w.store, workspaceNow(w.store).focused).at(-1)).toEqual({
      kind: 'note',
      path: KINDLE,
    });
    expect(revealOfFocused(w)).toMatchObject({
      path: KINDLE,
      reveal: { fragment: { kind: 'block', id: 'kd0041' } },
    });
  });

  it("opens a PDF's highlight in the reader at it", () => {
    const w = wiring();
    highlightPlaceOpener(w).openDocument({ path: PDF, highlightId: 'k3x9q2' });
    expect(placesOf(w.store)).toEqual([{ kind: 'document', path: PDF }]);
    expect(revealOfFocused(w)).toMatchObject({ path: PDF });
  });
});
