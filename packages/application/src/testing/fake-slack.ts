import { slackAnswerFailure } from '@dfai/domain';
import { SlackError, type SlackMethod, type SlackPort } from '../slack/ports.ts';

/** One call the fake heard: the method and its query. */
export interface SlackCall {
  readonly method: SlackMethod;
  readonly query: Readonly<Record<string, string>>;
}

export interface FakeSlack extends SlackPort {
  readonly calls: SlackCall[];
  /** Whether a token is kept, as the host would say. */
  hasToken: boolean;
}

/**
 * A Slack port answering each call with `answer`'s body, read as the real
 * adapter reads Slack's (`slackAnswerFailure`), so an `ok: false` is the
 * same `SlackError` here as there. Without a token every call fails as the
 * host's would.
 */
export function fakeSlack(
  answer: (call: SlackCall) => unknown,
  { hasToken = true }: { hasToken?: boolean } = {},
): FakeSlack {
  const fake: FakeSlack = {
    calls: [],
    hasToken,
    status: async () => ({ hasToken: fake.hasToken }),
    connect: async () => {
      fake.hasToken = true;
      return { hasToken: true };
    },
    disconnect: async () => {
      fake.hasToken = false;
      return { hasToken: false };
    },
    call: async ({ method, query }) => {
      if (!fake.hasToken) throw new SlackError({ kind: 'no_token', message: 'no token' });
      const call = { method, query };
      fake.calls.push(call);
      const body = answer(call);
      const failure = slackAnswerFailure({ status: 200, body, retryAfter: null });
      if (failure !== null) throw new SlackError(failure);
      return body;
    },
  };
  return fake;
}
