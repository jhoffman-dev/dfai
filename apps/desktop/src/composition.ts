import { isTauri } from '@tauri-apps/api/core';
import desktopPackage from '../package.json' with { type: 'json' };
import {
  anthropicApiProvider,
  claudeCodeProvider,
  remarkMarkdown,
  tauriModelHttp,
  tauriModelProcess,
  tauriApiBridge,
  tauriApiSettings,
  tauriGlobalCapture,
  tauriExternalLinks,
  tauriHttp,
  tauriSecrets,
  tauriExportFiles,
  tauriGoogleCalendar,
  tauriGoogleDrive,
  tauriPdfRenderer,
  tauriGranola,
  tauriKindleNotebook,
  tauriKindleSession,
  tauriSqliteSource,
  tauriPageSnapshot,
  tauriIndex,
  tauriEmbeddings,
  tauriEmbeddingCache,
  browserIdle,
  webWorkerNoteChunker,
  webWorkerNoteDeriver,
  staticAppInfo,
  tauriAppInfo,
  tauriVaultFs,
  tauriVaultPicker,
  tauriVaultStore,
  tauriVaultWatch,
  tauriActivityStore,
  tauriWindowClosing,
  tauriGit,
  tauriGitFolders,
  tauriGitHub,
  tauriMacName,
  tauriSleepClock,
  tauriSyncFiles,
} from '@dfai/adapters';
import type {
  ActivityStore,
  WindowClosingPort,
  AppInfoPort,
  ExternalLinkPort,
  GlobalCapturePort,
  GoogleCalendarPort,
  GranolaPort,
  GranolaPullRecords,
  PageSnapshotPort,
  ExportFilesPort,
  GoogleDrivePort,
  NotePageRenderer,
  PdfRendererPort,
} from '@dfai/application';
import { createKindleSync } from '@dfai/application';
import { createExportPageRenderer } from '@dfai/ui';
import type { VaultPorts } from './vault/use-vault.ts';
import type { NotePorts } from './notes/use-note.ts';
import type { IndexPorts } from './index/use-index.ts';
import type { LocalApiPorts } from './api/use-local-api.ts';
import type { SourcePorts } from './sources/source-ports.ts';
import { browserClipboard } from './settings/clipboard.ts';
import type { OnHost } from './vault/bound-to-vault.ts';
import type { ChatPorts } from './chat/use-chat.ts';
import { browserMacId } from './sync/browser-mac-id.ts';
import { browserSyncPause } from './sync/browser-sync-pause.ts';
import { browserGranolaPullRecords } from './granola/browser-granola-store.ts';
import { browserKindleRecords } from './kindle/browser-kindle-records.ts';
import { browserKindleVaults } from './kindle/browser-kindle-vaults.ts';
import type { KindleHost } from './kindle/use-kindle-sync.ts';
import type { SyncHostPorts } from './sync/use-sync.ts';
import type { SemanticPorts } from './semantic/use-semantic-search.ts';
import { browserSemanticOptIn } from './semantic/browser-semantic-opt-in.ts';
import {
  browserGlobalCaptureStore,
  type GlobalCaptureStore,
} from './global-capture/browser-global-capture-store.ts';

/**
 * The composition root: the one place allowed to know about every layer.
 * `pnpm dev` opens the UI in a plain browser, where no Tauri runtime answers.
 */
export function resolveAppInfoPort(): AppInfoPort {
  const build = builtCommit();
  return isTauri()
    ? tauriAppInfo({ build })
    : staticAppInfo({ name: 'DFAI', version: desktopPackage.version, build });
}

/** The commit this app was built from, which Vite writes in; absent in the unit tests. */
function builtCommit(): string | null {
  return typeof __ATLAS_BUILD__ === 'string' ? __ATLAS_BUILD__ : null;
}

export function resolveVaultPorts(): OnHost<VaultPorts> {
  return {
    fs: tauriVaultFs,
    picker: tauriVaultPicker,
    store: tauriVaultStore,
    watch: tauriVaultWatch,
  };
}

export function resolveNotePorts(): OnHost<NotePorts> {
  return { fs: tauriVaultFs, markdown: remarkMarkdown };
}

export function resolveIndexPorts(): OnHost<IndexPorts> {
  return {
    fs: tauriVaultFs,
    index: tauriIndex,
    markdown: remarkMarkdown,
    // The notes are read for the index in a worker, so the window stays the user's (#135).
    deriver: webWorkerNoteDeriver,
  };
}

/**
 * Semantic search (P32-02, ADR-0031): the small model the host runs on this
 * Mac, the cache beside the index, and the window's idle moments, which the
 * cache is built in so typing never waits behind it.
 */
export function resolveSemanticPorts(): SemanticPorts {
  return {
    embedder: tauriEmbeddings,
    cache: tauriEmbeddingCache,
    idle: browserIdle(),
    optIn: browserSemanticOptIn,
    chunker: webWorkerNoteChunker,
  };
}

export function resolveSourcePorts(): SourcePorts {
  return { http: tauriHttp, sqlite: tauriSqliteSource, secrets: tauriSecrets };
}

/** Google Calendar, through the host's sign-in (ADR-0030). */
export function resolveGoogleCalendar(): GoogleCalendarPort {
  return tauriGoogleCalendar;
}

/** Granola, through the host's pinned module (ADR-0034), and where this Mac keeps each vault's pull record. */
export function resolveGranola(): { port: GranolaPort; records: GranolaPullRecords } {
  return { port: tauriGranola, records: browserGranolaPullRecords };
}

/** The global capture shortcut: registered by the host, chosen and kept on this Mac (#81). */
export function resolveGlobalCapture(): { port: GlobalCapturePort; store: GlobalCaptureStore } {
  return { port: tauriGlobalCapture, store: browserGlobalCaptureStore };
}

export function resolveExternalLinks(): ExternalLinkPort {
  return tauriExternalLinks;
}

export function resolvePageSnapshot(): PageSnapshotPort {
  return tauriPageSnapshot;
}

/**
 * Exporting notes (#501): the host's save dialogs and writes, the system
 * WebKit's PDF, Google Drive through the Calendar's sign-in, and the note
 * drawn as the reading view draws it.
 */
export function resolveExportPorts(): {
  files: ExportFilesPort;
  pdf: PdfRendererPort;
  drive: GoogleDrivePort;
  renderer: NotePageRenderer;
} {
  return {
    files: tauriExportFiles,
    pdf: tauriPdfRenderer,
    drive: tauriGoogleDrive,
    renderer: createExportPageRenderer(),
  };
}

export function resolveLocalApiPorts(): LocalApiPorts {
  return {
    bridge: tauriApiBridge,
    settings: tauriApiSettings,
    clipboard: browserClipboard,
    mcpEntry: builtMcpEntry(),
  };
}

/**
 * The MCP server beside the checkout this app was built from, which Vite writes
 * in at build time. Absent where nothing built it in — the unit tests — and then
 * Settings shows the README's placeholder instead.
 */
function builtMcpEntry(): string | null {
  return typeof __ATLAS_MCP_ENTRY__ === 'string' ? __ATLAS_MCP_ENTRY__ : null;
}

/**
 * Claude, the two ways (ADR-0021): the person's own Claude Code, which keeps
 * its login to itself, and the API with a key the host fills in from the
 * Keychain. Each run of Claude Code gets an id no other run has.
 */
export function resolveChatPorts(): ChatPorts {
  return {
    claudeCode: claudeCodeProvider(tauriModelProcess(() => crypto.randomUUID())),
    anthropicApi: (vault) =>
      anthropicApiProvider({ http: tauriModelHttp, secrets: tauriSecrets, vault }),
  };
}

/**
 * Sync through GitHub (U-29): the Mac's own git and gh, run by the host with
 * argument shapes it holds fixed, and this Mac's name for commits and copies.
 */
export function resolveSyncPorts(): SyncHostPorts {
  return {
    git: tauriGit,
    files: tauriSyncFiles,
    folders: tauriGitFolders,
    github: tauriGitHub,
    pause: browserSyncPause,
    thisMac: { name: tauriMacName.name, id: browserMacId(() => crypto.randomUUID()) },
    sleepClock: tauriSleepClock,
  };
}

/**
 * Each vault's Activity log, kept by the host in the app's data folder (U-28),
 * and the window's close button, which waits for its last lines.
 */
export function resolveActivityPorts(): { store: ActivityStore; closing: WindowClosingPort } {
  return { store: tauriActivityStore, closing: tauriWindowClosing };
}

/** A wait on the window's own timer: Kindle sync's gap between fetches, and its join deadline. */
const kindleTimer = {
  wait: (milliseconds: number) =>
    new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds)),
};

/**
 * Kindle (ADR-0044): the host's own Amazon session and notebook fetches, and
 * the app's **one** sync of it (`createKindleSync`), so launch, the schedule,
 * Settings and ⌘K never run two at once. `main.tsx` asks for this once.
 */
export function resolveKindle(): KindleHost {
  return {
    notebook: tauriKindleNotebook,
    session: tauriKindleSession,
    sync: createKindleSync({ deadline: kindleTimer }),
    delay: kindleTimer,
    records: browserKindleRecords,
    vaults: browserKindleVaults,
  };
}
