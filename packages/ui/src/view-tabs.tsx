import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  DndContext,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { Menu } from '@base-ui/react/menu';
import {
  layoutLabel,
  viewIcon,
  type LayoutChoice,
  type ViewLayout,
  type ViewTab,
} from '@dfai/domain';
import { Icon, sidebarGlyph } from './icon.tsx';
import { MenuItems, type MenuCommand } from './menu-items.tsx';
import { EditableTitle } from './page-head.tsx';
import { tabWords } from './drag/announcements.ts';
import { usePressSensors } from './drag/dnd.ts';
import type { OverlaySlot, OverlaySlots } from './overlay-slot.ts';

/**
 * What a type's tabs can do besides switching (issue #11): add, rename, copy,
 * delete and move. Each is the app's to carry out; the tabs only ask.
 */
export interface ViewTabEditing {
  /** "Task": what the type is called, for "Edit Task type". */
  readonly typeLabel: string;
  /** What "+" offers, each with why it cannot be chosen when it cannot. */
  readonly layouts: readonly LayoutChoice[];
  readonly onAdd: (layout: ViewLayout) => void;
  readonly onRename: (args: { path: string; name: string }) => void;
  readonly onDuplicate: (path: string) => void;
  /** Asks to delete the view, through the app's usual question first. */
  readonly onDelete: (path: string) => void;
  /** Settles once the move is written; a rejection puts the tab back where it was. */
  readonly onMove: (args: { path: string; to: number }) => void | Promise<unknown>;
  /** Opens the type's own definition; left out where the page already offers it. */
  readonly onEditType?: (() => void) | undefined;
  /** Opens the template the type's new notes start as, making it if there is none. */
  readonly onEditTemplate?: (() => void) | undefined;
}

/**
 * The tabs across a view's head: the other views of the same notes. Given
 * `editing`, they are a type's tabs — "+" adds one, the selected one's "…"
 * renames, copies or deletes it, any can be dragged, or moved with Alt+← and
 * Alt+→, to another place, the gear opens the type itself, and the page
 * beside it the type's template.
 */
export function ViewTabs({
  tabs,
  onOpenView,
  editing,
  popups,
}: {
  tabs: readonly ViewTab[];
  onOpenView: (path: string) => void;
  editing?: ViewTabEditing | undefined;
  popups?: OverlaySlots | undefined;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const sensors = useSensors(...usePressSensors());
  const held = useHeldOrder(tabs);
  const shown = held.tabs;
  const titleOf = useCallback(
    (id: UniqueIdentifier | undefined) =>
      id === undefined ? null : (tabs.find((tab) => tab.path === String(id))?.title ?? null),
    [tabs],
  );
  const announcements = useMemo(() => tabAnnouncements(titleOf), [titleOf]);

  // A move is asked against the tabs as shown — a move made a moment ago
  // included — and shown at once, rather than when the files are read again.
  const moveTo = (path: string, to: number) => {
    if (editing === undefined) return;
    const order: string[] = shown.map((tab) => tab.path).filter((each) => each !== path);
    order.splice(to, 0, path);
    held.hold(order);
    const written = editing.onMove({ path, to });
    if (written instanceof Promise) {
      // The app says why a move failed; the tabs only stop showing it.
      written.catch(() => held.release());
    }
  };

  const move = (tab: ViewTab, to: number) => {
    if (editing === undefined || !tab.movable || to < 0 || to >= shown.length) return;
    moveTo(tab.path, to);
    setSaid(tabWords.moved(tab.title, to + 1, shown.length));
  };

  // dnd-kit swallows the click that ends a drag, so a dropped tab is not also opened.
  const drop = ({ active, over }: DragEndEvent) => {
    if (over === null || active.id === over.id || editing === undefined) return;
    const to = shown.findIndex((tab) => tab.path === String(over.id));
    if (to !== -1) moveTo(String(active.id), to);
  };

  return (
    <nav className="view-tabs" aria-label="Views">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        accessibility={{ announcements }}
        onDragEnd={drop}
      >
        {shown.map((tab, at) => (
          <TabItem
            key={tab.path}
            tab={tab}
            movable={editing !== undefined && tab.movable}
            renaming={renaming === tab.path}
            onOpen={() => {
              if (!tab.selected) onOpenView(tab.path);
            }}
            onStep={(step) => move(tab, at + step)}
            {...(editing !== undefined && {
              menu: tabMenu({ tab, editing, onRename: () => setRenaming(tab.path) }),
              onRename: (name: string) => editing.onRename({ path: tab.path, name }),
              onRenamed: () => setRenaming(null),
            })}
            slot={popups?.('view-tab-menu')}
          />
        ))}
      </DndContext>
      {editing !== undefined && (
        <AddViewMenu layouts={editing.layouts} onAdd={editing.onAdd} slot={popups?.('add-view')} />
      )}
      {editing?.onEditType !== undefined && (
        <button
          type="button"
          className="view-tabs__add"
          aria-label={`Edit ${editing.typeLabel} type`}
          title={`Edit ${editing.typeLabel} type`}
          onClick={editing.onEditType}
        >
          <Icon name="gear" size={15} />
        </button>
      )}
      {editing?.onEditTemplate !== undefined && (
        <button
          type="button"
          className="view-tabs__add"
          aria-label={`Edit ${editing.typeLabel} template`}
          title={`Edit ${editing.typeLabel} template`}
          onClick={editing.onEditTemplate}
        >
          <Icon name="template" size={15} />
        </button>
      )}
      {editing !== undefined && (
        <span className="visually-hidden" role="status">
          {said}
        </span>
      )}
    </nav>
  );
}

/** The selected tab's "…": what can be done to the view, a type's default table having less. */
function tabMenu({
  tab,
  editing,
  onRename,
}: {
  tab: ViewTab;
  editing: ViewTabEditing;
  onRename: () => void;
}): MenuCommand[] {
  return [
    { label: 'Rename', onSelect: onRename, movesFocus: true },
    { label: 'Duplicate', onSelect: () => editing.onDuplicate(tab.path) },
    ...(tab.deletable
      ? [{ label: 'Delete view', onSelect: () => editing.onDelete(tab.path), destructive: true }]
      : []),
  ];
}

function TabItem({
  tab,
  movable,
  renaming,
  onOpen,
  onStep,
  menu,
  onRename,
  onRenamed,
  slot,
}: {
  tab: ViewTab;
  movable: boolean;
  renaming: boolean;
  onOpen: () => void;
  onStep: (step: -1 | 1) => void;
  menu?: readonly MenuCommand[];
  onRename?: (name: string) => void;
  onRenamed?: () => void;
  slot: OverlaySlot | undefined;
}) {
  const {
    setNodeRef: setDragRef,
    setActivatorNodeRef,
    listeners,
    transform,
    isDragging,
  } = useDraggable({ id: tab.path, disabled: !movable });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: tab.path, disabled: !movable });
  // The tab is both what is dragged and what another tab is dropped on.
  const setItemRef = useCallback(
    (node: HTMLDivElement | null) => {
      setDragRef(node);
      setDropRef(node);
    },
    [setDragRef, setDropRef],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!movable || !event.altKey) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    onStep(event.key === 'ArrowLeft' ? -1 : 1);
  };

  const className = [
    'view-tabs__item',
    isDragging ? 'view-tabs__item--dragging' : '',
    isOver && !isDragging ? 'view-tabs__item--over' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={setItemRef}
      className={className}
      style={
        transform === null
          ? undefined
          : { transform: `translate3d(${transform.x}px, 0, 0)`, zIndex: 2 }
      }
    >
      {renaming && onRename !== undefined ? (
        <EditableTitle
          value={tab.title}
          label="View name"
          hint="Rename this view"
          editing
          inputClassName="view-tabs__rename"
          onCommit={onRename}
          {...(onRenamed !== undefined && { onDone: onRenamed })}
        />
      ) : (
        <button
          ref={setActivatorNodeRef}
          type="button"
          className="view-tabs__tab"
          aria-pressed={tab.selected}
          title={movable ? 'Drag, or Alt+← / Alt+→, to move' : undefined}
          aria-keyshortcuts={movable ? 'Alt+ArrowLeft Alt+ArrowRight' : undefined}
          // A tab that cannot move still takes the press; its drag is disabled.
          {...listeners}
          onClick={onOpen}
          onKeyDown={onKeyDown}
        >
          {tab.title}
        </button>
      )}
      {tab.selected && !renaming && menu !== undefined && (
        <TabMenu title={tab.title} items={menu} slot={slot} />
      )}
    </div>
  );
}

function TabMenu({
  title,
  items,
  slot,
}: {
  title: string;
  items: readonly MenuCommand[];
  slot: OverlaySlot | undefined;
}) {
  const chosen = useRef<MenuCommand | null>(null);
  return (
    <Menu.Root {...slot}>
      <Menu.Trigger
        className="view-tabs__more"
        // Only the selected tab has one, so "View options" is unambiguous — and a
        // name holding the tab's title would also answer to a search for the tab.
        aria-label="View options"
        title={`Options for ${title}`}
      >
        <Icon name="more" size={15} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="menu-positioner" side="bottom" align="start" sideOffset={6}>
          <Menu.Popup
            className="menu"
            aria-labelledby={undefined}
            aria-label="View options"
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

/** "+": a new view of the type, by layout. A layout the type cannot draw says why. */
function AddViewMenu({
  layouts,
  onAdd,
  slot,
}: {
  layouts: readonly LayoutChoice[];
  onAdd: (layout: ViewLayout) => void;
  slot: OverlaySlot | undefined;
}) {
  return (
    <Menu.Root {...slot}>
      <Menu.Trigger className="view-tabs__add" aria-label="Add a view" title="Add a view">
        <Icon name="plus" size={15} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="menu-positioner" side="bottom" align="start" sideOffset={6}>
          <Menu.Popup
            className="menu layout-menu"
            aria-labelledby={undefined}
            aria-label="Add a view"
          >
            {layouts.map((choice) => (
              <Menu.Item
                key={choice.layout}
                label={layoutLabel(choice.layout)}
                disabled={!choice.available}
                className="layout-menu__item"
                onClick={() => onAdd(choice.layout)}
              >
                <Icon name={sidebarGlyph(viewIcon(choice.layout))} size={16} />
                <span className="layout-menu__words">
                  <span className="menu__label">{layoutLabel(choice.layout)}</span>
                  {choice.reason !== null && (
                    <span className="layout-menu__reason">{choice.reason}</span>
                  )}
                </span>
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

const orderKey = (paths: readonly string[]) => paths.join('\n');

/**
 * The tabs in the order last asked for, until the files are read again. Each
 * move is shown at once; the tabs as given are followed again once they are in
 * an order no move here has left behind — the move landed, or something else
 * changed them.
 */
function useHeldOrder(tabs: readonly ViewTab[]) {
  const [held, setHeld] = useState<{ order: readonly string[]; behind: readonly string[] } | null>(
    null,
  );
  const given = orderKey(tabs.map((tab) => tab.path));
  const current =
    held !== null && held.behind.includes(given) && orderKey(held.order) !== given ? held : null;
  // Adjusted while rendering, as React advises for state that follows a prop.
  if (held !== null && current === null) setHeld(null);

  const byPath = new Map(tabs.map((tab) => [tab.path as string, tab]));
  const reordered = current?.order.flatMap((path) => byPath.get(path) ?? []) ?? [];
  const shown = current !== null && reordered.length === tabs.length ? reordered : tabs;

  return {
    tabs: shown,
    hold: (order: readonly string[]) =>
      setHeld({
        order,
        behind: [...(current?.behind ?? [given]), orderKey(shown.map((tab) => tab.path))],
      }),
    release: () => setHeld(null),
  };
}

/** dnd-kit hands over ids; the sentences want the tabs' names. */
function tabAnnouncements(
  titleOf: (id: UniqueIdentifier | undefined) => string | null,
): Announcements {
  const name = (id: UniqueIdentifier) => titleOf(id) ?? String(id);
  return {
    onDragStart: ({ active }) => tabWords.start(name(active.id)),
    onDragOver: ({ active, over }) => tabWords.over(name(active.id), titleOf(over?.id)),
    onDragEnd: ({ active, over }) => tabWords.end(name(active.id), titleOf(over?.id)),
    onDragCancel: ({ active }) => tabWords.cancel(name(active.id)),
  };
}
