import { useRef, type ReactNode, type Ref } from 'react';
import { Menu } from '@base-ui/react/menu';
import type { PageCrumb } from '@dfai/domain';
import { Icon, sidebarGlyph, type IconName } from './icon.tsx';
import { MenuItems, type MenuCommand } from './menu-items.tsx';
import { PageBarToggles } from './page-bar-toggles.tsx';
import { usePaneFocus } from './pane-focus.ts';

/** One command in a page's "…" menu. */
export type PageMenuItem = MenuCommand;

/**
 * Back and Forward for the pane a bar sits on. Each names where it goes, so
 * its tooltip can say so; null when there is nowhere to go, which disables it.
 */
export interface PageHistory {
  readonly back: string | null;
  readonly forward: string | null;
  readonly onBack: () => void;
  readonly onForward: () => void;
}

/**
 * The nav bar across the top of a pane: where it is, then how it stands and
 * what can be done with it (`FlowTable.dc.html`).
 *
 * Left, Back and Forward, then a breadcrumb — the section or folder, the
 * page's name, and a quiet count beside it. Right, the view's own buttons,
 * a quiet word for the save state, the star, and a "…" menu holding
 * everything that used to be a button on the page: saving now, splitting,
 * the page's properties. The arranging controls live here too, rather than
 * floating: splitting as a button before the menu, and closing a split pane
 * as the very last control, where a close sits on any panel.
 */
export function PageBar({
  crumb,
  name,
  count,
  status,
  star,
  actions,
  menu = [],
  menuOpen,
  onMenuOpenChange,
  onShowSidebar,
  history,
  onSplit,
  onClose,
  closesFromShortcut,
}: {
  /** Null while there is no page to place — an empty pane. */
  crumb: PageCrumb | null;
  name: string | null;
  /** What the page holds, in a few words beside its name — "186 tasks". */
  count?: string;
  /** The save state, as a few quiet words. */
  status?: ReactNode;
  /** The favourite star, when the page can be one. */
  star?: ReactNode;
  /** The view's own buttons — Filter, Sort, New — drawn before the save word. */
  actions?: ReactNode;
  menu?: readonly PageMenuItem[];
  /**
   * The menu's open state, when the app owns it, so it obeys the one-overlay
   * rule. Left out, the menu keeps its own.
   */
  menuOpen?: boolean;
  onMenuOpenChange?: (open: boolean) => void;
  /** Given on the first pane while the sidebar is hidden: the way back to it. */
  onShowSidebar?: () => void;
  /** Back and Forward, drawn before the breadcrumb. */
  history?: PageHistory;
  /** Given only while there is room for another pane. */
  onSplit?: () => void;
  /** Given only while there is another pane to be left with. */
  onClose?: () => void;
  /**
   * Whether the split shortcut closes this pane — it closes the focused one —
   * so the Close button's tooltip names it only where pressing it would.
   * Left out, the pane's frame says whether it is the focused one.
   */
  closesFromShortcut?: boolean;
}) {
  return (
    // Two boxes because a container cannot query itself: the outer one is
    // measured, and the row inside it gives way as the pane narrows.
    <div className="page-bar">
      <div className="page-bar__row">
        {onShowSidebar !== undefined && (
          <button
            className="icon-button page-bar__button"
            type="button"
            onClick={onShowSidebar}
            aria-label="Show sidebar"
            title="Show sidebar (⌘\)"
          >
            <Icon name="panel" size={15} />
          </button>
        )}
        {history !== undefined && <HistoryButtons history={history} />}
        {crumb !== null && name !== null && (
          <nav className="page-bar__crumbs" aria-label="Breadcrumb">
            <Icon name={sidebarGlyph(crumb.icon)} size={15} className="page-bar__crumb-icon" />
            <span className="page-bar__parent">{crumb.parent}</span>
            <span className="page-bar__slash" aria-hidden="true">
              /
            </span>
            <span className="page-bar__name" aria-current="page" title={name}>
              {name}
            </span>
            {count !== undefined && <span className="page-bar__count">{count}</span>}
          </nav>
        )}
        <span className="page-bar__spacer" />
        {actions !== undefined && <div className="page-bar__actions">{actions}</div>}
        {status !== undefined && (
          // A live region: "Unsaved" turning to "Saved" is announced, politely.
          <span className="page-bar__status" role="status">
            {status}
          </span>
        )}
        {star}
        <PageBarToggles />
        {onSplit !== undefined && (
          <PaneButton
            label="Split right"
            icon="split"
            shortcut={SPLIT_SHORTCUT}
            onPress={onSplit}
          />
        )}
        {menu.length > 0 && (
          <PageMenu items={menu} open={menuOpen} onOpenChange={onMenuOpenChange} />
        )}
        {onClose !== undefined && (
          <CloseButton
            onPress={onClose}
            {...(closesFromShortcut !== undefined && { closesFromShortcut })}
          />
        )}
      </div>
    </div>
  );
}

/**
 * A page's own button in its bar — "New template", "Open today's note". It is
 * always an icon, a label and a title: the bar narrows a button to its icon
 * alone in a narrow pane, and the title is then what it is told by.
 */
export function PageAction({
  icon,
  label,
  title = label,
  tone = 'ghost',
  disabled = false,
  busy = false,
  expanded,
  pressed,
  onPressStart,
  onPress,
  buttonRef,
  children,
}: {
  icon: IconName;
  label: string;
  /** The tooltip, when it says more than the label — a shortcut, say. */
  title?: string;
  tone?: 'ghost' | 'secondary' | 'primary';
  disabled?: boolean;
  /**
   * Unavailable for now, but still focusable (`aria-disabled`): a press does
   * nothing, and the keyboard's focus is not dropped as a disabled button's is.
   */
  busy?: boolean;
  /** Given when the button opens a form under the bar. */
  expanded?: boolean;
  /** Given when the button shows and hides something beside the page: the type editor, say. */
  pressed?: boolean;
  /** The pointer coming down, before the press focuses anything. */
  onPressStart?: () => void;
  onPress: () => void;
  /** The button itself, for a page that hands the focus back to it. */
  buttonRef?: Ref<HTMLButtonElement>;
  /** After the label: a shortcut hint, say. */
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`btn btn--${tone} btn--sm page-bar__action`}
      title={title}
      disabled={disabled}
      {...(busy && { 'aria-disabled': true })}
      {...(buttonRef !== undefined && { ref: buttonRef })}
      {...(expanded !== undefined && { 'aria-expanded': expanded })}
      {...(pressed !== undefined && { 'aria-pressed': pressed })}
      {...(onPressStart !== undefined && { onPointerDown: onPressStart })}
      onClick={busy ? undefined : onPress}
    >
      <Icon name={icon} size={15} />
      <span className="page-bar__action-label">{label}</span>
      {children}
    </button>
  );
}

/** Splits an unsplit window and closes the focused pane of a split one. */
const SPLIT_SHORTCUT = '⇧⌘\\';

/**
 * Close, naming the shortcut only on the pane the shortcut closes: the focused
 * one, read from the frame unless the page says so itself. Its own component,
 * so a change of focus draws this button and not the page.
 */
function CloseButton({
  onPress,
  closesFromShortcut,
}: {
  onPress: () => void;
  closesFromShortcut?: boolean;
}) {
  const focused = usePaneFocus();
  const named = closesFromShortcut ?? focused;
  return (
    <PaneButton
      label="Close pane"
      icon="close"
      shortcut={named ? SPLIT_SHORTCUT : null}
      onPress={onPress}
    />
  );
}

/** Splitting or closing, as an icon with its command, and its shortcut if it has one, as the tooltip. */
function PaneButton({
  label,
  icon,
  shortcut,
  onPress,
}: {
  label: 'Split right' | 'Close pane';
  icon: 'split' | 'close';
  shortcut: string | null;
  onPress: () => void;
}) {
  return (
    <button
      className="icon-button page-bar__button"
      type="button"
      onClick={onPress}
      aria-label={label}
      title={shortcut === null ? label : `${label} (${shortcut})`}
    >
      <Icon name={icon} size={15} />
    </button>
  );
}

function HistoryButtons({ history }: { history: PageHistory }) {
  return (
    <div className="page-bar__history" role="group" aria-label="History">
      <HistoryButton
        label="Back"
        icon="arrow-left"
        destination={history.back}
        shortcut="⌘["
        onGo={history.onBack}
      />
      <HistoryButton
        label="Forward"
        icon="arrow-right"
        destination={history.forward}
        shortcut="⌘]"
        onGo={history.onForward}
      />
    </div>
  );
}

function HistoryButton({
  label,
  icon,
  destination,
  shortcut,
  onGo,
}: {
  label: 'Back' | 'Forward';
  icon: 'arrow-left' | 'arrow-right';
  destination: string | null;
  shortcut: string;
  onGo: () => void;
}) {
  return (
    <button
      className="icon-button page-bar__button"
      type="button"
      onClick={onGo}
      disabled={destination === null}
      aria-label={label}
      title={destination === null ? label : `${label} to ${destination} (${shortcut})`}
    >
      <Icon name={icon} size={15} />
    </button>
  );
}

/**
 * The "…" menu, on a page's bar and on the peek's. Open state, focus,
 * typeahead and Escape are Base UI's (ADR-0015).
 */
export function PageMenu({
  items,
  open,
  onOpenChange,
}: {
  items: readonly PageMenuItem[];
  open: boolean | undefined;
  onOpenChange: ((open: boolean) => void) | undefined;
}) {
  const chosen = useRef<PageMenuItem | null>(null);

  return (
    <Menu.Root open={open} onOpenChange={(next) => onOpenChange?.(next)}>
      <Menu.Trigger className="icon-button page-bar__button" aria-label="More" title="More">
        <Icon name="more" size={15} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="menu-positioner" side="bottom" align="end" sideOffset={6}>
          <Menu.Popup
            className="menu"
            aria-labelledby={undefined}
            aria-label="Page"
            render={<ul />}
            finalFocus={() => {
              const returnFocus = chosen.current?.movesFocus !== true;
              chosen.current = null;
              return returnFocus;
            }}
          >
            <MenuItems items={items} chosen={chosen} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
