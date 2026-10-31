import { memo, useMemo } from 'react';
import type { NavigationPlace, PaletteCommand } from '@dfai/domain';
import { SEARCH_SCOPE, type IndexPort, type SemanticEngine } from '@dfai/application';
import { SearchPalette } from '@dfai/ui';
import { useSearch } from './index/use-search.ts';
import { useIndexPhase, type IndexStatusStore } from './index/index-status-store.ts';
import { useScopedIndexKey } from './reads/use-scoped-index-key.ts';
import { hideOverlay, useOverlayUp, usePeek, type OverlayStore } from './overlay-store.ts';
import { useFocusedPlace, type WorkspaceStore } from './workspace/workspace-store.ts';

/**
 * The search palette, drawn while ⌘K has it up. It watches the overlay store
 * for itself and keeps its query there, so opening it and typing into it
 * draws only the palette, not the window behind it (#261). Drawn with `memo`,
 * and handed steady handlers, so the window drawn again does not draw it.
 */
export const SearchPaletteSlot = memo(function SearchPaletteSlot(props: SearchPaletteSlotProps) {
  const up = useOverlayUp(props.store, 'search');
  return up ? <OpenSearchPalette {...props} /> : null;
});

export interface SearchPaletteSlotProps {
  readonly store: OverlayStore;
  readonly workspace: WorkspaceStore;
  readonly index: IndexPort;
  /** Search by meaning in the open vault (P32-02); null or left out, it is not offered. */
  readonly semantic?: SemanticEngine | null;
  /**
   * The commands on offer, given the place the focused pane shows: a note
   * can be archived or unarchived from here. Read while the palette is up,
   * so the window is not drawn for a switch between notes.
   */
  readonly commandsFor: (focused: NavigationPlace | null) => readonly PaletteCommand[];
  /** Commands the query itself calls for — a pasted link, say — listed first. */
  readonly offerFor: (query: string) => readonly PaletteCommand[];
  /**
   * The index's status, read while the palette is up: the hits are searched
   * again when the index has news (`useSearch`), without drawing the window
   * that holds the palette (#326).
   */
  readonly indexStatus: IndexStatusStore;
  /** The open vault's root; null with none open. */
  readonly vault: string | null;
  /** A command chosen, once the palette has closed, with the query it was chosen from. */
  readonly onCommand: (id: string, query: string) => void;
  /** A note chosen, once the palette has closed; with its block, a highlight in it (#507). */
  readonly onPick: (path: string, block?: string) => void;
  readonly fallbackFocus: () => HTMLElement | null;
}

function OpenSearchPalette({
  store,
  workspace,
  index,
  semantic = null,
  commandsFor,
  offerFor,
  indexStatus,
  vault,
  onCommand,
  onPick,
  fallbackFocus,
}: SearchPaletteSlotProps) {
  const shown = useFocusedPlace(workspace);
  const peek = usePeek(store);
  // The note on screen is the peeked one while the peek is up: its "this note" commands are offered.
  const focused = useMemo<NavigationPlace | null>(
    () => (peek === null ? shown : { kind: 'note', path: peek.path }),
    [peek, shown],
  );
  const commands = useMemo(() => commandsFor(focused), [commandsFor, focused]);
  const changeKey = usePaletteKey(indexStatus, vault);
  const search = useSearch({ index, semantic, commands, offerFor, changeKey, store });
  return (
    <SearchPalette
      query={search.query}
      commands={search.commands}
      archived={{ included: search.includeArchived, onChange: search.setIncludeArchived }}
      {...(semantic !== null && {
        meaning: {
          on: search.byMeaning,
          onChange: search.setByMeaning,
          progress: search.meaning?.progress ?? null,
          problem: search.meaning?.problem ?? null,
        },
      })}
      onCommand={(id) => {
        // Closing forgets the query (`withClosed`); this render's is the one chosen from.
        hideOverlay(store, 'search');
        onCommand(id, search.query);
      }}
      hits={search.hits}
      selected={search.selected}
      onQuery={search.setQuery}
      onMove={search.move}
      onPick={(path, block) => {
        hideOverlay(store, 'search');
        if (block === undefined) onPick(path);
        else onPick(path, block);
      }}
      onClose={() => hideOverlay(store, 'search')}
      fallbackFocus={fallbackFocus}
    />
  );
}

/**
 * What the hits are searched again on: any note's news (#327), and the index
 * building, which the search waits out rather than answer from a half-written
 * index. The scoped key does not hear a rebuild begin, so the phase says it.
 */
function usePaletteKey(status: IndexStatusStore, vault: string | null): string {
  const building = useIndexPhase(status, vault) === 'building';
  const key = useScopedIndexKey({ status, vault, reader: ['search'], scope: SEARCH_SCOPE });
  return building ? 'building' : key;
}
