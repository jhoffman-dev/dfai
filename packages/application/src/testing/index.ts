/**
 * The application's fakes and fixtures that run in the webview as well as in
 * tests, re-exported from the package's index. Node-only support (SQLite, the
 * disk) is imported by path from tests, never from here.
 */

export { fakeHostVaultFs, fakeIndexPort, fakeMarkdown, fakeVaultFs } from './fake-ports.ts';
export { memoryIndexPort } from './memory-index.ts';
export { memoryActivityStore, recordingActivity } from './fake-activity.ts';
export { apiFixture, bodyOf, codeOf, encoded } from './api-fixture.ts';
export {
  fakeBlockCalendar,
  fakeCalendarSource,
  fakeGoogleCalendar,
  memoryBlockSyncRecords,
  memoryMeetingSyncRecords,
} from './fake-google-calendar.ts';
export {
  fakeGoogleDrive,
  fakePdfRenderer,
  readOnlyVault,
  recordingExportFiles,
} from './fake-export.ts';
export { fakeGranola, granolaNote, granolaTurn } from './fake-granola.ts';
export { fakeSlack } from './fake-slack.ts';
export type { FakeSlack, SlackCall } from './fake-slack.ts';
export { fakeEmbedder, memoryEmbeddingCache } from './fake-embeddings.ts';
export type { FakeEmbedder, MemoryEmbeddingCache } from './fake-embeddings.ts';
export type { GranolaCall, GranolaCallKey } from './fake-granola.ts';
export { fakeKindleDelay, fakeKindleNotebook, fakeKindleSink, kindlePage } from './fake-kindle.ts';
export type {
  FakeKindleNotebookScript,
  KindleNotebookCall,
  KindleScriptedAnswer,
  KindleSinkWrite,
} from './fake-kindle.ts';
export { fakeClaudeStepPorts } from './fake-claude-step.ts';
export {
  CONFLICT_BLOBS,
  failed,
  fakeBlob,
  fakeSleepClock,
  memorySyncFiles,
  memoryVault,
  OK,
  said,
  scriptedFolders,
  scriptedGit,
  statusText,
} from './fake-git.ts';
export type { GitScript } from './fake-git.ts';
