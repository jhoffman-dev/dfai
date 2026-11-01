import { describe, expect, it } from 'vitest';
import { createVaultPath } from '@dfai/domain';
import {
  NO_INPUT,
  NO_OVERLAY,
  CELL_PICKER,
  closeOverlay,
  drawnByWindow,
  holdsTheScreen,
  holdsShortcuts,
  openOverlay,
  peekAfterMove,
  peekPosition,
  peekWithout,
  rowPeek,
  pageMenuOverlay,
  paneOverlayOf,
  panePopupOverlay,
  withArchived,
  withMeaning,
  withClosed,
  withMoved,
  withOpened,
  withPeekClosed,
  withPeekOpened,
  withPeekReplaced,
  withPeekStepped,
  withQuery,
  type OverlayState,
} from './overlay.ts';

describe('openOverlay', () => {
  it('opens what is asked for when nothing is up', () => {
    expect(openOverlay(null, 'search')).toBe('search');
    expect(openOverlay(null, 'capture')).toBe('capture');
    expect(openOverlay(null, 'new-note-menu')).toBe('new-note-menu');
  });

  it('closes the new-note menu as another overlay opens', () => {
    expect(openOverlay('new-note-menu', 'search')).toBe('search');
    expect(openOverlay('new-note-menu', 'capture')).toBe('capture');
  });

  it('leaves an open palette up, and queues nothing behind it', () => {
    expect(openOverlay('capture', 'search')).toBe('capture');
    expect(openOverlay('search', 'capture')).toBe('search');
    expect(openOverlay('search', 'new-note-menu')).toBe('search');
  });

  it('holds Settings up like a palette, and lets a palette hold it off', () => {
    expect(openOverlay(null, 'settings')).toBe('settings');
    expect(openOverlay('settings', 'search')).toBe('settings');
    expect(openOverlay('settings', 'capture')).toBe('settings');
    expect(openOverlay('search', 'settings')).toBe('search');
    expect(openOverlay('new-note-menu', 'settings')).toBe('settings');
  });

  it('lets a row menu give way to the move picker or the delete question it opens', () => {
    expect(openOverlay('tree-menu', 'move-picker')).toBe('move-picker');
    expect(openOverlay('tree-menu', 'delete-dialog')).toBe('delete-dialog');
    expect(openOverlay(pageMenuOverlay(0), 'delete-dialog')).toBe('delete-dialog');
  });

  it('holds the move picker and the delete question up like a palette', () => {
    expect(openOverlay('move-picker', 'search')).toBe('move-picker');
    expect(openOverlay('delete-dialog', 'tree-menu')).toBe('delete-dialog');
    expect(openOverlay('delete-dialog', 'pages-menu')).toBe('delete-dialog');
  });

  it('gives way with a page menu as it does with the new-note menu', () => {
    expect(openOverlay(null, pageMenuOverlay(0))).toBe('page-menu-0');
    expect(openOverlay(pageMenuOverlay(0), 'search')).toBe('search');
    expect(openOverlay('search', pageMenuOverlay(1))).toBe('search');
  });

  it('has one page menu up at a time, even across panes', () => {
    expect(openOverlay(pageMenuOverlay(0), pageMenuOverlay(1))).toBe('page-menu-1');
    expect(closeOverlay(pageMenuOverlay(1), pageMenuOverlay(0))).toBe('page-menu-1');
  });

  it('gives way with a pane popup, and tells popups apart by pane and name', () => {
    const filter = panePopupOverlay(0, 'filter');
    expect(openOverlay(filter, 'search')).toBe('search');
    expect(openOverlay('search', filter)).toBe('search');
    expect(openOverlay(filter, panePopupOverlay(1, 'filter'))).toBe('pane-1-filter');
    expect(closeOverlay(panePopupOverlay(0, 'sort'), filter)).toBe('pane-0-sort');
  });

  it('keeps a palette asked for again as it is', () => {
    expect(openOverlay('search', 'search')).toBe('search');
  });
});

describe('closeOverlay', () => {
  it('closes the overlay that is up', () => {
    expect(closeOverlay('search', 'search')).toBeNull();
    expect(closeOverlay('new-note-menu', 'new-note-menu')).toBeNull();
  });

  it('does not close an overlay that replaced the one closing', () => {
    expect(closeOverlay('search', 'new-note-menu')).toBe('search');
  });

  it('leaves nothing up as nothing', () => {
    expect(closeOverlay(null, 'capture')).toBeNull();
  });
});

describe('holdsTheScreen', () => {
  it('is true while a palette or dialog is up', () => {
    expect(holdsTheScreen('search')).toBe(true);
    expect(holdsTheScreen('capture')).toBe(true);
    expect(holdsTheScreen('settings')).toBe(true);
  });

  it('is false with nothing up, or only a menu or popover', () => {
    expect(holdsTheScreen(null)).toBe(false);
    expect(holdsTheScreen('new-note-menu')).toBe(false);
  });
});

describe('the overlay state', () => {
  const typed: OverlayState = {
    overlay: 'search',
    palette: { query: 'sourd', selected: 2, includeArchived: true, byMeaning: false },
    peek: null,
  };

  it('opens and closes by the one-at-a-time rule', () => {
    expect(withOpened(NO_OVERLAY, 'new-note-menu').overlay).toBe('new-note-menu');
    expect(withOpened(withOpened(NO_OVERLAY, 'new-note-menu'), 'search').overlay).toBe('search');
    expect(withOpened(typed, 'capture').overlay).toBe('search');
    expect(withClosed(withOpened(NO_OVERLAY, 'capture'), 'capture').overlay).toBeNull();
  });

  it('forgets what was typed once the search palette closes, and opens it empty', () => {
    const closed = withClosed(typed, 'search');
    expect(closed).toEqual(NO_OVERLAY);
    expect(withOpened(closed, 'search').palette).toEqual(NO_INPUT);
  });

  it('keeps what is typed while the palette stays up', () => {
    expect(withOpened(typed, 'settings')).toEqual(typed);
    expect(withClosed(typed, 'capture')).toEqual(typed);
  });

  it('leaves the window drawing nothing for the palette, and every other overlay as it is', () => {
    expect(drawnByWindow(typed)).toBeNull();
    expect(drawnByWindow(NO_OVERLAY)).toBeNull();
    expect(drawnByWindow({ ...NO_OVERLAY, overlay: 'settings' })).toBe('settings');
    expect(drawnByWindow({ ...NO_OVERLAY, overlay: pageMenuOverlay(1) })).toBe('page-menu-1');
  });
});

describe('a table cell’s picker (#300)', () => {
  const picker = panePopupOverlay(0, CELL_PICKER);
  const up: OverlayState = withOpened(NO_OVERLAY, picker);

  it('is a popup of its pane, drawn by that pane alone', () => {
    expect(up.overlay).toBe('pane-0-cell-picker');
    expect(paneOverlayOf(up.overlay, 0)).toBe(picker);
    expect(paneOverlayOf(up.overlay, 1)).toBeNull();
    expect(holdsTheScreen(up.overlay)).toBe(false);
  });

  it('gives way to ⌘K, and closing late does not close the palette that replaced it', () => {
    const searching = withOpened(up, 'search');
    expect(searching.overlay).toBe('search');
    expect(withClosed(searching, picker).overlay).toBe('search');
  });

  it('closes on its own close, and opens over nothing a palette holds', () => {
    expect(withClosed(up, picker)).toEqual(NO_OVERLAY);
    expect(withOpened(withOpened(NO_OVERLAY, 'settings'), picker).overlay).toBe('settings');
  });

  it('gives way to another of the pane’s popups, as a menu does', () => {
    expect(withOpened(up, panePopupOverlay(0, 'filter')).overlay).toBe('pane-0-filter');
  });
});

describe('the search palette input', () => {
  const chosen = { query: 'sour', selected: 3, includeArchived: false, byMeaning: false };

  it('chooses the first result again for a new query or a new archive choice', () => {
    expect(withQuery(chosen, 'sourd')).toEqual({ ...chosen, query: 'sourd', selected: 0 });
    expect(withArchived(chosen, true)).toEqual({ ...chosen, includeArchived: true, selected: 0 });
  });

  it('chooses the first result again when searching by meaning is turned on or off', () => {
    expect(withMeaning(chosen, true)).toEqual({ ...chosen, byMeaning: true, selected: 0 });
    expect(withMeaning({ ...chosen, byMeaning: true }, false)).toEqual({ ...chosen, selected: 0 });
  });

  it('moves the choice through the rows, wrapping at either end', () => {
    expect(withMoved(chosen, 1, 5).selected).toBe(4);
    expect(withMoved(chosen, 2, 5).selected).toBe(0);
    expect(withMoved({ ...chosen, selected: 0 }, -1, 5).selected).toBe(4);
  });

  it('stays on the first row with nothing to choose from', () => {
    expect(withMoved(chosen, 1, 0).selected).toBe(0);
  });
});

describe('the peek layer', () => {
  const ROWS = ['Tasks/a.md', 'Tasks/b.md', 'Tasks/c.md'].map(createVaultPath);
  const fromRow = (index: number) => ({
    path: ROWS[index] ?? ROWS[0]!,
    from: { within: 'Task table', order: ROWS, index },
  });
  const peeked = withPeekOpened(NO_OVERLAY, fromRow(1));

  it('is opened by a row on its note, where it sits in the rows', () => {
    expect(rowPeek({ path: ROWS[2]!, order: ROWS, within: 'Task table' })).toEqual(fromRow(2));
    // A row its own list does not hold peeks with no stepping, never at index -1.
    const stray = createVaultPath('Elsewhere.md');
    expect(rowPeek({ path: stray, order: ROWS, within: 'Task table' })).toEqual({
      path: stray,
      from: null,
    });
  });

  it('opens over the panes with nothing else up', () => {
    expect(peeked.peek?.path).toBe('Tasks/b.md');
    expect(peeked.overlay).toBeNull();
  });

  it('is refused while a menu or a dialog is up, rather than opening above it', () => {
    const menu = withOpened(NO_OVERLAY, pageMenuOverlay(0));
    expect(withPeekOpened(menu, fromRow(0))).toBe(menu);
    const palette = withOpened(NO_OVERLAY, 'capture');
    expect(withPeekOpened(palette, fromRow(0))).toBe(palette);
  });

  it('lets a menu, a picker or the search palette open above it, keeping it under them', () => {
    const menu = withOpened(peeked, 'new-note-menu');
    expect(menu.overlay).toBe('new-note-menu');
    expect(menu.peek).toEqual(peeked.peek);
    const search = withOpened(peeked, 'search');
    expect(search.overlay).toBe('search');
    expect(withClosed(search, 'search').peek).toEqual(peeked.peek);
  });

  it('closes the top layer only: what is above the peek, then the peek', () => {
    const menu = withOpened(peeked, 'new-note-menu');
    const menuClosed = withClosed(menu, 'new-note-menu');
    expect(menuClosed.peek).toEqual(peeked.peek);
    expect(withPeekClosed(menuClosed)).toEqual(NO_OVERLAY);
    // Closing the peek closes what is above it, which was the peek's own.
    expect(withPeekClosed(menu)).toEqual(NO_OVERLAY);
  });

  it('steps through the rows it was opened from, in their order', () => {
    const next = withPeekStepped(peeked, 2);
    expect(next.peek?.path).toBe('Tasks/c.md');
    expect(peekPosition(next.peek)).toEqual({ index: 2, count: 3, within: 'Task table' });
    expect(withPeekStepped(next, 0).peek?.path).toBe('Tasks/a.md');
  });

  it('steps past a row deleted by another program, in the direction it was going', () => {
    const listed = (path: string) => path !== 'Tasks/c.md';
    expect(withPeekStepped(peeked, 2, listed)).toBe(peeked);
    const atEnd = withPeekStepped(peeked, 2);
    expect(withPeekStepped(atEnd, 1, (path) => path !== 'Tasks/b.md').peek?.path).toBe(
      'Tasks/a.md',
    );
  });

  it('keeps its rows when a link to the note it shows is followed in it', () => {
    expect(withPeekReplaced(peeked, ROWS[1]!)).toBe(peeked);
  });

  it('steps nowhere past either end, nor for a note opened from no list', () => {
    expect(withPeekStepped(peeked, 3)).toBe(peeked);
    expect(withPeekStepped(peeked, -1)).toBe(peeked);
    const linked = withPeekOpened(NO_OVERLAY, { path: ROWS[0]!, from: null });
    expect(withPeekStepped(linked, 1)).toBe(linked);
    expect(peekPosition(linked.peek)).toBeNull();
    expect(withPeekStepped(NO_OVERLAY, 0)).toBe(NO_OVERLAY);
  });

  it('shows another note in place, opened from no list, only while it is up', () => {
    const replaced = withPeekReplaced(peeked, createVaultPath('Notes/elsewhere.md'));
    expect(replaced.peek).toEqual({ path: 'Notes/elsewhere.md', from: null });
    expect(withPeekReplaced(NO_OVERLAY, ROWS[0]!)).toBe(NO_OVERLAY);
  });

  it('holds the shortcuts that make or arrange notes, as a palette does', () => {
    expect(holdsShortcuts(NO_OVERLAY)).toBe(false);
    expect(holdsShortcuts(peeked)).toBe(true);
    expect(holdsShortcuts(withOpened(NO_OVERLAY, 'search'))).toBe(true);
    expect(holdsShortcuts(withOpened(NO_OVERLAY, 'new-note-menu'))).toBe(false);
  });

  it('follows its note when it moves, and the rows it steps through with it', () => {
    const move = { from: createVaultPath('Tasks'), to: createVaultPath('Done') };
    const moved = peekAfterMove(peeked.peek, move);
    expect(moved?.path).toBe('Done/b.md');
    expect(moved?.from?.order).toEqual(['Done/a.md', 'Done/b.md', 'Done/c.md']);
    const elsewhere = { from: createVaultPath('Other'), to: createVaultPath('Else') };
    expect(peekAfterMove(peeked.peek, elsewhere)).toBe(peeked.peek);
    expect(peekAfterMove(null, move)).toBeNull();
  });

  it('closes when its note is deleted, and steps past a deleted row from then on', () => {
    expect(peekWithout(peeked.peek, [createVaultPath('Tasks/b.md')])).toBeNull();
    const kept = peekWithout(peeked.peek, [createVaultPath('Tasks/a.md')]);
    expect(kept).toEqual({
      path: 'Tasks/b.md',
      from: { within: 'Task table', order: ['Tasks/b.md', 'Tasks/c.md'], index: 0 },
    });
    expect(peekWithout(peeked.peek, [createVaultPath('Other.md')])).toBe(peeked.peek);
    expect(peekWithout(null, [createVaultPath('Tasks/b.md')])).toBeNull();
  });
});
