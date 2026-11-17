/**
 * The people an Inbox item names, and what Inbox assist would do about each
 * (#899, #906): link someone already in People, add someone new, or ask.
 *
 * - **Links** only on an exact match ({@link personMatch}) that Claude picked too.
 * - **Would add** only when the item itself gives an address, nobody in People
 *   is exact or near, and Claude picked nobody. (Claude's confidence is already
 *   high: an unsure item is a question before its people are looked at.)
 * - Anything between is a question, naming the vault's own person where there is one.
 *
 * Never over what is written: an item that lists people already keeps them. A
 * suggestion it lists adds nothing; one it does not is a question.
 */

import { namesNote } from '../automations/proposal-schema.ts';
import { newPersonRefusal } from '../people/person.ts';
import { givesAddress, personMatch, type PersonCandidate } from '../people/person-match.ts';
import type { AssistPersonAnswer } from './assist-answer.ts';
import { heldWords, type HeldField } from './assist-held.ts';
import type { AssistTarget } from './assist-plan.ts';

/** What would be done about one person an item names. */
export type AssistPersonStep =
  | { readonly kind: 'link'; readonly person: AssistTarget }
  | { readonly kind: 'add'; readonly name: string; readonly email: string };

/** What the people rules read: the people offered, as matched, and what the item holds. */
export interface AssistPeopleFacts {
  /** The people Claude was offered, by the vault's own titles. */
  readonly offered: readonly AssistTarget[];
  /** Those people with their addresses and aliases. */
  readonly directory: readonly PersonCandidate[];
  /** Every address the item's own text gives. */
  readonly addresses: readonly string[];
  /** What the item lists under `people` already; null when nothing. */
  readonly listed: HeldField | null;
}

type Decided = { readonly step: AssistPersonStep | null } | { readonly question: string };

/** A step for each person named, once each; or the first question any of them raises. */
export function assistPeople(
  named: readonly AssistPersonAnswer[],
  facts: AssistPeopleFacts,
): { readonly steps: readonly AssistPersonStep[] } | { readonly question: string } {
  const offered = new Set(facts.offered.map((target) => target.path));
  const directory = facts.directory.filter((person) => offered.has(person.path));
  const steps: AssistPersonStep[] = [];
  for (const each of named) {
    const decided = personStep(each, { ...facts, directory });
    if ('question' in decided) return decided;
    if (decided.step !== null && !steps.some((step) => sameStep(step, decided.step!))) {
      steps.push(decided.step);
    }
  }
  return { steps };
}

function personStep(named: AssistPersonAnswer, facts: AssistPeopleFacts): Decided {
  const match = personMatch({ name: named.name, email: named.email, people: facts.directory });
  if (match.kind === 'near') return isThis(titleOf(match.people[0]!.path, facts));
  if (match.kind === 'exact') {
    const target = { path: match.person.path, title: titleOf(match.person.path, facts) };
    if (named.person !== target.path) return isThis(target.title);
    return linked(target, facts);
  }
  if (named.person !== null) return isThis(titleOf(named.person, facts));
  return added(named, facts);
}

const isThis = (title: string): Decided => ({ question: `Is this ${title}?` });

/** A person's title as the vault gives it: the offered note's, or its file name. */
function titleOf(path: string, facts: AssistPeopleFacts): string {
  return facts.offered.find((target) => target.path === path)?.title ?? path;
}

/** Linking someone, unless the item lists people already: then them, nothing; anyone else, a question. */
function linked(target: AssistTarget, facts: AssistPeopleFacts): Decided {
  if (facts.listed === null) return { step: { kind: 'link', person: target } };
  const listed = facts.listed;
  if (
    listed.resolved === target.path ||
    listed.written.some((name) => namesNote(name, target.path))
  ) {
    return { step: null };
  }
  return {
    question: `It lists ${heldWords(listed, facts.offered)}; Claude suggests ${target.title}.`,
  };
}

/** Adding someone nobody in People is like: only with an address the item gives, a name a note can take, and nobody listed. */
function added(named: AssistPersonAnswer, facts: AssistPeopleFacts): Decided {
  if (named.email === null) {
    return { question: `${named.name} is not in People, and the item gives no email. Add them?` };
  }
  if (!givesAddress(facts.addresses, named.email)) {
    return { question: `Claude gave an email for ${named.name} that the item does not hold.` };
  }
  const refusal = newPersonRefusal(named.name);
  if (refusal !== null) return { question: `${refusal}. Add them by hand?` };
  if (facts.listed !== null) {
    return {
      question: `It lists ${heldWords(facts.listed, facts.offered)}; Claude suggests adding ${named.name}.`,
    };
  }
  return { step: { kind: 'add', name: named.name, email: named.email } };
}

function sameStep(left: AssistPersonStep, right: AssistPersonStep): boolean {
  if (left.kind === 'link' && right.kind === 'link') return left.person.path === right.person.path;
  return left.kind === 'add' && right.kind === 'add' && left.name === right.name;
}
