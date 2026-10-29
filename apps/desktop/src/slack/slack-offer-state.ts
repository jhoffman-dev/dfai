import { CaptureRefusedError, explainSlackFailure } from '@dfai/domain';
import { SlackError } from '@dfai/application';
import type { SlackOfferView } from '@dfai/ui';
import { errorMessage } from '../query/error-message.ts';

/** Failures whose fix is in Settings → Slack: the offer then has an Open Settings. */
const FIXED_IN_SETTINGS = new Set(['no_token', 'refused', 'missing_scope', 'keychain']);

/** A read or save that failed, as the offer draws it: what went wrong and what to do. */
export function problemOf(cause: unknown): SlackOfferView {
  if (cause instanceof SlackError) {
    const { problem, fix } = explainSlackFailure(cause.failure);
    return {
      state: 'problem',
      problem,
      fix,
      inSettings: FIXED_IN_SETTINGS.has(cause.failure.kind),
    };
  }
  if (cause instanceof CaptureRefusedError) {
    return {
      state: 'problem',
      problem: `DFAI cannot save this message: ${cause.message}`,
      fix: 'The link stays as you pasted it.',
      inSettings: false,
    };
  }
  return {
    state: 'problem',
    problem: `The Slack message could not be saved: ${errorMessage(cause)}`,
    fix: 'The link stays as you pasted it.',
    inSettings: false,
  };
}
