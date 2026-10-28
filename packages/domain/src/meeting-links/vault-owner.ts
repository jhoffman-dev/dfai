import type { MeetingAttendee } from '../meetings/meeting-header.ts';
import { emailKey } from '../meetings/mapping/meeting-email-key.ts';
import { vocabularyKey } from '../terms/spelling.ts';
import type { DirectoryPerson } from './attendee-matching.ts';

/**
 * A name as people write it, in the forms a profile and an attendee list
 * differ by: as written, and `Last, First` turned round. Spelt as the Terms
 * page compares spellings (composed, single-spaced, case folded).
 */
function nameForms(name: string): string[] {
  const forms = [vocabularyKey(name)];
  const parts = name.split(',');
  if (parts.length === 2) {
    const [last = '', first = ''] = parts;
    forms.push(vocabularyKey(`${first.trim()} ${last.trim()}`));
  }
  return forms.filter((form) => form !== '');
}

/** Whether two names are one, in the spellings a profile and an attendee list differ by. */
export function sameName(left: string, right: string): boolean {
  const wanted = new Set(nameForms(right));
  return nameForms(left).some((form) => wanted.has(form));
}

/**
 * An address as offered to keep in `selfEmails`: the part in `<…>` when
 * written as a mail client copies it, composed and case folded. What is
 * shown and kept, not what is compared ({@link emailKey}).
 */
function writtenAddress(email: string): string {
  const bracketed = /<([^<>]+)>\s*$/.exec(email)?.[1] ?? email;
  return bracketed.normalize('NFC').trim().toLowerCase();
}

/** Whether two addresses are one ({@link emailKey}); blank text is no address, so never one. */
export function sameAddress(left: string, right: string): boolean {
  const key = emailKey(left);
  return key !== '' && key === emailKey(right);
}

/**
 * Whether an address is on more than one Person note: a shared or group
 * mailbox, which tells nobody apart, so it never says who the owner is (#226).
 */
export function isSharedAddress(email: string, people: readonly DirectoryPerson[]): boolean {
  const holders = people.filter((person) => person.emails.some((each) => sameAddress(each, email)));
  return holders.length > 1;
}

/** Whether a person's note is the owner's: its name or an alias is the profile's. */
export function isOwnerNote(person: DirectoryPerson, selfName: string | null): boolean {
  return (
    selfName !== null && [person.name, ...person.aliases].some((form) => sameName(form, selfName))
  );
}

/**
 * The addresses on the vault owner's own Person note: the person whose name —
 * or alias — is the profile's. Offered for the person to keep as
 * `selfEmails`, and read as theirs only while the vault keeps none
 * ({@link ownerAddressesInUse}).
 */
export function ownerAddresses(
  people: readonly DirectoryPerson[],
  selfName: string | null,
): string[] {
  const mine = people.filter((person) => isOwnerNote(person, selfName));
  const addresses = mine.flatMap(({ emails }) => emails.map(writtenAddress));
  return [...new Set(addresses)].filter((email) => email !== '');
}

/**
 * Whether an attendee is the vault's owner: their name is the profile's in
 * any common spelling (`Last, First`, case, spacing), or their address is
 * one of the vault's `selfEmails`. Never proposed as someone new.
 */
export function isOwnerAttendee({
  attendee,
  selfName,
  selfEmails,
}: {
  attendee: MeetingAttendee;
  selfName: string | null;
  selfEmails: readonly string[];
}): boolean {
  if (selfName !== null && sameName(attendee.name, selfName)) return true;
  if (attendee.email === null) return false;
  const { email } = attendee;
  return selfEmails.some((each) => sameAddress(email, each));
}

/**
 * The addresses that are the vault's owner (ADR-0024 amendment): the vault's
 * `selfEmails` (or Granola's older key in its place) once it holds any, and
 * then only those; while it holds none, the addresses on the owner's own
 * Person note, as before the setting existed, so a vault that never set it
 * links and assigns as it did.
 */
export function ownerAddressesInUse({
  selfEmails,
  people,
  selfName,
}: {
  selfEmails: readonly string[];
  people: readonly DirectoryPerson[];
  selfName: string | null;
}): readonly string[] {
  return selfEmails.length > 0 ? selfEmails : ownerAddresses(people, selfName);
}

/**
 * The attendees, with any at one of the vault's `selfEmails` read as the
 * person they are rather than a group: the owner said that address is
 * theirs, which outweighs the guess a group rule makes from its spelling
 * (`team@…`). Only `selfEmails` does this: the Person note's addresses are
 * not the owner's word.
 */
export function ownerNotAGroup(
  attendees: readonly MeetingAttendee[],
  selfEmails: readonly string[],
): readonly MeetingAttendee[] {
  if (selfEmails.length === 0) return attendees;
  const mine = new Set(selfEmails.map(emailKey).filter((key) => key !== ''));
  return attendees.map((attendee) =>
    attendee.group && attendee.email !== null && mine.has(emailKey(attendee.email))
      ? { ...attendee, group: false }
      : attendee,
  );
}
