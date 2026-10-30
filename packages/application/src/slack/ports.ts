import type { SlackFailure } from '@dfai/domain';

/** Whether this vault has a Slack token on this Mac. Never the token. */
export interface SlackConnectionStatus {
  readonly hasToken: boolean;
}

/** The Web API methods DFAI calls, every one a read; the host refuses any other. */
export type SlackMethod =
  'auth.test' | 'conversations.replies' | 'chat.getPermalink' | 'users.info';

/**
 * Slack's Web API, through the host (#105, ADR-0017). The host keeps the
 * token and sends it only to slack.com; every call names the vault it is for,
 * so one that lands after a switch is refused rather than sent with the
 * other's token. A method's answer comes back only when Slack said `ok`;
 * anything else is a {@link SlackError}.
 */
export interface SlackPort {
  status(args: { vault: string }): Promise<SlackConnectionStatus>;
  /** Keeps the token, replacing any kept before. Whether Slack accepts it is `auth.test`'s to say. */
  connect(args: { vault: string; token: string }): Promise<SlackConnectionStatus>;
  disconnect(args: { vault: string }): Promise<SlackConnectionStatus>;
  call(args: {
    vault: string;
    method: SlackMethod;
    query: Readonly<Record<string, string>>;
  }): Promise<unknown>;
}

/** A Slack call that failed, with what the host or Slack said. */
export class SlackError extends Error {
  readonly failure: SlackFailure;

  constructor(failure: SlackFailure) {
    super(failure.message);
    this.name = 'SlackError';
    this.failure = failure;
  }
}
