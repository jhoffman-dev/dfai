/**
 * Whose a meeting's action item is (P29-05): the rule that splits "mine"
 * from "waiting for". The model names an owner in words; who that is — the
 * vault's owner, a person the vault has a note for, a name it has none for,
 * or nobody it can name — is decided here, from the meeting's attendees, the
 * vault's people and the profile, never by the model.
 *
 * Only what is certain is a person. A name that could be two people, a group,
 * "everyone", and a name nobody in the meeting or the vault has are guesses,
 * and say so.
 */

import { matchAttendees, type DirectoryPerson } from '../meeting-links/attendee-matching.ts';
import {
  isOwnerAttendee,
  isOwnerNote,
  isSharedAddress,
  ownerAddressesInUse,
  ownerNotAGroup,
  sameAddress,
  sameName,
} from '../meeting-links/vault-owner.ts';
import type { MeetingAttendee } from '../meetings/meeting-header.ts';
import { isSelfSpeaker, isUnnamedSpeaker } from '../meetings/transcript.ts';
import { vocabularyKey } from '../terms/spelling.ts';
import type { VaultPath } from '../vault/vault-path.ts';

export type ItemOwner =
  /**
   * The vault's owner: the item is theirs to do. `doubt` is set when that
   * rests on a reading, and `shared` says which: "we", or the owner named
   * with others.
   */
  | { readonly kind: 'self'; readonly doubt?: string; readonly shared?: 'we' | 'with-others' }
  /** Someone the vault has exactly one Person note for. */
  | { readonly kind: 'person'; readonly name: string; readonly person: DirectoryPerson }
  /**
   * Someone named with no Person note to link. `inMeeting` is whether the
   * meeting lists them: a name that is neither is only the model's word.
   */
  | { readonly kind: 'named'; readonly name: string; readonly inMeeting: boolean }
  /** More than one person it could be, or more than one named: left for the person to say. */
  | { readonly kind: 'ambiguous'; readonly name: string; readonly candidates: readonly string[] }
  /** Nobody the answer could name: left for the person to say. */
  | { readonly kind: 'unknown' };

/** Who an item's owner may be found among. */
export interface OwnerDirectory {
  /** The meeting's attendees, as its frontmatter lists them. */
  readonly attendees: readonly MeetingAttendee[];
  readonly people: readonly DirectoryPerson[];
  /** The vault owner's name, from their profile. */
  readonly selfName: string | null;
  /** The vault owner's own addresses, the vault's `selfEmails`: an attendee at one is them. */
  readonly selfEmails: readonly string[];
  /** Who the meeting's transcript says spoke, as it writes them (`You`, `Mara`): none without one. */
  readonly speakers: readonly string[];
}

/**
 * The directory as an owner is looked up in it: with every name the owner
 * goes by, their own Person notes, and the transcript's speakers who are
 * surely not the vault's owner ({@link othersSpeaking}).
 */
interface OwnerSearch extends OwnerDirectory {
  readonly othersSpeaking: readonly string[];
  /**
   * The profile's name, and each name and alias of the owner's own Person
   * notes that tells them apart from everyone else in the meeting (#226).
   */
  readonly ownerNames: readonly string[];
  /**
   * The names and aliases of the owner's own Person notes that another
   * attendee or speaker also goes by, each with who else has it: such a name
   * could be either of them.
   */
  readonly sharedNames: ReadonlyMap<string, readonly string[]>;
  /** The owner's own Person notes ({@link ownersNotes}). */
  readonly ownerNotes: readonly VaultPath[];
}

/** Whether a name is one the owner goes by, in any common spelling. */
const isOwnersName = (name: string, { ownerNames }: Pick<OwnerSearch, 'ownerNames'>): boolean =>
  ownerNames.some((each) => sameName(name, each));

/** Whether an attendee is the owner: by any name they go by, or one of their addresses. */
function isOwnersAttendee(
  attendee: MeetingAttendee,
  search: Pick<OwnerSearch, 'ownerNames' | 'selfEmails'>,
): boolean {
  return (
    isOwnersName(attendee.name, search) ||
    isOwnerAttendee({ attendee, selfName: null, selfEmails: search.selfEmails })
  );
}

/** Words a model writes for the vault's owner besides `You`. */
const SELF_WORDS = /^(?:me|i|myself|mine)$/i;
/** Words for the speaker and some others: it is the owner's task to check. */
const WE_WORDS = /^(?:we|us|ourselves|both of us|the two of us)$/i;
/** Words a model writes when it could not tell, or meant many: none of them is a name. */
const NOBODY =
  /^(?:unknown|unclear|unassigned|nobody|no one|none|n\/?a|tbd|someone|somebody|everyone|everybody|all|all of us|the team|team|the group|not sure|unsure|to be decided|to be determined|\?+)$/i;
/** Between two owners of one item. */
const JOINT = /\s+(?:and|&|\+)\s+/i;
const ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/**
 * The owner as written, without what a model wraps a name in: a link's
 * brackets (reading `[[People/X|Y]]` as X), stars, a gloss in brackets or
 * after a colon, and the full stop of a sentence.
 */
function tidyOwner(written: string): string {
  return written
    .replace(/\[\[([^\]|#]*)(?:[|#][^\]]*)?\]\]/g, (_, target: string) => lastSegment(target))
    .replace(/[[\]*]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*\([^()]*\)\s*$/, '')
    .replace(/\s*:\s*the vault.s owner\.?$/i, '')
    .replace(/[.,;:!]+$/, '')
    .trim();
}

function lastSegment(target: string): string {
  return (target.split('/').pop() ?? '').replace(/\.md$/i, '').trim();
}

/** The full stop or other mark a sentence ends an owner with: no part of an address. */
const SENTENCE_END = /[.,;:!?]+$/;
/** Quotes and brackets around an owner, as a model writes `(mara@…)` or `“mara@…”`. */
const OPENING = /^["'“‘([]+/;
const CLOSING = /["'”’)\]]+$/;

/**
 * The owner without the sentence's end or the quotes and brackets around it,
 * however they nest (`(mara@example.com).`): each pass takes something off,
 * so it ends.
 */
function unwrapped(written: string): string {
  let text = written.trim();
  for (let before = ''; text !== before;) {
    before = text;
    text = text.replace(SENTENCE_END, '').replace(OPENING, '').replace(CLOSING, '').trim();
  }
  return text;
}

/**
 * An owner written as an address: bare, or the way a mail client copies it,
 * either one perhaps ending a sentence or in quotes or brackets. Null when it is a name.
 */
function addressOf(written: string): { name: string; email: string } | null {
  const text = unwrapped(written);
  const bracketed = /^(.*?)\s*<([^<>]+)>$/.exec(text);
  const email = (bracketed?.[2] ?? text).trim();
  if (!ADDRESS.test(email)) return null;
  const name = (bracketed?.[1] ?? '').replace(/^["']|["']$/g, '').trim();
  return { name: name === '' ? email : name, email };
}

const firstNameOf = (name: string): string => {
  const [last = '', first = ''] = name.includes(',') ? name.split(',') : [];
  return vocabularyKey((name.includes(',') ? first.trim() || last : name).split(/\s+/)[0] ?? '');
};

/**
 * The attendees an owner could be: those of that name or address, else —
 * for a first name alone — every attendee whose name starts with it, and
 * every speaker the transcript names who is no attendee and not the owner.
 */
function attendeesNamed(owner: { name: string; email: string | null }, directory: OwnerSearch) {
  const all = directory.attendees;
  if (owner.email !== null) {
    const addressed = all.filter(
      (each) => each.email !== null && sameAddress(each.email, owner.email!),
    );
    if (addressed.length > 0) return addressed;
  }
  const exact = all.filter((each) => sameName(each.name, owner.name));
  if (exact.length > 0) return exact;
  if (/\s/.test(owner.name) || owner.email !== null) return [];
  const unlisted = directory.othersSpeaking
    .filter((speaker) => !all.some((each) => sameName(each.name, speaker)))
    .map((speaker): MeetingAttendee => ({ name: speaker, email: null, group: false }));
  return [...all, ...unlisted].filter(
    (each) => !each.group && firstNameOf(each.name) === vocabularyKey(owner.name),
  );
}

/** Whether `name` is the profile's first name and no other attendee, or speaker, has it. */
function isOwnersFirstName(name: string, search: OwnerSearch): boolean {
  const { attendees, selfName, othersSpeaking } = search;
  if (selfName === null || /\s|@/.test(name)) return false;
  if (firstNameOf(selfName) !== vocabularyKey(name)) return false;
  const others = [
    ...attendees.filter((each) => !each.group && !sameName(each.name, selfName)),
    ...othersSpeaking.map((speaker) => ({ name: speaker })),
  ];
  return !others.some((each) => firstNameOf(each.name) === vocabularyKey(name));
}

/**
 * The transcript's speakers who are surely not the vault's owner. Once the
 * transcript has a label for the owner — `You`, or their name as the profile
 * or their own attendee entry spells it — every other named speaker is
 * someone else; a one-word label beside `You` too, even the profile's own
 * first name. Until then a one-word label could be the owner's, so only a
 * fuller name the owner does not have counts.
 */
function othersSpeaking({
  speakers,
  attendees,
  ownerNames,
  selfEmails,
}: Omit<OwnerSearch, 'othersSpeaking'>): string[] {
  const named = [...new Set(speakers.map((each) => each.trim()))].filter(
    (each) => each !== '' && !isUnnamedSpeaker(each),
  );
  const saysYou = named.some(isSelfSpeaker);
  const ownersNames = [
    ...ownerNames,
    ...attendees
      .filter((attendee) => isOwnersAttendee(attendee, { ownerNames, selfEmails }))
      .map((attendee) => attendee.name),
  ];
  const isOwners = (label: string) =>
    isSelfSpeaker(label) ||
    (!(saysYou && isOneWord(label)) && ownersNames.some((name) => sameName(label, name)));
  const knowsOwner = named.some(isOwners);
  return named.filter((label) => !isOwners(label) && (knowsOwner || !isOneWord(label)));
}

const isOneWord = (name: string): boolean => !/\s/.test(name.trim());

/**
 * Whether a one-word owner is somebody other than the vault's owner by that
 * very name: a speaker the transcript tells apart from the owner
 * ({@link othersSpeaking}), or — unless it is the profile's name — the one
 * Person note, not the owner's, that has it as its name or an alias. Either
 * outranks the owner's first name.
 */
function namesSomeoneElse(name: string, search: OwnerSearch): boolean {
  if (!isOneWord(name) || name.includes('@') || isSelfSpeaker(name) || SELF_WORDS.test(name)) {
    return false;
  }
  if (search.othersSpeaking.some((speaker) => sameName(speaker, name))) return true;
  const { people } = search;
  if (isOwnersName(name, search)) return false;
  const person = matchAttendees([{ name, email: null, group: false }], people, []).linked[0]
    ?.person;
  return person !== undefined && !search.ownerNotes.includes(person.path);
}

/** The search with nobody in it who is the vault's owner: for a name that is someone else's. */
function withoutTheOwner(search: OwnerSearch): OwnerSearch {
  const { attendees, people, ownerNotes } = search;
  return {
    ...search,
    attendees: attendees.filter((attendee) => !isOwnersAttendee(attendee, search)),
    people: people.filter((person) => !ownerNotes.includes(person.path)),
    selfName: null,
    ownerNames: [],
    sharedNames: new Map(),
    ownerNotes: [],
    selfEmails: [],
  };
}

/** Whether a single owner, with no and/&, is the vault's owner. */
function isSelf(owner: { name: string; email: string | null }, directory: OwnerSearch): boolean {
  const { name, email } = owner;
  if (email === null && (isSelfSpeaker(name) || SELF_WORDS.test(name))) return true;
  if (isOwnersName(name, directory)) return true;
  if (email === null && isOwnersFirstName(name, directory)) return true;
  // Only an attendee that is the one it could be: two of a first name are neither.
  const listed = attendeesNamed(owner, directory).filter((each) => !each.group);
  const attendee = (listed.length === 1 ? listed[0] : undefined) ?? { name, email, group: false };
  return isOwnersAttendee({ ...attendee, email: email ?? attendee.email }, directory);
}

function ownerOf(written: string): { name: string; email: string | null } {
  const address = addressOf(written);
  return address === null ? { name: tidyOwner(written), email: null } : address;
}

/**
 * Whose an item is, from the owner its answer wrote. `You` (as a transcript
 * writes the owner), any name the owner goes by — the profile's, or a name
 * or alias of their own Person note (#226) — in its common spellings, the
 * profile's first name when no other attendee or speaker has it, or any of
 * the owner's addresses is the owner; "we" is the owner's too, to check. A one-word
 * name the transcript gives another speaker, or a Person note other than the
 * owner's has, is never the owner ({@link namesSomeoneElse}). Any other name
 * or address is matched as an attendee is (`matchAttendees`): one person is
 * that person; a first name two attendees share, or several Person notes, is
 * ambiguous; a group, "everyone", blank, or what a provider calls a speaker
 * it could not name is nobody. Two owners ("You and Tobias") are not split
 * into two items: the owner's task when they are one of them, ambiguous
 * otherwise.
 */
export function itemOwner(written: string, directory: OwnerDirectory): ItemOwner {
  return ownerIn(written, asTheOwnerSaid(directory));
}

/**
 * The directory as the owner is found in it (ADR-0024 amendment): an
 * attendee at one of the vault's `selfEmails` is the owner even when a group
 * rule read their address as a group's, and with no `selfEmails` the
 * owner's own Person note's addresses are theirs, as before the setting. The
 * owner's own Person notes ({@link ownersNotes}) give the
 * other names and aliases the owner goes by (#226), as a meeting's
 * participants leave the owner out (#227); one another attendee or speaker
 * also goes by is not the owner's alone ({@link othersWithName}).
 */
function asTheOwnerSaid(directory: OwnerDirectory): OwnerSearch {
  const { attendees, people, selfName, selfEmails, speakers } = directory;
  const addresses = ownerAddressesInUse({ selfEmails, people, selfName });
  const mine = ownersNotes({ people, selfName, addresses });
  const listed = ownerNotAGroup(attendees, selfEmails);
  const ownerNames: string[] = selfName === null || selfName.trim() === '' ? [] : [selfName];
  const sharedNames = new Map<string, readonly string[]>();
  for (const name of mine.flatMap((person) => [person.name, ...person.aliases])) {
    if (name.trim() === '' || ownerNames.some((each) => sameName(each, name))) continue;
    const others = othersWithName(name, { attendees: listed, speakers, selfName, addresses });
    if (others.length === 0) ownerNames.push(name);
    else sharedNames.set(name, others);
  }
  const said = {
    attendees: listed,
    people,
    selfName,
    selfEmails: addresses,
    speakers,
    ownerNames,
    sharedNames,
    ownerNotes: mine.map((person) => person.path),
  };
  return { ...said, othersSpeaking: othersSpeaking(said) };
}

/**
 * The owner's own Person notes: the one the profile names — by its name, or
 * an alias that is the profile's name. Only with none is a note found by
 * address, and then only the one note at an address of the owner's that no
 * other note has: a note never becomes the owner's for sharing one address
 * with theirs, and a shared mailbox tells nobody apart (#226).
 */
function ownersNotes({
  people,
  selfName,
  addresses,
}: {
  people: readonly DirectoryPerson[];
  selfName: string | null;
  addresses: readonly string[];
}): readonly DirectoryPerson[] {
  const named = people.filter((person) => isOwnerNote(person, selfName));
  if (named.length > 0) return named;
  const own = addresses.filter((email) => !isSharedAddress(email, people));
  const addressed = people.filter((person) =>
    person.emails.some((email) => own.some((each) => sameAddress(each, email))),
  );
  return addressed.length === 1 ? addressed : [];
}

/**
 * Who else in the meeting goes by a name of the owner's Person note: an
 * attendee who is not the owner, or a speaker the transcript writes some
 * other way, whose name — or first name — it is. The speaker written by that
 * very name is the one in question, so is not counted. Empty when the name is
 * the owner's alone, as the profile's first name must be ({@link isOwnersFirstName}).
 */
function othersWithName(
  name: string,
  {
    attendees,
    speakers,
    selfName,
    addresses,
  }: {
    attendees: readonly MeetingAttendee[];
    speakers: readonly string[];
    selfName: string | null;
    addresses: readonly string[];
  },
): string[] {
  const attending = attendees
    .filter(
      (attendee) =>
        !attendee.group && !isOwnerAttendee({ attendee, selfName, selfEmails: addresses }),
    )
    .map((attendee) => attendee.name);
  const speaking = speakers.filter(
    (label) =>
      !isSelfSpeaker(label) &&
      !isUnnamedSpeaker(label) &&
      !sameName(label, name) &&
      (selfName === null || !sameName(label, selfName)),
  );
  const others = [...new Set([...attending, ...speaking].map((each) => each.trim()))];
  return others.filter(
    (other) => sameName(other, name) || firstNameOf(other) === vocabularyKey(name),
  );
}

function ownerIn(written: string, directory: OwnerSearch): ItemOwner {
  const whole = tidyOwner(written);
  const joint = jointOwners(whole);
  if (joint !== null) return jointOwner(joint, whole, directory);
  const owner = ownerOf(written);
  const { name } = owner;
  if (name === '' || isUnnamedSpeaker(name) || NOBODY.test(name)) return { kind: 'unknown' };
  if (owner.email === null && WE_WORDS.test(name)) {
    return {
      kind: 'self',
      doubt: 'Claude wrote “We”, which may be you or others, so check whose it is.',
      shared: 'we',
    };
  }
  const sharers = owner.email === null ? sharedName(name, directory) : undefined;
  if (sharers !== undefined) {
    return { kind: 'ambiguous', name, candidates: [directory.selfName ?? 'you', ...sharers] };
  }
  if (owner.email === null && namesSomeoneElse(name, directory)) {
    return otherOwner(owner, withoutTheOwner(directory));
  }
  if (isSelf(owner, directory)) return { kind: 'self' };
  return otherOwner(owner, directory);
}

/** Who else goes by a name of the owner's Person note, when another attendee or speaker has it too. */
function sharedName(name: string, { sharedNames }: OwnerSearch): readonly string[] | undefined {
  for (const [shared, others] of sharedNames) if (sameName(name, shared)) return others;
  return undefined;
}

function jointOwners(whole: string): string[] | null {
  const parts = whole.split(JOINT).map((part) => part.trim());
  return parts.length > 1 && parts.every((part) => part !== '') ? parts : null;
}

function jointOwner(parts: readonly string[], whole: string, directory: OwnerSearch): ItemOwner {
  const owners = parts.map((part) => ({ part, owner: ownerIn(part, directory) }));
  const others = owners.filter(({ owner }) => owner.kind !== 'self').map(({ part }) => part);
  if (others.length < owners.length) {
    const named = others.length === 0 ? 'others' : others.join(' and ');
    return {
      kind: 'self',
      doubt: `Claude named you and ${named} for this, and an item has one owner: it is yours, so check who else is on it.`,
      shared: 'with-others',
    };
  }
  return { kind: 'ambiguous', name: whole, candidates: parts };
}

/** Someone who is not the owner: the person they are, or the guess they are. */
function otherOwner(
  owner: { name: string; email: string | null },
  directory: OwnerSearch,
): ItemOwner {
  const { people } = directory;
  const named = attendeesNamed(owner, directory);
  // A group took nothing on: a list is not who an item waits on.
  if (named.length > 0 && named.every((each) => each.group)) return { kind: 'unknown' };
  const listed = named.filter((each) => !each.group);
  if (listed.length > 1) {
    return { kind: 'ambiguous', name: owner.name, candidates: listed.map((each) => each.name) };
  }
  const attendee = listed[0] ?? { name: owner.name, email: owner.email, group: false };
  if (isOwnersAttendee(attendee, directory)) {
    return { kind: 'self' };
  }
  const matching = matchAttendees([attendee], people, []);
  const person = matching.linked[0]?.person;
  if (person !== undefined) {
    return directory.ownerNotes.includes(person.path)
      ? { kind: 'self' }
      : { kind: 'person', name: person.name, person };
  }
  const several = matching.ambiguous[0]?.candidates;
  if (several !== undefined) {
    return {
      kind: 'ambiguous',
      name: attendee.name,
      candidates: several.map((each) => each.name).sort(),
    };
  }
  return { kind: 'named', name: attendee.name, inMeeting: listed.length === 1 };
}
