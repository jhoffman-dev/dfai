import type { ChatProviderId } from '@dfai/application';

const KEY = 'atlas.chat';

/** How the chat reaches Claude, as Settings → Claude chose: a preference of this Mac's. */
export interface ChatSettings {
  readonly provider: ChatProviderId;
  /** Blank for the default model. */
  readonly model: string;
}

export interface ChatSettingsStore {
  read(): ChatSettings;
  write(settings: ChatSettings): void;
}

const DEFAULT: ChatSettings = { provider: 'claude-code', model: '' };

/**
 * Kept in `localStorage`, like the theme. Every access is guarded, since the
 * accessor throws wherever site data is blocked; a choice that cannot be read
 * is the default, Claude Code with its default model.
 */
export function createBrowserChatSettingsStore(): ChatSettingsStore {
  let chosen: ChatSettings | null = null;
  return {
    read: () => chosen ?? readStored(),
    write: (settings) => {
      chosen = settings;
      try {
        window.localStorage.setItem(KEY, JSON.stringify(settings));
      } catch {
        // Safe to ignore: the choice holds for this session, and is simply
        // not there next time.
      }
    },
  };
}

export const browserChatSettingsStore = createBrowserChatSettingsStore();

function readStored(): ChatSettings {
  try {
    const stored = JSON.parse(window.localStorage.getItem(KEY) ?? 'null') as unknown;
    if (typeof stored !== 'object' || stored === null) return DEFAULT;
    const { provider, model } = stored as Record<string, unknown>;
    return {
      provider: provider === 'anthropic-api' ? 'anthropic-api' : 'claude-code',
      model: typeof model === 'string' ? model : '',
    };
  } catch {
    return DEFAULT;
  }
}
