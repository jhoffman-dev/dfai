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

import { isPublicMail } from '../meeting-links/attendee-matching.ts';
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

/** Whether `written` reaches one of their mailboxes. */
export function hasMailbox(person: PersonCandidate, written: string): boolean {
  return person.emails.some((theirs) => sameMailbox(theirs, written));
}

/** A person's name and aliases. */
export const namesOf = (person: PersonCandidate): readonly string[] => [
  person.name,
  ...person.aliases,
];

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

/** The address in `given` that is `email` exactly, as the item spells it; null when none is. */
export function heldAddress(given: readonly string[], email: string): string | null {
  if (addressParts(email) === null) return null;
  const wanted = email.trim().toLowerCase();
  return given.find((written) => written.trim().toLowerCase() === wanted) ?? null;
}

/** Words as names are compared: spelt as the Terms page compares them, letters and digits only. */
function nameWords(text: string): string[] {
  return vocabularyKey(text)
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter((word) => word !== '');
}

/** The most words of an item looked through for a name: a pasted page is not read to its end. */
export const MENTION_WORDS_MAX = 4_000;

/**
 * The item's prose: its words with addresses, links and paths taken out. A
 * name found only in `tobias.fenn@example.com` or `/team/mara-quill` is not
 * the item naming someone (#907).
 */
function proseWords(text: string): string[] {
  const prose = text
    .slice(0, MENTION_WORDS_MAX * 16)
    .split(/\s+/u)
    .filter((token) => !/[@/]|^www\./iu.test(token))
    .join(' ');
  return nameWords(prose).slice(0, MENTION_WORDS_MAX);
}

/** Whether `text` names `name` in its prose as whole words, in order: "Mara Quill" in "call mara quill today", not in "Maralyn". */
export function mentionsName(text: string, name: string): boolean {
  const wanted = nameWords(name);
  if (wanted.length === 0) return false;
  const words = proseWords(text);
  return words.some((_, at) => wanted.every((word, offset) => words[at + offset] === word));
}

/** How many words a name has, as names are compared: a name of one word is also a common word ("May", "Will"). */
export function nameWordCount(name: string): number {
  return nameWords(name).length;
}

/**
 * Whether `text` writes `email` as `name`'s own: "Wren Calloway
 * <wc1@example.org>", "Wren Calloway (wc1@example.org)", "Wren Calloway:
 * wc1@example.org" — the name starting its run of words, not the end of a
 * longer one ("Sarah Jane Smith" is not "Jane Smith"). A comma or anything
 * else between them ties nothing: in a list, the next address is the next
 * person's ("Tobias Fenn, wren@example.org, Mara Quill").
 */
export function addressBesideName(text: string, name: string, email: string): boolean {
  const wanted = nameWords(name);
  const address = email.trim().toLowerCase();
  if (wanted.length === 0) return false;
  for (const line of text.slice(0, MENTION_WORDS_MAX * 16).split(/\n/u)) {
    const tokens = line.split(/\s+/u).filter((token) => token !== '');
    const words = tokens.map((token) => nameWords(token).join(' '));
    for (let at = 0; at + wanted.length < tokens.length; at += 1) {
      if (!wanted.every((word, offset) => words[at + offset] === word)) continue;
      if (!startsRun(tokens[at - 1])) continue;
      const last = tokens[at + wanted.length - 1]!;
      if (writtenAs(last, tokens[at + wanted.length]!) === address) return true;
    }
  }
  return false;
}

/** Whether a name starting after `before` starts its run: at the line's start, after punctuation, or after a word without a capital. */
function startsRun(before: string | undefined): boolean {
  if (before === undefined) return true;
  return /[^\p{L}\p{N}]$/u.test(before) || !/^\p{Lu}/u.test(before);
}

/** The address `next` gives as the name's own after `last`, lower-cased; '' for none: `Name <a>`, `Name (a)`, `Name: a`. */
function writtenAs(last: string, next: string): string {
  if (/[\p{L}\p{N}]:$/u.test(last)) return next.replace(/^[<(]|[>)]?[.,;]*$/gu, '').toLowerCase();
  if (!/[\p{L}\p{N}]$/u.test(last)) return '';
  const bracketed = /^[<(]([^<>()]+)[>)][.,;:]*$/u.exec(next);
  return bracketed?.[1]?.toLowerCase() ?? '';
}

/**
 * Whether an address looks like theirs by its local part — `mara@`,
 * `mara.quill@` — wherever it is. At a public mail provider only their whole
 * name does: `tobias@gmail.com` is anyone called Tobias.
 */
export function addressNamesPerson(address: string, person: PersonCandidate): boolean {
  const parts = addressParts(address);
  if (parts === null) return false;
  return namesOf(person).some(
    (name) =>
      localPartsMatch(parts.local, asLocalPart(name), {
        publicMail: isPublicMail(parts.domain),
      }) !== null,
  );
}

/**
 * Whether an address may be theirs by its local part, at any provider: the
 * doubt a link asks about (`mara@gmail.com` beside "Mara Quill"), never the
 * evidence an add is planned on.
 */
export function addressMayBePerson(address: string, person: PersonCandidate): boolean {
  const parts = addressParts(address);
  if (parts === null) return false;
  return namesOf(person).some(
    (name) => localPartsMatch(parts.local, asLocalPart(name), { publicMail: false }) !== null,
  );
}

/** A name as a new person's are compared across a plan: case, accents and spacing aside. */
export function foldedPersonName(name: string): string {
  return vocabularyKey(name).normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/gu, '');
}

/** The mailbox an address reaches, `+tag` aside, as a key; null for text that is not an address. */
export function mailboxKey(written: string): string | null {
  const parts = addressParts(written);
  return parts === null ? null : `${parts.local}@${parts.domain}`;
}
