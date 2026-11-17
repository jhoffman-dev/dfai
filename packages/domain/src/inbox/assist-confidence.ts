/**
 * How sure Claude must be before Inbox assist (#899) plans anything for an
 * item. The model says how sure it is; what that allows is decided here.
 *
 * Only an answer at {@link ASSIST_ACTION_FLOOR} may plan an action. Below it
 * the item is always a question: at {@link ASSIST_GUESS_FLOOR} the question
 * carries Claude's guess, and under that it says Claude could not tell.
 */

import { PROPOSAL_CONFIDENCES, type ProposalConfidence } from '../proposals/proposal.ts';

/** The least sure an answer may be and still plan an action: high, as "After a meeting" holds its tasks (#226). */
export const ASSIST_ACTION_FLOOR: ProposalConfidence = 'high';

/** The least sure an answer may be for its question to carry Claude's guess. */
export const ASSIST_GUESS_FLOOR: ProposalConfidence = 'medium';

/** What an answer's confidence allows: an action, a question with a guess, or a question without one. */
export type AssistSureness = 'act' | 'ask-with-guess' | 'ask-blind';

export function assistSureness(confidence: ProposalConfidence): AssistSureness {
  if (atLeast(confidence, ASSIST_ACTION_FLOOR)) return 'act';
  return atLeast(confidence, ASSIST_GUESS_FLOOR) ? 'ask-with-guess' : 'ask-blind';
}

function atLeast(confidence: ProposalConfidence, floor: ProposalConfidence): boolean {
  // The list runs from most sure to least.
  return PROPOSAL_CONFIDENCES.indexOf(confidence) <= PROPOSAL_CONFIDENCES.indexOf(floor);
}
