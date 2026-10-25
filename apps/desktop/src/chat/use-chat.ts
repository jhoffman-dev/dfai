import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  acceptProposal,
  captureWindowContext,
  createChatSession,
  undoProposal,
  type ActivityLog,
  type ApiRouterDeps,
  type ChatState,
  type ChatWindow,
  type MarkdownPort,
  type ModelProvider,
  type OpenNotes,
  type ProviderStatus,
  type Toolboxes,
  type VaultFsPort,
} from '@dfai/application';
import { chatModelOrDefault, type ProfileState, type VaultPath } from '@dfai/domain';
import type { ChatDraft, ChatProblemView } from '@dfai/ui';
import { localClock } from '../today.ts';
import type { ClipboardWriter } from '../settings/clipboard.ts';
import type { ChatSettings, ChatSettingsStore } from './chat-settings-store.ts';
import { chosenProvider } from './claude-step-ports.ts';
import { profileWhenKnown } from './profile-when-known.ts';
import { useChatHistory, type ChatHistory } from './use-chat-history.ts';

/** How long the first question waits for the settings note to be read before going without a name. */
const PROFILE_WAIT_MS = 1500;

/** The two ways to reach Claude, as the composition root builds them. */
export interface ChatPorts {
  readonly claudeCode: ModelProvider;
  /** The API provider for the vault open at the moment of asking. */
  readonly anthropicApi: (vault: () => string | null) => ModelProvider;
}

/** What the chat reaches in the app: the vault as the API sees it, and as the panes see it. */
export interface ChatVault {
  readonly api: ApiRouterDeps;
  /** Bound to the open vault; null while none is. */
  readonly fs: VaultFsPort | null;
  readonly markdown: MarkdownPort;
  readonly openNotes: Pick<OpenNotes, 'state' | 'reload'>;
  /** Built once at the composition root, so the chat and automations share one toolbox (P29-03). */
  readonly toolboxes: Pick<Toolboxes, 'chat'>;
  readonly notePaths: readonly VaultPath[];
  /** The open vault's absolute path, or null. */
  readonly vaultKey: string | null;
  /** Re-reads the tree and the index after the chat wrote. */
  readonly onChanged: () => void;
}

/** Where the chat sits and whether it is showing, decided outside the chat. */
export interface ChatSeat {
  readonly open: boolean;
  /** Whether the seat was asked for this session, as against remembered across a launch. */
  readonly asked: boolean;
  readonly toggle: () => void;
  readonly close: () => void;
}

export interface ChatController {
  readonly open: boolean;
  /** The question being typed: kept here, since the panel comes and goes with the aside's tab. */
  readonly draft: ChatDraft;
  /** Whether the panel should take the keys as it mounts: only when it was asked for. */
  readonly focusOnMount: boolean;
  readonly toggle: () => void;
  readonly close: () => void;
  readonly state: ChatState;
  readonly session: ReturnType<typeof createChatSession>;
  readonly model: string;
  readonly problem: ChatProblemView | null;
  readonly history: ChatHistory;
  readonly settings: ChatSettings;
  readonly setSettings: (settings: ChatSettings) => void;
  readonly copy: (text: string) => void;
}

/**
 * The chat panel's state and wiring (P27). The session holds the rules; this
 * hands it the vault as it is now, captures the window it opens on, and says
 * whether the chosen way of reaching Claude works.
 */
export function useChat({
  ports,
  store,
  vault,
  window: shown,
  clipboard,
  settingsOpen,
  seat,
  activity,
  profile,
  askShown = false,
}: {
  ports: ChatPorts;
  store: ChatSettingsStore;
  vault: ChatVault;
  window: ChatWindow;
  clipboard: ClipboardWriter;
  /** Settings is up, and shows whether Claude can be reached. */
  settingsOpen: boolean;
  /** Where an Accept, an Undo and a failed turn are said (U-28). */
  activity: ActivityLog;
  /** Who the person is, from Settings → Profile; told to the model with each question. */
  profile: ProfileState;
  /**
   * The chat's seat: the right sidebar's Claude tab (UI v2 plan, question 4).
   * Whether it is on screen, and the way to bring it up or put it away.
   */
  seat: ChatSeat;
  /** Ask (#37) is on screen: it draws the chat too, and says when Claude cannot be reached. */
  askShown?: boolean;
}): ChatController {
  const { open } = seat;
  const [draftText, setDraftText] = useState('');
  const draft = useMemo<ChatDraft>(
    () => ({ text: draftText, onChange: setDraftText }),
    [draftText],
  );
  const [settings, setStoredSettings] = useState(() => store.read());
  const latest = useRef({ vault, settings, ports });
  latest.current = { vault, settings, ports };
  const [profiles] = useState(() => profileWhenKnown({ waitMs: PROFILE_WAIT_MS }));
  useEffect(() => profiles.set(profile), [profiles, profile]);

  const provider = useCallback((): ModelProvider => {
    const { settings: chosen, ports: reached } = latest.current;
    return chosenProvider({
      settings: chosen,
      ports: reached,
      vault: () => latest.current.vault.vaultKey,
    });
  }, []);

  const session = useMemo(
    () =>
      createChatSession({
        provider,
        model: () => chatModelOrDefault(latest.current.settings.model),
        profile: profiles.get,
        toolbox: () => {
          const { fs, toolboxes } = latest.current.vault;
          return fs === null ? null : toolboxes.chat(fs);
        },
        clock: localClock,
        vault: () => {
          const { fs, notePaths } = latest.current.vault;
          return fs === null ? null : { fs, notePaths };
        },
        accept: async (proposal) => {
          const { fs, openNotes, onChanged } = latest.current.vault;
          if (fs === null) throw new Error('No vault is open.');
          const done = await acceptProposal({ fs, openNotes, proposal });
          onChanged();
          return done;
        },
        undo: async (applied) => {
          const { fs, openNotes, onChanged } = latest.current.vault;
          if (fs === null) throw new Error('No vault is open.');
          await undoProposal({ fs, openNotes, applied });
          onChanged();
        },
        stamp: () => chatStamp(localClock.now()),
        newId: () => crypto.randomUUID(),
        activity,
      }),
    [provider, activity, profiles],
  );
  const state = useSyncExternalStore(session.subscribe, session.state);

  // Another vault is another conversation: nothing said about one reaches the other.
  useEffect(() => session.newChat(), [session, vault.vaultKey]);

  useWindowContext({ session, open, shown, api: vault.api, asked: state.items.length > 0 });
  const problem = useProviderProblem({
    asking: open || askShown || settingsOpen,
    provider,
    settings,
  });
  const history = useChatHistory({ session, fs: vault.fs, chatPath: state.chatPath });

  const setSettings = useCallback(
    (next: ChatSettings) => {
      store.write(next);
      setStoredSettings(next);
    },
    [store],
  );

  return {
    open,
    draft,
    focusOnMount: seat.asked,
    // One function for the window's life, the seat's: every page's bar is handed it (#325).
    toggle: seat.toggle,
    close: seat.close,
    state,
    session,
    model: chatModelOrDefault(settings.model),
    problem,
    history,
    settings,
    setSettings,
    copy: (text) => {
      clipboard.write(text).catch(() => {
        // Nothing to do: the text is still on screen to select by hand.
      });
    },
  };
}

/** Offers the chat the window it is opened on, until something is asked. */
function useWindowContext({
  session,
  open,
  shown,
  api,
  asked,
}: {
  session: ReturnType<typeof createChatSession>;
  open: boolean;
  shown: ChatWindow;
  api: ApiRouterDeps;
  asked: boolean;
}) {
  // Read through a ref and followed by its key: a new object naming the same
  // window, as every render makes, is not a new context.
  const latestWindow = useRef(shown);
  latestWindow.current = shown;
  const key =
    shown.kind === 'path'
      ? `path:${shown.path}`
      : shown.kind === 'query'
        ? `query:${shown.text}`
        : 'none';
  useEffect(() => {
    if (!open || asked) return;
    let current = true;
    captureWindowContext({ window: latestWindow.current, api })
      .then((context) => {
        if (current) session.offerContext(context);
      })
      .catch(() => {
        // A window that cannot be read is simply not offered; the chat still works.
      });
    return () => {
      current = false;
    };
  }, [open, asked, key, api, session]);
}

/** Whether the chosen way of reaching Claude works, asked each time the panel or Settings opens. */
function useProviderProblem({
  asking,
  provider,
  settings,
}: {
  /** Whether anything shows the answer now. */
  asking: boolean;
  provider: () => ModelProvider;
  settings: ChatSettings;
}): ChatProblemView | null {
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  useEffect(() => {
    if (!asking) return;
    let current = true;
    provider()
      .status()
      .then((found) => current && setStatus(found))
      .catch((error: unknown) => {
        if (current) {
          setStatus({ ready: false, problem: 'unavailable', message: String(error), fix: null });
        }
      });
    return () => {
      current = false;
    };
  }, [asking, provider, settings.provider]);
  return status === null || status.ready ? null : { message: status.message, fix: status.fix };
}

/** `2026-09-27 10:04`, in the person's own time, as a chat note's `created:` says it. */
export function chatStamp(ms: number): string {
  const at = new Date(ms);
  const two = (value: number) => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`;
}
