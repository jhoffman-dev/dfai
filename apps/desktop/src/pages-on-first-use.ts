import type { ComponentType } from 'react';
import type * as LaterParts from './later-parts.ts';
import { importAgain, reloadWindow } from './chunk-files.ts';
import {
  chunkOf,
  onFirstUse,
  type Chunk,
  type FailedPartProps,
  type OnFirstUse,
} from './on-first-use.ts';
import type { PageChrome } from './page-frame-fallback.tsx';
import { ChatFailed, PageFailed, PartFailed, SettingsFailed } from './part-failed.tsx';

/*
 * The pages and parts that are not on the start path, split into chunks that
 * are fetched the first time one is drawn, or once start-up has committed
 * (`preloadPages`). Today, the Inbox, the note editor, the sidebar and the
 * shell stay in the main chunk: they are what start-up shows. Each must be
 * drawn inside a `Suspense`.
 */

/** Every part's preload, in the order declared. */
const PRELOADS: (() => Promise<void>)[] = [];

/** A chunk of its own, named as the build names it: after its file. */
const chunk = <M>(name: string, load: () => Promise<M>): Chunk<M> =>
  chunkOf({ load, loadAgain: importAgain(name) });

/** A part of `module`'s chunk that, when the chunk cannot be loaded, says so where it would be. */
function later<M, P extends object>(
  module: Chunk<M>,
  pick: (loaded: M) => ComponentType<P>,
  Failed: ComponentType<FailedPartProps<P>> = PartFailed,
): OnFirstUse<P> {
  const part = onFirstUse({ chunk: module, pick, Failed, reloadWindow });
  PRELOADS.push(part.preload);
  return part;
}

/** A page over the panes: when its chunk cannot be loaded, it says so inside its frame. */
const laterPage = <M, P extends PageChrome>(
  module: Chunk<M>,
  pick: (loaded: M) => ComponentType<P>,
) => later(module, pick, PageFailed);

/** The chunk most parts share, so that loading it once, or once again, brings them all. */
const laterParts = chunk(
  'later-parts',
  (): Promise<typeof LaterParts> => import('./later-parts.ts'),
);

// The pages the tabs show (`workspace/page-tab.tsx`), each in its own chunk.
export const graphPage = laterPage(
  chunk('graph-page', () => import('./graph/graph-page.tsx')),
  (m) => m.default,
);
export const typePage = laterPage(
  chunk('type-page', () => import('./types/type-page.tsx')),
  (m) => m.TypePage,
);
export const queryScreen = laterPage(
  chunk('query-screen', () => import('./query/query-screen.tsx')),
  (m) => m.QueryScreen,
);
export const tagsScreen = laterPage(
  chunk('tags-screen', () => import('./tags/tags-screen.tsx')),
  (m) => m.TagsScreen,
);
export const automationsScreen = laterPage(
  chunk('automations-screen', () => import('./automations/automations-screen.tsx')),
  (m) => m.AutomationsScreen,
);
export const activityScreen = laterPage(
  chunk('activity-screen', () => import('./activity/activity-screen.tsx')),
  (m) => m.ActivityScreen,
);
/** The Library and All highlights (#507): one chunk, since one is often opened from the other. */
const researchScreens = chunk('research-screens', () => import('./research/research-screens.tsx'));
export const libraryScreen = laterPage(researchScreens, (m) => m.LibraryScreen);
export const highlightsScreen = laterPage(researchScreens, (m) => m.HighlightsScreen);
// The PDF reader, with pdf.js, in a chunk of its own (#504): half a megabyte nobody pays for until a PDF opens.
export const documentReader = laterPage(
  chunk('document-reader', () => import('./reader/document-reader.tsx')),
  (m) => m.DocumentReader,
);
// The EPUB reader, with foliate-js and its zip reader, in a chunk of its own (#505).
export const bookReader = laterPage(
  chunk('book-reader-tab', () => import('./reader/book-reader-tab.tsx')),
  (m) => m.BookReaderTab,
);
export const archivePage = laterPage(laterParts, (m) => m.ArchivePage);
export const weeklyReviewPage = laterPage(laterParts, (m) => m.WeeklyReviewPage);
export const templatesPage = laterPage(laterParts, (m) => m.TemplatesPage);
export const termsPage = laterPage(laterParts, (m) => m.TermsPage);
/**
 * Ask (#37), in the chunk the sidebar chat is in: the two draw the same parts
 * (the composer, a proposal), and a chunk of its own would split those into a
 * third that both import — one a failed preload can leave broken under
 * `later-parts`, past its Reload (#271).
 */
export const askScreen = laterPage(laterParts, (m) => m.AskScreen);

// What a note pane draws for a dashboard, an artifact, or a view's rarer layouts: inline.
export const dashboardView = later(laterParts, (m) => m.DashboardView);
export const widgetEditor = later(laterParts, (m) => m.WidgetEditor);
export const artifactViewer = later(laterParts, (m) => m.ArtifactViewer);
export const calendarView = later(laterParts, (m) => m.CalendarView);
export const timelineView = later(laterParts, (m) => m.TimelineView);
export const feedView = later(laterParts, (m) => m.FeedView);

// Claude's panel, failing in its own place with its Close; and Settings, failing inside
// its own window. `SettingsPanel` draws the dialog and its sections in one `Suspense`.
export const chatPanel = later(laterParts, (m) => m.ChatPanel, ChatFailed);
export const claudeSettings = later(laterParts, (m) => m.ClaudeSettings);
export const settingsDialog = later(laterParts, (m) => m.SettingsDialog, SettingsFailed);
// The sections `app.tsx` hands to Settings (drawn by name from `settings/settings-sections.ts`).
export const globalCaptureSettings = later(laterParts, (m) => m.GlobalCaptureSettings);
export const googleCalendarSettingsCard = later(laterParts, (m) => m.GoogleCalendarSettingsCard);
export const granolaSettingsCard = later(laterParts, (m) => m.GranolaSettingsCard);
export const kindleSettingsCard = later(laterParts, (m) => m.KindleSettingsCard);
export const imageSettingsPanel = later(laterParts, (m) => m.ImageSettingsPanel);
export const profileSettingsCard = later(laterParts, (m) => m.ProfileSettingsCard);
export const quickAddSettingsCard = later(laterParts, (m) => m.QuickAddSettingsCard);
export const secretsSettingsCard = later(laterParts, (m) => m.SecretsSettingsCard);
export const syncSettingsCard = later(laterParts, (m) => m.SyncSettingsCard);

/**
 * Runs every preload and waits for all of them to settle. One that rejects is
 * warned about rather than thrown: the part it belongs to deals with its own
 * chunk where it is drawn.
 */
export async function preloadAll(preloads: readonly (() => Promise<void>)[]): Promise<void> {
  const settled = await Promise.allSettled(preloads.map((preload) => preload()));
  for (const result of settled) {
    if (result.status === 'rejected')
      console.warn('A part of DFAI could not preload:', result.reason);
  }
}

/**
 * Fetches every part's chunk, so that one drawn later appears at once, with no
 * fallback. A chunk that cannot be loaded is warned about, and its part offers
 * to load it again where it is drawn.
 */
export const preloadPages = (): Promise<void> => preloadAll(PRELOADS);
