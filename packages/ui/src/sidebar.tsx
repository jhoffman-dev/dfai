import { memo, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Menu } from '@base-ui/react/menu';
import {
  isSidebarSectionId,
  SIDEBAR_SECTION_LABELS,
  type ActiveSidebarPage,
  type QuickViewId,
  type SidebarEntry,
  type SidebarIcon,
  type SidebarSectionId,
  type SidebarTreeRow,
  type VaultPath,
} from '@dfai/domain';
import { FavoriteStar } from './favorite-star.tsx';
import { Icon, sidebarGlyph, type IconName } from './icon.tsx';
import { VaultTree, type TreeEditing } from './vault-tree.tsx';
import { MenuItems, type MenuCommand } from './menu-items.tsx';
import { SortableList } from './sortable-list.tsx';
import { TypeRowMenu, type TypeMenuAnchor } from './type-row-menu.tsx';
import { useLongPress } from './long-press.ts';
import { useReorderTransition } from './reorder-transition.ts';
import { useSidebarSections, type SectionOrder, type SectionStore } from './sidebar-sections.ts';
import { openHowFrom, type OpenHow } from './open-how.ts';
import { useSteadyCallback } from './steady-callback.ts';

/** One of the vault's types, with how many notes declare it. */
export interface SidebarType {
  readonly name: string;
  readonly label: string;
  readonly count: number;
  readonly icon: SidebarIcon;
}

/** A type file that does not read whole, listed under Types with why (#683). */
export interface SidebarBrokenType {
  readonly path: VaultPath;
  readonly name: string;
  readonly problem: string;
}

const NONE_BROKEN: readonly SidebarBrokenType[] = [];

/** A saved view lifted to the top of the sidebar — Today, or Inbox. */
export interface SidebarQuickView {
  readonly id: QuickViewId;
  readonly entry: SidebarEntry;
  /** How many notes it holds right now, when that is known. */
  readonly count: number | null;
}

/** The Inbox's row: what it opens, and how many notes wait there. */
export interface InboxRowLink {
  readonly onOpen: () => void;
  /** How many notes wait in the Inbox, when that is known. */
  readonly count: number | null;
}

/** The vault as it is on disk, which only Pages draws. */
export interface SidebarTree {
  readonly rows: readonly SidebarTreeRow[];
  readonly onToggleDirectory: (path: VaultPath) => void;
  /** What the Archive's row opens: the Archive, in place of the panes. */
  readonly onOpenArchive?: () => void;
  /** Rows' menus, naming in place and dragging; left out, Pages only opens. */
  readonly editing?: TreeEditing;
  /** The section's "+": what can be made at the top level. */
  readonly create?: HeaderMenu;
}

/** A section heading's "+" menu, its open state owned by the app's one-overlay rule. */
export interface HeaderMenu {
  readonly label: string;
  readonly items: readonly MenuCommand[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

const QUICK_GLYPHS: Readonly<Record<QuickViewId, IconName>> = { today: 'sun', inbox: 'inbox' };

/**
 * The vault: a few rows to jump to, then five collapsible peers — favourites,
 * types, views, dashboards and Pages.
 *
 * Four of the sections are short lists and one is the whole vault, so only
 * Pages is virtualised — it keeps the tree, and the tree keeps its own
 * guarantee. The other four are ordinary lists inside a disclosure, which is
 * what lets each section be a real heading and each row carry a star.
 *
 * All five share one scroller (issue #17): each section is as tall as its
 * rows, and the tree is virtualised against that scroller rather than one of
 * its own, so a short window scrolls the sidebar once instead of squeezing
 * every section into a scrollbar of its own.
 *
 * The sections can be dragged by their grip (or moved with Alt+↑/↓ from it)
 * into any order, and open or shut a section keeps its place in it; the
 * order is the domain's rule, and this only draws it.
 */
export function Sidebar({
  favorites,
  types,
  brokenTypes = NONE_BROKEN,
  views,
  dashboards,
  quick,
  tree,
  active,
  sectionStore,
  sectionOrder,
  onSearch,
  onOpenGraph,
  onOpenTags,
  onOpenAsk,
  onOpenLibrary,
  onOpenHighlights,
  onOpenAutomations,
  activity,
  onOpenTemplates,
  onOpenSkills,
  onOpenTerms,
  inbox,
  onOpenReview,
  onOpenToday,
  onOpen,
  onOpenType,
  onEditType,
  onEditTemplate,
  onNewType,
  viewsCreate,
  onToggleFavorite,
}: {
  favorites: readonly SidebarEntry[];
  types: readonly SidebarType[];
  /** Type files that do not read whole, listed under the types. */
  brokenTypes?: readonly SidebarBrokenType[];
  views: readonly SidebarEntry[];
  dashboards: readonly SidebarEntry[];
  quick: readonly SidebarQuickView[];
  tree: SidebarTree;
  /** The one page to mark as where you are, decided by `activeSidebarPageOf`. */
  active: ActiveSidebarPage;
  sectionStore: SectionStore;
  /** The order the vault keeps the sections in, and how to change it; left out, they stay put. */
  sectionOrder?: SectionOrder;
  onSearch: () => void;
  /** Opens the graph of the whole vault; its row sits under the quick views when given. */
  onOpenGraph?: () => void;
  /** Opens the tags page; its row sits under the graph's when given. */
  onOpenTags?: () => void;
  /** Opens the Library of literature notes (#507); its row sits under the tags' when given. */
  /** Opens Ask, where a question starts (#37). Steady, so its row is not drawn with every window render. */
  onOpenAsk?: () => void;
  onOpenLibrary?: () => void;
  /** Opens All highlights (#507); its row sits under the Library's when given. */
  onOpenHighlights?: () => void;
  /** Opens the Automations page; its row sits under the research rows when given. */
  onOpenAutomations?: () => void;
  /** The Activity page's row, under the Automations', and how many errors arrived since it was last open. */
  activity?: ActivityRowLink;
  /** Opens the Templates page; its row sits under the Activity's when given. */
  onOpenTemplates?: () => void;
  /** Opens the Skills page (#169); its row sits under the Templates' when given. */
  onOpenSkills?: () => void;
  /** Opens the Terms page; its row sits last when given. */
  onOpenTerms?: () => void;
  /**
   * The Inbox page's row, after Today, when given: it stands in for a saved
   * view titled Inbox, which the page then links to (P30-01).
   */
  inbox?: InboxRowLink;
  /** Opens the weekly review; its row sits under the Inbox's when given (P30-07). */
  onOpenReview?: () => void;
  /**
   * Opens the Today page; its row comes first when given, and stands in for a
   * saved view titled Today, which the page then links to (#111) — never two rows.
   */
  onOpenToday?: () => void;
  /** Opens a note; `how` is where the click asked for it: here, a new tab or a split. */
  onOpen: (path: VaultPath, how: OpenHow) => void;
  onOpenType: (name: string) => void;
  /** Opens a type's definition; a type's menu offers it when given. */
  onEditType?: (name: string) => void;
  /** Opens a type's template, made if it has none; a type's menu offers it when given. */
  onEditTemplate?: (name: string) => void;
  /** Starts a new type; the Types heading offers it when given. */
  onNewType?: () => void;
  /** The Views heading's "+": a new view, a new query. */
  viewsCreate?: HeaderMenu;
  onToggleFavorite: (path: VaultPath) => void;
}) {
  const sections = useSidebarSections(sectionStore, sectionOrder);
  const root = useRef<HTMLDivElement>(null);
  // Held as state, not a ref, so the tree is handed the element once it is
  // mounted (see useScrollMargin).
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const beforeReorder = useReorderTransition(root);
  const openPaths = active?.kind === 'note' ? [active.path] : [];
  // The Archive is a page of its own; its row in Pages is where it is marked.
  if (active?.kind === 'archive') {
    for (const row of tree.rows) if (row.opensArchive) openPaths.push(row.entry.path);
  }
  const open = useSameSet(openPaths);
  const openTypeName = active?.kind === 'type' ? active.name : null;
  // The favourites section is the list of favourites, so nothing else has to be
  // told which notes are starred.
  const starred = useSameSet(favorites.map((entry) => entry.path));
  // The lists are drawn with `memo`, and the app hands over new handlers on
  // every render: these stay the same and call the latest (#293).
  const openEntry = useSteadyCallback(onOpen);
  const toggleFavorite = useSteadyCallback(onToggleFavorite);
  const openType = useSteadyCallback(onOpenType);
  const editType = useSteadyCallback((name: string) => onEditType?.(name));
  const editTemplate = useSteadyCallback((name: string) => onEditTemplate?.(name));

  const list = (entries: readonly SidebarEntry[], empty: string) => (
    <EntryList
      entries={entries}
      empty={empty}
      open={open}
      starred={starred}
      onOpen={openEntry}
      onToggleFavorite={toggleFavorite}
    />
  );

  const bodies: Readonly<Record<SidebarSectionId, SectionBody>> = {
    favorites: { children: list(favorites, 'Star a note to keep it here.') },
    types: {
      ...(onNewType !== undefined && {
        action: (
          <button
            type="button"
            className="icon-button sidebar__heading-action"
            aria-label="New type"
            title="New type"
            onClick={onNewType}
          >
            <Icon name="plus" size={14} />
          </button>
        ),
      }),
      children: (
        <>
          <TypeList
            types={types}
            anyBroken={brokenTypes.length > 0}
            openTypeName={openTypeName}
            onOpenType={openType}
            {...(onEditType !== undefined && { onEditType: editType })}
            {...(onEditTemplate !== undefined && { onEditTemplate: editTemplate })}
          />
          <BrokenTypeList broken={brokenTypes} onOpen={openEntry} />
        </>
      ),
    },
    views: {
      ...(viewsCreate !== undefined && { action: <SectionMenu menu={viewsCreate} /> }),
      children: list(views, 'No views yet.'),
    },
    dashboards: { children: list(dashboards, 'No dashboards yet.') },
    userSpace: {
      ...(tree.create !== undefined && { action: <SectionMenu menu={tree.create} /> }),
      children: (
        <VaultTree
          rows={tree.rows}
          open={open}
          starred={starred}
          onToggleDirectory={tree.onToggleDirectory}
          onSelectFile={onOpen}
          onToggleFavorite={onToggleFavorite}
          {...(tree.onOpenArchive !== undefined && { onOpenArchive: tree.onOpenArchive })}
          {...(tree.editing !== undefined && { editing: tree.editing })}
          scrollParent={scroller}
        />
      ),
    },
  };

  return (
    <div className="sidebar" ref={root}>
      <QuickRows
        quick={quick}
        open={open}
        graphOn={active?.kind === 'graph'}
        tagsOn={active?.kind === 'tags'}
        askOn={active?.kind === 'ask'}
        libraryOn={active?.kind === 'library'}
        highlightsOn={active?.kind === 'highlights'}
        automationsOn={active?.kind === 'automations'}
        activityOn={active?.kind === 'activity'}
        templatesOn={active?.kind === 'templates'}
        skillsOn={active?.kind === 'skills'}
        termsOn={active?.kind === 'terms'}
        inboxOn={active?.kind === 'inbox'}
        reviewOn={active?.kind === 'review'}
        todayOn={active?.kind === 'today'}
        onSearch={onSearch}
        onOpen={onOpen}
        {...(onOpenGraph !== undefined && { onOpenGraph })}
        {...(onOpenTags !== undefined && { onOpenTags })}
        {...(onOpenAsk !== undefined && { onOpenAsk })}
        {...(onOpenLibrary !== undefined && { onOpenLibrary })}
        {...(onOpenHighlights !== undefined && { onOpenHighlights })}
        {...(onOpenAutomations !== undefined && { onOpenAutomations })}
        {...(activity !== undefined && { activity })}
        {...(onOpenTemplates !== undefined && { onOpenTemplates })}
        {...(onOpenSkills !== undefined && { onOpenSkills })}
        {...(onOpenTerms !== undefined && { onOpenTerms })}
        {...(inbox !== undefined && { inbox })}
        {...(onOpenReview !== undefined && { onOpenReview })}
        {...(onOpenToday !== undefined && { onOpenToday })}
      />

      <div className="sidebar__scroll" ref={setScroller}>
        <SortableList
          className="sidebar__sections"
          items={sections.shown}
          idOf={(id) => id}
          nameOf={(id) => SIDEBAR_SECTION_LABELS[id]}
          onMove={({ id, to }) => {
            if (sections.move === null || !isSidebarSectionId(id)) return;
            beforeReorder();
            sections.move({ id, to });
          }}
          canMove={({ id, to }) => isSidebarSectionId(id) && sections.canMove({ id, to })}
        >
          {(id, handle) => (
            <Section
              id={id}
              sections={sections}
              onToggle={sections.toggle}
              handle={sections.move === null ? null : handle}
              {...bodies[id]}
            />
          )}
        </SortableList>
      </div>
    </div>
  );
}

/**
 * Search, then whichever of Today and Inbox the vault has — the Today and
 * Inbox pages' rows in place of the views of those names, when they are
 * given — then the graph and the tags.
 */
function QuickRows({
  quick,
  open,
  graphOn,
  tagsOn,
  askOn,
  libraryOn,
  highlightsOn,
  automationsOn,
  activityOn,
  templatesOn,
  skillsOn,
  termsOn,
  inboxOn,
  reviewOn,
  todayOn,
  onSearch,
  onOpenGraph,
  onOpenTags,
  onOpenAsk,
  onOpenLibrary,
  onOpenHighlights,
  onOpenAutomations,
  activity,
  onOpenTemplates,
  onOpenSkills,
  onOpenTerms,
  inbox,
  onOpenReview,
  onOpenToday,
  onOpen,
}: {
  quick: readonly SidebarQuickView[];
  open: ReadonlySet<string>;
  graphOn: boolean;
  tagsOn: boolean;
  askOn: boolean;
  libraryOn: boolean;
  highlightsOn: boolean;
  automationsOn: boolean;
  activityOn: boolean;
  templatesOn: boolean;
  skillsOn: boolean;
  termsOn: boolean;
  inboxOn: boolean;
  reviewOn: boolean;
  todayOn: boolean;
  onSearch: () => void;
  onOpenGraph?: () => void;
  onOpenTags?: () => void;
  /** Opens Ask, where a question starts (#37). */
  onOpenAsk?: () => void;
  onOpenLibrary?: () => void;
  onOpenHighlights?: () => void;
  onOpenAutomations?: () => void;
  activity?: ActivityRowLink;
  onOpenTemplates?: () => void;
  onOpenSkills?: () => void;
  onOpenTerms?: () => void;
  inbox?: InboxRowLink;
  onOpenReview?: () => void;
  onOpenToday?: () => void;
  onOpen: (path: VaultPath, how: OpenHow) => void;
}) {
  // A page's row stands in for the saved view of its name: one Today, one Inbox.
  const views = quick.filter(
    (view) =>
      !(view.id === 'inbox' && inbox !== undefined) &&
      !(view.id === 'today' && onOpenToday !== undefined),
  );
  return (
    <ul className="sidebar__list sidebar__quick" aria-label="Go to">
      {/* Search and Ask share a row: where to look something up, and where to ask (#37). */}
      <li
        className={onOpenAsk === undefined ? 'sidebar__item' : 'sidebar__item sidebar__item--pair'}
      >
        <button type="button" className="sidebar__row" onClick={onSearch} title="Search (⌘K)">
          <Icon name="search" className="sidebar__icon" />
          <span className="sidebar__name">Search</span>
          <kbd className="sidebar__key" aria-hidden="true">
            ⌘K
          </kbd>
        </button>
        {onOpenAsk !== undefined && <AskQuickButton on={askOn} onOpen={onOpenAsk} />}
      </li>
      {onOpenToday !== undefined && (
        <li className={todayOn ? 'sidebar__item sidebar__item--on' : 'sidebar__item'}>
          <button
            type="button"
            className="sidebar__row"
            aria-current={todayOn ? 'page' : undefined}
            onClick={onOpenToday}
          >
            <Icon name="sun" className="sidebar__icon" />
            <span className="sidebar__name">Today</span>
          </button>
        </li>
      )}
      {views.map(({ id, entry, count }) => {
        const on = open.has(entry.path);
        return (
          <li key={id} className={on ? 'sidebar__item sidebar__item--on' : 'sidebar__item'}>
            <button
              type="button"
              className="sidebar__row"
              aria-current={on ? 'page' : undefined}
              onClick={(event) => onOpen(entry.path, openHowFrom(event))}
            >
              <Icon name={QUICK_GLYPHS[id]} className="sidebar__icon" />
              <span className="sidebar__name">{entry.title}</span>
              {count !== null && count > 0 && <span className="sidebar__badge">{count}</span>}
            </button>
          </li>
        );
      })}
      {inbox !== undefined && <InboxQuickRow {...inbox} on={inboxOn} />}
      {onOpenReview !== undefined && (
        <li className={reviewOn ? 'sidebar__item sidebar__item--on' : 'sidebar__item'}>
          <button
            type="button"
            className="sidebar__row"
            aria-current={reviewOn ? 'page' : undefined}
            onClick={onOpenReview}
          >
            <Icon name="calendar" className="sidebar__icon" />
            <span className="sidebar__name">Weekly review</span>
          </button>
        </li>
      )}
      {onOpenGraph !== undefined && (
        <li className={graphOn ? 'sidebar__item sidebar__item--on' : 'sidebar__item'}>
          <button
            type="button"
            className="sidebar__row"
            aria-current={graphOn ? 'page' : undefined}
            onClick={onOpenGraph}
          >
            <Icon name="graph" className="sidebar__icon" />
            <span className="sidebar__name">Graph</span>
          </button>
        </li>
      )}
      {onOpenTags !== undefined && (
        <li className={tagsOn ? 'sidebar__item sidebar__item--on' : 'sidebar__item'}>
          <button
            type="button"
            className="sidebar__row"
            aria-current={tagsOn ? 'page' : undefined}
            onClick={onOpenTags}
          >
            <Icon name="tag" className="sidebar__icon" />
            <span className="sidebar__name">Tags</span>
          </button>
        </li>
      )}
      {onOpenLibrary !== undefined && (
        <li className={libraryOn ? 'sidebar__item sidebar__item--on' : 'sidebar__item'}>
          <button
            type="button"
            className="sidebar__row"
            aria-current={libraryOn ? 'page' : undefined}
            onClick={onOpenLibrary}
          >
            <Icon name="book" className="sidebar__icon" />
            <span className="sidebar__name">Library</span>
          </button>
        </li>
      )}
      {onOpenHighlights !== undefined && (
        <li className={highlightsOn ? 'sidebar__item sidebar__item--on' : 'sidebar__item'}>
          <button
            type="button"
            className="sidebar__row"
            aria-current={highlightsOn ? 'page' : undefined}
            onClick={onOpenHighlights}
          >
            <Icon name="quote" className="sidebar__icon" />
            <span className="sidebar__name">All highlights</span>
          </button>
        </li>
      )}
      {onOpenAutomations !== undefined && (
        <li className={automationsOn ? 'sidebar__item sidebar__item--on' : 'sidebar__item'}>
          <button
            type="button"
            className="sidebar__row"
            aria-current={automationsOn ? 'page' : undefined}
            onClick={onOpenAutomations}
          >
            <Icon name="bolt" className="sidebar__icon" />
            <span className="sidebar__name">Automations</span>
          </button>
        </li>
      )}
      {activity !== undefined && <ActivityQuickRow {...activity} on={activityOn} />}
      {onOpenTemplates !== undefined && (
        <li className={templatesOn ? 'sidebar__item sidebar__item--on' : 'sidebar__item'}>
          <button
            type="button"
            className="sidebar__row"
            aria-current={templatesOn ? 'page' : undefined}
            onClick={onOpenTemplates}
          >
            <Icon name="template" className="sidebar__icon" />
            <span className="sidebar__name">Templates</span>
          </button>
        </li>
      )}
      {onOpenSkills !== undefined && (
        <li className={skillsOn ? 'sidebar__item sidebar__item--on' : 'sidebar__item'}>
          <button
            type="button"
            className="sidebar__row"
            aria-current={skillsOn ? 'page' : undefined}
            onClick={onOpenSkills}
          >
            <Icon name="skill" className="sidebar__icon" />
            <span className="sidebar__name">Skills</span>
          </button>
        </li>
      )}
      {onOpenTerms !== undefined && (
        <li className={termsOn ? 'sidebar__item sidebar__item--on' : 'sidebar__item'}>
          <button
            type="button"
            className="sidebar__row"
            aria-current={termsOn ? 'page' : undefined}
            onClick={onOpenTerms}
          >
            <Icon name="term" className="sidebar__icon" />
            <span className="sidebar__name">Terms</span>
          </button>
        </li>
      )}
    </ul>
  );
}

/** The Activity row's link: how to open the page, and the errors since it was last open. */
export interface ActivityRowLink {
  readonly onOpen: () => void;
  readonly unseenErrors: number;
}

/**
 * The Activity page's row. A badge counts the errors that arrived since the
 * page was last open, and the row's name says so too, for a screen reader.
 */
function InboxQuickRow({ onOpen, count, on }: InboxRowLink & { on: boolean }) {
  return (
    <li className={on ? 'sidebar__item sidebar__item--on' : 'sidebar__item'}>
      <button
        type="button"
        className="sidebar__row"
        aria-current={on ? 'page' : undefined}
        onClick={onOpen}
      >
        <Icon name="inbox" className="sidebar__icon" />
        <span className="sidebar__name">Inbox</span>
        {count !== null && count > 0 && <span className="sidebar__badge">{count}</span>}
      </button>
    </li>
  );
}

function ActivityQuickRow({ onOpen, unseenErrors, on }: ActivityRowLink & { on: boolean }) {
  const errors = `${unseenErrors} new ${unseenErrors === 1 ? 'error' : 'errors'}`;
  return (
    <li className={on ? 'sidebar__item sidebar__item--on' : 'sidebar__item'}>
      <button
        type="button"
        className="sidebar__row"
        aria-current={on ? 'page' : undefined}
        aria-label={unseenErrors > 0 ? `Activity, ${errors}` : 'Activity'}
        onClick={onOpen}
      >
        <Icon name="pulse" className="sidebar__icon" />
        <span className="sidebar__name">Activity</span>
        {unseenErrors > 0 && (
          <span className="sidebar__badge sidebar__badge--alert" title={errors}>
            {unseenErrors}
          </span>
        )}
      </button>
    </li>
  );
}

/**
 * The same set from one render to the next while it holds the same paths, so
 * a list drawn with `memo` is not drawn again for a set made anew.
 */
function useSameSet(paths: readonly string[]): ReadonlySet<string> {
  const spelled = JSON.stringify(paths);
  return useMemo(() => new Set<string>(JSON.parse(spelled) as string[]), [spelled]);
}

/** Drawn again only for a change of its own: its types, the one open, or its handlers' presence. */
/**
 * Ask, beside Search on its row (#37): no row of its own, so the sidebar's
 * sections keep their height. Its own memo: the sidebar is drawn again with
 * the window, and a button handed a steady `onOpen` need not be drawn with it.
 */
const AskQuickButton = memo(function AskQuickButton({
  on,
  onOpen,
}: {
  on: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className={on ? 'sidebar__row sidebar__row--on' : 'sidebar__row'}
      aria-current={on ? 'page' : undefined}
      onClick={onOpen}
      title="Ask (⌘J)"
    >
      <Icon name="spark" className="sidebar__icon" />
      <span className="sidebar__name">Ask</span>
      <kbd className="sidebar__key" aria-hidden="true">
        ⌘J
      </kbd>
    </button>
  );
});

/**
 * One type's row. A click or a tap opens the type; its menu comes by
 * right-click, Shift+F10 — or a finger held on the row (#659), since a touch
 * screen has no right button and the row has no "…" of its own.
 */
function TypeRow({
  type,
  on,
  onOpen,
  onKeyDown,
  onMenu,
}: {
  type: SidebarType;
  on: boolean;
  onOpen: (name: string) => void;
  onKeyDown: (type: SidebarType, event: KeyboardEvent<HTMLButtonElement>) => void;
  /** Null where the sidebar has no menu to offer: then a hold is only a slow tap, and a right-click is the browser's. */
  onMenu: ((type: SidebarType, anchor: TypeMenuAnchor) => void) | null;
}) {
  const hold = useLongPress((at) => onMenu?.(type, at));
  return (
    <li className={on ? 'sidebar__item sidebar__item--on' : 'sidebar__item'}>
      <button
        type="button"
        className="sidebar__row"
        aria-label={`${type.label}, ${type.count === 1 ? '1 note' : `${type.count} notes`}`}
        title={type.label}
        aria-current={on ? 'page' : undefined}
        {...(onMenu === null ? {} : hold)}
        onClick={() => onOpen(type.name)}
        onKeyDown={(event) => onKeyDown(type, event)}
        onContextMenu={
          onMenu === null
            ? undefined
            : (event) => {
                event.preventDefault();
                onMenu(type, { x: event.clientX, y: event.clientY });
              }
        }
      >
        <Icon name={sidebarGlyph(type.icon)} className="sidebar__icon" />
        <span className="sidebar__name">{type.label}</span>
        {/* A nought says nothing the row's name does not: the row stays, the count goes. */}
        {type.count > 0 && (
          <span className="sidebar__count" aria-hidden="true">
            {type.count}
          </span>
        )}
      </button>
    </li>
  );
}

const TypeList = memo(function TypeList({
  types,
  anyBroken,
  openTypeName,
  onOpenType,
  onEditType,
  onEditTemplate,
}: {
  types: readonly SidebarType[];
  /** Whether a type file is listed as broken below, so the types are not "none yet". */
  anyBroken: boolean;
  openTypeName: string | null;
  onOpenType: (name: string) => void;
  onEditType?: (name: string) => void;
  onEditTemplate?: (name: string) => void;
}) {
  const [menu, setMenu] = useState<{ type: SidebarType; anchor: TypeMenuAnchor } | null>(null);
  // A type file that cannot be read is listed below, so none are "defined yet" only without one.
  if (types.length === 0) {
    return anyBroken ? null : <p className="sidebar__empty">No types defined yet.</p>;
  }

  const openMenu = (type: SidebarType, anchor: TypeMenuAnchor) => {
    if (onEditType !== undefined) setMenu({ type, anchor });
  };
  const onKeyDown = (type: SidebarType, event: KeyboardEvent<HTMLButtonElement>) => {
    // Shift+F10 or the menu key: the row's menu, from the keyboard.
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
    if (onEditType === undefined) return;
    event.preventDefault();
    openMenu(type, event.currentTarget);
  };

  return (
    <>
      <ul className="sidebar__list">
        {types.map((type) => (
          <TypeRow
            key={type.name}
            type={type}
            on={type.name === openTypeName}
            onOpen={onOpenType}
            onKeyDown={onKeyDown}
            onMenu={onEditType === undefined ? null : openMenu}
          />
        ))}
      </ul>
      {onEditType !== undefined && (
        <TypeRowMenu
          label={menu?.type.label ?? ''}
          anchor={menu?.anchor ?? null}
          onClose={() => setMenu(null)}
          items={
            menu === null
              ? []
              : [
                  { label: 'Open', onSelect: () => onOpenType(menu.type.name), movesFocus: true },
                  {
                    label: 'Edit type',
                    onSelect: () => onEditType(menu.type.name),
                    movesFocus: true,
                  },
                  ...(onEditTemplate === undefined
                    ? []
                    : [
                        {
                          label: 'Edit template',
                          onSelect: () => onEditTemplate(menu.type.name),
                          movesFocus: true,
                        },
                      ]),
                ]
          }
        />
      )}
    </>
  );
});

/**
 * The type files that do not read whole, below the types: each opens its file
 * to be mended, and says why under its name. Nothing is drawn when all read.
 */
const BrokenTypeList = memo(function BrokenTypeList({
  broken,
  onOpen,
}: {
  broken: readonly SidebarBrokenType[];
  onOpen: (path: VaultPath, how: OpenHow) => void;
}) {
  if (broken.length === 0) return null;
  return (
    <ul className="sidebar__list">
      {broken.map((type) => (
        <li key={type.path} className="sidebar__item sidebar__item--problem">
          <button
            type="button"
            className="sidebar__row"
            aria-label={`${type.name} has a problem: ${type.path}`}
            title={type.path}
            onClick={(event) => onOpen(type.path, openHowFrom(event))}
          >
            <Icon name="doc" className="sidebar__icon" />
            <span className="sidebar__name">{type.name}</span>
          </button>
          <p className="sidebar__empty sidebar__problem">{type.problem}</p>
        </li>
      ))}
    </ul>
  );
});

/** What a section holds, apart from its heading. */
interface SectionBody {
  /** A button at the end of the heading — Types' New type, Pages' "+". */
  readonly action?: ReactNode;
  readonly children: ReactNode;
}

/** A section: a heading that opens and shuts, a grip to move it by, and what it holds. */
function Section({
  id,
  sections,
  onToggle,
  handle,
  action,
  children,
}: SectionBody & {
  id: SidebarSectionId;
  sections: ReturnType<typeof useSidebarSections>;
  onToggle: (id: SidebarSectionId) => void;
  /** The grip it is dragged by; null when sections cannot be moved. */
  handle: ReactNode;
}) {
  const expanded = sections.isExpanded(id);
  const bodyId = `sidebar-${id}`;
  const headingId = `sidebar-${id}-heading`;

  return (
    // Named by its own heading, which is what makes it a landmark a screen
    // reader can jump between rather than an anonymous <section>.
    <section className="sidebar__section" aria-labelledby={headingId} data-reorder-id={id}>
      {/* The heading, its grip and its "+" stick to the top of the scroller
          while the section's rows pass under them. */}
      <div className="sidebar__head">
        <h2 className="sidebar__heading" id={headingId}>
          <button
            type="button"
            className="sidebar__disclosure"
            aria-expanded={expanded}
            aria-controls={bodyId}
            onClick={() => onToggle(id)}
          >
            {SIDEBAR_SECTION_LABELS[id]}
            <Icon name="chevron" size={12} className="sidebar__chevron" />
          </button>
        </h2>
        {/* Beside the heading, not in it, so the section is still named by it. */}
        {handle}
        {action}
      </div>
      <div className="sidebar__body" id={bodyId}>
        {expanded && children}
      </div>
    </section>
  );
}

/** Drawn again only for a change of its own: its entries, or which of them is open or starred. */
const EntryList = memo(function EntryList({
  entries,
  empty,
  open,
  starred,
  onOpen,
  onToggleFavorite,
}: {
  entries: readonly SidebarEntry[];
  empty: string;
  /** The page you are on, when it is a note: the row shown as open. */
  open: ReadonlySet<string>;
  starred: ReadonlySet<string>;
  onOpen: (path: VaultPath, how: OpenHow) => void;
  onToggleFavorite: (path: VaultPath) => void;
}) {
  if (entries.length === 0) return <p className="sidebar__empty">{empty}</p>;

  return (
    <ul className="sidebar__list">
      {entries.map((entry) => (
        <li
          key={entry.path}
          className={open.has(entry.path) ? 'sidebar__item sidebar__item--on' : 'sidebar__item'}
        >
          <button
            type="button"
            className="sidebar__row"
            title={entry.title}
            aria-current={open.has(entry.path) ? 'page' : undefined}
            onClick={(event) => onOpen(entry.path, openHowFrom(event))}
          >
            <Icon name={sidebarGlyph(entry.icon)} className="sidebar__icon" />
            <span className="sidebar__name">{entry.title}</span>
          </button>
          <FavoriteStar
            name={entry.title}
            favorite={starred.has(entry.path)}
            onToggle={() => onToggleFavorite(entry.path)}
          />
        </li>
      ))}
    </ul>
  );
});

/** A section's "+": a small button at the heading's end, opening what can be made there. */
function SectionMenu({ menu }: { menu: HeaderMenu }) {
  const chosen = useRef<MenuCommand | null>(null);
  return (
    <Menu.Root open={menu.open} onOpenChange={(next) => menu.onOpenChange(next)}>
      <Menu.Trigger
        className="icon-button sidebar__heading-action"
        aria-label={menu.label}
        title={menu.label}
      >
        <Icon name="plus" size={14} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="menu-positioner" side="bottom" align="end" sideOffset={4}>
          <Menu.Popup
            className="menu"
            aria-label={menu.label}
            render={<ul />}
            finalFocus={() => {
              const returnFocus = chosen.current?.movesFocus !== true;
              chosen.current = null;
              return returnFocus;
            }}
          >
            <MenuItems items={menu.items} chosen={chosen} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
