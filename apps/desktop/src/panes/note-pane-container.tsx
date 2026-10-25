import {
  memo,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type ReactNode,
} from 'react';
import { useStore } from 'zustand';
import {
  ARTIFACT_KEYS,
  createVaultPath,
  isBlockType,
  isFavorite,
  deleteRefusal,
  isMovable,
  isPersonType,
  isTemplateNote,
  messageWithoutPaths,
  PROJECT_STATUS_KEY,
  templateNameOf,
  templateUses,
  noteLinks,
  noteTitle,
  NO_LINKS,
  placeOfFile,
  readerDocumentOf,
  readLiteratureNote,
  writeFailedReport,
  type NoteSuggestion,
  type TagSuggestion,
  type QueryViewSummary,
  type SavedViewSummary,
  isWorkspaceSplit,
  tabPlace,
  type NavigationPlace,
  type NoteNames,
  type SidebarEntry,
  type Tab,
  type TabId,
  type VaultGraph,
  type VaultPath,
} from '@dfai/domain';
import type {
  ActivityLog,
  DefinedType,
  NoteChanges,
  ExternalLinkPort,
  IndexPort,
  LinkedRangeStore,
  OpenNotes,
  SourceRefresher,
  ThumbnailQueue,
  VaultFsPort,
} from '@dfai/application';
import { notePaneScope, readerHighlightLinks } from '@dfai/application';
import {
  ThumbnailValue,
  ChatToggleProvider,
  CustomizeToggle,
  NoteNamesProvider,
  LinkedSections,
  NotePane,
  PageAction,
  SourcePanel,
  TaskScheduleSummary,
  useCalendarNav,
  type CalendarNavigation,
  type ChatToggle,
  type CreateRelated,
  type GroupFolds,
  type GroupFoldStore,
  type NotePeople,
  type NoteReveal,
  type NotePaneState,
  type OpenHow,
  type PaneArrangement,
  type PeekRequest,
  type Planner,
  type TemplateNotice,
  type ViewTabEditing,
  useSteadyCallback,
} from '@dfai/ui';
import { useNote, type NotePorts } from '../notes/use-note.ts';
import type { IndexStatusStore } from '../index/index-status-store.ts';
import type { ReadTypesAgain } from '../types/use-types.ts';
import { useScopedIndexKey } from '../reads/use-scoped-index-key.ts';
import { hideOverlay, openPeek, showOverlay } from '../overlay-store.ts';
import {
  pageMenuOverlay,
  panePopupOverlay,
  paneOverlayOf,
  rowPeek,
  type Peek,
} from '../overlay.ts';
import { clickLink, type LinkPlaces } from '../workspace/open-place.ts';
import { useTabPageHistory } from '../workspace/tab-history.ts';
import {
  closePane,
  focusPane,
  openInPane,
  openPlace,
  splitPane,
  type WorkspaceStore,
} from '../workspace/workspace-store.ts';
import { sameWiringParts, type WorkspaceWiring } from '../workspace/workspace-wiring.tsx';
import { useTabReveal } from './reveals.ts';
import { useOutsideChangeReload } from './use-outside-change-reload.ts';
import { artifactViewer, dashboardView, widgetEditor } from '../pages-on-first-use.ts';
import { useUnlinkedMentions } from '../graph/use-unlinked-mentions.ts';
import { useImages } from '../notes/use-images.ts';
import { useBookmarks } from '../notes/use-bookmarks.ts';
import { useEmbedImage } from '../notes/use-embed-image.ts';
import { useBlockPicking, useTransclusions } from '../notes/use-block-links.ts';
import { useLinePromotion } from '../notes/use-line-promotion.ts';
import { useNoteHighlights, type KeptCommentsOfVault } from '../notes/use-note-highlights.ts';
import { useMeetingCorrections } from '../notes/use-meeting-corrections.ts';
import { cryptoRng } from '../random.ts';
import { usePlanner } from '../timeblocks/use-planner.ts';
import { useTaskSchedule } from '../timeblocks/use-task-schedule.ts';
import { webviewImageProbe } from '../notes/webview-image-probe.ts';
import { browserImagePlacementStore } from '../notes/browser-image-placement-store.ts';
import { useNoteProperties } from '../types/use-note-properties.ts';
import { clearRow, focusRow, type AsideStore } from '../aside/aside-store.ts';
import { usePublishShownNote, type ShownNote, type ShownNotes } from '../aside/shown-notes.ts';
import { usePropertiesInAside } from '../aside/use-properties-in-aside.ts';
import { useAddProperty } from '../types/use-add-property.ts';
import type { NotesBeingMade } from '../notes/notes-being-made.ts';
import { useCreateLinkedNote } from '../notes/use-create-linked-note.ts';
import { useCreateRelated } from '../types/use-create-related.ts';
import type { TabLanding } from '../types/use-type-views.ts';
import { useDashboard } from '../dashboard/use-dashboard.ts';
import { useDashboardEditing } from '../dashboard/use-dashboard-editing.ts';
import { useSavedView } from '../query/use-saved-view.ts';
import type { ViewDrafts } from '../query/use-view-drafts.ts';
import { useSource } from '../sources/use-source.ts';
import type { SourcePorts } from '../sources/source-ports.ts';
import { useArtifactCopy, type ArtifactCopyView } from '../artifacts/use-artifact-copy.ts';
import { useThumbnailBackfill } from '../artifacts/use-thumbnail-backfill.ts';
import { usePageThumbnail, type PageThumbnailView } from '../thumbnails/use-page-thumbnail.ts';
import { SqlViewBody, ViewBody, ViewHeadToolbar } from './view-body.tsx';
import { useSqlView } from '../query/use-sql-view.ts';
import { useQueryView, type QueryViewState } from '../query/use-query-view.ts';
import { QueryViewBody } from './query-view-body.tsx';
import { useQueryBlocks } from '../query/use-query-blocks.ts';
import { useLinkedPage } from '../linked-pages/use-linked-page.ts';
import { pageHeading } from './page-heading.ts';
import { localClock, localNow, localToday } from '../today.ts';
import type { OpenEditors, PaneEditors } from './open-editors.ts';
import type { StrandedEdits } from '../notes/stranded-edits.ts';
import type { KeptComments } from '../notes/stranded-comments.ts';
import { pageArchiveItems } from '../archive/archive-menu.ts';
import type { ExportCommands } from '../export/export-flow.ts';
import type { ArchiveCommands } from '../archive/use-archive.ts';
import { useViewChoosing, type ViewChoosing } from '../archive/use-view-choosing.ts';
import { rowPaths, type ChosenPeopleMerge } from '../people/use-chosen-people.ts';
import type { TickMemory } from '../query/tick-memory.ts';
import type { Toasts } from '../toasts/toasts.ts';
import { createBrowserQueryFoldStore } from '../query/browser-query-fold-store.ts';
import { useGroupFolds } from '../query/use-group-folds.ts';

// Loaded on first use: most notes are neither a dashboard nor an artifact.
const ArtifactViewer = artifactViewer.Component;
const DashboardView = dashboardView.Component;
const WidgetEditor = widgetEditor.Component;

/**
 * Everything a pane needs that is the same in every pane.
 *
 * The ports and the vault-wide facts are shared; what makes one pane different
 * from another is only the note it holds.
 */
export interface PaneContext {
  /** The vault the panes' notes are in, which their unsaved work belongs to. */
  readonly vault: string | null;
  readonly notes: NotePorts;
  readonly index: IndexPort;
  readonly sources: SourcePorts;
  /** The window's one source refresher, which the local API shares. */
  readonly sourceRefresher: SourceRefresher;
  /** Opens an artifact's link in the browser. */
  readonly links: ExternalLinkPort;
  /** Opens New artifact, where a view of artifacts would make a blank note. */
  readonly newArtifact: () => void;
  /** Artifact thumbnails being made, which the gallery and the note both show. */
  readonly thumbnails: ThumbnailQueue;
  readonly types: readonly DefinedType[];
  readonly notePaths: readonly VaultPath[];
  /**
   * Where the index says it has news. Each reader keys itself on the part of
   * it its own data is made from (`useScopedIndexKey`, #325), so the context
   * does not change, and draw every pane, when the index does.
   */
  readonly indexStatus: IndexStatusStore;
  /** Re-reads the tree and the index, after this pane wrote something. */
  readonly onChanged: () => void;
  /** Every sync of the index's news: a hidden tab hears here that its note changed outside. */
  readonly changes: NoteChanges;
  /** Re-reads the types as well, after this pane wrote a type file; settles once they are read. */
  readonly onTypeSaved: ReadTypesAgain;
  readonly suggestNotes: (query: string) => NoteSuggestion[];
  /** Tags offered after `#`. */
  readonly suggestTags: (query: string) => readonly TagSuggestion[];
  /** Who `@` offers, and which links draw as a person's chip. */
  readonly people: NotePeople;
  /** Opens the tags page on a tag, by its name as written. */
  readonly openTag: (name: string) => void;
  /** The panes' editors, and whether one holds typing in a note not yet saved. */
  readonly editors: OpenEditors & Pick<PaneEditors, 'stateOf' | 'flushHolding'>;
  /** Work a closed pane could not write, kept until its note is opened again. */
  readonly stranded: StrandedEdits;
  /** Comments a closed literature note could not write (#534), kept until it is opened again. */
  readonly strandedComments: KeptComments;
  /** Where a save the pane gave up on is said (U-28). */
  readonly activity: ActivityLog;
  /** The window's toasts, where a change made from a view is said with its Undo (#320). */
  readonly toasts: Toasts;
  /** Every saved view and the type it lists, for a view's tabs. */
  readonly savedViews: readonly SavedViewSummary[];
  /** What a type's tabs can do, opening what they make where they are (ADR-0023). */
  readonly typeTabs: (landing: TabLanding) => ViewTabEditing | undefined;
  /** Every saved DFAI query, for a query view's tabs (ADR-0019). */
  readonly queryViews: readonly QueryViewSummary[];
  /** Every dashboard, which a query view can be added to. */
  readonly dashboards: readonly SidebarEntry[];
  /** What ticked notes' statuses were, shared by every pane for the session. */
  readonly tickMemory: TickMemory;
  /** Which groups of each view are folded shut, remembered on this Mac. */
  readonly groupFolds: GroupFoldStore;
  /** Which of recent and all a linked page's sections were left on, on this Mac (P30-06). */
  readonly linkedRanges: LinkedRangeStore;
  /** Every note and connection, which each note's links are read from; null until read. */
  readonly graph: VaultGraph | null;
  /** The panes as a write from outside them reaches them — linking a mention. */
  readonly openNotes: OpenNotes;
  /** Every view note's path, SQL views included, so a new view's name is checked against them. */
  readonly viewPaths: readonly string[];
  /** Every view's unsaved toolbar changes, kept while the app is open. */
  readonly viewDrafts: ViewDrafts;
  /** Puts notes in the Archive and takes them out: a page's menu, a view's chosen rows. */
  readonly archive: ArchiveCommands;
  /** Merging the people a People view's rows chose (#464). */
  readonly peopleMerge: ChosenPeopleMerge;
  /** Exporting notes (#501): a page's menu, the peek's, a view's chosen rows. Null where none can be made. */
  readonly exporting: ExportCommands | null;
  /** Told the problem with a link — one that could not be made or followed — or null once one leads somewhere. */
  readonly onLinkProblem: (message: string | null) => void;
  /** Where a link to a highlight or a PDF leads (#506), read from the vault. */
  readonly linkPlaces: LinkPlaces;
  /** What `[[` is making, the window over, so no two panes make one name twice. */
  readonly notesBeingMade: NotesBeingMade;
  /** A template's own ways to be renamed, deleted and made a note, and the page listing them all (ADR-0026). */
  readonly templateCommands: TemplateCommands;
}

/** What a pane showing a template does instead of what it does to a note. */
export interface TemplateCommands {
  readonly onOpenTemplates: () => void;
  readonly rename: (args: { path: VaultPath; name: string }) => void;
  readonly askDelete: (path: VaultPath) => void;
  readonly askMoveToNotes: (path: VaultPath) => void;
}

/**
 * A tab on a note, or an empty one: the note pane with everything it needs
 * drawn from the wiring and the stores. What it subscribes to is its own —
 * its history, its reveal, its pane's popups, whether the window is split —
 * so the other pane's tabs cost it no draw.
 *
 * While hidden it is not drawn again at all — the editor waits as it was,
 * its autosave stood down — so the window's other work does not cost a draw
 * per hidden tab; it is drawn afresh as it shows. The wiring comes as a prop
 * rather than from its context for exactly that reason: a context change
 * would draw its readers under a memo, a prop does not. The contexts the
 * page reads — the note names, the chat's switch — come the same way and are
 * provided again here: a change above stops at a provider of the same
 * context, so a hidden tab's page is not drawn for it either.
 */
export const NotePaneContainer = memo(
  // Named as the export: what the render counts know the tab by.
  function NotePaneContainer(props: NoteTabProps) {
    return useNoteTab(props);
  },
  (before, after) => (before.hidden && after.hidden) || sameNoteTab(before, after),
);

/**
 * The parts of the wiring a note's tab reads. Any new part a note tab reads
 * must be added here: a part left out is compared by nobody, and the tab keeps
 * drawing what it was handed before (#325).
 */
const NOTE_TAB_WIRING = [
  'pane',
  'note',
  'store',
  'reveals',
  'overlays',
  'nameOf',
  'onShowSidebar',
  'aside',
  'shown',
] as const;

/**
 * Whether a shown note's tab would draw the same: its own props, and what it
 * reads of the wiring. The window draws for the index's news; a tab whose
 * note and readers moved for none of it draws nothing (#325).
 */
function sameNoteTab(before: NoteTabProps, after: NoteTabProps): boolean {
  return (
    before.hidden === after.hidden &&
    before.names === after.names &&
    before.chat === after.chat &&
    before.pane === after.pane &&
    before.tab === after.tab &&
    sameWiringParts(NOTE_TAB_WIRING, before.wiring, after.wiring)
  );
}

export interface NoteTabProps {
  wiring: WorkspaceWiring;
  names: NoteNames;
  chat: ChatToggle | null;
  pane: number;
  tab: Tab;
  /**
   * Whether the tab is behind another one. The editor stays mounted, so its
   * undo keeps; it flushes as it hides, and its autosave stands down until shown.
   */
  hidden: boolean;
}

/** The tab drawn: a hook, since its hooks are the tab component's own. */
function useNoteTab({ wiring, names, chat, pane, tab, hidden }: NoteTabProps) {
  const { store, reveals, overlays, nameOf, note, onShowSidebar } = wiring;
  const place = tabPlace(tab);
  const path = place?.kind === 'note' ? place.path : null;
  const history = useTabPageHistory({ store, pane, id: tab.id, nameOf });
  const reveal = useTabReveal(reveals, { tab: tab.id, path });
  // A hidden tab draws none of its pane's popups: the shown tab draws them,
  // and two menus up at once would fight over the focus.
  const overlay = useStore(overlays, (state) =>
    hidden ? null : paneOverlayOf(state.overlay, pane),
  );
  const split = useStore(store, (state) => isWorkspaceSplit(state.workspace));
  const menu = pageMenuOverlay(pane);
  const drawn = useNotePane({
    tabId: tab.id,
    path,
    context: wiring.pane,
    hidden,
    onPeek: (peek) => openPeek(overlays, peek),
    aside: { store: wiring.aside, shown: wiring.shown, workspace: store },
    onOpenNote: (target, how = 'here') => {
      // A PDF — a literature note's file — opens in the reader (#504).
      const place: NavigationPlace = placeOfFile(target);
      if (how === 'here') openInPane(store, { pane, place });
      else {
        focusPane(store, pane);
        openPlace(store, place, how);
      }
    },
    onFollowLink: (target, heading, how) =>
      clickLink(
        {
          store,
          reveals,
          overlays,
          notePaths: wiring.pane.notePaths,
          onProblem: wiring.pane.onLinkProblem,
          places: wiring.pane.linkPlaces,
        },
        {
          pane,
          target,
          heading: heading ?? null,
          ...(how !== undefined && { how }),
          inPeek: false,
        },
      ),
    reveal,
    onRename: note.onRename,
    onToggleFavorite: note.onToggleFavorite,
    onMoveTo: note.onMoveTo,
    onDelete: note.onDelete,
    onMergeInto: note.onMergeInto,
    onShowInGraph: note.onShowInGraph,
    arrangement: {
      // Which of these a pane offers is the domain's rule; the bar draws a
      // button and a menu item for each it is given.
      ...(!split && { onSplit: () => splitPane(store, pane) }),
      ...(split && { onClose: () => closePane(store, pane) }),
      // The way back to a hidden sidebar sits where it went: the first
      // pane's top-left corner.
      ...(pane === 0 && onShowSidebar !== null && { onShowSidebar }),
      history,
      menuOpen: overlay === menu,
      onMenuOpenChange: (open) =>
        open ? showOverlay(overlays, menu) : hideOverlay(overlays, menu),
      popups: (name) => ({
        open: overlay === panePopupOverlay(pane, name),
        onOpenChange: (open) =>
          open
            ? showOverlay(overlays, panePopupOverlay(pane, name))
            : hideOverlay(overlays, panePopupOverlay(pane, name)),
      }),
    },
  });
  // The focus landing on the page around a table — the editor, the bar — lets
  // the row the table held go, so the aside follows the note again. A cell's
  // editor and its picker render inside `.table`, so they are not landings.
  const onFocusCapture = (event: FocusEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest('.table') === null) clearRow(wiring.aside, tab.id);
  };
  return (
    <div className="pane__tab" hidden={hidden} onFocusCapture={onFocusCapture}>
      <NoteNamesProvider value={names}>
        <ChatToggleProvider value={chat}>{drawn.page}</ChatToggleProvider>
      </NoteNamesProvider>
    </div>
  );
}

/** A note pane as drawn, and what the peek's own header shows of it. */
export interface DrawnNotePane {
  readonly page: ReactNode;
  readonly state: NotePaneState;
  /** The page's title as it heads it; null until the note is read. */
  readonly title: string | null;
  /** Writes the unsaved edits, settling once the write has landed or been refused. */
  readonly flush: () => Promise<void>;
}

/**
 * The note pane of a tab, or of the peek, drawn: its hooks are the tab's,
 * which is why this is a hook.
 */
export function useNotePane({
  tabId,
  path,
  context,
  chrome = 'page',
  hidden = false,
  onPeek,
  onOpenNote,
  onFollowLink,
  reveal = null,
  onRename,
  onToggleFavorite,
  onMoveTo,
  onDelete,
  onMergeInto,
  onShowInGraph,
  arrangement,
  aside,
}: {
  /** The tab this is the content of; the editor is registered under it — the peek's under its own id. */
  tabId: TabId;
  path: VaultPath | null;
  context: PaneContext;
  /** `peek` draws the page inside the center peek: no bar, its properties in one strip. */
  chrome?: 'page' | 'peek';
  /** Given, a row or card of a view in the page clicked plainly peeks its note (slice 6b). */
  onPeek?: (peek: Peek) => void;
  /** The right sidebar (#306): where this tab says what it shows, and the workspace it follows. */
  aside: { store: AsideStore; shown: ShownNotes; workspace: WorkspaceStore };
  /**
   * Whether the tab is behind another one. The editor stays mounted, so its
   * undo keeps; it flushes as it hides, and its autosave stands down until shown.
   */
  hidden?: boolean;
  /** Opens a note in this pane — a backlink, a table row, a board card — or where the click asked. */
  onOpenNote: (path: VaultPath, how?: OpenHow) => void;
  /** Opens the note a link names, at the heading or block it names when it does. */
  onFollowLink: (target: string, heading?: string | null, how?: OpenHow) => void;
  /** A block or heading of this pane's note to bring into view: where a followed link pointed. */
  reveal?: NoteReveal | null;
  onRename: (args: { path: VaultPath; name: string }) => void;
  onToggleFavorite: (path: VaultPath) => void;
  /** Offered in the page's menu when the page can be moved. */
  onMoveTo?: (path: VaultPath) => void;
  /** Offered in the page's menu when the page can be deleted. */
  onDelete?: (path: VaultPath) => void;
  /** Offered in a person's page menu and right sidebar: merge them into another person (#464). */
  onMergeInto?: (path: VaultPath) => void;
  /** Opens the graph around a note, from its page's menu. */
  onShowInGraph?: (path: VaultPath) => void;
  /** Splitting, closing and the page menu's open state, which the app owns. */
  arrangement: PaneArrangement;
}): DrawnNotePane {
  const { notes, index, sources, types, notePaths, onChanged, editors, savedViews } = context;

  // The editor's comments typed in highlights and not yet written (#534): part of this pane's work.
  const pendingComments = useRef<(() => Promise<void>) | null>(null);
  const holdPendingComments = useCallback((writePending: (() => Promise<void>) | null) => {
    pendingComments.current = writePending;
  }, []);
  const note = usePaneNote({ tabId, path, context, hidden, pendingComments });
  const keptComments = useKeptCommentsOf(context);
  // What the pane's readers re-read on: the index's news of what this note
  // shows, not of a note saved anywhere (#325). A hidden tab reads nothing,
  // and once shown again reads what moved while it was hidden. An empty tab's
  // key is held too: one switched on as its first note opens draws it twice.
  const scope = useMemo(() => notePaneScope(note.open, path ?? ''), [note.open, path]);
  const indexKey = useScopedIndexKey({
    status: context.indexStatus,
    vault: context.vault,
    reader: ['note', path],
    scope,
    enabled: !hidden,
  });

  const links = useNoteLinks({ context, path });
  const linkCheck = useMemo(
    () => ({ fs: notes.fs, markdown: notes.markdown, notePaths }),
    [notes.fs, notes.markdown, notePaths],
  );
  const noteProperties = useNoteProperties({ note: note.open, types, index, links: linkCheck });
  const taskSchedule = useTaskSchedule({
    index,
    types,
    path,
    typeName: noteProperties.typeName,
    indexKey,
  });
  const addProperty = useAddProperty({
    fs: notes.fs,
    markdown: notes.markdown,
    typeName: noteProperties.typeName,
    types,
    setProperty: note.setProperty,
    rememberKind: noteProperties.rememberKind,
    onTypeSaved: context.onTypeSaved,
  });
  const createRelated = useCreateRelated({
    fs: notes.fs,
    markdown: notes.markdown,
    types,
    notePaths,
    beside: path,
    onChanged,
  });
  // A note made from a table's relation cell goes where a new note of its
  // type goes: the page beside it is the view, which lives in .atlas/views.
  const createRelatedFromTable = useCreateRelated({
    fs: notes.fs,
    markdown: notes.markdown,
    types,
    notePaths,
    beside: null,
    onChanged,
  });
  const createLinkedNote = useCreateLinkedNote({
    fs: notes.fs,
    markdown: notes.markdown,
    notePaths,
    beside: path,
    onChanged,
    onProblem: context.onLinkProblem,
    beingMade: context.notesBeingMade,
  });
  const dashboard = useDashboard({ note: note.open, index, types, notePaths, indexKey });
  const literatureDocument = literatureDocumentOf(note.open?.properties ?? null);
  // Each highlight of a PDF's or a book's literature note offers "Open in PDF" or "Open in EPUB" (#506), as its file reads.
  const highlightLinks = useMemo(
    () =>
      note.open === null
        ? null
        : readerHighlightLinks(notes.markdown, {
            properties: note.open.properties,
            text: note.open.onDisk,
          }),
    [notes.markdown, note.open],
  );
  const dashboardEditing = useDashboardEditing({
    note: note.open,
    isDashboard: dashboard.results !== null,
    ports: notes,
    index,
    types,
    notePaths,
    savedViews,
    editors,
    activity: context.activity,
    onChanged,
    editorSlot: arrangement.popups?.('widget-editor'),
    inPeek: chrome === 'peek',
  });
  const { toasts, openNotes } = context;
  const viewToasts = useMemo(() => ({ toasts, panes: openNotes }), [toasts, openNotes]);
  const savedView = useSavedView({
    note: note.open,
    index,
    fs: notes.fs,
    markdown: notes.markdown,
    types,
    notePaths,
    indexKey,
    onChanged,
    editors,
    tickMemory: context.tickMemory,
    drafts: context.viewDrafts,
    viewPaths: context.viewPaths,
    activity: context.activity,
    toasts: viewToasts,
  });
  const planner = usePlanner({
    active:
      savedView.display.layout === 'calendar' &&
      isBlockType(savedView.type?.name ?? savedView.query?.type),
    vault: context.vault,
    fs: notes.fs,
    markdown: notes.markdown,
    index,
    editors,
    types,
    notePaths,
    indexKey,
    onChanged,
    activity: context.activity,
  });
  const sqlView = useSqlView({ note: note.open, index, indexKey });
  const viewKey = `${context.vault ?? ''}\u0000${path ?? ''}`;
  const folds = useGroupFolds({ store: context.groupFolds, view: viewKey });
  // Each pane's own: the store reads this Mac's storage through, so a fold
  // made in one pane is what the other sees when it opens the view.
  const [queryFolds] = useState(createBrowserQueryFoldStore);
  const queryView = useQueryView({
    folds,
    queryFold: { store: queryFolds, view: viewKey },
    note: note.open,
    ports: { index, fs: notes.fs, markdown: notes.markdown, editors, activity: context.activity },
    types,
    notePaths,
    indexKey,
    queryViews: context.queryViews,
    dashboards: context.dashboards,
    viewPaths: context.viewPaths,
    onChanged,
    onOpenNote: (target) => onOpenNote(createVaultPath(target)),
  });
  const viewRows = useMemo(() => rowPaths(savedView.result), [savedView.result]);
  const choosing = useViewChoosing({
    viewKey: path ?? '',
    commands: context.archive,
    tab: tabId,
    present: viewRows,
    exporting: context.exporting,
    ...(isPersonType(savedView.type?.name ?? savedView.query?.type ?? null) && {
      people: context.peopleMerge,
    }),
  });
  // Held here, above both, because the toolbar pages the range the body draws.
  const calendar = useCalendarNav({
    today: localToday(),
    resetKey: path,
    range: savedView.display.calendarRange,
    onRange: savedView.setCalendarRange,
  });
  const source = useSource({
    note: note.open,
    fs: notes.fs,
    markdown: notes.markdown,
    index,
    sources,
    refresher: context.sourceRefresher,
    vaultRoot: context.vault,
    setProperty: note.setProperty,
    onChanged,
  });
  const artifact = useArtifactCopy({
    note: note.open,
    fs: notes.fs,
    clock: localClock,
    links: context.links,
    thumbnails: context.thumbnails,
    setProperties: note.setProperties,
    activity: context.activity,
    onChanged,
  });
  const pageThumbnail = usePageThumbnail({
    note: note.open,
    type: types.find((candidate) => candidate.name === noteProperties.typeName),
    thumbnails: context.thumbnails,
    ports: {
      fs: notes.fs,
      probe: webviewImageProbe,
      placement: browserImagePlacementStore,
      now: localNow,
      onSaved: onChanged,
    },
    setProperties: note.setProperties,
  });
  const loadImage = useImages({ fs: notes.fs, notePath: path });
  const bookmarks = useBookmarks({
    fs: notes.fs,
    markdown: notes.markdown,
    index,
    notePath: path,
    notePaths,
    types,
    revision: indexKey,
  });
  const transclusions = useTransclusions({
    fs: notes.fs,
    markdown: notes.markdown,
    index,
    notePath: path,
    notePaths,
    revision: indexKey,
  });
  const queries = useQueryBlocks({
    index,
    types,
    notePaths,
    notePath: path,
    revision: indexKey,
    onOpenNote: (target) => onOpenNote(createVaultPath(target)),
  });
  const linked = useLinkedPage({
    index,
    clock: localClock,
    store: context.linkedRanges,
    types,
    notePaths,
    // A template of a type is what its notes start as, not a page of the type.
    notePath: path !== null && isTemplateNote(path) ? null : path,
    // The type is the loaded note's, which lags the pane's path while a note opens.
    loadedPath: note.open?.path ?? null,
    typeName: noteProperties.typeName,
    projectStatus: textOrNull(note.open?.properties[PROJECT_STATUS_KEY]),
    revision: indexKey,
  });
  const picking = useBlockPicking({
    fs: notes.fs,
    markdown: notes.markdown,
    index,
    notePath: path,
    notePaths,
    openNotes: context.openNotes,
    rng: cryptoRng,
    onChanged,
    onRefused: context.onLinkProblem,
  });
  const promotion = useLinePromotion({
    fs: notes.fs,
    markdown: notes.markdown,
    openNotes: context.openNotes,
    flush: note.flush,
    path,
    notePaths,
    types,
    onChanged,
    onOpenNote,
    activity: context.activity,
    toasts: context.toasts,
  });
  const highlights = useNoteHighlights({
    fs: notes.fs,
    markdown: notes.markdown,
    openNotes: context.openNotes,
    flush: note.flush,
    path,
    open: note.open,
    onChanged,
    toasts: context.toasts,
    onWritePending: holdPendingComments,
    ...(keptComments !== undefined && { kept: keptComments }),
  });
  const corrections = useMeetingCorrections({
    fs: notes.fs,
    markdown: notes.markdown,
    openNotes: context.openNotes,
    flush: note.flush,
    path,
    properties: note.open?.properties ?? null,
    onChanged,
    activity: context.activity,
  });
  const embedImage = useEmbedImage({
    ports: {
      fs: notes.fs,
      probe: webviewImageProbe,
      placement: browserImagePlacementStore,
      now: localNow,
      onSaved: onChanged,
      activity: context.activity,
    },
    notePath: path,
  });
  const backfill = useThumbnailBackfill({
    thumbnails: context.thumbnails,
    index,
    fs: notes.fs,
    markdown: notes.markdown,
  });
  const openTarget = (target: string, how?: OpenHow) => onOpenNote(createVaultPath(target), how);
  const pageKey = usePageKey(path, note.open);
  const template = templateNoticeFor(path, context);
  const heading =
    note.open === null
      ? null
      : pageHeading({
          note: note.open,
          typeName: noteProperties.typeName,
          sql: savedView.result?.sql ?? sqlView.sql,
        });
  const customPropertyValues = useMemo(
    () => ({
      ...(artifact !== null && { [ARTIFACT_KEYS.cover]: thumbnailValue(artifact, loadImage) }),
      ...(pageThumbnail !== null && {
        [pageThumbnail.key]: pageThumbnailValue(pageThumbnail, loadImage),
      }),
    }),
    [artifact, pageThumbnail, loadImage],
  );
  // What the aside shows for this tab (#306): said through the store, read by
  // a selector there, so the aside follows the focused tab without `App`.
  // Memoised on what its Properties and Backlinks read; the callbacks are
  // steady, so a render of this tab publishes nothing new unless those
  // changed, and the document goes apart, since it changes with every key.
  const steadyOpenNote = useSteadyCallback(onOpenNote);
  const steadyAdd = useSteadyCallback(addProperty);
  const steadyCreateRelated = useSteadyCallback(createRelated);
  const steadyFind = useSteadyCallback(links.mentions.find);
  const steadyLink = useSteadyCallback(links.mentions.link);
  const { typeName, typeLabel, rows, relationChoices, relationTargets, keys } = noteProperties;
  const steadyMergeInto = useSteadyCallback(() => {
    if (path !== null) onMergeInto?.(path);
  });
  // A person, not a template of one, merges into another from the menu and the aside (#464).
  const mergeInto =
    onMergeInto !== undefined && path !== null && template === null && isPersonType(typeName)
      ? steadyMergeInto
      : null;
  const shownPath = note.open?.path ?? null;
  const shownTitle = heading?.title.text ?? null;
  usePublishShownNote(aside.shown, tabId, {
    shown: useMemo<ShownNote | null>(
      () =>
        shownPath === null || shownTitle === null
          ? null
          : {
              path: shownPath,
              title: shownTitle,
              kicker: typeLabel ?? 'Note',
              panel: {
                typeName,
                typeLabel,
                rows,
                relationChoices,
                relationTargets,
                fileKeys: keys,
                customValues: customPropertyValues,
                onChange: note.setProperty,
                onAdd: steadyAdd,
                onOpenNote: steadyOpenNote,
                onCreateRelated: steadyCreateRelated,
              },
              links: links.links,
              mentions: links.mentions.state,
              onFindMentions: steadyFind,
              onLinkMention: steadyLink,
              ...(mergeInto !== null && { onMergeInto: mergeInto }),
            },
      [
        shownPath,
        shownTitle,
        typeName,
        typeLabel,
        rows,
        relationChoices,
        relationTargets,
        keys,
        customPropertyValues,
        note.setProperty,
        steadyAdd,
        steadyOpenNote,
        steadyCreateRelated,
        links.links,
        links.mentions.state,
        steadyFind,
        steadyLink,
        mergeInto,
      ],
    ),
    doc: note.open?.doc ?? null,
  });
  // Whether the aside is showing this tab's properties, so the body need not: the tab's own answer.
  const propertiesInAside = usePropertiesInAside({
    aside: aside.store,
    workspace: aside.workspace,
    tab: tabId,
    path,
  });
  // The row this tab's tables held goes with the tab.
  useEffect(() => () => clearRow(aside.store, tabId), [aside.store, tabId]);
  // A row of a view in this note, as its focus lands: the aside shows the row's note.
  const onRowFocus = useCallback(
    (row: string) => {
      if (path !== null)
        focusRow(aside.store, { tab: tabId, path: createVaultPath(row), within: path });
    },
    [aside.store, tabId, path],
  );
  // Named for the list the row was clicked in, as the peek's header says it: "3 of 186 in Tasks".
  const peekRow = useSteadyCallback(({ path: row, order }: PeekRequest) =>
    onPeek?.(
      rowPeek({
        path: createVaultPath(row),
        order: order.map(createVaultPath),
        within: shownTitle ?? 'this view',
      }),
    ),
  );

  const page = (
    <NotePane
      key={pageKey}
      chrome={chrome}
      state={note.state}
      heading={heading}
      propertiesInAside={propertiesInAside}
      arrangement={arrangement}
      onChange={note.changeDoc}
      onSave={note.save}
      onFollowLink={onFollowLink}
      suggestNotes={context.suggestNotes}
      onCreateNote={createLinkedNote}
      suggestTags={context.suggestTags}
      people={context.people}
      bookmarks={bookmarks}
      transclusions={transclusions}
      highlightLinks={highlightLinks}
      highlights={highlights}
      {...(queries !== undefined && { queries })}
      picking={picking}
      // A template's lines are what new notes start with, not work to promote.
      {...(promotion !== undefined && template === null && { promotion })}
      reveal={reveal}
      onOpenTag={context.openTag}
      links={links.links}
      mentions={links.mentions.state}
      onFindMentions={links.mentions.find}
      onLinkMention={links.mentions.link}
      onOpenNote={onOpenNote}
      loadImage={loadImage}
      {...(embedImage !== undefined && { embedImage })}
      typeName={noteProperties.typeName}
      properties={noteProperties.rows}
      propertyKeys={noteProperties.keys}
      relationChoices={noteProperties.relationChoices}
      typeLabel={noteProperties.typeLabel}
      relationTargets={noteProperties.relationTargets}
      customPropertyValues={customPropertyValues}
      onChangeProperty={note.setProperty}
      onAddProperty={addProperty}
      onCreateRelated={createRelated}
      onRename={(name) => {
        if (path === null) return;
        // A template is renamed as a template, never through the note's own flow.
        if (template !== null) context.templateCommands.rename({ path, name });
        else onRename({ path, name });
      }}
      {...(template !== null && { template })}
      {...(corrections !== undefined && template === null && { corrections })}
      {...(onMoveTo !== undefined &&
        path !== null &&
        template === null &&
        isMovable({ path, kind: 'file' }) && { onMoveTo: () => onMoveTo(path) })}
      {...(path !== null &&
        template !== null && { onDelete: () => context.templateCommands.askDelete(path) })}
      {...(onDelete !== undefined &&
        path !== null &&
        template === null &&
        deleteRefusal({ path, kind: 'file' }) === null && { onDelete: () => onDelete(path) })}
      {...(mergeInto !== null && { onMergeInto: mergeInto })}
      {...(context.exporting !== null &&
        path !== null &&
        template === null && { onExport: () => context.exporting?.ask([path]) })}
      {...pageArchiveItems({
        commands: context.archive,
        path,
        properties: note.open?.properties ?? null,
      })}
      {...(onShowInGraph !== undefined &&
        path !== null &&
        template === null && { onShowInGraph: () => onShowInGraph(path) })}
      onOverwrite={note.overwrite}
      onDiscard={note.discard}
      favorite={note.open !== null && isFavorite(note.open.properties)}
      onToggleFavorite={() => {
        if (path !== null) onToggleFavorite(path);
      }}
      aside={
        artifactAside(artifact, path) ?? (
          <>
            {taskSchedule !== null && <TaskScheduleSummary {...taskSchedule} />}
            {linked !== null && (
              <LinkedSections
                // A page's own "show more" and folds, never the last page's.
                key={path}
                sections={linked.sections}
                problem={linked.problem}
                onChangeRange={linked.setRange}
                onOpenNote={(target) => onOpenNote(createVaultPath(target))}
              />
            )}
          </>
        )
      }
      // A template is edited as text, whatever it makes: the Dashboard
      // template's widgets are its frontmatter, not a dashboard to arrange.
      body={
        template !== null
          ? undefined
          : paneBody({
              source,
              dashboard: { ...dashboard, ...dashboardEditing },
              savedView,
              planner,
              sqlView,
              queryView,
              calendar,
              arrangement,
              openTarget,
              followLink: onFollowLink,
              openTag: context.openTag,
              thumbnails: context.thumbnails,
              fs: notes.fs,
              choosing,
              folds,
              onRowFocus,
              createRelated: createRelatedFromTable,
              ...(onPeek !== undefined && { onPeek: peekRow }),
            })
      }
      {...(template === null &&
        dashboardEditing.toggle !== null && {
          actions: <CustomizeToggle {...dashboardEditing.toggle} />,
        })}
      {...(template === null &&
        dashboardEditing.toggle === null &&
        literatureDocument !== null && {
          actions: (
            <PageAction
              icon="book"
              label={literatureDocument.label}
              onPress={() => onOpenNote(literatureDocument.file)}
            />
          ),
        })}
      toolbar={
        template === null && (
          <ViewHeadToolbar
            view={savedView}
            note={note.open}
            savedViews={savedViews}
            calendar={calendar}
            onOpenNote={onOpenNote}
            onNewArtifact={context.newArtifact}
            backfill={backfill}
            popups={arrangement.popups}
            choosing={choosing}
            tabEditing={context.typeTabs}
          />
        )
      }
    />
  );
  return { page, state: note.state, title: shownTitle, flush: note.flush };
}

/** An artifact's saved copy, under its properties; nothing for any other note. */
function artifactAside(artifact: ArtifactCopyView | null, path: VaultPath | null): ReactNode {
  if (artifact === null || path === null) return null;
  return (
    <Suspense fallback={null}>
      <ArtifactViewer
        title={noteTitle(path)}
        url={artifact.url}
        copy={artifact.copy}
        adding={artifact.adding}
        error={artifact.error}
        onOpenLink={artifact.openLink}
        onReload={artifact.reload}
        onAddCopy={artifact.addCopy}
        thumbnail={{
          generating: artifact.thumbnail.generating,
          onRegenerate: artifact.thumbnail.regenerate,
        }}
      />
    </Suspense>
  );
}

/** An artifact's Thumbnail row: the picture, and Regenerate and Clear. */
function thumbnailValue(
  artifact: ArtifactCopyView,
  load: (src: string) => Promise<string | null>,
): (id: string) => ReactNode {
  const { thumbnail } = artifact;
  return function thumbnailRow(id) {
    return (
      <ThumbnailValue
        id={id}
        cover={thumbnail.cover}
        shown={thumbnail.shown}
        generating={thumbnail.generating}
        failure={thumbnail.failure}
        canGenerate={thumbnail.canGenerate}
        load={load}
        onRegenerate={thumbnail.regenerate}
        onClear={thumbnail.clear}
      />
    );
  };
}

/** A note's Thumbnail row: the picture of its page or the one it chose, and what to do with it. */
function pageThumbnailValue(
  thumbnail: PageThumbnailView,
  load: (src: string) => Promise<string | null>,
): (id: string) => ReactNode {
  return function pageThumbnailRow(id) {
    return (
      <ThumbnailValue
        id={id}
        cover={thumbnail.shown}
        shown={thumbnail.shown}
        generating={thumbnail.generating}
        failure={thumbnail.failure}
        canGenerate
        load={load}
        onRegenerate={thumbnail.regenerate}
        regenerateDiscards={thumbnail.discards}
        onClear={thumbnail.clear}
        onChoose={thumbnail.choose}
        clearable={!thumbnail.cleared}
        emptyLabel={thumbnail.cleared ? 'None' : 'None yet'}
      />
    );
  };
}

/** What the pane's note is linked with, both ways, and the notes that name it without a link. */
function useNoteLinks({ context, path }: { context: PaneContext; path: VaultPath | null }) {
  const { graph, index, notes, openNotes, indexStatus, vault, onChanged } = context;
  const links = useMemo(
    () => (graph === null || path === null ? NO_LINKS : noteLinks(graph, path)),
    [graph, path],
  );
  const title =
    path === null
      ? ''
      : (graph?.nodes.find((node) => node.path === path)?.title ?? noteTitle(path));
  const ports = useMemo(
    () => ({ index, fs: notes.fs, markdown: notes.markdown, openNotes }),
    [index, notes.fs, notes.markdown, openNotes],
  );
  const mentions = useUnlinkedMentions({
    ports,
    note: path === null ? null : { path, title },
    links,
    index: { status: indexStatus, vault },
    onChanged,
  });
  return { links, mentions };
}

/**
 * The pane's note, registered with the other panes so a write made elsewhere —
 * a board card moved, a table cell edited — can reach this editor.
 */
function usePaneNote({
  tabId,
  path,
  context,
  hidden,
  pendingComments,
}: {
  tabId: TabId;
  path: VaultPath | null;
  context: PaneContext;
  hidden: boolean;
  /** The write of the comments typed in the note's highlights and not yet written, while it is open. */
  pendingComments: { readonly current: (() => Promise<void>) | null };
}) {
  const { editors, stranded, changes } = context;
  const note = useNote({
    ports: context.notes,
    vault: context.vault,
    path,
    paused: hidden,
    onSaved: (saved) => editors.reloadOthers({ tabId, path: saved }),
    onStranded: stranded.keep,
    recoverStranded: stranded.take,
    settleStranded: stranded.settle,
    onSaveFailed: ({ path: failed, cause }) => {
      // The vault the pane is in: a save refused after a switch is still that vault's.
      if (context.vault === null) return;
      const problem = messageWithoutPaths(cause);
      context.activity
        .inVault(context.vault)
        .record(writeFailedReport({ write: 'save', path: failed, problem }));
    },
  });

  /**
   * This pane's editor as it stands now.
   *
   * The registration below must not be rewritten on every keystroke, so what is
   * registered reads through this rather than closing over one render.
   */
  const live = useRef(note);
  useEffect(() => {
    live.current = note;
  });

  // Written as the tab hides: what was typed is on disk before the editor
  // waits behind another tab, and the autosave has stood down by then.
  useEffect(() => {
    if (hidden) void live.current.flush();
  }, [hidden]);

  useOutsideChangeReload({ changes, vault: context.vault, path, live });

  useEffect(() => {
    if (path === null) return;
    editors.register(tabId, {
      path,
      setProperties: (changes) => live.current.setProperties(changes),
      save: () => live.current.save(),
      // The note's typing first: a comment's write is refused while the note holds unsaved typing.
      flush: async () => {
        await live.current.flush();
        await pendingComments.current?.();
      },
      reload: () => live.current.reload(),
      isDirty: () => live.current.dirty,
      repoint: (to) => live.current.repoint(to),
      abandon: () => live.current.abandon(),
    });
    return () => editors.register(tabId, null);
  }, [editors, tabId, path, pendingComments]);

  return note;
}

/**
 * Which page the pane is showing, as React's key for it.
 *
 * The path, except across a move: a note re-pointed under the pane already
 * holds its new path when the pane is handed it, and is the same page — the
 * editor, its cursor and whatever the "…" menu revealed stay as they were. A
 * note opened fresh is still holding the old one, and gets a fresh page.
 */
function usePageKey(path: VaultPath | null, open: { readonly path: VaultPath } | null): string {
  const [key, setKey] = useState(path ?? 'none');
  const wanted = path === null || open?.path !== path ? (path ?? 'none') : key;
  // Kept from one render to the next, the way React stores what an earlier
  // render saw: set during render, so the page is never drawn under a stale key.
  if (wanted !== key) setKey(wanted);
  return wanted;
}

/** What a page draws instead of the editor: a source, a dashboard or a view; nothing for prose. */
function paneBody({
  source,
  dashboard,
  savedView,
  planner,
  sqlView,
  queryView,
  calendar,
  arrangement,
  openTarget,
  followLink,
  openTag,
  thumbnails,
  fs,
  choosing,
  folds,
  onRowFocus,
  createRelated,
  onPeek,
}: {
  source: ReturnType<typeof useSource>;
  dashboard: ReturnType<typeof useDashboard> & ReturnType<typeof useDashboardEditing>;
  savedView: ReturnType<typeof useSavedView>;
  /** The tray of tasks to plan, for a calendar of blocks; null for any other view. */
  planner: Planner | null;
  sqlView: ReturnType<typeof useSqlView>;
  queryView: QueryViewState | null;
  calendar: CalendarNavigation;
  arrangement: PaneArrangement;
  openTarget: (target: string) => void;
  /** Follows a `[[link]]` in a feed's bodies, as one in the editor is followed. */
  followLink: (target: string) => void;
  /** Opens the tags page on a `#tag` in a feed's bodies. */
  openTag: (name: string) => void;
  thumbnails: ThumbnailQueue;
  fs: VaultFsPort;
  choosing: ViewChoosing;
  folds: GroupFolds;
  /** Told the row a table's focus landed in, for the aside. */
  onRowFocus: (path: string) => void;
  /** "New <type>…" in a table's relation cell. */
  createRelated: CreateRelated;
  /** Given, a table's row or a board's card clicked plainly peeks its note. */
  onPeek?: (request: PeekRequest) => void;
}): ReactNode {
  if (source.source !== null) {
    return (
      <SourcePanel
        source={source.source}
        report={source.report}
        refreshing={source.refreshing}
        onRefresh={source.refresh}
        secrets={source.secrets}
        outsideVault={source.outsideVault}
        {...(source.chooseFile !== null && { onChooseFile: source.chooseFile })}
        fileProblem={source.fileProblem}
      />
    );
  }
  if (dashboard.results !== null) {
    return (
      <>
        <Suspense fallback={null}>
          <DashboardView
            results={dashboard.results}
            onOpenNote={openTarget}
            {...(arrangement.popups !== undefined && { popups: arrangement.popups })}
            {...(dashboard.editing !== undefined && { editing: dashboard.editing })}
          />
        </Suspense>
        {dashboard.sheet !== null && (
          // Its own boundary: a sheet still loading must not hide the dashboard under it.
          <Suspense fallback={null}>
            <WidgetEditor {...dashboard.sheet} />
          </Suspense>
        )}
      </>
    );
  }
  if (sqlView.sql !== null) return <SqlViewBody view={sqlView} onOpenNote={openTarget} />;
  if (queryView !== null) {
    return (
      <QueryViewBody
        view={queryView}
        onOpenView={openTarget}
        {...(arrangement.popups !== undefined && { popups: arrangement.popups })}
      />
    );
  }
  if (savedView.query === null) return undefined;
  return (
    <ViewBody
      view={savedView}
      planner={planner}
      calendar={calendar}
      onOpenNote={openTarget}
      onFollowLink={followLink}
      onOpenTag={openTag}
      thumbnails={thumbnails}
      fs={fs}
      choosing={choosing}
      folds={folds}
      onRowFocus={onRowFocus}
      onCreateRelated={createRelated}
      {...(arrangement.popups !== undefined && { popups: arrangement.popups })}
      {...(onPeek !== undefined && { onPeek })}
    />
  );
}

/** A property's value when it is one piece of text, as a status is written. */
function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * The band a template's page wears, or null for anything else: what the
 * template is used for, read from its name and the vault's types.
 */
function templateNoticeFor(path: VaultPath | null, context: PaneContext): TemplateNotice | null {
  if (path === null || !isTemplateNote(path)) return null;
  return {
    uses: templateUses(templateNameOf(path), context.types),
    onOpenTemplates: context.templateCommands.onOpenTemplates,
    onMoveToNotes: () => context.templateCommands.askMoveToNotes(path),
  };
}

/**
 * The PDF or EPUB a literature note is a note of, which its bar offers to
 * open ("Open PDF", "Open EPUB"; #504, #505); null for any other note.
 */
function literatureDocumentOf(
  properties: Readonly<Record<string, unknown>> | null,
): { readonly file: VaultPath; readonly label: string } | null {
  return readerDocumentOf(properties === null ? null : readLiteratureNote(properties));
}

/** The kept comments of the pane's vault: what its note keeps there, and is offered back. */
function useKeptCommentsOf({
  vault,
  strandedComments: { offered, keep, settle },
}: Pick<PaneContext, 'vault' | 'strandedComments'>): KeptCommentsOfVault | undefined {
  return useMemo(
    () =>
      vault === null
        ? undefined
        : {
            offered,
            keep: (kept) => keep({ vault, ...kept }),
            settle: (settled) => settle({ vault, ...settled }),
          },
    [vault, offered, keep, settle],
  );
}
