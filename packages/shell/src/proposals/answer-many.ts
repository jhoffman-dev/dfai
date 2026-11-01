import { messageOf } from '@dfai/domain';
import type { AcceptedProposal, ProposalArchived } from '@dfai/application';
import type { ProposalNotice } from './proposal-notice.ts';

/** What answering several in turn did: each one done, and each one that was not, with why. */
export interface InTurn<Item, Done> {
  readonly done: readonly Done[];
  readonly failed: readonly { readonly item: Item; readonly reason: string }[];
}

/**
 * Answers each item in turn, as it would be answered alone (#168): one that
 * fails is set aside with why, and the rest still go ahead.
 */
export async function inTurn<Item, Done>(
  items: readonly Item[],
  answer: (item: Item) => Promise<Done>,
): Promise<InTurn<Item, Done>> {
  const done: Done[] = [];
  const failed: { item: Item; reason: string }[] = [];
  for (const item of items) {
    try {
      done.push(await answer(item));
    } catch (cause) {
      failed.push({ item, reason: messageOf(cause) });
    }
  }
  return { done, failed };
}

const proposals = (count: number) => (count === 1 ? '1 proposal' : `${count} proposals`);

/** What answering several says: how many were, how many were not, and any the Archive refused. */
export function answeredNotice(
  verb: 'Accepted' | 'Rejected',
  { done, failed }: InTurn<unknown, ProposalArchived>,
): ProposalNotice {
  const said =
    done.length === 0
      ? `None of the ${proposals(failed.length)} was ${verb.toLowerCase()}.`
      : `${verb} ${proposals(done.length)}.`;
  const undoable = verb === 'Accepted' && done.length > 0;
  const stranded = strandedNote(done);
  return {
    text: [said, notAnswered(failed.length, done.length), stranded].join(''),
    opens: null,
    undoable,
    // Those not answered say why on their cards. None answered, or one left in the
    // Inbox, is a failure: with nothing to undo it stays on the page until read.
    failed: stranded !== '' || (done.length === 0 && failed.length > 0),
  };
}

function notAnswered(failed: number, done: number): string {
  if (failed === 0) return '';
  if (done === 0) return failed === 1 ? ' Its card says why.' : ' Their cards say why.';
  return failed === 1
    ? ' 1 was not: its card says why.'
    : ` ${failed} were not: their cards say why.`;
}

function strandedNote(done: readonly ProposalArchived[]): string {
  const stranded = done.filter((answer) => answer.archiveProblem !== null);
  const [first] = stranded;
  if (first === undefined) return '';
  return ` ${proposals(stranded.length)} stayed in the Inbox: ${first.archiveProblem}`;
}

/** What undoing an accept of one or several says: what came back, and what could not, with why. */
export function undoneNotice(
  accepted: readonly AcceptedProposal[],
  { done, failed }: InTurn<AcceptedProposal, unknown>,
): ProposalNotice {
  const [only] = accepted;
  if (accepted.length === 1 && only !== undefined) {
    const [refused] = failed;
    const text =
      refused === undefined ? `Undone: ${only.headline} is back in the Inbox.` : refused.reason;
    return { text, opens: null, undoable: false, failed: refused !== undefined };
  }
  const back =
    done.length === 0
      ? ''
      : `Undone: ${proposals(done.length)} ${done.length === 1 ? 'is' : 'are'} back in the Inbox.`;
  const left = failed.map(({ item, reason }) => ` ${item.headline} was not: ${reason}`);
  return {
    text: [back, ...left].join('').trim(),
    opens: null,
    undoable: false,
    failed: failed.length > 0,
  };
}
