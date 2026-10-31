import { describe, expect, it } from 'vitest';
import { readCapture } from '@dfai/domain';
import { slackCapture, slackSource } from '@dfai/domain/testing';
import { SlackError } from '@dfai/application';
import { problemOf } from './slack-offer-state.ts';

/* Review of PR #631: every way a read or save can fail, as the offer draws it. */

const refusal = (): unknown => {
  try {
    // A channel the permalink rule passes and the contract's channel rule does not.
    readCapture(slackCapture({ source: slackSource({ channel: { id: 'X0NOTACHAN' } }) }));
  } catch (error) {
    return error;
  }
  throw new Error('the contract took it');
};

describe('problemOf', () => {
  it('says what Slack’s failure means, with a way to Settings only when the fix is there', () => {
    expect(problemOf(new SlackError({ kind: 'no_token', message: '' }))).toMatchObject({
      state: 'problem',
      inSettings: true,
    });
    expect(problemOf(new SlackError({ kind: 'not_found', message: '' }))).toMatchObject({
      state: 'problem',
      inSettings: false,
    });
  });

  it('says a message the contract refused cannot be saved, and why', () => {
    const view = problemOf(refusal());
    expect(view).toMatchObject({ state: 'problem', inSettings: false });
    expect(view.state === 'problem' && view.problem).toMatch(/^DFAI cannot save this message: /);
    expect(view.state === 'problem' && view.problem).toContain('X0NOTACHAN');
  });

  it('says anything else went wrong in its own words, the link kept', () => {
    expect(problemOf(new Error('the disk is full'))).toEqual({
      state: 'problem',
      problem: 'The Slack message could not be saved: the disk is full',
      fix: 'The link stays as you pasted it.',
      inSettings: false,
    });
    expect(problemOf('odd')).toMatchObject({
      problem: 'The Slack message could not be saved: odd',
    });
  });
});
