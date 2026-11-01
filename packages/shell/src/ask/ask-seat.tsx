import { createContext, useContext } from 'react';
import type { OpenHow } from '@dfai/ui';
import type { ChatController } from '../chat/use-chat.ts';
import type { AskFocus } from './ask-focus.ts';

/** What Ask is handed by the app (#37): the chat, and how to follow what an answer cites. */
export interface AskSeat {
  readonly chat: ChatController;
  /** Follows `[[Note#^id]]` in the focused pane, or where the click asked. */
  readonly onFollowCitation: (link: string, how: OpenHow) => void;
  /** Opens a web address in the browser. */
  readonly onOpenWeb: (url: string) => void;
  /** Follows a link in a proposed change, as the sidebar chat does. */
  readonly onFollowLink: (target: string) => void;
  /** Whether, and in which pane, Ask was asked for the keys. */
  readonly focus: AskFocus;
}

const AskSeatContext = createContext<AskSeat | null>(null);

/**
 * The chat, handed to Ask's tab as a context rather than through the pages'
 * wiring, as the aside's Claude tab is: the chat's state changes with every
 * streamed word, and only Ask should be drawn again for it — not every tab
 * the wiring reaches (#325).
 */
export const AskSeatProvider = AskSeatContext.Provider;

/** What Ask is handed, or null outside the app's panes. */
export function useAskSeat(): AskSeat | null {
  return useContext(AskSeatContext);
}
