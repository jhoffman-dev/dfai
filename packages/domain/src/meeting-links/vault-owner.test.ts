import { describe, expect, it } from 'vitest';
import { createVaultPath } from '../vault/vault-path.ts';
import {
  isOwnerAttendee,
  ownerAddresses,
  ownerAddressesInUse,
  ownerNotAGroup,
} from './vault-owner.ts';

/** #173: an attendee is the vault's owner by the profile's name or by the vault's `selfEmails`. */
describe('isOwnerAttendee', () => {
  const attendee = (name: string, email: string | null) => ({ name, email, group: false });

  it('is the owner by an address alone, whatever name the attendee shows', () => {
    expect(
      isOwnerAttendee({
        attendee: attendee('mq', 'mara.quill@example.com'),
        selfName: null,
        selfEmails: ['mara.quill@example.com'],
      }),
    ).toBe(true);
  });

  it('compares addresses as a mail client writes them: case, spaces and `Name <address>`', () => {
    expect(
      isOwnerAttendee({
        attendee: attendee('mq', ' Mara Quill <MARA.Quill@Example.com> '),
        selfName: null,
        selfEmails: ['mara.quill@example.com'],
      }),
    ).toBe(true);
  });

  it('compares addresses in one Unicode form, however the setting was typed', () => {
    expect(
      isOwnerAttendee({
        attendee: attendee('ren', 'rén@example.com'),
        selfName: null,
        selfEmails: ['rén@example.com'],
      }),
    ).toBe(true);
    expect(
      isOwnerAttendee({
        attendee: attendee('ren', 'rén@example.com'),
        selfName: null,
        selfEmails: ['rén@example.com'],
      }),
    ).toBe(true);
  });

  it('is the owner by name alone, with no address set', () => {
    expect(
      isOwnerAttendee({
        attendee: attendee('Quill, Mara', null),
        selfName: 'Mara Quill',
        selfEmails: [],
      }),
    ).toBe(true);
  });

  it('is not the owner by neither: another name at another address', () => {
    expect(
      isOwnerAttendee({
        attendee: attendee('Tobias Fenn', 'tobias.fenn@example.com'),
        selfName: 'Mara Quill',
        selfEmails: ['mara.quill@example.com'],
      }),
    ).toBe(false);
    expect(
      isOwnerAttendee({
        attendee: attendee('mq', 'mara.quill@example.com'),
        selfName: null,
        selfEmails: [],
      }),
    ).toBe(false);
  });
});

describe('isOwnerAttendee, across a domain’s two forms', () => {
  const attendee = (email: string) => ({ name: 'mq', email, group: false });

  it('is the owner whichever form either side holds', () => {
    for (const [listed, set] of [
      ['mara@xn--bcher-kva.example', 'mara@bücher.example'],
      ['mara@bücher.example', 'mara@xn--bcher-kva.example'],
    ] as const) {
      expect(
        isOwnerAttendee({ attendee: attendee(listed), selfName: null, selfEmails: [set] }),
      ).toBe(true);
    }
  });

  it('is not the owner at another domain', () => {
    expect(
      isOwnerAttendee({
        attendee: attendee('mara@xn--bcher-kva.example'),
        selfName: null,
        selfEmails: ['mara@bucher.example'],
      }),
    ).toBe(false);
  });
});

describe('ownerAddressesInUse', () => {
  const owner = {
    path: createVaultPath('People/Mara Quill.md'),
    name: 'Mara Quill',
    emails: ['Mara.Quill@example.com'],
    aliases: [],
    company: null,
  };

  it('is the vault’s selfEmails alone once it holds any', () => {
    expect(
      ownerAddressesInUse({
        selfEmails: ['mq@example.org'],
        people: [owner],
        selfName: 'Mara Quill',
      }),
    ).toEqual(['mq@example.org']);
  });

  it('is the owner’s Person note’s addresses while selfEmails holds none', () => {
    expect(
      ownerAddressesInUse({ selfEmails: [], people: [owner], selfName: 'Mara Quill' }),
    ).toEqual(['mara.quill@example.com']);
    expect(ownerAddressesInUse({ selfEmails: [], people: [owner], selfName: null })).toEqual([]);
  });

  it('offers the Person note’s addresses as written, never in their ASCII form', () => {
    const unicode = { ...owner, emails: ['mara@bücher.example'] };
    expect(ownerAddresses([unicode], 'Mara Quill')).toEqual(['mara@bücher.example']);
  });
});

describe('ownerNotAGroup', () => {
  const team = { name: 'Studio', email: 'Team@Quill.example', group: true };
  const list = { name: 'All hands', email: 'all@quill.example', group: true };

  it('reads an attendee at one of selfEmails as a person, and leaves every other group a group', () => {
    expect(ownerNotAGroup([team, list], ['team@quill.example'])).toEqual([
      { ...team, group: false },
      list,
    ]);
  });

  it('changes nothing with no selfEmails', () => {
    const attendees = [team, list];
    expect(ownerNotAGroup(attendees, [])).toBe(attendees);
  });
});
