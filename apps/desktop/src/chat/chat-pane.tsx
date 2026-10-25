import { Suspense } from 'react';
import type { ChatNameHint, OpenHow } from '@dfai/ui';
import { DEFAULT_CHAT_MODEL } from '@dfai/domain';
import { chatPanel, claudeSettings } from '../pages-on-first-use.ts';
import type { ChatController } from './use-chat.ts';

// Loaded on first use: the panel opens on demand, the card only inside Settings.
const ChatPanel = chatPanel.Component;
const ClaudeSettings = claudeSettings.Component;

/** The chat panel, wired to its controller. */
export function ChatPane({
  chat,
  onFollowLink,
  onFollowCitation,
  onOpenWeb,
  loadImage,
  nameHint,
}: {
  chat: ChatController;
  onFollowLink: (target: string) => void;
  /** Follows a citation in an answer, where the click asked (⌘-click: a new tab). */
  onFollowCitation: (link: string, how: OpenHow) => void;
  /** Opens a web address an answer gives in the browser. */
  onOpenWeb: (url: string) => void;
  loadImage: (src: string) => Promise<string | null>;
  /** Offered while Settings → Profile has no name; null once it has one. */
  nameHint: ChatNameHint | null;
}) {
  const { session } = chat;
  return (
    // The panel's own frame while its chunk arrives, so the panes do not move twice.
    <Suspense fallback={<aside className="chat" aria-label="Claude" aria-busy="true" />}>
      <ChatPanel
        state={chat.state}
        model={chat.model}
        problem={chat.problem}
        history={chat.history}
        loadImage={loadImage}
        nameHint={nameHint}
        draft={chat.draft}
        focusOnMount={chat.focusOnMount}
        actions={{
          onSend: (text) => void session.send(text),
          onStop: () => session.stop(),
          onRetry: () => void session.retry(),
          onNewChat: () => session.newChat(),
          onClose: chat.close,
          onRemoveContext: () => session.removeContext(),
          onAccept: (id) => void session.accept(id),
          onReject: (id) => session.reject(id),
          onUndo: (id) => void session.undo(id),
          onCopy: chat.copy,
          onFollowLink,
          onFollowCitation,
          onOpenWeb,
        }}
      />
    </Suspense>
  );
}

/** Settings → Claude, wired to where the choice is kept. */
export function ClaudeSettingsCard({ chat }: { chat: ChatController }) {
  return (
    <ClaudeSettings
      provider={chat.settings.provider}
      model={chat.settings.model}
      defaultModel={DEFAULT_CHAT_MODEL}
      problem={chat.problem}
      onProvider={(provider) => chat.setSettings({ ...chat.settings, provider })}
      onModel={(model) => chat.setSettings({ ...chat.settings, model })}
    />
  );
}
