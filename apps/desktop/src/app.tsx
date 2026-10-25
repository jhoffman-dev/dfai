import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useState,
  type ComponentProps,
} from 'react';
import { QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import {
  activeNotePaths,
  activeTabOf,
  ASK_PLACE,
  tabPlace,
  createVaultPath,
  favoriteValue,
  rankNoteSuggestions,
  readWikiLink,
  sidebarTreeRows,
  vaultInitial,
  FAVORITE_KEY,
  hasFullName,
  NAME_PLACEHOLDER,
  moveRefusal,
  noteNames,
  noteTitle,
  tagKey,
  taskTypeOf,
  ARTIFACT_KINDS,
  ARTIFACT_TYPE,
  claudeArtifactUrl,
  pastedArtifactCommands,
  SAVE_ARTIFACT_LINK,
  TYPE_ICONS,
  VAULT_ROOT,
  type EntryMove,
  type GraphScope,
  type NavigationPlace,
  type PagePlace,
  type VaultEntry,
  type VaultPath,
  typeShownAt,
} from '@dfai/domain';
import {
  createNoteChanges,
  createOwnWrites,
  createRefreshSpacing,
  createSourceRefresher,
  createTagRenames,
  createMeetingDrafts,
  createToolboxes,
  findTaskTemplate,
  getAppInfo,
  PEOPLE_SCOPE,
  PERSON_EMAILS_SCOPE,
  PROJECTS_SCOPE,
  SECRETS_SCOPE,
  SYNC_SCOPE,
  setNoteProperty,
  readsTouchedByPaths,
  reportingIndexWrites,
  type VaultRead,
  type ActivityStore,
  type WindowClosingPort,
  type ApiRouterDeps,
  type AppInfoPort,
  type ExternalLinkPort,
  type GlobalCapturePort,
  type ExportFilesPort,
  type GoogleCalendarPort,
  type GoogleDrivePort,
  type NotePageRenderer,
  type PdfRendererPort,
  type GranolaPort,
  type GranolaPullRecords,
  type PageSnapshotPort,
} from '@dfai/application';
import {
  AppShell,
  ASIDE_WIDTH,
  ASIDE_WIDTH_TYPE,
  AsideToggleProvider,
  ChatToggleProvider,
  collapseFor,
  useSteadyCallback,
  CapturePalette,
  DeleteDialog,
  lostUsesText,
  TemplateToNoteDialog,
  MovePicker,
  AboutSettings,
  IndexSettings,
  indexStatusText,
  SidebarFooter,
  OpenFromGitHubDialog,
  VaultHeader,
  VaultEmptyState,
  NewTypeDialog,
  NewViewDialog,
  NewArtifactDialog,
  AddDocumentDialog,
  NoteNamesProvider,
  Toast,
  type AppInfoState,
  type OpenHow,
} from '@dfai/ui';
import { useVault, type VaultPorts } from './vault/use-vault.ts';
import { boundToVault, type OnHost } from './vault/bound-to-vault.ts';
import type { NotePorts } from './notes/use-note.ts';
import { useIndex, type IndexPorts } from './index/use-index.ts';
import { useIndexFailure, useIndexReady } from './index/index-status-store.ts';
import { openOnce } from './index/open-once.ts';
import { createWindowQueryClient } from './reads/query-client.ts';
import { createReadInvalidator } from './reads/read-invalidator.ts';
import { tellingOwnWrites } from './reads/telling-own-writes.ts';
import { useSqlViews } from './reads/use-sql-views.ts';
import { useScopedIndexKey } from './reads/use-scoped-index-key.ts';
import { LinkHintsHost } from './linked-pages/link-hints-host.tsx';
import { createNotesBeingMade } from './notes/notes-being-made.ts';
import { useVaultReads } from './reads/use-vault-reads.ts';
import { refreshAfterWatch } from './index/watched-paths.ts';
import { IndexProgressPill, LiveIndexSettings } from './index/index-progress.tsx';
import { useOutsideChanges } from './vault/use-outside-changes.ts';
import { useCreateNote } from './notes/use-create-note.ts';
import { useTypes } from './types/use-types.ts';
import { useTypeCommands } from './types/use-type-commands.ts';
import { useSidebarCatalog } from './sidebar/use-sidebar-catalog.ts';
import { browserSectionStore } from './sidebar/browser-section-store.ts';
import { createBrowserGroupFoldStore } from './query/browser-group-fold-store.ts';
import { createBrowserLinkedRangeStore } from './linked-pages/browser-linked-range-store.ts';
import { useTemplates } from './types/use-templates.ts';
import {
  PANES_WRITE_GAVE_UP,
  SWITCH_WRITE_GAVE_UP,
  useEditorsWrittenBeforeClose,
  useOpenEditors,
  writtenWithin,
} from './panes/open-editors.ts';
import { useStrandedEdits } from './notes/stranded-edits.ts';
import {
  browserStrandedCommentStore,
  browserStrandedStore,
} from './notes/browser-stranded-store.ts';
import { useStrandedComments } from './notes/stranded-comments.ts';
import { placeName } from './panes/place-name.ts';
import type { PaneContext } from './panes/note-pane-container.tsx';
import { createRevealStore } from './panes/reveals.ts';
import { ActiveSidebar } from './workspace/active-sidebar.tsx';
import { browserWorkspaceStore } from './workspace/browser-workspace-store.ts';
import { followLink, openNote as openNotePlace, openNoteAtBlock } from './workspace/open-place.ts';
import { PanesContainer } from './workspace/panes-container.tsx';
import { createAskFocus } from './ask/ask-focus.ts';
import { AskSeatProvider, type AskSeat } from './ask/ask-seat.tsx';
import {
  closeActiveTab,
  openPlace,
  toggleAsk,
  usePageShown,
  closeNotes as closeNotesIn,
  activePlace,
  createWorkspaceStore,
  focusedNotePath,
  followMove as followMoveIn,
  goBack,
  goForward,
  keepNotes,
  loadVault,
  newTabIn,
  nextTab,
  previousTab,
  activateNthTab,
  reopenClosedTab,
  toggleSplit as toggleSplitIn,
  workspaceNow,
} from './workspace/workspace-store.ts';
import {
  WorkspaceStoresProvider,
  WorkspaceWiringProvider,
  type WorkspaceStores,
} from './workspace/workspace-wiring.tsx';
import { browserThemeStore } from './theme/browser-theme-store.ts';
import { useVaultGraph } from './graph/use-vault-graph.ts';

import { localClock, localTimeZone, localToday } from './today.ts';
import { cryptoRng } from './random.ts';
import type { Overlay } from './overlay.ts';
import {
  closePeek,
  createOverlayStore,
  followPeekMove,
  forgetPeeked,
  hideOverlay as hideIn,
  peekNow,
  replacePeek,
  showOverlay as showIn,
  useWindowOverlay,
} from './overlay-store.ts';
import { PEEK_EDITOR, PeekLayer } from './panes/peek-container.tsx';
import { leavePeek } from './panes/peek-moves.ts';
import { SearchPaletteSlot } from './search-palette-slot.tsx';
import { linkPlacesOf } from './reader/link-places.ts';
import { movingEditorsIn, openNotesIn } from './panes/open-notes.ts';
import { useVaultEntries, type VaultEntryPorts } from './vault/use-vault-entries.ts';
import { MergePeopleSlot, PossibleDuplicatesSlot } from './people/people-merge-slot.tsx';
import { usePeopleMerge } from './people/use-people-merge.ts';
import { useExport } from './export/use-export.ts';
import { ExportSlot } from './export/export-slot.tsx';
import { paletteExportCommands, runPaletteExportCommand } from './export/palette-export.ts';
import { vaultSettingsWriter } from './settings/vault-settings-writer.ts';
import { useLocalApi, type LocalApiPorts } from './api/use-local-api.ts';
import { useApiHost } from './api/use-api-host.ts';
import { createAutomationRelay } from './api/automation-relay.ts';
import { createOwnerNameRelay } from './api/owner-name-relay.ts';
import { createClaudeStepRelay } from './api/claude-step-relay.ts';
import { createMoveRelay } from './api/move-relay.ts';
import { SettingsPanel } from './settings/settings-panel.tsx';
import {
  GlobalCaptureSettings,
  GoogleCalendarSettingsCard,
  GranolaSettingsCard,
  ImageSettingsPanel,
  KindleSettingsCard,
  ProfileSettingsCard,
  QuickAddSettingsCard,
  SecretsSettingsCard,
  SyncSettingsCard,
  settingsSectionLinks,
} from './settings/settings-sections.ts';
import { browserImagePlacementStore } from './notes/browser-image-placement-store.ts';
import { useTickMemory } from './query/tick-memory.ts';
import { createToasts } from './toasts/toasts.ts';
import { ToastHost } from './toasts/toast-host.tsx';
import { useViewDrafts } from './query/use-view-drafts.ts';
import { useNewView } from './query/use-new-view.ts';
import { createBrowserTypeTabStore } from './types/browser-type-tab-store.ts';
import { useTypeViews } from './types/use-type-views.ts';
import { paletteEditTypeOffers, runPaletteEditTypeCommand } from './types/palette-edit-type.ts';
import { useTemplatesPage } from './templates/use-templates-page.ts';
import { answersWrittenOrGivenUp, useAnswersWrittenBeforeClose } from './proposals/answer-queue.ts';
import { useNewArtifact } from './artifacts/use-new-artifact.ts';
import { useAddToLibrary } from './reader/use-add-to-library.ts';
import { useThumbnailQueue, useThumbnailsNow } from './artifacts/use-thumbnails.ts';
import { createQueryTextStore, queryTextOf } from './query/query-text-store.ts';
import { AppNotices } from './app-notices.tsx';
import { browserActivitySeenStore } from './activity/browser-activity-seen-store.ts';
import { useActivity } from './activity/use-activity.ts';
import { useActivityLog, useNoticeActivity } from './activity/use-activity-log.ts';
import { usePeople } from './people/use-people.ts';
import { useAppShortcuts } from './app-shortcuts.ts';
import { AsideContainer } from './aside/aside-container.tsx';
import {
  createAsideStore,
  hideAside,
  asideShown as asideShownNow,
  claudeShown as claudeShownNow,
  loadVaultAside,
  selectAsideTab,
  setAsideFolded,
  showAsideTab,
  toggleAside as toggleAsideIn,
  toggleClaude,
  useAsideShown,
  useClaudeAsked,
  useClaudeShown,
} from './aside/aside-store.ts';
import { browserAsideStore } from './aside/browser-aside-store.ts';
import { ClaudeSeatProvider } from './aside/claude-seat.tsx';
import { createShownNotes } from './aside/shown-notes.ts';
import { useAsideCollapsed } from './aside/use-aside-collapsed.ts';
import { useAsideWidth } from './aside/use-aside-width.ts';
import type { GlobalCaptureStore } from './global-capture/browser-global-capture-store.ts';
import { useGlobalCapture } from './global-capture/use-global-capture.ts';
import type { SourcePorts } from './sources/source-ports.ts';
import { useGoogleCalendar } from './settings/use-google-calendar.ts';
import { useGranola } from './settings/use-granola.ts';
import { useGranolaPull } from './granola/use-granola-pull.ts';
import { useKindleSync, type KindleHost } from './kindle/use-kindle-sync.ts';
import { NO_KINDLE } from './kindle/no-kindle.ts';
import { paletteKindleCommands, runPaletteKindleCommand } from './kindle/palette-kindle.ts';
import { useSecrets } from './settings/use-secrets.ts';
import { useQuickAddSetting } from './quick-add/use-quick-add-setting.ts';
import { useSidebarOrder } from './sidebar/use-sidebar-order.ts';
import { useVaultTags } from './tags/use-vault-tags.ts';
import { useArchive } from './archive/use-archive.ts';
import { useInboxWaiting } from './inbox/use-inbox-waiting.ts';
import { createPendingWrites } from './workspace/pending-writes.ts';
import { createPageHoldsByVault } from './workspace/page-holds.ts';
import { useBuiltInTypes } from './types/use-built-in-types.ts';
import { useBlockType } from './timeblocks/use-block-type.ts';
import { useTaskMigration } from './gtd/use-task-migration.ts';
import { useParaMigration } from './para/use-para-migration.ts';
import { useVaultTidy } from './vault/use-vault-tidy.ts';
import { useMeetingCleanup } from './meetings/use-meeting-cleanup.ts';
import { useMeetingProjects } from './meetings/use-meeting-projects.ts';
import { AutomationsRunner } from './automations/automations-runner.tsx';
import { createAutomationsStore, useOwnerNeeded } from './automations/automations-store.ts';
import { MeetingImportRunner } from './meetings/meeting-import-runner.tsx';
import { archiveCommand, withCommandBeforeDelete } from './archive/archive-menu.ts';
import { paletteArchiveCommands, runPaletteArchiveCommand } from './archive/palette-archive.ts';
import { ChatPane, ClaudeSettingsCard } from './chat/chat-pane.tsx';
import { useProfileSetting } from './profile/use-profile-setting.ts';
import { useSelfEmailsSetting } from './profile/use-self-emails-setting.ts';
import { settingsUnreadable, vaultOwnerKnown } from './profile/vault-owner-known.ts';
import { useSettingsPause } from './profile/use-settings-pause.ts';
import { browserChatSettingsStore } from './chat/chat-settings-store.ts';
import { claudeStepPorts } from './chat/claude-step-ports.ts';
import { chatWindowOf } from './chat/chat-window.ts';
import { useChat, type ChatPorts } from './chat/use-chat.ts';
import { closingInStages } from './activity/closing-stages.ts';
import type { SyncHostPorts } from './sync/use-sync.ts';
import { createSyncStore, settleSync, useSyncForWindow } from './sync/sync-store.ts';
import { SyncLight, SyncRunner, SyncSettingsSlot } from './sync/sync-container.tsx';
import { useScopedIndexNews } from './reads/use-scoped-index-news.ts';
import { useOpenFromGitHub } from './sync/use-open-from-github.ts';
import { browserClipboard } from './settings/clipboard.ts';

const OPEN_TEMPLATES = 'open-templates';
const OPEN_TERMS = 'open-terms';
const OPEN_LIBRARY = 'open-library';
const OPEN_HIGHLIGHTS = 'open-highlights';
const ADD_PDF = 'add-pdf';
const ADD_EPUB = 'add-epub';
const FIND_DUPLICATE_PEOPLE = 'find-duplicate-people';
const MERGE_SELECTED_PEOPLE = 'merge-selected-people';
/** Why a merge was not worked out: links to the people might be missed. */
const INDEX_BEHIND_FOR_MERGE =
  'The index could not catch up with the vault, so links to these people could be missed. Try the merge again.';
const OPEN_INBOX = 'open-inbox';
const OPEN_REVIEW = 'open-review';
const OPEN_TODAY = 'open-today';

/** What the search palette can do besides find notes. */
const PALETTE_COMMANDS = [
  { id: 'new-query', label: 'New query', keywords: ['sql'] },
  { id: 'new-view', label: 'New view' },
  { id: 'new-artifact', label: 'New artifact', keywords: ['claude', 'save', 'link', 'html'] },
  { id: OPEN_TEMPLATES, label: 'Templates', keywords: ['template', 'edit templates'] },
  { id: OPEN_TERMS, label: 'Terms', keywords: ['glossary', 'spelling', 'vocabulary', 'aliases'] },
  // No word with a "t" in it: the palette's work budget types "tobia" (tools/perf/budgets.spec.ts).
  { id: ADD_PDF, label: 'Add PDF…', keywords: ['pdf', 'book', 'paper', 'library', 'reader'] },
  { id: ADD_EPUB, label: 'Add EPUB…', keywords: ['epub', 'ebook', 'book', 'library', 'reader'] },
  {
    id: OPEN_LIBRARY,
    label: 'Library',
    // No keyword holds a "t": ⌘K's first letter typed lists no more commands for it than before (#507).
    keywords: ['books', 'sources', 'pdf', 'epub', 'kindle', 'reading'],
  },
  {
    id: OPEN_HIGHLIGHTS,
    label: 'All highlights',
    keywords: ['quotes', 'annotations', 'comments', 'kindle', 'pdf', 'epub', 'reading'],
  },
  {
    id: FIND_DUPLICATE_PEOPLE,
    label: 'Possible duplicate people',
    keywords: ['merge', 'people', 'person', 'duplicates', 'same', 'email'],
  },
  {
    id: MERGE_SELECTED_PEOPLE,
    label: 'Merge selected people…',
    keywords: ['merge', 'people', 'person', 'selected', 'rows', 'duplicate'],
  },
  {
    id: OPEN_INBOX,
    label: 'Inbox',
    keywords: ['process', 'file', 'proposals', 'accept', 'reject', 'suggestions', 'claude'],
  },
  { id: OPEN_REVIEW, label: 'Weekly review', keywords: ['review', 'gtd', 'week'] },
  {
    id: OPEN_TODAY,
    label: 'Today',
    keywords: ['overdue', 'due', 'next actions', 'waiting', 'plan', 'day', 'gtd'],
  },
] as const;

/** The kinds an artifact can be, as the New artifact dialog offers them. */
const ARTIFACT_KIND_CHOICES = ARTIFACT_KINDS.map((kind) => ({
  value: kind,
  label: kind.charAt(0).toUpperCase() + kind.slice(1),
}));

/** What the search palette offers for a query before any command it names. */
const paletteOffers = (query: string) => pastedArtifactCommands(query);

export { localToday };

/**
 * Where focus goes when an overlay closes and what opened it has gone: the
 * note being edited, or else the tree — somewhere a keyboard can carry on
 * from, rather than `<body>`.
 */
function focusFallback(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>('.pane--focused [contenteditable="true"]') ??
    document.querySelector<HTMLElement>('[role="tree"] [tabindex="0"]')
  );
}

/** Stands in where the host gave no export ports: never reached, as no export is offered then. */
const NOT_OFFERED = (): never => {
  throw new Error('Exporting is not offered here.');
};
const NO_EXPORT_FILES: ExportFilesPort = {
  choose: NOT_OFFERED,
  write: NOT_OFFERED,
  finish: NOT_OFFERED,
};
const NO_PDF: PdfRendererPort = { pagingScript: '', render: NOT_OFFERED };
const NO_DRIVE: GoogleDrivePort = {
  findFolder: NOT_OFFERED,
  createFolder: NOT_OFFERED,
  uploadDocument: NOT_OFFERED,
};
const NO_RENDERER: NotePageRenderer = { bodyHtml: NOT_OFFERED, styles: '' };

/** A Google Drive retry's wait, on the window's own timer. */
const waitOnTimer = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/** The window, with its one query cache (ADR-0040): every whole-vault read below is kept in it. */
export function App(props: ComponentProps<typeof AppWindow>) {
  const [client] = useState(createWindowQueryClient);
  return (
    <QueryClientProvider client={client}>
      <AppWindow {...props} />
    </QueryClientProvider>
  );
}

function AppWindow({
  appInfo,
  vault: vaultPorts,
  notes: notePorts,
  index: indexPorts,
  sources,
  links,
  snapshot,
  api,
  chat: chatPorts,
  activity: activityPorts,
  sync: syncPorts,
  googleCalendar,
  granola: granolaPorts,
  kindle: kindlePorts,
  globalCapture: globalCapturePorts,
  exporting: exportPorts,
}: {
  appInfo: AppInfoPort;
  vault: OnHost<VaultPorts>;
  notes: OnHost<NotePorts>;
  index: OnHost<IndexPorts>;
  /** Feeds, SQLite files and the secrets feeds send. */
  sources: SourcePorts;
  /** Opens an artifact's link in the browser. */
  links: ExternalLinkPort;
  /** Pictures an artifact's saved copy for its thumbnail. */
  snapshot: PageSnapshotPort;
  api: LocalApiPorts;
  /** Claude, through Claude Code or an API key (ADR-0021). */
  chat: ChatPorts;
  /** Where each vault's Activity log is kept, on this Mac (U-28), and the window's close, to write it first. */
  activity: { store: ActivityStore; closing: WindowClosingPort };
  /** The Mac's own git and gh, for syncing the vault through GitHub (U-29). */
  sync: SyncHostPorts;
  /** Google Calendar, signed in to by the host, which keeps the tokens (ADR-0030). */
  googleCalendar: GoogleCalendarPort;
  /** Granola, through the host, which keeps the key (ADR-0034), and this Mac's record of each vault's pulls. */
  granola: { port: GranolaPort; records: GranolaPullRecords };
  /** Kindle through the host's own Amazon session (ADR-0044), and the app's one sync; left out, Kindle is not offered. */
  kindle?: KindleHost;
  /** The shortcut that opens quick capture from any app, registered by the host (#81). */
  globalCapture: { port: GlobalCapturePort; store: GlobalCaptureStore };
  /** Where exports go, how a PDF is made and how a Doc reaches Drive (#501); left out, nothing is exported. */
  exporting?: {
    files: ExportFilesPort;
    pdf: PdfRendererPort;
    drive: GoogleDrivePort;
    renderer: NotePageRenderer;
  };
}) {
  const [app, setApp] = useState<AppInfoState>({ kind: 'loading' });
  // The last sync runs before the Activity log's final write, so its line is kept.
  const closing = useMemo(() => closingInStages(activityPorts.closing), [activityPorts.closing]);
  const editors = useOpenEditors();
  // The tabs and panes, and where each tab was asked to scroll to (ADR-0040).
  const [workspace] = useState(() => createWorkspaceStore({ remembered: browserWorkspaceStore }));
  const [reveals] = useState(createRevealStore);
  // The right sidebar (#306): remembered per vault as the tabs are, read in the same event.
  const [asideStore] = useState(() => createAsideStore({ remembered: browserAsideStore }));
  const [shownNotes] = useState(createShownNotes);
  // Where the sync, run by its own runner below, says how it stands (#326). A
  // switch waits for a sync under way, whose remaining steps would otherwise
  // be refused half-done (U-29).
  const [syncStore] = useState(createSyncStore);
  const [automationsStore] = useState(createAutomationsStore);
  // The Inbox and Proposals tabs hold their background writes here: a switch
  // waits for the clarifications and answers still being written behind those
  // pages, which the host would refuse once another vault is open (#217, #166).
  const [pendingWrites] = useState(createPendingWrites);
  // The window's toasts: a change said with its Undo, held outside the pages (#320).
  const [toasts] = useState(createToasts);
  // A switch and a sync wait for every pane's work, but not forever: a hung write is said, not waited out (#534).
  const flushAllWithin = useMemo(
    () =>
      writtenWithin({
        flushAll: editors.flushAll,
        onGaveUp: () => toasts.show({ message: PANES_WRITE_GAVE_UP, tone: 'error' }),
      }),
    [editors, toasts],
  );
  const flushAllBeforeSwitch = useMemo(
    () =>
      writtenWithin({
        flushAll: editors.flushAll,
        onGaveUp: () => toasts.show({ message: SWITCH_WRITE_GAVE_UP, tone: 'error' }),
      }),
    [editors, toasts],
  );
  const leaveVault = useCallback(async () => {
    await flushAllBeforeSwitch();
    await answersWrittenOrGivenUp(pendingWrites.drained());
    await settleSync(syncStore);
  }, [flushAllBeforeSwitch, pendingWrites, syncStore]);
  // So is the window's close, whatever tab those pages are in, or were.
  useAnswersWrittenBeforeClose(pendingWrites, closing.writes);
  // And every pane's work, a comment typed in a highlight among it (#534), as leaving the vault does.
  useEditorsWrittenBeforeClose(editors, closing.writes);
  // Every pane's unsaved work is written before the host moves to another vault,
  // while its paths still mean the vault it was typed in.
  // Choosing and listing a vault come before there is one to bind writes to,
  // and need none: useVault is handed no way to write.
  const choosing = useMemo(() => boundToVault(vaultPorts, null), [vaultPorts]);
  const {
    location,
    rows,
    notePaths,
    notesListedFor,
    error,
    chooseVault,
    showVault,
    toggleDirectory,
    expandDirectory,
    forgetDirectory,
    isExpanded,
    reload,
  } = useVault(choosing, {
    beforeSwitch: leaveVault,
    // In the same event as the location: the tabs' paths mean this vault (R14-01).
    onSwitched: (next) => {
      loadVault(workspace, next.absolutePath);
      loadVaultAside(asideStore, next.absolutePath);
      // The peeked note is the last vault's; its edits were written as the switch began.
      closePeek(overlays);
    },
  });
  const vaultKey = location?.absolutePath ?? null;
  const tickMemory = useTickMemory(vaultKey);
  const [groupFolds] = useState(createBrowserGroupFoldStore);
  const [linkedRanges] = useState(createBrowserLinkedRangeStore);
  // One Activity log for the window; each use case records where it gives up (A28-01).
  const activityLog = useActivityLog({
    store: activityPorts.store,
    vaultKey,
    closing: closing.last,
  });
  // One feed for the window: every refresh of the index says here which notes changed (P28-03).
  const [noteChanges] = useState(() =>
    createNoteChanges({
      onError: (cause) => console.error('A note change could not be handled:', cause),
    }),
  );
  // Everything below writes through these, so a write that finishes after a
  // switch is refused instead of landing in the vault opened next.
  // What the app itself wrote, so the watcher's report of it is not refreshed for twice (#254).
  // The window's whole-vault reads, read again when what they are made from changes (#259).
  const queryClient = useQueryClient();
  const [reads] = useState(() => createReadInvalidator({ client: queryClient }));
  // The app's own writes also tell the reads of the folders they land in: the
  // watcher's echo of a template written here is left out.
  const [ownWrites] = useState(() =>
    tellingOwnWrites(createOwnWrites({ clock: localClock }), ({ vault, path }) =>
      reads.invalidate(vault, readsTouchedByPaths([path])),
    ),
  );
  const vault = useMemo(
    () => boundToVault(vaultPorts, vaultKey, ownWrites),
    [vaultPorts, vaultKey, ownWrites],
  );
  const notes = useMemo(
    () => boundToVault(notePorts, vaultKey, ownWrites),
    [notePorts, vaultKey, ownWrites],
  );
  // Opened once per vault: a new vault gets a new opening (#238). Each write
  // says which of the graph and the tags it changed, read again when the
  // index next has news for its readers (#259).
  const index = useMemo(() => {
    const bound = boundToVault(indexPorts, vaultKey, ownWrites);
    const opened = openOnce(bound.index);
    if (vaultKey === null) return { ...bound, index: opened };
    const report = (facets: Iterable<VaultRead>) => reads.invalidateWithIndex(vaultKey, facets);
    const stale = () => reads.waitingFor(vaultKey);
    return { ...bound, index: reportingIndexWrites({ index: opened, report, stale }) };
  }, [indexPorts, vaultKey, ownWrites, reads]);
  /** The note the person is working in, read as it is needed: the window is not drawn for a switch. */
  const focusedNote = useCallback(() => focusedNotePath(workspaceNow(workspace)), [workspace]);
  // What the query tab is writing, read by the chat for the window it opens on.
  const [queryText] = useState(createQueryTextStore);
  // What `[[` is making, shared by every pane, so two cannot make one name twice.
  const [notesBeingMade] = useState(createNotesBeingMade);
  /** The focused tab's query text while that tab shows the query page, else null. */
  const focusedQueryText = useCallback(() => {
    const tab = activeTabOf(workspaceNow(workspace));
    return tabPlace(tab)?.kind === 'query' ? (queryTextOf(queryText, tab.id) ?? '') : null;
  }, [workspace, queryText]);
  const {
    status: indexStatus,
    store: indexStore,
    progress: indexProgress,
    rebuild,
    refresh,
    catchUp: catchUpIndex,
    settled: indexSettled,
  } = useIndex({
    ports: index,
    vaultKey: location?.absolutePath ?? null,
    activity: activityLog,
    changes: noteChanges,
    ownWrites,
  });
  useVaultReads({ reads, changes: noteChanges, index: indexStore, vaultKey });
  const indexReady = useIndexReady(indexStore, vaultKey);
  const indexFailedWith = useIndexFailure(indexStore, vaultKey);

  // Anything that edits the vault from outside — Obsidian, a sync client — should
  // show up here without a restart. The echo of the app's own writes is left
  // out: the app refreshed when it wrote (#254). Quiet when every path left is
  // a note the index holds: it moves the index only when the refresh found
  // something. Anything else is not in the index, so only a loud refresh tells
  // its readers.
  useOutsideChanges({
    watch: vault.watch,
    vaultKey: location?.absolutePath ?? null,
    fs: vault.fs,
    ownWrites,
    settled: indexSettled,
    onChange: (paths) => {
      if (vaultKey !== null) reads.invalidate(vaultKey, readsTouchedByPaths(paths));
      void reload();
      void refresh(refreshAfterWatch(paths));
    },
  });
  // The window's readers of one kind of note read again for news of that kind alone (#325).
  const peopleKey = useScopedIndexKey({
    status: indexStore,
    vault: vaultKey,
    reader: ['people'],
    scope: PEOPLE_SCOPE,
  });
  const projectsKey = useScopedIndexKey({
    status: indexStore,
    vault: vaultKey,
    reader: ['projects'],
    scope: PROJECTS_SCOPE,
  });
  const personEmailsKey = useScopedIndexKey({
    status: indexStore,
    vault: vaultKey,
    reader: ['person-emails'],
    scope: PERSON_EMAILS_SCOPE,
  });
  const {
    types,
    failure: typesFailure,
    reload: reloadTypes,
  } = useTypes({
    fs: vault.fs,
    markdown: notes.markdown,
    vaultKey: location?.absolutePath ?? null,
  });

  /** Re-reads the tree and the index, after something wrote to the vault. */
  const onChanged = useCallback(() => {
    void reload();
    void refresh();
  }, [reload, refresh]);
  const typesChanged = useCallback(() => {
    onChanged();
    void reloadTypes();
  }, [onChanged, reloadTypes]);
  // PARA's types are written into a vault that lacks them as it opens (P30-01).
  const typesOffer = useBuiltInTypes({
    fs: vault.fs,
    markdown: notes.markdown,
    vaultKey,
    activity: activityLog,
    onChanged: typesChanged,
  });
  // Timeblocks are notes of the Block type, written once a vault's tasks follow GTD (P31-01).
  useBlockType({
    fs: vault.fs,
    markdown: notes.markdown,
    vaultKey,
    types,
    activity: activityLog,
    onChanged: typesChanged,
  });

  // Sync through GitHub (U-29) is run by `SyncRunner`, drawn below; it counts
  // an edit from the index's news of any note, heard without drawing (#326).
  const syncEdits = useScopedIndexNews({
    status: indexStore,
    vault: vaultKey,
    reader: 'sync',
    scope: SYNC_SCOPE,
  });
  const sync = useSyncForWindow(syncStore);
  // Granola's meetings (ADR-0034): on open once sync has pulled, every 15 minutes, and on Sync now.
  const granolaPull = useGranolaPull({
    granola: granolaPorts.port,
    records: granolaPorts.records,
    fs: vault.fs,
    markdown: notes.markdown,
    index: index.index,
    vaultKey,
    syncedThisSession: sync.syncedThisSession,
    syncPulls: sync.syncPulls,
    catchUpIndex,
    clock: localClock,
    activity: activityLog,
    onWrote: onChanged,
  });
  // Kindle's highlights into literature notes (#508): once the index is ready, every four hours, and on asking.
  const kindleOpenNotes = useMemo(() => openNotesIn(editors), [editors]);
  const kindleSync = useKindleSync({
    kindle: kindlePorts ?? NO_KINDLE,
    fs: vault.fs,
    markdown: notes.markdown,
    index: index.index,
    openNotes: kindleOpenNotes,
    rng: cryptoRng,
    clock: localClock,
    vaultKey,
    indexReady,
    onWrote: onChanged,
  });

  const thumbnails = useThumbnailQueue({ notes, snapshot, editors, types, onChanged });
  const thumbnailsNow = useThumbnailsNow(thumbnails);
  // One of each for the whole window: the panes and the API share the refresher,
  // so a source is never refreshed twice at once.
  const sourceRefresher = useMemo(
    () => createSourceRefresher({ activity: activityLog }),
    [activityLog],
  );
  // The tags page and the API rename tags through one queue per vault.
  const tagRenames = useMemo(() => createTagRenames(), []);
  const refreshSpacing = useMemo(() => createRefreshSpacing(), []);
  const apiHost = useApiHost({ vault: location, indexReady });
  // An archive from another tool moves notes; the panes follow through this,
  // pointed at `followEntryMove` below, so the API's deps stay put.
  const apiMoves = useMemo(() => createMoveRelay(), []);
  // What the automation runner, made further down, holds: read by the API's automations routes.
  const apiAutomations = useMemo(() => createAutomationRelay(), []);
  // Steady: the API's deps last the app's life, and read the index open now.
  const apiIndexRefresh = useSteadyCallback((recheck: readonly VaultPath[]) =>
    refresh({ recheck }),
  );
  // The owner's name is read further down, from the profile; a request asks for it when it arrives.
  const apiOwner = useMemo(() => createOwnerNameRelay(), []);
  const apiClaude = useMemo(() => createClaudeStepRelay(), []);
  const meetingDrafts = useMemo(() => createMeetingDrafts(), []);
  const apiDeps = useMemo<ApiRouterDeps>(
    () => ({
      host: apiHost,
      appInfo,
      clock: localClock,
      // Unbound: the router binds each request to the vault open as it arrives.
      fs: vaultPorts.fs,
      markdown: notePorts.markdown,
      index: indexPorts.index,
      openNotes: openNotesIn(editors),
      movingNotes: movingEditorsIn(editors, apiMoves.follow),
      indexRefresh: apiIndexRefresh,
      // The queue of the vault open as each request arrives.
      thumbnails: thumbnailsNow,
      // Feeds and SQLite files only: the API never reaches the secret store.
      sources: { http: sources.http, sqlite: sources.sqlite },
      imagePlacement: () => browserImagePlacementStore.read(),
      sourceRefresher,
      tagRenames,
      refreshSpacing,
      newUploadId: () => crypto.randomUUID(),
      rng: cryptoRng,
      automationClock: apiAutomations.clock,
      activity: activityLog,
      googleCalendar,
      timeZone: localTimeZone,
      ownerName: apiOwner.name,
      claudeStep: apiClaude.ports,
      meetingDrafts,
      // A draft that failed after the API answered is said in the window, where no caller is left.
      notices: { warn: (message) => toasts.show({ message, tone: 'error' }) },
    }),
    [
      apiHost,
      appInfo,
      vaultPorts.fs,
      notePorts.markdown,
      indexPorts.index,
      editors,
      apiMoves.follow,
      apiIndexRefresh,
      thumbnailsNow,
      sources.http,
      sources.sqlite,
      sourceRefresher,
      tagRenames,
      refreshSpacing,
      apiAutomations.clock,
      activityLog,
      googleCalendar,
      apiOwner.name,
      apiClaude.ports,
      meetingDrafts,
      toasts,
    ],
  );
  // A write from another tool shows up the way one made here does.
  useLocalApi({ bridge: api.bridge, deps: apiDeps, onWrote: onChanged });
  // A chat's drafting tools write through the API's routes in-process; the vault catches up as after any API write.
  const draftWrote = useSteadyCallback(() => onChanged());
  // One toolbox construction for the chat and for a rule's Claude step (P29-03).
  const toolboxes = useMemo(
    () =>
      createToolboxes({
        api: apiDeps,
        markdown: notePorts.markdown,
        newId: () => crypto.randomUUID(),
        onWrote: draftWrote,
      }),
    [apiDeps, notePorts.markdown, draftWrote],
  );

  useSqlViews({ index: index.index, types, ready: indexReady, status: indexStore });

  const paletteCommandsFor = useSteadyCallback((focused: NavigationPlace | null) => [
    ...PALETTE_COMMANDS,
    ...paletteArchiveCommands(focused?.kind === 'note' ? focused.path : null),
    // Offered wherever the host can export: the commands themselves are made further down.
    ...(exportPorts === undefined
      ? []
      : paletteExportCommands(focused?.kind === 'note' ? focused.path : null)),
    ...(kindlePorts === undefined || location === null
      ? []
      : paletteKindleCommands(kindleSync.view.connected)),
  ]);
  const paletteOffersFor = useCallback(
    (query: string) => [...paletteOffers(query), ...paletteEditTypeOffers(types, query)],
    [types],
  );
  // One overlay at a time; the rule is `openOverlay` and `closeOverlay`. The
  // search palette draws itself from the store, so ⌘K does not draw the window.
  const [overlays] = useState(createOverlayStore);
  const overlay = useWindowOverlay(overlays);
  const showOverlay = useCallback((requested: Overlay) => showIn(overlays, requested), [overlays]);
  const hideOverlay = useCallback((closing: Overlay) => hideIn(overlays, closing), [overlays]);
  // One object, so what is handed it is not made anew each time the window draws.
  const overlayPort = useMemo(
    () => ({ show: showOverlay, hide: hideOverlay }),
    [showOverlay, hideOverlay],
  );
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Capture asked for with no vault open: it has no Inbox to land in.
  const [captureWantedVault, setCaptureWantedVault] = useState(false);
  // Capture asked for — by ⇧⌘N, ⌥⌘N or the global shortcut: put up with a
  // vault open, and with none, said to need one rather than opened.
  const askForCapture = useCallback(() => {
    setCaptureWantedVault(location === null);
    if (location !== null) showOverlay('capture');
  }, [location, showOverlay]);
  const globalCapture = useGlobalCapture({ ...globalCapturePorts, pressed: askForCapture });
  const captureNeedsVault =
    captureWantedVault && location === null
      ? 'Quick capture needs a vault: open one, and what you capture lands in its Inbox.'
      : null;

  const [favoriteError, setFavoriteError] = useState<string | null>(null);

  const { catalog, sidebarTypes, quick } = useSidebarCatalog({
    fs: vault.fs,
    markdown: notes.markdown,
    index: index.index,
    types,
    notePaths,
    vaultKey: location?.absolutePath ?? null,
    indexReady,
  });

  // A page is a tab that reads its own hooks (tab-model.md, PR B). The window
  // keeps three things alive only while a page shows, and is drawn as each flips.
  const inboxShown = usePageShown(workspace, 'inbox');
  const activityShown = usePageShown(workspace, 'activity');
  const automationsShown = usePageShown(workspace, 'automations');
  /** Opens a page in the focused pane's active tab. */
  const openPage = useCallback(
    (place: PagePlace) => openPlace(workspace, place, 'here'),
    [workspace],
  );
  // Ask is asked for the keys only by ⌘J and the sidebar's Ask, in the pane they land in (#37).
  const [askFocus] = useState(createAskFocus);
  const openAsk = useCallback(() => {
    openPlace(workspace, ASK_PLACE, 'here');
    askFocus.request(workspaceNow(workspace).focused);
  }, [workspace, askFocus]);
  // The aside folds where the window is too narrow for it beside the left
  // sidebar (collapse.ts). Asking for it there — ⇧⌘J, the bar's button, ⌥⌘\ —
  // hides the left sidebar instead, where that makes room (not under 796px,
  // where the aside folds on its own: the sidebar then stays), so Claude is
  // reachable in a 1000px window; ⌘\ brings the sidebar back. The store is
  // told as the window folds it, so the toggle's pressed state, each note's
  // body and every ask read what is on screen, not what is remembered.
  const asideWidth = useAsideWidth({
    aside: asideStore,
    workspace,
    savedViews: catalog.savedViews,
    types,
  });
  const asideCollapsed = useAsideCollapsed({ sidebarOpen, asideWidth });
  useEffect(() => setAsideFolded(asideStore, asideCollapsed), [asideStore, asideCollapsed]);
  const roomForAside = useCallback((wanted: number) => {
    const width = window.innerWidth;
    const folds = (open: boolean) =>
      collapseFor({ width, sidebarOpen: open, asideWidth: wanted }).aside;
    if (folds(true) && !folds(false)) setSidebarOpen(false);
  }, []);
  // An ask opens the aside whatever the store holds: the window's answer to
  // the room just made arrives after this event, so `folded` still says folded.
  // Room is made for the width the ask will show: by default the width of the
  // tab the aside comes back on (340 for the type editor), else the one given.
  // Steady, so every page's toggle keeps one function for the window's life.
  const askForAside = useSteadyCallback(
    (show: (store: typeof asideStore) => void, width: number = asideWidth) => {
      roomForAside(width);
      show(asideStore);
    },
  );
  /** The Type tab chosen in the open aside: room is made for the 340px editor, as Edit type does. */
  const selectTypeTab = useCallback(
    () => askForAside((store) => selectAsideTab(store, 'type'), ASIDE_WIDTH_TYPE),
    [askForAside],
  );
  /**
   * A type's editor is the right sidebar's Type tab (slice 12): asked for,
   * the type is shown — its page, unless the focused tab already shows it or
   * one of its views — and the aside comes up on Type, room made for 340px.
   */
  const editType = useCallback(
    (name: string) => {
      const shown = typeShownAt(activePlace(workspaceNow(workspace)), catalog.savedViews);
      if (shown !== name) openPage({ kind: 'type', name });
      askForAside((store) => showAsideTab(store, 'type'), ASIDE_WIDTH_TYPE);
    },
    [workspace, catalog.savedViews, openPage, askForAside],
  );
  const openType = useCallback(
    (name: string, mode: 'notes' | 'edit' = 'notes') => {
      if (mode === 'edit') editType(name);
      else openPage({ kind: 'type', name });
    },
    [openPage, editType],
  );
  // What the pages hold in flight, per vault: shared by every tab on a page, kept across a switch and back.
  const [holdsByVault] = useState(createPageHoldsByVault);
  const openGraph = useCallback(
    (scope: GraphScope) => openPage({ kind: 'graph', scope }),
    [openPage],
  );
  const openQuery = useCallback(() => openPage({ kind: 'query' }), [openPage]);
  const openTags = useCallback((tag: string | null) => openPage({ kind: 'tags', tag }), [openPage]);
  const openArchive = useCallback(() => openPage({ kind: 'archive' }), [openPage]);
  const openInbox = useCallback(() => openPage({ kind: 'inbox' }), [openPage]);
  const activity = useActivity({
    log: activityLog,
    vaultKey,
    open: activityShown,
    seen: browserActivitySeenStore,
    clock: localClock,
  });
  const vaultGraph = useVaultGraph({ index: index.index, vaultKey, ready: indexReady });
  const vaultTags = useVaultTags({ index: index.index, vaultKey, ready: indexReady });
  const openTag = useCallback((name: string) => openTags(tagKey(name)), [openTags]);
  // Every relation is shown by the names in the same copy the graph reads.
  const names = useMemo(
    () => noteNames(vaultGraph.kind === 'ready' ? vaultGraph.graph.nodes : null),
    [vaultGraph],
  );

  const nameOfPlace = useCallback(
    (place: NavigationPlace) =>
      placeName(place, {
        titleOf: (path) =>
          (vaultGraph.kind === 'ready'
            ? vaultGraph.graph.nodes.find((node) => node.path === path)?.title
            : undefined) ?? noteTitle(path),
        typeLabelOf: (name) => types.find((type) => type.name === name)?.label ?? name,
        tagNameOf: (key) =>
          (vaultTags.state.kind === 'ready'
            ? vaultTags.state.counts.find((tag) => tag.key === key)?.name
            : undefined) ?? key,
      }),
    [vaultGraph, types, vaultTags.state],
  );
  // Steady, and the stores never change: the frames and strips read these and
  // are not drawn when the window is (tab-model.md §6).
  // Tabs remembered from the last launch may name notes deleted since: once
  // this vault's notes are listed, those tabs open on nothing (#346 attack).
  useEffect(() => {
    if (notesListedFor !== null && notesListedFor === vaultKey) keepNotes(workspace, notePaths);
  }, [workspace, notesListedFor, vaultKey, notePaths]);
  const nameOf = useSteadyCallback(nameOfPlace);
  const workspaceStores = useMemo<WorkspaceStores>(
    () => ({ store: workspace, reveals, overlays, nameOf, aside: asideStore, shown: shownNotes }),
    [workspace, reveals, overlays, nameOf, asideStore, shownNotes],
  );
  /** Opens a note from outside the panes — the sidebar, search, a new note — where the click asked. */
  const openNote = useCallback(
    (path: VaultPath, how: OpenHow = 'here') => openNotePlace(workspace, path, how),
    [workspace],
  );
  /** Opens a note at a block: a highlight's place, from All highlights or a search (#507). */
  const openBlock = useCallback(
    (path: VaultPath, block: string, how: OpenHow = 'here') =>
      openNoteAtBlock({ store: workspace, reveals }, { path, block, how }),
    [workspace, reveals],
  );

  const viewDrafts = useViewDrafts(vaultKey);
  // Every path a new view's name is checked against: the views folder's files, lifted views included.
  const viewPaths = catalog.takenViewPaths;

  const stranded = useStrandedEdits({
    store: browserStrandedStore,
    vaultKey: location?.absolutePath ?? null,
    now: Date.now,
  });
  // Comments typed in a literature note's highlights that it could not write as it closed (#534).
  const strandedComments = useStrandedComments({
    store: browserStrandedCommentStore,
    vaultKey: location?.absolutePath ?? null,
    now: Date.now,
  });

  const { onTypeSaved, newType, newNoteOfType } = useTypeCommands({
    ports: { fs: vault.fs, markdown: notes.markdown },
    types,
    notePaths,
    onChanged,
    reloadTypes,
    onTypeCreated: (created) => {
      hideOverlay('new-type');
      openType(created.name, 'edit');
    },
    onNoteCreated: openNote,
  });

  const newView = useNewView({
    fs: vault.fs,
    markdown: notes.markdown,
    types,
    viewPaths,
    activity: activityLog,
    onCreated: (path) => {
      hideOverlay('new-view');
      onChanged();
      openNote(path);
    },
  });
  const newArtifact = useNewArtifact({
    thumbnails,
    fs: vault.fs,
    markdown: notes.markdown,
    index: index.index,
    clock: localClock,
    indexKey: projectsKey,
    activity: activityLog,
    onCreated: (path) => {
      hideOverlay('new-artifact');
      onChanged();
      openNote(path);
    },
  });
  const { start: startArtifact } = newArtifact;
  const addPdf = useAddToLibrary({
    kind: 'pdf',
    fs: vault.fs,
    types,
    today: localToday,
    onAdded: ({ added, allAdded }) => {
      onChanged();
      if (!allAdded) return;
      hideOverlay('add-pdf');
      const [first] = added;
      if (first !== undefined) openNote(first.file);
    },
  });
  const addEpub = useAddToLibrary({
    kind: 'epub',
    fs: vault.fs,
    types,
    today: localToday,
    onAdded: ({ added, allAdded }) => {
      onChanged();
      if (!allAdded) return;
      hideOverlay('add-epub');
      const [first] = added;
      if (first !== undefined) openNote(first.file);
    },
  });
  const startNewArtifact = useCallback(
    (url = '') => {
      startArtifact(url);
      showOverlay('new-artifact');
    },
    [startArtifact, showOverlay],
  );

  const startNewView = useCallback(
    (type: string | null) => {
      newView.start(type);
      showOverlay('new-view');
    },
    [newView, showOverlay],
  );

  const profileSetting = useProfileSetting({
    fs: vault.fs,
    markdown: notes.markdown,
    vaultKey,
    activity: activityLog,
  });
  const selfEmailsSetting = useSelfEmailsSetting({
    fs: vault.fs,
    markdown: notes.markdown,
    index: index.index,
    vaultKey,
    changeKey: personEmailsKey,
    indexReady,
    activity: activityLog,
  });
  // What a rule's Claude step reaches (P29-03), with the owner's name as their profile holds it (P29-05)
  // and their addresses as the vault's settings hold them (#173).
  const ownerName = profileSetting.profile === 'unknown' ? null : profileSetting.profile.name;
  useEffect(() => apiOwner.point(ownerName), [apiOwner, ownerName]);
  const ownerEmails = selfEmailsSetting.emails;
  // Whether both were read, so nothing that asks who the owner is acts on a stand-in: an unreadable settings note is not known.
  const ownerKnown = vaultOwnerKnown(profileSetting, selfEmailsSetting);
  // Meanwhile the import and the automations are held: said on the Inbox and, once each way, in Activity.
  const settingsProblem = settingsUnreadable(profileSetting);
  useSettingsPause({ unreadable: settingsProblem, vaultKey, activity: activityLog });
  const claudeStep = useMemo(
    () =>
      claudeStepPorts({
        ports: chatPorts,
        store: browserChatSettingsStore,
        toolboxes,
        vault: () => vaultKey,
        selfName: () => ownerName,
        selfEmails: () => ownerEmails,
      }),
    [chatPorts, toolboxes, vaultKey, ownerName, ownerEmails],
  );
  // The assistant's propose-tasks route asks Claude as a rule's step does (P32-05).
  useEffect(() => apiClaude.point(claudeStep), [apiClaude, claudeStep]);
  // The chat's seat is the aside's Claude tab (plan question 4): ⇧⌘J brings
  // the aside up on it. Its toggle and close are one function each for the
  // window's life — every page's bar is handed the toggle (#325) — reading
  // the store at the press rather than closing over what was shown.
  const claudeShown = useClaudeShown(asideStore);
  const claudeAsked = useClaudeAsked(asideStore);
  const toggleChatSeat = useCallback(
    () =>
      claudeShownNow(asideStore.getState())
        ? hideAside(asideStore)
        : askForAside(toggleClaude, ASIDE_WIDTH),
    [asideStore, askForAside],
  );
  const closeChatSeat = useCallback(() => hideAside(asideStore), [asideStore]);
  const chatSeat = useMemo(
    () => ({ open: claudeShown, asked: claudeAsked, toggle: toggleChatSeat, close: closeChatSeat }),
    [claudeShown, claudeAsked, toggleChatSeat, closeChatSeat],
  );
  // Ask (#37) is the chat's other seat: whether Claude can be reached is asked while it shows too.
  const askShown = usePageShown(workspace, 'ask');
  const chat = useChat({
    ports: chatPorts,
    store: browserChatSettingsStore,
    seat: chatSeat,
    askShown,
    vault: {
      api: apiDeps,
      fs: location === null ? null : vault.fs,
      markdown: notes.markdown,
      openNotes: openNotesIn(editors),
      toolboxes,
      notePaths,
      vaultKey,
      onChanged,
    },
    // The focused tab's query, while it is on the query page; else the note it shows, or nothing.
    window: chatWindowOf({ query: focusedQueryText(), focused: focusedNote() }),
    clipboard: browserClipboard,
    settingsOpen: overlay === 'settings',
    activity: activityLog,
    profile: profileSetting.profile,
  });
  // The chat follows the note being worked in, and the query being written,
  // while it is open: a switch of note or a keystroke in the query draws the
  // window again then, and only then, since the chat's window is read from a
  // render. Shut, neither costs the window anything.
  const [, windowMoved] = useReducer((drawn: number) => drawn + 1, 0);
  useEffect(() => {
    if (!chat.open) return;
    const stopNotes = workspace.subscribe((state, before) => {
      const was = activeTabOf(before.workspace);
      const now = activeTabOf(state.workspace);
      if (
        was.id !== now.id ||
        tabPlace(was)?.kind !== tabPlace(now)?.kind ||
        focusedNotePath(state.workspace) !== focusedNotePath(before.workspace)
      ) {
        windowMoved();
      }
    });
    const stopQuery = queryText.subscribe(windowMoved);
    return () => {
      stopNotes();
      stopQuery();
    };
  }, [chat.open, workspace, queryText]);

  const favoritePaths = useMemo(
    () => new Set(catalog.favorites.map((entry) => entry.path)),
    [catalog],
  );

  /**
   * Stars a note, or unstars it, by writing the property into the file.
   *
   * A note open in a pane is written through that pane's own save: writing the
   * same file underneath it would move the file on while the editor still held
   * the modification time it read, and the next save would be refused.
   */
  const toggleFavorite = useCallback(
    (path: VaultPath) => {
      const value = favoriteValue(!favoritePaths.has(path));
      setFavoriteError(null);

      editors
        .setPropertiesIfOpen({ path, values: { [FAVORITE_KEY]: value } })
        .then((takenByAPane) => {
          if (takenByAPane) return;
          return setNoteProperty({
            fs: vault.fs,
            markdown: notes.markdown,
            path,
            key: FAVORITE_KEY,
            value,
            today: localToday(),
          }).then(() => reload());
        })
        .then(() => void refresh())
        .catch((cause: unknown) =>
          setFavoriteError(cause instanceof Error ? cause.message : String(cause)),
        );
    },
    [favoritePaths, editors, vault.fs, notes.markdown, reload, refresh],
  );

  const {
    templates,
    listed: templatesListed,
    contentsOf,
  } = useTemplates({
    fs: vault.fs,
    vaultKey: location?.absolutePath ?? null,
  });

  // Held from one render to the next: `createNoteIn` is built on it and is one
  // of the ports every vault use-case is handed. A new one each render gave
  // them all new ports each render, and whatever reads when its ports change
  // (the Inbox's proposals) then read the vault again, drew, and read again,
  // without end — which kept the window too busy to place a click (#140).
  const openCreated = useCallback(
    (path: VaultPath) => {
      void reload();
      // Made over the peek — a capture, a related note from its strip — it is not
      // opened in the page hidden under the peek, which nobody would see move.
      if (peekNow(overlays) === null) openNote(path);
      void refresh();
    },
    [reload, openNote, refresh, overlays],
  );
  const {
    createNewNote,
    createNoteIn,
    createFromTemplate,
    captureNote,
    openDailyNote: openOrMakeDailyNote,
    error: createError,
  } = useCreateNote({
    fs: vault.fs,
    markdown: notes.markdown,
    notePaths,
    beside: focusedNote,
    templates,
    contentsOf,
    onCreated: openCreated,
  });

  // A note or folder moved in the app takes with it the panes showing it, the
  // unsaved edits of a view under it, and what its ticks remembered.
  const followEntryMove = useCallback(
    (move: EntryMove) => {
      followMoveIn(workspace, move);
      followPeekMove(overlays, move);
      viewDrafts.follow(move);
      tickMemory.follow(move);
    },
    [workspace, overlays, viewDrafts, tickMemory],
  );
  useEffect(() => apiMoves.point(followEntryMove), [apiMoves, followEntryMove]);

  // A deleted note takes with it the panes showing it and, for a view, its
  // unsaved edits — or a new view made under its name would wear them.
  const closeDeleted = useCallback(
    (gone: readonly VaultPath[]) => {
      closeNotesIn(workspace, gone);
      forgetPeeked(overlays, gone);
      viewDrafts.forget(gone);
    },
    [workspace, overlays, viewDrafts],
  );

  const entryPorts = useMemo<VaultEntryPorts>(
    () => ({
      fs: vault.fs,
      index: index.index,
      editors: movingEditorsIn(editors, followEntryMove),
      tree: { reload, expandDirectory, forgetDirectory, isExpanded },
      closeNotes: closeDeleted,
      refresh: () => void refresh(),
      createNoteIn,
      overlay: { show: showOverlay, hide: hideOverlay },
    }),
    [
      vault.fs,
      index.index,
      editors,
      followEntryMove,
      reload,
      expandDirectory,
      forgetDirectory,
      isExpanded,
      closeDeleted,
      refresh,
      createNoteIn,
      showOverlay,
      hideOverlay,
    ],
  );
  const entries = useVaultEntries(entryPorts, notePaths);
  const peopleMerge = usePeopleMerge({
    ports: {
      fs: vault.fs,
      index: index.index,
      markdown: notes.markdown,
      editors: entryPorts.editors,
      refreshIndex: async (saved) => {
        if (!(await refresh({ recheck: saved }))) throw new Error(INDEX_BEHIND_FOR_MERGE);
      },
    },
    settings: vaultSettingsWriter({ fs: vault.fs, markdown: notes.markdown }),
    notePaths,
    overlay: { show: showOverlay, hide: hideOverlay },
    toasts,
    activity: activityLog,
    onChanged: () => void refresh(),
    closeNotes: closeDeleted,
    openActivity: () => openPage({ kind: 'activity' }),
  });
  const exporting = useExport({
    ports: {
      fs: vault.fs,
      index: index.index,
      markdown: notes.markdown,
      clock: localClock,
      google: googleCalendar,
      // Nothing is exported without the host's ports: `exportCommands` is not handed out then.
      files: exportPorts?.files ?? NO_EXPORT_FILES,
      pdf: exportPorts?.pdf ?? NO_PDF,
      drive: exportPorts?.drive ?? NO_DRIVE,
      renderer: exportPorts?.renderer ?? NO_RENDERER,
      wait: waitOnTimer,
    },
    vault: vaultKey,
    appName: app.kind === 'ready' ? app.info.name : '',
    notePaths,
    overlay: { show: showOverlay, hide: hideOverlay },
    toasts,
    activity: activityLog,
    openActivity: () => openPage({ kind: 'activity' }),
    openLink: (url) => {
      links
        .open(url)
        .catch((cause: unknown) => console.error('The Google Doc could not be opened:', cause));
    },
  });
  const exportCommands = exportPorts === undefined ? null : exporting.commands;
  // Each one function for as long as the entries' ports: the panes are handed them (#325).
  const { rename: renameEntry, askMove: askEntryMove, askDelete: askEntryDelete } = entries;
  const templatesPage = useTemplatesPage({
    ports: {
      fs: vault.fs,
      markdown: notes.markdown,
      editors: entryPorts.editors,
      closeNotes: entryPorts.closeNotes,
      overlay: overlayPort,
    },
    types,
    listed: templatesListed,
    onChanged,
    onOpen: openNote,
  });
  const { editTypeTemplate, askDelete: askDeleteTemplate, askMoveToNotes } = templatesPage;
  const onRenameTemplate = templatesPage.page.onRename;
  const templateCommands = useMemo(
    () => ({
      onOpenTemplates: () => openPage({ kind: 'templates' }),
      rename: onRenameTemplate,
      askDelete: askDeleteTemplate,
      askMoveToNotes,
    }),
    [openPage, onRenameTemplate, askDeleteTemplate, askMoveToNotes],
  );
  const [typeTabStore] = useState(createBrowserTypeTabStore);
  const typeViews = useTypeViews({
    ports: { fs: vault.fs, markdown: notes.markdown, editors },
    types,
    savedViews: catalog.savedViews,
    viewPaths,
    vaultKey,
    store: typeTabStore,
    onChanged,
    onOpenType: openType,
    onEditTemplate: editTypeTemplate,
    askDelete: entries.askDelete,
  });
  const { landing: typeLanding, remember: rememberTypeTab } = typeViews;
  /** A type in the sidebar opens on its views — the last one open, else the first — or its table. */
  const openTypePage = useCallback(
    (name: string) => {
      const view = typeLanding(name);
      if (view === null) openType(name, 'notes');
      else openNote(view);
    },
    [typeLanding, openType, openNote],
  );
  // Whichever of a type's views the person is in is the one its type opens on next.
  useEffect(
    () =>
      workspace.subscribe((state) => {
        const path = focusedNotePath(state.workspace);
        if (path !== null) rememberTypeTab(path);
      }),
    [workspace, rememberTypeTab],
  );

  const archivePorts = useMemo(
    () => ({ ...entryPorts, markdown: notes.markdown }),
    [entryPorts, notes.markdown],
  );
  /** Re-reads the tree and the index after a write; settles once the index holds it. */
  const settleArchive = useCallback(() => {
    const refreshed = refresh();
    void reload();
    return refreshed;
  }, [refresh, reload]);
  const archive = useArchive({
    ports: archivePorts,
    clock: localClock,
    notePaths,
    onSettled: settleArchive,
    offerLinks: entries.offerLinks,
  });
  const archiveCommands = archive.commands;
  // Moving the tasks to GTD's statuses, previewed from the Inbox page (P30-02).
  const taskMigration = useTaskMigration({
    ports: archivePorts,
    vaultKey,
    indexReady,
    open: inboxShown,
    activity: activityLog,
    onChanged: typesChanged,
  });
  // Moving Area and Resource notes onto the one Project type, previewed from the Inbox page (#213).
  const paraMigration = useParaMigration({
    ports: archivePorts,
    vaultKey,
    indexReady,
    open: inboxShown,
    activity: activityLog,
    onChanged: typesChanged,
  });
  // Moving loose notes and old meetings to their home folders, once, previewed there too (#214).
  const vaultTidy = useVaultTidy({
    ports: archivePorts,
    vaultKey,
    indexReady,
    open: inboxShown,
    activity: activityLog,
    onChanged: settleArchive,
  });
  // The tasks meetings made that today's rules would not have, offered to archive there too (#226).
  const cleanupPorts = useMemo(
    () => ({ ...archivePorts, index: index.index }),
    [archivePorts, index.index],
  );
  const cleanupOwner = useMemo(
    () => (ownerKnown ? { selfName: ownerName, selfEmails: ownerEmails } : null),
    [ownerKnown, ownerName, ownerEmails],
  );
  const ownerNeeded = useOwnerNeeded(automationsStore, cleanupOwner);
  const meetingCleanup = useMeetingCleanup({
    ports: cleanupPorts,
    owner: cleanupOwner,
    vaultKey,
    indexReady,
    open: inboxShown,
    activity: activityLog,
    onChanged: settleArchive,
    onOpenTask: (path) => openNote(createVaultPath(path)),
  });
  // Filing the meetings with no project as their series is, previewed there too (#227).
  const meetingProjects = useMeetingProjects({
    ports: archivePorts,
    vaultKey,
    indexReady,
    open: inboxShown,
    owner: { selfName: ownerName, selfEmails: ownerEmails },
    activity: activityLog,
    onChanged: settleArchive,
  });
  // The Today page and the weekly review show in the sidebar once the vault has tasks.
  const tasksShown = taskTypeOf(types) !== null;
  const todayView = quick.find((view) => view.id === 'today')?.entry ?? null;
  const inboxView = quick.find((view) => view.id === 'inbox')?.entry ?? null;
  // One Inbox: its count is what waits to be filed and the proposals waiting
  // for an answer, read by the window whatever tab the page is in.
  const waiting = useInboxWaiting({
    index: index.index,
    fs: vault.fs,
    markdown: notes.markdown,
    vaultKey,
    indexReady,
    types,
  });
  // As with Today, no row that opens nothing: the Inbox shows once the vault
  // has an Inbox view or something waits in it.
  const inboxRowShown = inboxView !== null || (waiting ?? 0) > 0;
  const automationPorts = useMemo(
    () => ({ ...archivePorts, types, notePaths, claude: claudeStep }),
    [archivePorts, types, notePaths, claudeStep],
  );
  // The automations, and the meeting import, are run by their runners, drawn below (#326).
  const treeMenuFor = useCallback(
    (entry: VaultEntry) =>
      withCommandBeforeDelete(
        entries.menuFor(entry),
        archiveCommand({ entry, notePaths, commands: archiveCommands }),
      ),
    [entries, notePaths, archiveCommands],
  );

  /** Renames a note from its page head; every pane showing it follows. */
  const renamePaneNote = useCallback(
    ({ path, name }: { path: VaultPath; name: string }) =>
      renameEntry({ path, kind: 'file' }, name),
    [renameEntry],
  );

  const captureTemplate = useMemo(() => findTaskTemplate(templates), [templates]);

  const quickAddSetting = useQuickAddSetting({
    fs: vault.fs,
    markdown: notes.markdown,
    vaultKey,
    activity: activityLog,
  });
  const sidebarOrder = useSidebarOrder({
    fs: vault.fs,
    markdown: notes.markdown,
    vaultKey,
    activity: activityLog,
  });
  // Heard, not drawn: listed again for news of any note while Settings is open.
  const secretsNews = useScopedIndexNews({
    status: indexStore,
    vault: vaultKey,
    reader: 'secrets',
    scope: SECRETS_SCOPE,
  });
  const secrets = useSecrets({
    store: sources.secrets,
    fs: vault.fs,
    markdown: notes.markdown,
    index: index.index,
    vault: vaultKey,
    edits: secretsNews,
    active: overlay === 'settings',
  });
  const googleCalendarSetting = useGoogleCalendar({
    port: googleCalendar,
    fs: vault.fs,
    markdown: notes.markdown,
    vault: vaultKey,
    active: overlay === 'settings',
    activity: activityLog,
  });
  const granolaSetting = useGranola({
    port: granolaPorts.port,
    pull: granolaPull,
    vault: vaultKey,
    links,
    fs: vault.fs,
    markdown: notes.markdown,
  });
  const captureTask = useCallback(
    async (name: string) => {
      const path = await captureNote(name, captureTemplate);
      // Over the peek, a capture lands without moving the page hidden under it.
      if (path !== null && peekNow(overlays) === null) openNote(path);
    },
    [captureNote, captureTemplate, openNote, overlays],
  );

  /** Today's note, made on demand — where and from what is `ensureDailyNote`'s to say. */
  const openDailyNote = useCallback(async () => {
    const path = await openOrMakeDailyNote(localToday());
    if (path !== null) openNote(path);
  }, [openOrMakeDailyNote, openNote]);

  const [linkError, setLinkError] = useState<string | null>(null);

  const peoplePorts = useMemo(
    () => ({ fs: vault.fs, markdown: notes.markdown, index: index.index }),
    [vault.fs, notes.markdown, index.index],
  );
  const vaultPeople = usePeople({
    ports: peoplePorts,
    indexKey: peopleKey,
    ready: indexReady,
    notePaths,
    types,
    templates,
    onCreated: onChanged,
  });

  // Archived notes are not offered for `[[`; a link to one still opens it.
  const notesInUse = useMemo(() => activeNotePaths(notePaths), [notePaths]);
  const suggestNotes = useCallback(
    (query: string) => rankNoteSuggestions(query, notesInUse, { linkable: notePaths }),
    [notesInUse, notePaths],
  );

  const linkPlaces = useMemo(
    () => linkPlacesOf({ fs: notes.fs, markdown: notes.markdown }),
    [notes],
  );
  /** Follows a wiki link in the pane it was clicked in — a link opens where you are reading. */
  const followLinkInPane = useCallback(
    (link: { pane: number; target: string; heading?: string | null; how?: OpenHow }) =>
      followLink(
        { store: workspace, reveals, notePaths, onProblem: setLinkError, places: linkPlaces },
        link,
      ),
    [workspace, reveals, notePaths, linkPlaces],
  );
  /**
   * Opens the line a proposal or an answer cites — `[[2026-10-01 Standup#^t0003]]` —
   * in the focused pane, or where the click asked (⌘-click: a new tab).
   */
  const followSource = useCallback(
    (link: string, how: OpenHow = 'here') => {
      const read = readWikiLink(link.trim());
      if (read === null) {
        setLinkError(`${link} is not a link to a note`);
        return;
      }
      followLinkInPane({
        pane: workspaceNow(workspace).focused,
        target: read.target,
        heading: read.heading,
        how,
      });
    },
    [followLinkInPane, workspace],
  );
  /** A web address an answer gives, opened in the browser: the window never navigates. */
  const openWebLink = useCallback(
    (url: string) => {
      links.open(url).catch((cause: unknown) => {
        setLinkError(`${url} could not be opened: ${String(cause)}`);
      });
    },
    [links],
  );

  const paneOpenNotes = useMemo(() => openNotesIn(editors), [editors]);
  const paneContext: PaneContext = useMemo(
    () => ({
      vault: vaultKey,
      notes,
      index: index.index,
      sources,
      sourceRefresher,
      links,
      newArtifact: startNewArtifact,
      thumbnails,
      types,
      notePaths,
      indexStatus: indexStore,
      onChanged,
      changes: noteChanges,
      onTypeSaved,
      suggestNotes,
      suggestTags: vaultTags.suggest,
      people: vaultPeople.people,
      openTag,
      editors,
      stranded,
      strandedComments,
      activity: activityLog,
      toasts,
      savedViews: catalog.savedViews,
      typeTabs: typeViews.editingFor,
      queryViews: catalog.queryViews,
      dashboards: catalog.dashboards,
      tickMemory,
      groupFolds,
      linkedRanges,
      graph: vaultGraph.kind === 'ready' ? vaultGraph.graph : null,
      openNotes: paneOpenNotes,
      viewPaths,
      viewDrafts,
      archive: archiveCommands,
      peopleMerge: peopleMerge.commands,
      exporting: exportCommands,
      onLinkProblem: setLinkError,
      linkPlaces,
      notesBeingMade,
      templateCommands,
    }),
    [
      vaultKey,
      notes,
      index.index,
      sources,
      sourceRefresher,
      links,
      startNewArtifact,
      thumbnails,
      types,
      notePaths,
      indexStore,
      onChanged,
      noteChanges,
      onTypeSaved,
      suggestNotes,
      vaultTags.suggest,
      vaultPeople.people,
      openTag,
      editors,
      stranded,
      strandedComments,
      activityLog,
      toasts,
      catalog.savedViews,
      typeViews.editingFor,
      catalog.queryViews,
      catalog.dashboards,
      tickMemory,
      groupFolds,
      linkedRanges,
      vaultGraph,
      paneOpenNotes,
      viewPaths,
      viewDrafts,
      archiveCommands,
      peopleMerge,
      exportCommands,
      templateCommands,
      notesBeingMade,
      linkPlaces,
    ],
  );

  useEffect(() => {
    let cancelled = false;
    getAppInfo({ appInfo })
      .then((info) => {
        if (!cancelled) setApp({ kind: 'ready', info });
      })
      .catch((cause: unknown) => {
        if (!cancelled) setApp({ kind: 'failed', message: String(cause) });
      });
    return () => {
      cancelled = true;
    };
  }, [appInfo]);

  useAppShortcuts({
    // Read at the key press: the window is not drawn again as ⌘K or the peek opens.
    layers: () => overlays.getState(),
    // The editors are registered under their tabs: the peek's, else the focused pane's shown one saves.
    save: () =>
      editors.savePane(
        peekNow(overlays) === null ? activeTabOf(workspaceNow(workspace)).id : PEEK_EDITOR,
      ),
    newNote: () => void createNewNote(),
    toggleSidebar: () => setSidebarOpen((was) => !was),
    toggleSplit: () => toggleSplitIn(workspace),
    dailyNote: () => void openDailyNote(),
    back: () => goBack(workspace),
    forward: () => goForward(workspace),
    show: showOverlay,
    capture: askForCapture,
    ask: () => {
      if (toggleAsk(workspace)) askFocus.request(workspaceNow(workspace).focused);
    },
    toggleChat: chat.toggle,
    toggleAside: () =>
      asideShownNow(asideStore.getState()) ? hideAside(asideStore) : askForAside(toggleAsideIn),
    tabs: {
      newTab: () => newTabIn(workspace, workspaceNow(workspace).focused),
      closeTab: () => closeActiveTab(workspace),
      nextTab: () => nextTab(workspace),
      previousTab: () => previousTab(workspace),
      nthTab: (n) => activateNthTab(workspace, n),
      reopenClosedTab: () => reopenClosedTab(workspace),
    },
  });

  const treeRows = useMemo(() => sidebarTreeRows(rows), [rows]);
  const toggleSidebar = useCallback(() => setSidebarOpen((was) => !was), []);
  const asideShown = useAsideShown(asideStore);
  const toggleAsideSeat = useCallback(
    () =>
      asideShownNow(asideStore.getState()) ? hideAside(asideStore) : askForAside(toggleAsideIn),
    [asideStore, askForAside],
  );
  const asideToggle = useMemo(
    () => ({ shown: asideShown, onToggle: toggleAsideSeat }),
    [asideShown, toggleAsideSeat],
  );
  const rowPorts = useMemo(() => ({ pane: paneContext, openNote }), [paneContext, openNote]);
  const typeAside = useMemo(
    () => ({
      onDelete: (path: VaultPath) => entries.askDelete({ path, kind: 'file' }),
      onEditTemplate: editTypeTemplate,
      onOpenType: (name: string) => openType(name),
    }),
    [entries, editTypeTemplate, openType],
  );

  // Steady, so the sync light is drawn for its own news and not with the window (#326).
  const openSyncSettings = useCallback(() => showOverlay('settings'), [showOverlay]);
  const fromGitHub = useOpenFromGitHub({
    folders: syncPorts.folders,
    store: choosing.store,
    openVault: vaultKey,
    beforeSwitch: leaveVault,
    showVault,
    onDone: () => hideOverlay('open-from-github'),
  });

  const noticeMessages = [
    error,
    typesFailure,
    linkError,
    vaultPeople.error,
    createError,
    entries.notice,
    archive.notice,
    favoriteError,
    typeViews.error,
    newNoteOfType.error,
    templatesPage.notice,
    sidebarOrder.unreadable,
  ];
  const indexFailure = location !== null ? indexFailedWith : null;
  const sidebarOrderFailure =
    sidebarOrder.problem === null
      ? null
      : `The sidebar's order could not be saved: ${sidebarOrder.problem}`;
  // A red notice is where a use case gave up, so it is kept in the Activity log
  // once each time it appears. The index's failure is not: syncIndex records
  // it. Nor is the sidebar's order, whose setting records it. Nor is the offer
  // to update links, which is a question, not a failure; edits kept for later
  // are a warning.
  useNoticeActivity(
    { errors: noticeMessages, warnings: [stranded.notice, strandedComments.notice] },
    activityLog,
  );
  const notices = (
    <AppNotices
      messages={[
        ...noticeMessages,
        sidebarOrderFailure,
        indexFailure,
        captureNeedsVault,
        sync.conflict,
      ]}
      links={entries.links}
      stranded={stranded}
      keptComments={strandedComments}
    />
  );
  /** Writes what was typed in the peek, closes it, then runs `act`; at once with no peek up. */
  const leavingPeekFor = (act: () => void) =>
    leavePeek(overlays, {
      flush: () => {
        const peek = peekNow(overlays);
        return peek === null ? Promise.resolve() : editors.flushHolding([peek.path]);
      },
      act,
    });
  const runPlaceCommand = (id: string, pasted: string) => {
    if (
      runPaletteEditTypeCommand(id, {
        editType: (name) => openType(name, 'edit'),
        editTemplate: editTypeTemplate,
      })
    ) {
      return;
    }
    if (id === OPEN_TEMPLATES) openPage({ kind: 'templates' });
    else if (id === OPEN_TERMS) openPage({ kind: 'terms' });
    else if (id === OPEN_LIBRARY) openPage({ kind: 'library' });
    else if (id === OPEN_HIGHLIGHTS) openPage({ kind: 'highlights' });
    else if (id === ADD_PDF) {
      addPdf.reset();
      showOverlay('add-pdf');
    } else if (id === ADD_EPUB) {
      addEpub.reset();
      showOverlay('add-epub');
    } else if (id === FIND_DUPLICATE_PEOPLE) peopleMerge.commands.findDuplicates();
    else if (id === MERGE_SELECTED_PEOPLE)
      peopleMerge.commands.mergeChosen(activeTabOf(workspaceNow(workspace))?.id ?? '');
    else if (id === OPEN_INBOX) openInbox();
    else if (id === OPEN_REVIEW) openPage({ kind: 'review' });
    else if (id === OPEN_TODAY) openPage({ kind: 'today' });
    else if (id === 'new-query') openQuery();
    else if (id === 'new-artifact') startNewArtifact();
    else if (id === SAVE_ARTIFACT_LINK) startNewArtifact(pasted);
    else startNewView(null);
  };
  // Steady, so the palette is not drawn again with the window while it is shut (#261).
  const runPaletteCommand = useSteadyCallback((id: string, query: string) => {
    const pasted = claudeArtifactUrl(query) ?? '';
    if (
      runPaletteArchiveCommand(id, {
        // "This note" is the one on screen: the peeked one while the peek is up.
        focused: peekNow(overlays)?.path ?? focusedNote(),
        commands: archiveCommands,
        openArchive: () => leavingPeekFor(openArchive),
      })
    ) {
      return;
    }
    if (
      exportCommands !== null &&
      runPaletteExportCommand(id, {
        focused: peekNow(overlays)?.path ?? focusedNote(),
        commands: exportCommands,
      })
    ) {
      return;
    }
    if (runPaletteKindleCommand(id, kindleSync)) return;
    // A command that goes somewhere leaves the peek first, so where it went is on screen.
    leavingPeekFor(() => runPlaceCommand(id, pasted));
  });
  // Picked over the peek, a result shows in it, in place of its note (Q6).
  const openPaletteHit = useSteadyCallback((path: string, block?: string) => {
    // A highlight opens its note's page at its block, as a link to a block does: out of the peek.
    if (block !== undefined) leavingPeekFor(() => openBlock(createVaultPath(path), block));
    else if (peekNow(overlays) === null) openNote(createVaultPath(path));
    else replacePeek(overlays, createVaultPath(path));
  });

  const kindleShown = kindleSync.toastShown;
  const kindleToast = kindleSync.toast !== null && (
    <Toast
      key={`kindle-${kindleShown}`}
      message={kindleSync.toast}
      onDismiss={() => kindleSync.dismissToast(kindleShown)}
    />
  );
  const granolaShown = granolaPull.toastShown;
  const granolaToast = granolaPull.toast !== null && (
    <Toast
      key={granolaShown}
      message={granolaPull.toast}
      onDismiss={() => granolaPull.dismissToast(granolaShown)}
    />
  );
  // One child, `false` with no toast up, so the toast host is not drawn again with the window.
  const connectionToasts = (granolaToast !== false || kindleToast !== false) && (
    <>
      {granolaToast}
      {kindleToast}
    </>
  );

  // The panes' wiring that changes only with what it holds, so a window
  // redrawn for the index's news draws no pane that shows nothing new (#325).
  const noteCommands = useMemo(
    () => ({
      onRename: renamePaneNote,
      onToggleFavorite: toggleFavorite,
      onMoveTo: (target: VaultPath) => askEntryMove({ path: target, kind: 'file' }),
      onDelete: (target: VaultPath) => askEntryDelete({ path: target, kind: 'file' }),
      onMergeInto: peopleMerge.commands.mergeInto,
      onShowInGraph: (target: VaultPath) => openGraph({ kind: 'note', path: target, depth: 1 }),
    }),
    [renamePaneNote, toggleFavorite, askEntryMove, askEntryDelete, peopleMerge, openGraph],
  );
  const todayWiring = useMemo(
    () => ({
      view:
        todayView === null
          ? null
          : { title: todayView.title, onOpen: () => openNote(todayView.path) },
      onOpenDailyNote: () => void openDailyNote(),
    }),
    [todayView, openNote, openDailyNote],
  );
  const chatToggle = useMemo(
    () => (location === null ? null : { open: chat.open, onToggle: chat.toggle }),
    [location, chat.open, chat.toggle],
  );
  // Ask's tab reads the chat through its own context (#37), drawn again with each streamed word.
  const followInFocusedPane = useCallback(
    (target: string) => followLinkInPane({ pane: workspaceNow(workspace).focused, target }),
    [followLinkInPane, workspace],
  );
  const askSeat = useMemo<AskSeat>(
    () => ({
      chat,
      onFollowCitation: followSource,
      onOpenWeb: openWebLink,
      onFollowLink: followInFocusedPane,
      focus: askFocus,
    }),
    [chat, followSource, openWebLink, followInFocusedPane, askFocus],
  );
  const inboxWiring = useMemo(
    () => ({
      closing: closing.writes,
      pendingWrites,
      onOpenSource: followSource,
      typesOffer:
        typesOffer === null
          ? null
          : {
              reading: typesOffer.reading,
              lines: typesOffer.lines,
              onAccept: () => void typesOffer.accept(),
              onDismiss: typesOffer.dismiss,
            },
      taskMigration,
      paraMigration,
      vaultTidy,
      meetingCleanup,
      settingsUnreadable:
        settingsProblem === null
          ? null
          : {
              problem: settingsProblem,
              onOpenSettings: () => showOverlay('settings'),
            },
      ownerUnknown: ownerNeeded ? { onOpenSettings: () => showOverlay('settings') } : null,
      meetingProjects,
      view:
        inboxView === null
          ? null
          : { title: inboxView.title, onOpen: () => openNote(inboxView.path) },
    }),
    [
      closing.writes,
      pendingWrites,
      followSource,
      typesOffer,
      taskMigration,
      paraMigration,
      vaultTidy,
      meetingCleanup,
      settingsProblem,
      ownerNeeded,
      meetingProjects,
      inboxView,
      openNote,
      showOverlay,
    ],
  );
  const shell = (
    <NoteNamesProvider value={names}>
      <ChatToggleProvider value={chatToggle}>
        <SyncRunner
          store={syncStore}
          host={syncPorts}
          fs={vault.fs}
          markdown={notes.markdown}
          vaultKey={vaultKey}
          edits={syncEdits}
          clock={localClock}
          activity={activityLog}
          flushAll={flushAllWithin}
          closing={closing.first}
          onPulled={onChanged}
        />
        <AutomationsRunner
          store={automationsStore}
          status={indexStore}
          relay={apiAutomations}
          ports={automationPorts}
          clock={localClock}
          vaultKey={vaultKey}
          indexReady={indexReady}
          activity={activityLog}
          onSettled={settleArchive}
          live={automationsShown}
          sync={syncStore}
          ownerKnown={ownerKnown}
          // A rule a note sets off hears of it here (P29-01).
          changes={noteChanges}
        />
        {/* Meetings that n8n commits arrive by pull: each is checked, deduplicated and marked (P28-04). */}
        <MeetingImportRunner
          sync={syncStore}
          changes={noteChanges}
          ports={archivePorts}
          clock={localClock}
          activity={activityLog}
          vaultKey={vaultKey}
          indexReady={indexReady}
          selfName={ownerName}
          selfEmails={ownerEmails}
          ownerKnown={ownerKnown}
          onWritten={settleArchive}
        />
        <AppShell
          sidebarOpen={sidebarOpen}
          asideOpen={asideShown}
          // Every page carries its own way back in its bar; only the empty
          // state, which has no page, needs the shell's.
          {...(location === null && { onShowSidebar: toggleSidebar })}
          sidebar={
            <>
              {location !== null && (
                <>
                  <VaultHeader
                    vaultName={location.name}
                    vaultInitial={vaultInitial(location.name)}
                    templates={templates}
                    onChooseVault={chooseVault}
                    onOpenFromGitHub={() => showOverlay('open-from-github')}
                    onNewNote={() => void createNewNote()}
                    onNewFromTemplate={(path) => void createFromTemplate(path)}
                    onDailyNote={() => void openDailyNote()}
                    onNewArtifact={() => startNewArtifact()}
                    onHideSidebar={toggleSidebar}
                    menuOpen={overlay === 'new-note-menu'}
                    onMenuOpenChange={(open) =>
                      open ? showOverlay('new-note-menu') : hideOverlay('new-note-menu')
                    }
                  />
                  <ActiveSidebar
                    store={workspace}
                    viewOwner={typeViews.ownerOf}
                    favorites={catalog.favorites}
                    types={sidebarTypes}
                    views={catalog.views}
                    dashboards={catalog.dashboards}
                    quick={quick}
                    tree={{
                      rows: treeRows,
                      onToggleDirectory: toggleDirectory,
                      onOpenArchive: openArchive,
                      editing: {
                        menuFor: treeMenuFor,
                        menuOpen: overlay === 'tree-menu',
                        onMenuOpenChange: (open) =>
                          open ? showOverlay('tree-menu') : hideOverlay('tree-menu'),
                        renaming: entries.renaming,
                        onRename: ({ entry, name }) => entries.rename(entry, name),
                        onCancelRename: entries.cancelRename,
                        canDrop: ({ entry, folder }) => moveRefusal(entry, folder) === null,
                        onDrop: ({ entry, folder }) => entries.moveInto(entry, folder),
                      },
                      create: {
                        label: 'New in Pages',
                        items: [
                          {
                            label: 'New note',
                            onSelect: () => entries.newNoteIn(VAULT_ROOT),
                            movesFocus: true,
                          },
                          {
                            label: 'New folder',
                            onSelect: () => entries.newFolderIn(VAULT_ROOT),
                            movesFocus: true,
                          },
                        ],
                        open: overlay === 'pages-menu',
                        onOpenChange: (open) =>
                          open ? showOverlay('pages-menu') : hideOverlay('pages-menu'),
                      },
                    }}
                    sectionStore={browserSectionStore}
                    sectionOrder={sidebarOrder.order}
                    onSearch={() => showOverlay('search')}
                    onOpenGraph={() => openGraph({ kind: 'vault' })}
                    onOpenTags={() => openTags(null)}
                    onOpenAsk={openAsk}
                    onOpenLibrary={() => openPage({ kind: 'library' })}
                    onOpenHighlights={() => openPage({ kind: 'highlights' })}
                    onOpenAutomations={() => openPage({ kind: 'automations' })}
                    activity={{
                      onOpen: () => openPage({ kind: 'activity' }),
                      unseenErrors: activity.unseenErrors,
                    }}
                    onOpen={openNote}
                    onOpenTemplates={() => openPage({ kind: 'templates' })}
                    onOpenTerms={() => openPage({ kind: 'terms' })}
                    {...(inboxRowShown && { inbox: { onOpen: openInbox, count: waiting } })}
                    {...(tasksShown && { onOpenReview: () => openPage({ kind: 'review' }) })}
                    {...(tasksShown && { onOpenToday: () => openPage({ kind: 'today' }) })}
                    onOpenType={openTypePage}
                    onEditType={(name) => openType(name, 'edit')}
                    onEditTemplate={editTypeTemplate}
                    onNewType={() => {
                      newType.reset();
                      showOverlay('new-type');
                    }}
                    viewsCreate={{
                      label: 'New in Views',
                      items: [
                        { label: 'New view', onSelect: () => startNewView(null), movesFocus: true },
                        { label: 'New query', onSelect: openQuery, movesFocus: true },
                      ],
                      open: overlay === 'views-menu',
                      onOpenChange: (open) =>
                        open ? showOverlay('views-menu') : hideOverlay('views-menu'),
                    }}
                    onToggleFavorite={toggleFavorite}
                  />
                </>
              )}
              <SidebarFooter
                themeStore={browserThemeStore}
                onOpenSettings={() => showOverlay('settings')}
                sync={<SyncLight store={syncStore} onOpen={openSyncSettings} />}
              />
            </>
          }
          notices={
            <>
              {notices}
              <ToastHost toasts={toasts} activity={activityLog} vault={vaultKey}>
                {connectionToasts}
              </ToastHost>
            </>
          }
          main={
            location === null ? (
              <VaultEmptyState
                onChooseVault={chooseVault}
                onOpenFromGitHub={() => showOverlay('open-from-github')}
              />
            ) : null
          }
          panes={
            location === null ? null : (
              <WorkspaceStoresProvider value={workspaceStores}>
                <WorkspaceWiringProvider
                  value={{
                    ...workspaceStores,
                    pane: paneContext,
                    onShowSidebar: sidebarOpen ? null : toggleSidebar,
                    note: noteCommands,
                    pages: {
                      ports: archivePorts,
                      indexReady,
                      onSettled: settleArchive,
                      openNote,
                      openBlock,
                      openPage,
                      holds: holdsByVault.of(location.absolutePath),
                      today: todayWiring,
                      inbox: inboxWiring,
                      templates: templatesPage.page,
                      terms: { templates },
                      activity: { activity },
                      automations: { store: automationsStore, ports: automationPorts },
                      graph: { state: vaultGraph },
                      query: { text: queryText },
                      tags: {
                        tags: vaultTags.state,
                        renames: tagRenames.forVault(location.absolutePath),
                      },
                      type: {
                        onEditType: editType,
                        // An artifact is saved from its link or its page, not made blank.
                        onNewNote: (type) =>
                          type.name === ARTIFACT_TYPE
                            ? startNewArtifact()
                            : newNoteOfType.create(type),
                        onEditTemplate: (type) => editTypeTemplate(type.name),
                        onFindDuplicates: peopleMerge.commands.findDuplicates,
                        peopleMerge: peopleMerge.commands,
                      },
                    },
                  }}
                >
                  {/* Keyed by vault: its editors, and what each pane keeps mounted, are that vault's (R14-01). */}
                  <AsideToggleProvider value={asideToggle}>
                    <Fragment key={vaultKey ?? ''}>
                      <AskSeatProvider value={askSeat}>
                        <PanesContainer />
                      </AskSeatProvider>
                      {/* The peek over the panes: its editor is the vault's too. */}
                      <PeekLayer />
                    </Fragment>
                  </AsideToggleProvider>
                </WorkspaceWiringProvider>
              </WorkspaceStoresProvider>
            )
          }
          aside={
            location === null ? null : (
              // The same stores the panes read; the chat reaches only its own tab.
              <WorkspaceStoresProvider value={workspaceStores}>
                <ClaudeSeatProvider
                  value={
                    chat.open && (
                      <ChatPane
                        chat={chat}
                        onFollowLink={(target) =>
                          followLinkInPane({ pane: workspaceNow(workspace).focused, target })
                        }
                        onFollowCitation={followSource}
                        onOpenWeb={openWebLink}
                        loadImage={noImages}
                        nameHint={
                          profileSetting.profile !== 'unknown' &&
                          !hasFullName(profileSetting.profile)
                            ? {
                                placeholder: NAME_PLACEHOLDER,
                                onSetName: () => showOverlay('settings'),
                              }
                            : null
                        }
                      />
                    )
                  }
                >
                  <AsideContainer rows={rowPorts} types={typeAside} onSelectType={selectTypeTab} />
                </ClaudeSeatProvider>
              </WorkspaceStoresProvider>
            )
          }
          status={location === null ? null : indexStatusText(indexStatus)}
          floating={
            location === null ? null : (
              <IndexProgressPill status={indexStatus} progress={indexProgress} />
            )
          }
          overlay={
            overlay === 'settings' ? (
              <SettingsPanel
                ports={api}
                themeStore={browserThemeStore}
                activity={activityLog}
                sections={settingsSectionLinks({ vaultOpen: location !== null })}
                onClose={() => hideOverlay('settings')}
                fallbackFocus={focusFallback}
              >
                {location !== null && (
                  <ProfileSettingsCard setting={profileSetting} emails={selfEmailsSetting} />
                )}
                {location === null ? (
                  <IndexSettings index={null} onRebuild={() => void rebuild()} />
                ) : (
                  <LiveIndexSettings
                    index={indexStatus}
                    progress={indexProgress}
                    onRebuild={() => void rebuild()}
                  />
                )}
                <ImageSettingsPanel store={browserImagePlacementStore} />
                <GlobalCaptureSettings
                  view={globalCapture.status}
                  onChange={globalCapture.change}
                />
                {location !== null && (
                  <QuickAddSettingsCard setting={quickAddSetting} types={types} />
                )}
                {location !== null && <SecretsSettingsCard setting={secrets} />}
                {location !== null && (
                  <GoogleCalendarSettingsCard setting={googleCalendarSetting} />
                )}
                {location !== null && <GranolaSettingsCard setting={granolaSetting} />}
                {location !== null && kindlePorts !== undefined && (
                  <KindleSettingsCard kindle={kindleSync} />
                )}
                <ClaudeSettingsCard chat={chat} />
                {location !== null && (
                  <SyncSettingsSlot store={syncStore}>
                    {(syncNow) => <SyncSettingsCard sync={syncNow} vaultName={location.name} />}
                  </SyncSettingsSlot>
                )}
                <AboutSettings app={app} />
              </SettingsPanel>
            ) : overlay === 'move-picker' && entries.picker !== null ? (
              <MovePicker
                subject={entries.picker.subject}
                destinations={entries.picker.destinations}
                onPick={entries.picker.pick}
                onClose={entries.picker.close}
                fallbackFocus={focusFallback}
              />
            ) : overlay === 'export-notes' ? (
              <ExportSlot
                store={exporting.store}
                commands={exporting.commands}
                fallbackFocus={focusFallback}
              />
            ) : overlay === 'merge-people' ? (
              <MergePeopleSlot
                store={peopleMerge.store}
                commands={peopleMerge.commands}
                fallbackFocus={focusFallback}
              />
            ) : overlay === 'people-duplicates' ? (
              <PossibleDuplicatesSlot
                store={peopleMerge.store}
                commands={peopleMerge.commands}
                onOpen={openNote}
                fallbackFocus={focusFallback}
              />
            ) : overlay === 'delete-dialog' && entries.question !== null ? (
              <DeleteDialog
                subject={entries.question.subject}
                onConfirm={entries.question.confirm}
                onClose={entries.question.close}
                fallbackFocus={focusFallback}
              />
            ) : overlay === 'template-delete' && templatesPage.question !== null ? (
              <DeleteDialog
                subject={{
                  name: templatesPage.question.name,
                  kind: 'note',
                  notes: 0,
                  otherFiles: null,
                  unsaved: templatesPage.question.unsaved ? [templatesPage.question.name] : [],
                  consequence: lostUsesText(templatesPage.question.lost),
                }}
                onConfirm={templatesPage.question.confirm}
                onClose={templatesPage.question.close}
                fallbackFocus={focusFallback}
              />
            ) : overlay === 'template-to-note' && templatesPage.question !== null ? (
              <TemplateToNoteDialog
                name={templatesPage.question.name}
                consequence={lostUsesText(templatesPage.question.lost)}
                unsaved={templatesPage.question.unsaved}
                onConfirm={templatesPage.question.confirm}
                onClose={templatesPage.question.close}
                fallbackFocus={focusFallback}
              />
            ) : overlay === 'open-from-github' ? (
              <OpenFromGitHubDialog
                busy={fromGitHub.busy}
                problem={fromGitHub.problem}
                onOpen={fromGitHub.open}
                onClose={() => {
                  fromGitHub.reset();
                  hideOverlay('open-from-github');
                }}
                fallbackFocus={focusFallback}
              />
            ) : overlay === 'new-type' ? (
              <NewTypeDialog
                icons={TYPE_ICONS}
                error={newType.error}
                onCreate={newType.create}
                onClose={() => hideOverlay('new-type')}
                fallbackFocus={focusFallback}
              />
            ) : overlay === 'new-view' ? (
              <NewViewDialog
                request={newView.request}
                types={newView.typeChoices}
                layouts={newView.layoutChoices}
                problems={newView.problems}
                onChange={newView.change}
                onCreate={newView.create}
                onClose={() => hideOverlay('new-view')}
                fallbackFocus={focusFallback}
              />
            ) : overlay === 'add-pdf' ? (
              <AddDocumentDialog
                kind="pdf"
                folder={addPdf.folder}
                adding={addPdf.adding}
                error={addPdf.error}
                onFiles={(files) => void addPdf.add(files)}
                onClose={() => hideOverlay('add-pdf')}
                fallbackFocus={focusFallback}
              />
            ) : overlay === 'add-epub' ? (
              <AddDocumentDialog
                kind="epub"
                folder={addEpub.folder}
                adding={addEpub.adding}
                error={addEpub.error}
                onFiles={(files) => void addEpub.add(files)}
                onClose={() => hideOverlay('add-epub')}
                fallbackFocus={focusFallback}
              />
            ) : overlay === 'new-artifact' ? (
              <NewArtifactDialog
                draft={newArtifact.draft}
                kinds={ARTIFACT_KIND_CHOICES}
                projects={newArtifact.projects}
                error={newArtifact.error}
                saving={newArtifact.saving}
                onChange={newArtifact.change}
                onCreate={() => void newArtifact.create()}
                onClose={() => hideOverlay('new-artifact')}
                fallbackFocus={focusFallback}
              />
            ) : overlay === 'capture' ? (
              <CapturePalette
                destination={
                  captureTemplate === null ? 'a blank note' : `a ${captureTemplate.name}`
                }
                onCapture={(name) => void captureTask(name)}
                onClose={() => hideOverlay('capture')}
                fallbackFocus={focusFallback}
              />
            ) : (
              <SearchPaletteSlot
                store={overlays}
                workspace={workspace}
                index={index.index}
                commandsFor={paletteCommandsFor}
                offerFor={paletteOffersFor}
                indexStatus={indexStore}
                vault={vaultKey}
                onCommand={runPaletteCommand}
                onPick={openPaletteHit}
                fallbackFocus={focusFallback}
              />
            )
          }
        />
      </ChatToggleProvider>
    </NoteNamesProvider>
  );
  return (
    <LinkHintsHost index={index.index} status={indexStore} vault={vaultKey}>
      {shell}
    </LinkHintsHost>
  );
}

/**
 * Pictures in a proposed change are drawn as their alt text: the chat shows
 * what would change, and a picture's bytes are the note's to load, not the
 * chat's.
 */
const noImages = async (): Promise<string | null> => null;
