import { CaptureRefusedError, explainSlackFailure } from '@dfai/domain';
import { SlackError } from '@dfai/application';
import type { SlackOfferView } from '@dfai/ui';
import { errorMessage } from '../query/error-message.ts';

/** A read or save that failed, as the offer draws it: what went wrong and what to do. */
export function problemOf(cause: unknown): SlackOfferView {
  if (cause instanceof SlackError) {
    // The domain says whether the fix is in Settings → Slack: the offer then has an Open Settings.
    const { problem, fix, inSettings } = explainSlackFailure(cause.failure, 'paste');
    return { state: 'problem', problem, fix, inSettings };
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
