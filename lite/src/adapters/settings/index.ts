import {
  DEFAULT_SETTINGS,
  DEFAULT_UI_PREFS,
  type RepoSettings,
  type Settings,
  type SettingsStore,
  type UiPrefs,
} from '../../application/index.ts';

/** Where the settings live in the browser's storage. */
export const SETTINGS_KEY = 'dfai-lite.settings';

/**
 * Settings in `localStorage`, as one JSON value. Whatever cannot be read
 * (missing, not JSON, a field of the wrong shape) loads as its default,
 * field by field, so one bad field never costs the others. The token is
 * written and read like any field and appears in no message.
 */
export function createLocalSettingsStore(storage: Storage): SettingsStore {
  return {
    load: () => settingsFrom(readJson(storage)),
    save: (settings) => storage.setItem(SETTINGS_KEY, JSON.stringify(settings)),
  };
}

function readJson(storage: Storage): unknown {
  const raw = storage.getItem(SETTINGS_KEY);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // Unreadable settings load as the defaults, as the port promises.
    return null;
  }
}

type Fields = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';

function settingsFrom(raw: unknown): Settings {
  if (!isRecord(raw)) return DEFAULT_SETTINGS;
  return {
    repo: repoFrom(raw.repo),
    token: isString(raw.token) && raw.token !== '' ? raw.token : null,
    ui: uiFrom(raw.ui),
  };
}

function repoFrom(raw: unknown): RepoSettings | null {
  if (!isRecord(raw)) return null;
  const { owner, name, branch } = raw;
  if (!isString(owner) || !isString(name) || !isString(branch)) return null;
  return { owner, name, branch };
}

const THEMES: readonly UiPrefs['theme'][] = ['system', 'light', 'dark'];

function uiFrom(raw: unknown): UiPrefs {
  if (!isRecord(raw)) return DEFAULT_UI_PREFS;
  const { theme, expandedFolders, lastOpenPath, preview } = raw;
  return {
    theme: THEMES.find((known) => known === theme) ?? DEFAULT_UI_PREFS.theme,
    expandedFolders:
      Array.isArray(expandedFolders) && expandedFolders.every(isString)
        ? expandedFolders
        : DEFAULT_UI_PREFS.expandedFolders,
    lastOpenPath: isString(lastOpenPath) ? lastOpenPath : DEFAULT_UI_PREFS.lastOpenPath,
    preview: typeof preview === 'boolean' ? preview : DEFAULT_UI_PREFS.preview,
  };
}
