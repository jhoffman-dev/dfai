import type { AskAnswerView, ChatActions, ChatEntryView, ChatProblemView } from './chat-view.ts';

export interface AskState {
  readonly entries: readonly ChatEntryView[];
  readonly busy: boolean;
  readonly error: { readonly message: string } | null;
  readonly notice: string | null;
}

/** The questions asked before, as the chats they were kept in; null while they are read. */
export type AskRecent = readonly { readonly path: string; readonly title: string }[] | null;

/** What a person can do on Ask: the chat's own, and following what an answer cites. */
export interface AskActions extends Pick<
  ChatActions,
  | 'onSend'
  | 'onStop'
  | 'onRetry'
  | 'onNewChat'
  | 'onAccept'
  | 'onReject'
  | 'onUndo'
  | 'onCopy'
  | 'onFollowLink'
  | 'onFollowCitation'
  | 'onOpenWeb'
> {
  /** Opens a past question's chat. */
  readonly onPickRecent: (path: string) => void;
}

export type { AskAnswerView, ChatProblemView };
