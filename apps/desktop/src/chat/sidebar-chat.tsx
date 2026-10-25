import { useMemo, type ComponentProps } from 'react';
import type { ChatState } from '@dfai/application';
import { ChatPanel, type ChatPanelState } from '@dfai/ui';
import { useAskState } from '../ask/use-ask-transcript.ts';

export type SidebarChatProps = Omit<ComponentProps<typeof ChatPanel>, 'state'> & {
  readonly state: ChatState;
};

/**
 * The chat beside the page (⇧⌘J), its answers read for citations as Ask's
 * are (#548). Loaded with `later-parts`, as Ask is, so the reading stays off
 * the start path and no chunk is shared under it (#552).
 */
export function SidebarChat({ state, ...panel }: SidebarChatProps) {
  const read = useAskState(state);
  const view = useMemo<ChatPanelState>(
    () => ({
      items: read.entries,
      busy: read.busy,
      error: read.error,
      notice: read.notice,
      context: state.context,
    }),
    [read, state.context],
  );
  return <ChatPanel state={view} {...panel} />;
}
