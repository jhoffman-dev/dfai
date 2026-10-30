import { invoke } from '@tauri-apps/api/core';
import { isSlackHostFailureKind, slackAnswerFailure } from '@dfai/domain';
import { SlackError, type SlackConnectionStatus, type SlackPort } from '@dfai/application';

/** A method's answer as the host hands it back: every status, the token struck from the body. */
interface SlackAnswer {
  readonly status: number;
  readonly body: string;
  readonly retryAfter: number | null;
}

/**
 * A Slack command's rejection as the app's error. The host rejects with a
 * `{ kind, message }` it built; anything else — Tauri refusing the
 * arguments, say — is a request that could not be made.
 */
export function slackErrorOf(rejection: unknown): SlackError {
  if (typeof rejection === 'object' && rejection !== null && 'kind' in rejection) {
    const { kind, message } = rejection as Record<string, unknown>;
    if (isSlackHostFailureKind(kind)) {
      return new SlackError({ kind, message: typeof message === 'string' ? message : '' });
    }
  }
  const message = rejection instanceof Error ? rejection.message : String(rejection);
  return new SlackError({ kind: 'invalid', message });
}

async function throughHost<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (rejection) {
    throw slackErrorOf(rejection);
  }
}

async function statusCommand(
  command: string,
  args: Record<string, string>,
): Promise<SlackConnectionStatus> {
  const status = await throughHost(invoke<unknown>(command, args));
  if (typeof status !== 'object' || status === null || !('hasToken' in status)) {
    throw new SlackError({
      kind: 'malformed',
      message: 'the host answered a status DFAI cannot read',
    });
  }
  return { hasToken: (status as { hasToken: unknown }).hasToken === true };
}

const parsed = (body: string): unknown => {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    // Not JSON is Slack's answer DFAI cannot read: `slackAnswerFailure` says so for a null body.
    return null;
  }
};

/**
 * Slack through the host (#105, ADR-0017). The host keeps the token and
 * fixes where it may go; what crosses here is whether one is kept and a
 * method's answer, read on this side by the domain's rule for what Slack's
 * answers mean.
 */
export const tauriSlack: SlackPort = {
  status: ({ vault }) => statusCommand('slack_status', { vault }),
  connect: ({ vault, token }) => statusCommand('slack_connect', { vault, token }),
  disconnect: ({ vault }) => statusCommand('slack_disconnect', { vault }),
  async call({ vault, method, query }) {
    const answer = await throughHost(
      invoke<SlackAnswer>('slack_request', { vault, method, query }),
    );
    const body = parsed(answer.body);
    const failure = slackAnswerFailure({
      status: answer.status,
      body,
      retryAfter: answer.retryAfter,
    });
    if (failure !== null) throw new SlackError(failure);
    return body;
  },
};
