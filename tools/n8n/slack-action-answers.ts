import {
  slackCapturePayload,
  usersToLookUp,
} from '../../packages/domain/src/capture/slack/slack-answers.ts';
import type { SlackCaptureAction } from './slack-request.ts';

/*
 * The domain's Slack shaping (packages/domain/src/capture/slack/, shared with
 * a pasted link in the app, #105), asked about the message a shortcut or a
 * reaction was on. Compiled into the workflow's Code nodes after the domain
 * modules it calls.
 */

/** What the Slack API answered for the action, as the build node gathers it. */
export interface SlackActionAnswers {
  readonly action: SlackCaptureAction;
  /** `chat.getPermalink`'s answer. */
  readonly permalink: unknown;
  /** `conversations.replies`' answer. */
  readonly replies: unknown;
  /** One `users.info` answer per id {@link lookUpFor} named. */
  readonly users: readonly unknown[];
}

/** Whose names the capture needs: whoever asked first, so n8n's lookup runs at least once. */
export function lookUpFor(action: SlackCaptureAction, replies: unknown): string[] {
  return usersToLookUp({ ts: action.ts, replies, first: action.userId });
}

/** The capture/v1 payload for the message the action was on. */
export function captureFor({ action, permalink, replies, users }: SlackActionAnswers) {
  const message = { channel: action.channel, ts: action.ts, kind: action.kind };
  return slackCapturePayload({ message, permalink, replies, users });
}
