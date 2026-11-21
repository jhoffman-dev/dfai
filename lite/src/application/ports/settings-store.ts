import type { VaultPath } from '../../domain/vault/index.ts';

/** The GitHub repository and branch the vault syncs with. */
export interface RepoSettings {
  readonly owner: string;
  readonly name: string;
  readonly branch: string;
}

/** How this device shows the app. Device-local: never synced. */
export interface UiPrefs {
  readonly theme: 'system' | 'light' | 'dark';
  readonly expandedFolders: readonly VaultPath[];
  /** The note open when the app was last closed, reopened on start. */
  readonly lastOpenPath: VaultPath | null;
  /** Rendered view (true) or source (false) when a note opens. */
  readonly preview: boolean;
}

export const DEFAULT_UI_PREFS: UiPrefs = {
  theme: 'system',
  expandedFolders: [],
  lastOpenPath: null,
  preview: false,
};

export interface Settings {
  /** Null until a repository is connected: the app then runs on a vault in memory. */
  readonly repo: RepoSettings | null;
  /** The GitHub token. A secret: never logged, never in a URL, an error or a commit. */
  readonly token: string | null;
  readonly ui: UiPrefs;
}

export const DEFAULT_SETTINGS: Settings = { repo: null, token: null, ui: DEFAULT_UI_PREFS };

/**
 * This device's settings (localStorage in the app). Synchronous, because the
 * app reads them before its first paint. `load` never throws: missing or
 * unreadable settings load as {@link DEFAULT_SETTINGS}, field by field.
 */
export interface SettingsStore {
  load(): Settings;
  save(settings: Settings): void;
}
