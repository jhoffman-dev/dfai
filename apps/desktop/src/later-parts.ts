/*
 * The parts of the app that start-up does not draw, gathered so that one
 * dynamic import splits them off (`pages-on-first-use.ts`): a part imported
 * here and nowhere else eagerly lands in this module's chunk.
 */
export {
  ArchivePage,
  ArtifactViewer,
  CalendarView,
  ClaudeSettings,
  DashboardView,
  FeedView,
  GlobalCaptureSettings,
  SettingsDialog,
  TemplatesPage,
  TermsPage,
  TimelineView,
  WeeklyReviewPage,
  WidgetEditor,
} from '@dfai/ui';
export { AskScreen } from './ask/ask-screen.tsx';
export { SidebarChat } from './chat/sidebar-chat.tsx';
export { GoogleCalendarSettingsCard } from './settings/google-calendar-settings-card.tsx';
export { GranolaSettingsCard } from './settings/granola-settings-card.tsx';
export { KindleSettingsCard } from './settings/kindle-settings-card.tsx';
export { ImageSettingsPanel } from './settings/image-settings-panel.tsx';
export { ProfileSettingsCard } from './profile/profile-settings-card.tsx';
export { QuickAddSettingsCard } from './quick-add/quick-add-settings-card.tsx';
export { SecretsSettingsCard } from './settings/secrets-settings-card.tsx';
export { SyncSettingsCard } from './sync/sync-settings-card.tsx';
