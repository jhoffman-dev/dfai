// @vitest-environment jsdom
/**
 * How much Pages draws again (#238): the sidebar is drawn again for
 * everything the window does — opening a note, every key typed in ⌘K — with
 * its handlers made anew each time. A row draws again only for a change of
 * its own, and the one menu every row's "…" opens still works from the first
 * key pressed, with the latest handlers.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createVaultPath, type SidebarTreeRow, type VaultEntry } from '@dfai/domain';
import { DndContext } from '@dnd-kit/core';
import { VaultTree, type TreeEditing } from './vault-tree.tsx';
import { VaultTreeRow, type TreeRowActions } from './vault-tree-row.tsx';
import { startCountingRenders, stopCountingRenders } from './testing/render-counter.ts';

// Before React loads, so every commit is handed to the counter.
await vi.hoisted(async () => {
  const { installRenderCounter } = await import('./testing/render-counter.ts');
  installRenderCounter();
});

const noteRow = (name: string): SidebarTreeRow => ({
  entry: { kind: 'file', name: `${name}.md`, path: createVaultPath(`${name}.md`) },
  depth: 0,
  isExpanded: false,
  isLoaded: true,
  label: name,
  icon: 'doc',
  opensArchive: false,
});

const ROWS = ['DFAI', 'Budget', 'Garden', 'Harbour', 'Ledger', 'Orchard'].map(noteRow);

/** Pages as the app hands it over: every handler, the sets and the editing made again on each render. */
function tree({
  rows = ROWS,
  open = [],
  starred = ['Garden.md'],
  editing = {},
  onSelectFile = () => {},
}: {
  rows?: readonly SidebarTreeRow[];
  open?: readonly string[];
  starred?: readonly string[];
  editing?: Partial<TreeEditing>;
  onSelectFile?: (path: string) => void;
} = {}) {
  return (
    <VaultTree
      rows={rows}
      open={new Set(open)}
      starred={new Set(starred)}
      onToggleDirectory={() => {}}
      onSelectFile={onSelectFile}
      onToggleFavorite={() => {}}
      editing={{
        menuFor: (entry: VaultEntry) => [
          { label: 'Rename', onSelect: () => {} },
          { label: `Duplicate ${entry.name}`, onSelect: () => {} },
        ],
        menuOpen: true,
        onMenuOpenChange: () => {},
        renaming: null,
        onRename: () => {},
        onCancelRename: () => {},
        canDrop: () => true,
        onDrop: () => {},
        ...editing,
      }}
    />
  );
}

/** How many of each `act` drew. */
function drawnBy(act: () => void): { rows: number; more: number } {
  startCountingRenders();
  act();
  const { renders } = stopCountingRenders();
  return { rows: renders['VaultTreeRow'] ?? 0, more: renders['MoreButton'] ?? 0 };
}

const ORCHARD = noteRow('Orchard');

/** One row inside the drag context it reads, as the tree draws it: its placement and editing made anew. */
function oneRow(accepts: boolean, actions: TreeRowActions) {
  return (
    <DndContext>
      <VaultTreeRow
        row={ORCHARD}
        placement={{ index: 0, top: 0, height: 30, indent: 10, tabbable: true, selected: false }}
        editing={{ renaming: false, accepts }}
        starred={false}
        actions={actions}
      />
    </DndContext>
  );
}

describe('VaultTreeRow — what it is compared by', () => {
  const actions: TreeRowActions = {
    onActivate: () => {},
    onFocusRow: () => {},
    onToggleFavorite: () => {},
    onMenu: () => {},
    onRename: () => {},
    onCancelRename: () => {},
  };

  it('draws again when what is held may be dropped on it, so it can light up', () => {
    const view = render(oneRow(false, actions));
    // The highlight itself needs a drag under way over the row, which the e2e drag specs drive.
    expect(drawnBy(() => view.rerender(oneRow(false, actions))).rows).toBe(0);
    expect(drawnBy(() => view.rerender(oneRow(true, actions))).rows).toBe(1);
  });
});

describe('VaultTree — what one commit draws', () => {
  it('draws no row again for a commit that changes nothing in the tree', () => {
    const view = render(tree());
    expect(screen.getAllByRole('treeitem')).toHaveLength(ROWS.length);
    const drawn = drawnBy(() => {
      view.rerender(tree());
      view.rerender(tree());
    });
    expect(drawn).toEqual({ rows: 0, more: 0 });
  });

  it('draws the one row a note opened in', () => {
    const view = render(tree({ open: ['DFAI.md'] }));
    const drawn = drawnBy(() => view.rerender(tree({ open: ['DFAI.md', 'Ledger.md'] })));
    expect(drawn.rows).toBe(1);
    expect(screen.getByRole('treeitem', { name: 'Ledger' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('draws the one row being named in place', () => {
    const view = render(tree());
    const drawn = drawnBy(() =>
      view.rerender(tree({ editing: { renaming: createVaultPath('Budget.md') } })),
    );
    expect(drawn.rows).toBe(1);
    expect(screen.getByRole('textbox', { name: 'Name for Budget' })).toBeDefined();
  });

  it('draws the one row starred, with its star on', () => {
    const view = render(tree());
    const drawn = drawnBy(() => view.rerender(tree({ starred: ['Garden.md', 'Ledger.md'] })));
    expect(drawn.rows).toBe(1);
    expect(
      screen.getByRole('treeitem', { name: 'Ledger' }).querySelector('.star--on'),
    ).not.toBeNull();
  });

  it('draws the one folder opened, expanded', () => {
    const shut: SidebarTreeRow = {
      entry: { kind: 'directory', name: 'Seeds', path: createVaultPath('Seeds') },
      depth: 0,
      isExpanded: false,
      isLoaded: true,
      label: 'Seeds',
      icon: 'folder',
      opensArchive: false,
    };
    const view = render(tree({ rows: [shut, ...ROWS] }));
    const drawn = drawnBy(() =>
      view.rerender(tree({ rows: [{ ...shut, isExpanded: true }, ...ROWS] })),
    );
    expect(drawn.rows).toBe(1);
    expect(screen.getByRole('treeitem', { name: 'Seeds' }).getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  it('opens with the latest handler, though the rows were not drawn again for it', async () => {
    const first = vi.fn();
    const latest = vi.fn();
    const view = render(tree({ onSelectFile: first }));
    view.rerender(tree({ onSelectFile: latest }));
    await userEvent.click(screen.getByRole('treeitem', { name: 'Harbour' }));
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledWith('Harbour.md', 'here');
  });
});

/**
 * The rows share one menu, built once beside the tree rather than once a row,
 * so there is no per-row menu to build lazily: a row's "…" is a plain button
 * that opens it. From the keyboard it opens on its first item, as a menu
 * button does (#250); from the pointer, on the menu itself.
 */
describe('VaultTree — a row’s menu from the keyboard', () => {
  const more = (name: string) => screen.getByRole('button', { name: `Options for ${name}` });

  it.each(['{Enter}', ' '])(
    'opens on its first item from %s, and Escape gives the focus back to the "…"',
    async (key) => {
      render(tree());
      more('Ledger').focus();
      await userEvent.keyboard(key);
      const menu = await screen.findByRole('menu', { name: 'Page' });
      const first = within(menu).getByRole('menuitem', { name: 'Rename' });
      await waitFor(() => expect(document.activeElement).toBe(first));
      // Base UI counts the first item as the one it is on, so the arrows go on from it.
      expect(first.hasAttribute('data-highlighted')).toBe(true);
      await userEvent.keyboard('{ArrowDown}');
      expect(document.activeElement).toBe(
        within(menu).getByRole('menuitem', { name: 'Duplicate Ledger.md' }),
      );

      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
      expect(document.activeElement).toBe(more('Ledger'));
    },
  );

  it('opens on its first item from Shift+F10 on the row too', async () => {
    render(tree());
    screen.getByRole('treeitem', { name: 'Ledger' }).focus();
    await userEvent.keyboard('{Shift>}{F10}{/Shift}');
    const menu = await screen.findByRole('menu', { name: 'Page' });
    await waitFor(() =>
      expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: 'Rename' })),
    );
  });

  it('opens on the menu itself, no item picked out, when the "…" is clicked', async () => {
    render(tree());
    await userEvent.click(more('Ledger'));
    const menu = await screen.findByRole('menu', { name: 'Page' });
    await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));
    // Long enough for Base UI's own focus, a frame after the popup mounts, to have landed.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(document.activeElement).toBe(menu);
    expect(
      within(menu)
        .queryAllByRole('menuitem')
        .some((item) => item === document.activeElement),
    ).toBe(false);
  });

  it('draws no row again for opening it or shutting it', async () => {
    render(tree());
    more('Ledger').focus();
    startCountingRenders();
    await userEvent.keyboard('{Enter}');
    const menu = await screen.findByRole('menu', { name: 'Page' });
    await waitFor(() =>
      expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: 'Rename' })),
    );
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    const { renders } = stopCountingRenders();
    expect({ rows: renders['VaultTreeRow'] ?? 0, more: renders['MoreButton'] ?? 0 }).toEqual({
      rows: 0,
      more: 0,
    });
    // The counter was on and saw the menu drawn, so the zeros above are not a counter that saw nothing.
    expect(renders['EntryMenu'] ?? 0).toBeGreaterThan(0);
  });
});

describe('VaultTree — what a scroll draws', () => {
  const MANY = Array.from({ length: 300 }, (_, at) =>
    noteRow(`Note ${String(at).padStart(3, '0')}`),
  );

  /** Scrolls the tree's own scroller to `top`, and lets the scroll settle as it would. */
  function scrollTo(scroller: HTMLElement, top: number) {
    scroller.scrollTop = top;
    scroller.dispatchEvent(new Event('scroll'));
    act(() => vi.advanceTimersByTime(500));
  }

  it('draws nothing again for a scroll that keeps the same rows drawn (#169)', () => {
    vi.useFakeTimers();
    try {
      const { container } = render(tree({ rows: MANY }));
      const scroller = container.querySelector<HTMLElement>('.tree');
      expect(scroller).not.toBeNull();
      const before = screen.getAllByRole('treeitem').length;
      expect(before).toBeGreaterThan(0);
      startCountingRenders();
      // A few pixels: within the rows the tree already holds past its edge.
      scrollTo(scroller as HTMLElement, 24);
      const { renders } = stopCountingRenders();
      expect(renders['VaultTree'] ?? 0).toBe(0);
      expect(screen.getAllByRole('treeitem')).toHaveLength(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('draws the rows a long scroll brings into view', () => {
    vi.useFakeTimers();
    try {
      const { container } = render(tree({ rows: MANY }));
      const scroller = container.querySelector<HTMLElement>('.tree') as HTMLElement;
      expect(screen.queryByRole('treeitem', { name: 'Note 250' })).toBeNull();
      scrollTo(scroller, 250 * 29);
      expect(screen.getByRole('treeitem', { name: 'Note 250' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
