import type { ReactNode } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { Icon } from './icon.tsx';
import { useReturnFocus, type FocusFallback } from './return-focus.ts';

/**
 * The sidebar as a drawer over the work, where the window is too narrow for
 * it beside (`shellLayoutFor`, #658). Open and closed are the app's to hold:
 * the drawer closes itself on Escape, on a tap outside and when the app says
 * so (a page opened from it), each through `onOpenChange`.
 */
export interface SidebarDrawer {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Where the focus goes as the drawer closes, when what opened it did not take the focus. */
  readonly returnFocus?: FocusFallback;
}

/**
 * The window: the sidebar on the ground colour behind a hairline, and the work
 * edge to edge on the surface beside it — one panel, or one per pane when the
 * window is split, with a hairline between them.
 */
export function AppShell({
  sidebar,
  main = null,
  notices = null,
  panes = null,
  status = null,
  overlay = null,
  floating = null,
  sidebarOpen = true,
  onShowSidebar,
  aside = null,
  asideOpen = true,
  drawer = null,
}: {
  sidebar: ReactNode;
  /**
   * A surface that takes the whole width in place of the panes — the empty
   * state, or a type's table. `null` shows the panes.
   */
  main?: ReactNode;
  /** Problems to report, above the panels rather than inside any one of them. */
  notices?: ReactNode;
  /**
   * The panes, drawn by the app inside a `PaneSplit` of its own, since how
   * many there are is the app's to know. Null shows nothing.
   */
  panes?: ReactNode;
  /**
   * What the app is doing in the background — indexing, say. Announced to a
   * screen reader rather than drawn: it is not something to read while working,
   * and the index's count and Rebuild live in Settings.
   */
  status?: ReactNode;
  /** Drawn above everything else — the search palette, for instance. */
  overlay?: ReactNode;
  /**
   * What floats over the content panel — the index's progress. Drawn inside the
   * panels' area, so it measures itself against them, clear of the sidebar.
   */
  floating?: ReactNode;
  sidebarOpen?: boolean;
  /** Given when the app offers a way back to a hidden sidebar. */
  onShowSidebar?: () => void;
  /** The right sidebar beside the work — or, until slice 8b, the chat — or null for none. */
  aside?: ReactNode;
  /**
   * Whether the aside is shown. Closed, it is not in the page at all, so
   * nothing in it can hold the focus or be read; the app remembers the state.
   */
  asideOpen?: boolean;
  /**
   * Given on a narrow screen: the sidebar is then a drawer over the work
   * rather than beside it, and `sidebarOpen` is not read. Null, the default,
   * is the wide window, drawn exactly as before.
   */
  drawer?: SidebarDrawer | null;
}) {
  const work =
    main === null ? (
      panes
    ) : (
      <PaneSplit count={1}>
        <MainPanel>{main}</MainPanel>
      </PaneSplit>
    );

  const asideShown = aside !== null && asideOpen;
  // With the drawer the sidebar is out of the flow, which is what `shell--narrow`
  // says to the stylesheet: the aside folds as it does with the sidebar hidden.
  const sidebarBeside = drawer === null && sidebarOpen;
  const className = [
    'shell',
    sidebarBeside ? null : 'shell--narrow',
    drawer === null ? null : 'shell--compact',
    asideShown ? 'shell--aside' : null,
  ]
    .filter((name) => name !== null)
    .join(' ');

  return (
    <div className={className}>
      {sidebarBeside && (
        <nav className="shell__sidebar" aria-label="Vault">
          {sidebar}
        </nav>
      )}
      {drawer !== null && <DrawerSidebar drawer={drawer}>{sidebar}</DrawerSidebar>}
      <main className="shell__main">
        {notices}
        {work}
        {!sidebarBeside && onShowSidebar !== undefined && (
          <button
            className="icon-button shell__show"
            type="button"
            onClick={onShowSidebar}
            aria-label="Show sidebar"
            title="Show sidebar (⌘\)"
          >
            <Icon name="panel" />
          </button>
        )}
        {floating}
      </main>
      {asideShown && <div className="shell__aside">{aside}</div>}
      <div className="visually-hidden" role="status">
        {status}
      </div>
      {overlay}
    </div>
  );
}

/**
 * The sidebar in a modal dialog over the work: the focus stays in it while it
 * is open, Escape and a tap on the scrim close it, and the focus goes back to
 * what opened it. The sidebar's own Hide button closes it too, through the
 * app. Unmounted while closed, as the sidebar is while hidden on a wide
 * window, so nothing in it can hold the focus or be read.
 */
function DrawerSidebar({ drawer, children }: { drawer: SidebarDrawer; children: ReactNode }) {
  return (
    <Dialog.Root open={drawer.open} onOpenChange={drawer.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="shell__scrim" />
        <DrawerPopup returnFocus={drawer.returnFocus}>{children}</DrawerPopup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Mounted as the drawer opens, so it reads what held the focus just then. A
 * pane's frame (`PaneFrame`, focusable from script only) holding it means a
 * button in its bar was clicked in WebKit, which focuses the frame rather
 * than the button: nothing the person chose, so the focus goes to the way
 * back in instead.
 */
function DrawerPopup({
  returnFocus,
  children,
}: {
  returnFocus: FocusFallback | undefined;
  children: ReactNode;
}) {
  const finalFocus = useReturnFocus(returnFocus, { unheld: isPaneFrame });
  return (
    <Dialog.Popup className="shell__drawer" aria-label="Sidebar" finalFocus={finalFocus}>
      <nav className="shell__sidebar" aria-label="Vault">
        {children}
      </nav>
    </Dialog.Popup>
  );
}

const isPaneFrame = (element: HTMLElement): boolean => element.classList.contains('pane');

/**
 * The split, as equal columns.
 *
 * A grid rather than anything positioned: the panes share the width the
 * window has, and neither one knows how much of it the other took. `count`
 * is how many columns the grid draws, which is how many panes it is given.
 */
export function PaneSplit({ count, children }: { count: number; children: ReactNode }) {
  return (
    <div className="shell__split" data-panes={count}>
      {children}
    </div>
  );
}

/**
 * The whole-width surface, in the same panel a pane has. What it holds draws
 * its own bar — a type's table heads itself like any page — so the panel is
 * only the surface.
 */
function MainPanel({ children }: { children: ReactNode }) {
  return <section className="panel">{children}</section>;
}
