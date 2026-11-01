import { describe, expect, it } from 'vitest';
import type { AcceptedProposal, ProposalArchived } from '@dfai/application';
import { answeredNotice, undoneNotice } from './answer-many.ts';

/** Which of a batch's notices stay until dismissed (review): only those saying something failed. */
const archived = (archiveProblem: string | null) => ({ archiveProblem }) as ProposalArchived;
const accepted = (headline: string) => ({ headline }) as AcceptedProposal;

describe('answeredNotice — whether it stays until read', () => {
  it('goes by itself when every one was answered, or some were and the cards say why the rest were not', () => {
    expect(answeredNotice('Rejected', { done: [archived(null)], failed: [] }).failed).toBe(false);
    const someNot = {
      done: [archived(null)],
      failed: [{ item: 'a', reason: 'refused' }],
    };
    expect(answeredNotice('Accepted', someNot).failed).toBe(false);
  });

  // None answered is no change made: never a green toast (attack-468).
  it('fails, with nothing to undo, when none was answered', () => {
    const noneDone = { done: [], failed: [{ item: 'a', reason: 'refused' }] };
    expect(answeredNotice('Accepted', noneDone)).toMatchObject({ undoable: false, failed: true });
  });

  it('fails when one was left in the Inbox: to read on the page, or with the accepts’ Undo', () => {
    const left = { done: [archived('The Archive is locked.')], failed: [] };
    expect(answeredNotice('Rejected', left)).toMatchObject({ undoable: false, failed: true });
    expect(answeredNotice('Accepted', left)).toMatchObject({ undoable: true, failed: true });
  });
});

describe('undoneNotice — whether it stays until read', () => {
  it('stays when an undo of one or of several could not be done', () => {
    const one = [accepted('Call Mara')];
    expect(undoneNotice(one, { done: [], failed: [{ item: one[0]!, reason: 'x' }] }).failed).toBe(
      true,
    );
    expect(undoneNotice(one, { done: [one[0]], failed: [] }).failed).toBe(false);
    const two = [accepted('Call Mara'), accepted('Book the room')];
    expect(
      undoneNotice(two, { done: [two[0]], failed: [{ item: two[1]!, reason: 'x' }] }).failed,
    ).toBe(true);
    expect(undoneNotice(two, { done: two, failed: [] }).failed).toBe(false);
  });
});
