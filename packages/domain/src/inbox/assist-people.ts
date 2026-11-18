/**
 * The people an Inbox item names, and what Inbox assist would do about each
 * (#899, #906): link someone already in People, add someone new, or ask.
 *
 * A line is planned only when the item's own text and the vault confirm it,
 * with Claude merely agreeing: Claude's names and addresses are never
 * evidence on their own (#907).
 *
 * - **Links** someone Claude picked, offered to it, whom the item holds one
 *   of the addresses of, or whose full name (two words or more: one word is
 *   also a common word) its prose gives as whole words — never a name found
 *   only in an address or a link — and nothing in it says otherwise: an
 *   address Claude gives them that is not theirs, an address with their name
 *   that is not theirs, or someone else of that name.
 * - **Would add** someone the item's prose names in full, under an address it
 *   holds exactly and ties to them (the address names them, or is written
 *   right beside their name), whom nobody in People (the Archive included)
 *   is exactly or nearly, nor any other add planned, and whose cleaned name
 *   is no note's title already.
 * - Anything between is a question, naming the vault's own person where there is one.
 *
 * Never over what is written: an item that lists people already keeps them. A
 * suggestion it lists adds nothing; one it does not is a question.
 */

import { namesNote } from '../automations/proposal-schema.ts';
import { isArchivedPath } from '../archive/archive.ts';
import { newPersonRefusal } from '../people/person.ts';
import {
  addressBesideName,
  addressNamesPerson,
  foldedPersonName,
  hasMailbox,
  heldAddress,
  mailboxKey,
  mentionsName,
  nameWordCount,
  namesOf,
  personMatch,
  type PersonCandidate,
} from '../people/person-match.ts';
import { vocabularyKey } from '../terms/spelling.ts';
import { cleanEntryName, isReservedEntryName } from '../vault/new-note.ts';
import type { AssistPersonAnswer } from './assist-answer.ts';
import { heldWords, type HeldField } from './assist-held.ts';
import type { AssistTarget } from './assist-plan.ts';

/** What would be done about one person an item names. */
export type AssistPersonStep =
  | { readonly kind: 'link'; readonly person: AssistTarget }
  /** A new person: their cleaned name, and the address exactly as the item gives it. */
  | { readonly kind: 'add'; readonly name: string; readonly email: string };

/** What the people rules read: the vault's people and what the item itself holds. */
export interface AssistPeopleFacts {
  /** The people Claude was offered, by the vault's own titles. */
  readonly offered: readonly AssistTarget[];
  /** Everyone in People with their addresses and aliases, the Archive's included. */
  readonly directory: readonly PersonCandidate[];
  /** The item's own words: its title and its text. */
  readonly text: string;
  /** Every address the item's own text gives. */
  readonly addresses: readonly string[];
  /** What the item lists under `people` already; null when nothing. */
  readonly listed: HeldField | null;
  /** Names, folded by {@link foldedPersonName}, that a note of any type has as its title already. */
  readonly takenTitles: ReadonlySet<string>;
}

type Decided = { readonly step: AssistPersonStep | null } | { readonly question: string };

/** A step for each person named, once each; or the first question any of them raises. */
export function assistPeople(
  named: readonly AssistPersonAnswer[],
  facts: AssistPeopleFacts,
): { readonly steps: readonly AssistPersonStep[] } | { readonly question: string } {
  const steps: AssistPersonStep[] = [];
  for (const each of named) {
    const decided = each.person === null ? added(each, facts) : linkedTo(each, facts);
    if ('question' in decided) return decided;
    const step = decided.step;
    if (step === null || steps.some((earlier) => sameStep(earlier, step))) continue;
    const clash = step.kind === 'add' ? clashingAdd(step, steps) : undefined;
    if (clash !== undefined && step.kind === 'add') {
      const oneMailbox = mailboxKey(clash.email) === mailboxKey(step.email);
      return {
        question: oneMailbox
          ? `Is ${step.email} ${step.name}’s address?`
          : `Is ${step.name} the same as ${clash.name}?`,
      };
    }
    steps.push(step);
  }
  return { steps };
}

/** A new person as the vault's people are matched, to match planned adds against one another. */
const asCandidate = (step: { name: string; email: string }): PersonCandidate => ({
  // Not a note yet: its address stands in for a path, which matching only tells apart by.
  path: step.email as PersonCandidate['path'],
  name: step.name,
  emails: [step.email],
  aliases: [],
});

/**
 * The earlier planned add that `step` may be: the same mailbox, the same name
 * but for case, accents or spacing, or one the vault's near match would call
 * them (#907). Undefined when it is nobody planned.
 */
export function clashingAdd(
  step: Extract<AssistPersonStep, { kind: 'add' }>,
  earlier: readonly AssistPersonStep[],
): Extract<AssistPersonStep, { kind: 'add' }> | undefined {
  const adds = earlier.filter((each) => each.kind === 'add');
  return adds.find(
    (each) =>
      sameStep(each, step) ||
      personMatch({ name: step.name, email: step.email, people: [asCandidate(each)] }).kind !==
        'none',
  );
}

/**
 * The names a plan may add, cleaned: each person Claude named with an
 * address and picked nobody for. Whether a note has one as its title already
 * is read for these alone.
 */
export function assistNewNames(
  answers: readonly { people: readonly AssistPersonAnswer[] }[],
): string[] {
  const names = answers.flatMap((answer) =>
    answer.people
      .filter((each) => each.person === null && each.email !== null)
      .map((each) => cleanEntryName(each.name))
      .filter((name) => name !== ''),
  );
  return [...new Set(names)];
}

/** Whether two steps are one: the same person linked, or one new person by the same name at the same mailbox. */
export function sameStep(left: AssistPersonStep, right: AssistPersonStep): boolean {
  if (left.kind === 'link' || right.kind === 'link') {
    return left.kind === 'link' && right.kind === 'link' && left.person.path === right.person.path;
  }
  return (
    mailboxKey(left.email) === mailboxKey(right.email) &&
    foldedPersonName(left.name) === foldedPersonName(right.name)
  );
}

/** Linking the person Claude picked: only when the item's own text names them, and nothing in it says otherwise. */
function linkedTo(named: AssistPersonAnswer, facts: AssistPeopleFacts): Decided {
  const target = facts.offered.find((each) => each.path === named.person);
  if (target === undefined) return { question: OFF_LIST };
  const person = facts.directory.find((each) => each.path === target.path) ?? {
    path: target.path,
    name: target.title,
    emails: [],
    aliases: [],
  };
  if (named.email !== null) {
    const held = heldAddress(facts.addresses, named.email);
    if (held === null) return { question: unmentionedEmail(target.title) };
    if (!hasMailbox(person, held)) return isThis(target.title);
  }
  const byAddress = facts.addresses.some((address) => hasMailbox(person, address));
  if (byAddress) return linked(target, facts);
  // A name is evidence only in full: one word ("May", "Will") is also a common word.
  const fullNames = namesOf(person).filter((name) => nameWordCount(name) >= 2);
  if (!fullNames.some((name) => mentionsName(facts.text, name))) return isThis(target.title);
  if (facts.addresses.some((address) => addressNamesPerson(address, person))) {
    return isThis(target.title);
  }
  const namesakes = facts.directory.filter(
    (other) => other.path !== person.path && shareAName(other, person),
  );
  return namesakes.length > 0 ? which([person, ...namesakes]) : linked(target, facts);
}

function shareAName(left: PersonCandidate, right: PersonCandidate): boolean {
  const keys = new Set(namesOf(right).map(vocabularyKey));
  return namesOf(left).some((name) => keys.has(vocabularyKey(name)));
}

/** What an answer's pick of a person it was not offered becomes. */
export const OFF_LIST =
  'Claude suggested a task or person that isn’t in your vault. Check this one by hand.';

const isThis = (title: string): Decided => ({ question: `Is this ${title}?` });

const unmentionedEmail = (name: string) =>
  `Claude gave an email for ${name} that this item doesn’t mention.`;

/** "Which Mara: Mara Quill or Mara Stone?" — by the first name they share, or "person". */
function which(people: readonly PersonCandidate[]): Decided {
  const firsts = new Set(people.map((each) => each.name.trim().split(/\s+/u)[0] ?? ''));
  const first = firsts.size === 1 ? [...firsts][0]! : 'person';
  return { question: `Which ${first}: ${people.map((each) => each.name).join(' or ')}?` };
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

/**
 * Adding someone Claude picked nobody for: only when the item's prose names
 * them in full, under an address it holds exactly and that is tied to them —
 * the address names them, or is written right beside their name — and the
 * vault leaves no doubt.
 */
function added(named: AssistPersonAnswer, facts: AssistPeopleFacts): Decided {
  const name = cleanEntryName(named.name);
  const email = named.email === null ? null : heldAddress(facts.addresses, named.email);
  if (named.email !== null && email === null) return { question: unmentionedEmail(name) };
  if (!mentionsName(facts.text, named.name)) {
    const fromAddress = email !== null && addressNamesPerson(email, asCandidate({ name, email }));
    if (fromAddress) return { question: `Add ${name} from ${email}?` };
    return { question: 'Claude named someone this item doesn’t mention.' };
  }
  const known = knownAlready(named.name, email, facts.directory);
  if (known !== null) return known;
  if (email === null) {
    return { question: `${name} is not in People, and the item gives no email. Add them?` };
  }
  if (nameWordCount(name) < 2) return { question: `Add ${name} to People?` };
  if (!tiedTo(email, name, facts)) return { question: `Is ${email} ${name}’s address?` };
  const unusable = unusableName(name, facts.takenTitles);
  if (unusable !== null) return { question: unusable };
  if (facts.listed !== null) {
    return {
      question: `It lists ${heldWords(facts.listed, facts.offered)}; Claude suggests adding ${name}.`,
    };
  }
  return { step: { kind: 'add', name, email } };
}

/** Whether the item ties `email` to `name`: the address names them, or is written right beside their name. */
function tiedTo(email: string, name: string, facts: AssistPeopleFacts): boolean {
  if (addressNamesPerson(email, asCandidate({ name, email }))) return true;
  return addressBesideName(facts.text, name, email);
}

/** The question when someone in People, the Archive included, is them or may be; null when nobody is. */
function knownAlready(
  name: string,
  email: string | null,
  directory: readonly PersonCandidate[],
): Decided | null {
  const match = personMatch({ name, email, people: directory });
  if (match.kind === 'none') return null;
  const people = match.kind === 'exact' ? [match.person] : match.people;
  const archived = people.find((each) => isArchivedPath(each.path));
  if (archived !== undefined)
    return { question: `${archived.name} is in your Archive. Is this them?` };
  return people.length > 1 ? which(people) : isThis(people[0]!.name);
}

/** Why a new person's note cannot take this name, in a question; null when it can. */
function unusableName(name: string, taken: ReadonlySet<string>): string | null {
  if (name === '' || isReservedEntryName(name))
    return 'Claude named someone no note can be called. Add them by hand?';
  if (taken.has(foldedPersonName(name))) return `A note is called ${name} already. Is this them?`;
  const refusal = newPersonRefusal(name);
  return refusal === null ? null : `${refusal}. Add them by hand?`;
}
