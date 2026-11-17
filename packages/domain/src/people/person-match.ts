/**
 * Whether a name, and an address if one is given, is someone already in
 * People (#899, #906): exactly one person, someone near, or nobody. Inbox
 * assist links a person only on an exact match and adds one only when nobody
 * is near; everything between is a question.
 *
 * It reuses the possible-duplicates list's similarity (#464): names spelt as
 * the Terms page compares them, and addresses by `person-similarity.ts`, so a
 * name or address that list would call a likely duplicate is never "nobody".
 */

import { vocabularyKey } from '../terms/spelling.ts';
import { addressesMatch, addressParts, localPartsMatch } from './person-similarity.ts';
import type { DuplicateCandidate } from './possible-duplicates.ts';

/** A person as they are matched: their note, its title, their addresses and aliases. */
export type PersonCandidate = DuplicateCandidate;

/** How a name matched the people in the vault. */
export type PersonMatch =
  | { readonly kind: 'exact'; readonly person: PersonCandidate }
  /** Everyone it may be, surest first: a question names the first. */
  | { readonly kind: 'near'; readonly people: readonly PersonCandidate[] }
  | { readonly kind: 'none' };

/**
 * How `name` (and `email`, when given) matches `people`:
 *
 * - **exact** — the one person with that mailbox; or, with no address given,
 *   the one person of that name or alias;
 * - **near** — two or more with that mailbox or name; one of that name when an
 *   address is given that is not theirs; an address a typo or a first name
 *   from theirs; a name a typo or a first name from theirs;
 * - **none** — nobody like them.
 */
export function personMatch({
  name,
  email,
  people,
}: {
  name: string;
  email: string | null;
  people: readonly PersonCandidate[];
}): PersonMatch {
  const byMailbox = email === null ? [] : people.filter((person) => hasMailbox(person, email));
  if (byMailbox.length === 1) return { kind: 'exact', person: byMailbox[0]! };
  const byName = people.filter((person) => namedExactly(person, name));
  if (byMailbox.length === 0 && byName.length === 1 && email === null) {
    return { kind: 'exact', person: byName[0]! };
  }
  const near = unique([
    ...byMailbox,
    ...byName,
    ...people.filter((person) => nearByName(person, name)),
    ...(email === null ? [] : people.filter((person) => nearByAddress(person, email))),
  ]);
  return near.length === 0 ? { kind: 'none' } : { kind: 'near', people: near };
}

function unique(people: readonly PersonCandidate[]): PersonCandidate[] {
  return people.filter((person, at) => people.findIndex((p) => p.path === person.path) === at);
}

/** Whether two addresses reach one mailbox: the same address, a `+tag` aside. */
function sameMailbox(left: string, right: string): boolean {
  const a = addressParts(left);
  const b = addressParts(right);
  return a !== null && b !== null && a.local === b.local && a.domain === b.domain;
}

function hasMailbox(person: PersonCandidate, written: string): boolean {
  return person.emails.some((theirs) => sameMailbox(theirs, written));
}

const namesOf = (person: PersonCandidate) => [person.name, ...person.aliases];

function namedExactly(person: PersonCandidate, name: string): boolean {
  const key = vocabularyKey(name);
  return key !== '' && namesOf(person).some((each) => vocabularyKey(each) === key);
}

/** A name spelt as an address's local part, so the address rules compare names too: `mara.quill`. */
const asLocalPart = (name: string) => vocabularyKey(name).split(/\s+/u).join('.');

/** A name a first name from theirs, a typo apart, or the same with its spaces dropped. */
function nearByName(person: PersonCandidate, name: string): boolean {
  const local = asLocalPart(name);
  return namesOf(person).some(
    (each) => localPartsMatch(local, asLocalPart(each), { publicMail: false }) !== null,
  );
}

function nearByAddress(person: PersonCandidate, email: string): boolean {
  return person.emails.some((theirs) => addressesMatch(email, theirs) !== null);
}

/** What an address in prose looks like: no spaces, brackets or quotes, an `@` with a dotted domain. */
const ADDRESS = /[^\s<>()[\]{}"',;:]+@[^\s<>()[\]{}"',;:]+\.[^\s<>()[\]{}"',;:.]+/gu;

/** Every address `text` gives, as written. */
export function addressesIn(text: string): string[] {
  return [...text.matchAll(ADDRESS)].map((found) => found[0]);
}

/** Whether `email` is one of `given`, as a mailbox: an address the item itself holds. */
export function givesAddress(given: readonly string[], email: string): boolean {
  return given.some((written) => sameMailbox(written, email));
}
