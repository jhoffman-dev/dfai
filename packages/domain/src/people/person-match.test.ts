import { describe, expect, it } from 'vitest';
import { createVaultPath } from '../vault/vault-path.ts';
import {
  addressesIn,
  addressNamesPerson,
  foldedPersonName,
  heldAddress,
  mailboxKey,
  mentionsName,
  personMatch,
  type PersonCandidate,
} from './person-match.ts';
import { isReservedEntryName } from '../vault/new-note.ts';

/**
 * #906: a name, and an address if one is given, is exactly one person in
 * People, someone near, or nobody — by the possible-duplicates list's rules.
 */

const person = (name: string, emails: string[] = [], aliases: string[] = []): PersonCandidate => ({
  path: createVaultPath(`People/${name}.md`),
  name,
  emails,
  aliases,
});
const MARA = person('Mara Quill', ['mara.quill@larkspur.example.com'], ['MQ']);
const TOBIAS = person('Tobias Fenn', ['tobias@example.com']);
const PEOPLE = [MARA, TOBIAS];

const match = (name: string, email: string | null = null, people = PEOPLE) =>
  personMatch({ name, email, people });
const nearNames = (name: string, email: string | null = null, people = PEOPLE) => {
  const found = match(name, email, people);
  return found.kind === 'near' ? found.people.map((each) => each.name) : found.kind;
};

describe('personMatch: exact', () => {
  it('is the one person of that name or alias, spelt as the Terms page compares', () => {
    expect(match('Mara Quill')).toEqual({ kind: 'exact', person: MARA });
    expect(match('  mara quill ')).toEqual({ kind: 'exact', person: MARA });
    expect(match('MQ')).toEqual({ kind: 'exact', person: MARA });
  });

  it('is the one person with that mailbox, a +tag aside, whatever name is given', () => {
    expect(match('M. Quill', 'Mara.Quill+payroll@larkspur.example.com')).toEqual({
      kind: 'exact',
      person: MARA,
    });
  });
});

describe('personMatch: near', () => {
  it('is one of that name when an address is given that is not theirs', () => {
    expect(nearNames('Mara Quill', 'mquill@elsewhere.example.org')).toEqual(['Mara Quill']);
  });

  it('is a first name, or a name a typo apart', () => {
    expect(nearNames('Mara')).toEqual(['Mara Quill']);
    expect(nearNames('Marra Quill')).toEqual(['Mara Quill']);
    expect(nearNames('MaraQuill')).toEqual(['Mara Quill']);
  });

  it('is an address a typo from theirs', () => {
    expect(nearNames('Someone', 'marra.quill@larkspur.example.com')).toEqual(['Mara Quill']);
  });

  it('is two people of one name, or one mailbox on two notes', () => {
    const twin = { ...person('Mara Quill'), path: createVaultPath('Contacts/Mara Quill.md') };
    expect(nearNames('Mara Quill', null, [MARA, twin])).toEqual(['Mara Quill', 'Mara Quill']);
    const shared = person('Payroll desk', ['tobias@example.com']);
    expect(nearNames('Desk', 'tobias@example.com', [TOBIAS, shared])).toEqual([
      'Tobias Fenn',
      'Payroll desk',
    ]);
  });
});

describe('personMatch: none', () => {
  it('is nobody like them', () => {
    expect(match('Wren Calloway', 'wren@example.org')).toEqual({ kind: 'none' });
    expect(match('Wren Calloway')).toEqual({ kind: 'none' });
    expect(match('Anyone', null, [])).toEqual({ kind: 'none' });
  });
});

describe('addressesIn and heldAddress', () => {
  it('finds the addresses prose gives, and holds one only as written, case aside', () => {
    const text = 'From: Tobias Fenn <Tobias.Fenn+news@example.com>, cc wren@example.org.\n';
    const found = addressesIn(text);
    expect(found).toEqual(['Tobias.Fenn+news@example.com', 'wren@example.org']);
    expect(heldAddress(found, 'tobias.fenn+NEWS@example.com')).toBe('Tobias.Fenn+news@example.com');
    expect(heldAddress(found, 'tobias.fenn@example.com')).toBeNull();
    expect(heldAddress(found, 'not an address')).toBeNull();
  });
});

describe('what an item’s own text says of a person (#907)', () => {
  it('names someone only as whole words, in order, case aside', () => {
    expect(mentionsName('Call MARA quill today', 'Mara Quill')).toBe(true);
    expect(mentionsName('Call Maralyn Quillson', 'Mara Quill')).toBe(false);
    expect(mentionsName('Quill, Mara', 'Mara Quill')).toBe(false);
    expect(mentionsName('anything', '  ')).toBe(false);
  });

  it('reads an address as theirs by its local part, wherever it is', () => {
    expect(addressNamesPerson('mara@other.example.net', MARA)).toBe(true);
    expect(addressNamesPerson('tobias@example.com', MARA)).toBe(false);
    expect(addressNamesPerson('not an address', MARA)).toBe(false);
  });

  it('folds new names and mailboxes as a plan compares them', () => {
    expect(foldedPersonName(' Tóbias  FENN ')).toBe(foldedPersonName('tobias fenn'));
    expect(mailboxKey('Tobi+x@Example.org')).toBe(mailboxKey('tobi@example.org'));
    expect(mailboxKey('nobody')).toBeNull();
  });

  it('knows the names no file can take', () => {
    expect(['CON', 'nul.txt', 'com1', 'LPT9'].every(isReservedEntryName)).toBe(true);
    expect(['Connie', 'Tobias Fenn', 'com'].some(isReservedEntryName)).toBe(false);
  });
});
