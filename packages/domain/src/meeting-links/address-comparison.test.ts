import { describe, expect, it } from 'vitest';
import { granolaNoteToFields } from '../meetings/mapping/granola-note.ts';
import { readAttendees } from '../meetings/mapping/meeting-attendees.ts';
import type { MeetingAttendee } from '../meetings/meeting-header.ts';
import { planPersonMerge, type MergeNote } from '../people/person-merge-plan.ts';
import { addressParts } from '../people/person-similarity.ts';
import { readAddresses } from '../profile/email-addresses.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import {
  emailDomain,
  matchAttendees,
  type DirectoryCompany,
  type DirectoryPerson,
} from './attendee-matching.ts';
import { meetingParticipants, participantOwnerOf } from './meeting-series.ts';
import { isOwnerAttendee, ownerNotAGroup } from './vault-owner.ts';

/*
 * #199: every place that compares two addresses reads them as one key, so
 * an address is the same one however it was typed or sent — its case, its
 * Unicode form, its domain as punycode or Unicode, `Name <address>`, the
 * spaces round it, a final dot on its domain. A `+tag` stays its own address.
 */

/** Mara's address in the forms a calendar, Granola, n8n or a person may write it. */
const MARA_FORMS = [
  'mara@bücher.example',
  'mara@xn--bcher-kva.example',
  'Mara@Bücher.Example',
  ' mara@bücher.example. ',
  'Mara Quill <MARA@xn--bcher-kva.example>',
] as const;

const attendee = (name: string, email: string | null, group = false): MeetingAttendee => ({
  name,
  email,
  group,
});

const person = (name: string, emails: string[]): DirectoryPerson => ({
  path: createVaultPath(`People/${name}.md`),
  name,
  emails,
  aliases: [],
  company: null,
});

const pairs = MARA_FORMS.flatMap((left) => MARA_FORMS.map((right) => [left, right] as const));

describe('Person matching (attendee-matching)', () => {
  it.each(pairs)('links an attendee at %j to the Person note holding %j', (listed, onFile) => {
    const mara = person('Mara Quill', [onFile]);
    const matching = matchAttendees([attendee('M. Q.', listed)], [mara], []);
    expect(matching.linked.map((each) => each.person.path)).toEqual([mara.path]);
    expect(matching.linked[0]?.by).toBe('email');
  });

  it('links a `+tag` address to the note holding it exactly, not to the untagged one', () => {
    const tagged = person('Mara Payroll', ['mara+payroll@xn--bcher-kva.example']);
    const plain = person('Mara Quill', ['mara@bücher.example']);
    const matching = matchAttendees(
      [attendee('M', 'Mara+Payroll@Bücher.example.')],
      [plain, tagged],
      [],
    );
    expect(matching.linked.map((each) => each.person.path)).toEqual([tagged.path]);
  });

  it('reads an address’s domain in one form for its company', () => {
    expect(emailDomain('mara@Bücher.Example.')).toBe('xn--bcher-kva.example');
    const company: DirectoryCompany = {
      path: createVaultPath('Companies/Bücher.md'),
      name: 'Bücher',
      aliases: [],
      domains: ['bücher.example'],
    };
    const matching = matchAttendees(
      [attendee('Lena Ortiz', 'lena@xn--bcher-kva.example')],
      [],
      [company],
    );
    expect(matching.unknown[0]?.company?.path).toBe(company.path);
  });

  it('lists an attendee written twice, in two forms, once', () => {
    const matching = matchAttendees(
      [attendee('Lena', 'lena@bücher.example'), attendee('Lena', 'LENA@xn--bcher-kva.example.')],
      [],
      [],
    );
    expect(matching.unknown).toHaveLength(1);
  });
});

describe('people: dedupe and merge', () => {
  it('splits addresses in one form for the possible-duplicates list', () => {
    expect(addressParts('Mara Quill <Mara@Bücher.Example.>')).toEqual(
      addressParts('mara@xn--bcher-kva.example'),
    );
  });

  it('adds no merged address the kept note already holds in another form', () => {
    const note = (path: string, email: string): MergeNote => ({
      path: createVaultPath(path),
      properties: { type: 'person', email },
      body: '',
    });
    const plan = planPersonMerge({
      kept: note('People/Mara Quill.md', 'mara@bücher.example'),
      duplicates: [
        note('People/Mara.md', 'Mara@xn--bcher-kva.example.'),
        note('People/M Quill.md', 'mara+payroll@bücher.example'),
      ],
    });
    expect(plan.emailsAdded).toEqual(['mara+payroll@bücher.example']);
  });
});

describe('the vault owner (vault-owner, meeting-series)', () => {
  it.each(pairs)('is the owner at %j when selfEmails holds %j', (listed, set) => {
    expect(
      isOwnerAttendee({ attendee: attendee('mq', listed), selfName: null, selfEmails: [set] }),
    ).toBe(true);
  });

  it('reads the owner’s address as a person, not a group, in any form', () => {
    const [read] = ownerNotAGroup(
      [attendee('team', 'Team@xn--bcher-kva.example.', true)],
      ['team@bücher.example'],
    );
    expect(read?.group).toBe(false);
  });

  it('is one participant of a series whichever form a meeting lists', () => {
    const owner = participantOwnerOf({ people: [], selfName: null, selfEmails: [] });
    const keysOf = (email: string) =>
      meetingParticipants({ attendees: [attendee('Lena', email)], people: [], owner });
    expect(keysOf('Lena Ortiz <LENA@xn--bcher-kva.example.>')).toEqual(
      keysOf('lena@bücher.example'),
    );
  });
});

describe('the mapper: Granola "me" and group addresses (meetings/mapping)', () => {
  const LA = 'America/Los_Angeles';
  const note = (ownerEmail: string) => ({
    id: 'not_4kTq2mWxLp4Rz7',
    object: 'note',
    owner: { name: 'Mara Quill', email: ownerEmail },
    title: 'Larkspur Payroll renewal',
    web_url: 'https://notes.granola.ai/d/0b6c1d2e',
    calendar_event: null,
    attendees: [],
    summary_text: 'Agreed.',
    summary_markdown: null,
    private_notes_text: null,
    private_notes_markdown: null,
    transcript: [
      {
        speaker: { source: 'speaker', attribution: 'me' },
        text: 'Hello.',
        start_time: '2026-10-06T17:00:01Z',
        end_time: '2026-10-06T17:00:01Z',
      },
    ],
  });
  const speakerOf = (ownerEmail: string, selfEmails: string[]) =>
    (
      granolaNoteToFields(note(ownerEmail), { timeZone: LA, selfEmails }).turns as {
        speaker: string;
      }[]
    )[0]?.speaker;

  it.each(pairs)('names the owner at %j "You" when selfEmails holds %j', (owner, set) => {
    expect(speakerOf(owner, [set])).toBe('You');
  });

  it('names the owner, not You, at another mailbox of theirs (`+tag`)', () => {
    expect(speakerOf('mara+payroll@bücher.example', ['mara@bücher.example'])).toBe('Mara Quill');
  });

  // An attendee's address is bare (the mapper reads `Name <address>` apart); the setting may hold any form.
  const BARE_FORMS = MARA_FORMS.filter((each) => !each.includes('<'));

  it.each(BARE_FORMS.flatMap((listed) => MARA_FORMS.map((set) => [listed, set] as const)))(
    'reads an attendee at %j as a group when groupAddresses holds %j',
    (listed, set) => {
      const [read] = readAttendees([{ name: 'Payroll', email: listed }], [set]);
      expect(read?.group).toBe(true);
    },
  );

  it('reads a `+tag` address as no group the untagged one is', () => {
    const [read] = readAttendees(
      [{ name: 'Mara', email: 'mara+payroll@bücher.example' }],
      ['mara@bücher.example'],
    );
    expect(read?.group).toBeUndefined();
  });

  it('lists one attendee for one address written in two forms, keeping the first as written', () => {
    const read = readAttendees(
      [
        { name: 'Lena Ortiz', email: 'lena@bücher.example' },
        { name: 'Lena', email: 'LENA@xn--bcher-kva.example' },
      ],
      [],
    );
    expect(read).toEqual([{ name: 'Lena Ortiz', email: 'lena@bücher.example' }]);
  });
});

describe('the selfEmails setting (profile)', () => {
  it('keeps one address typed twice in two forms once', () => {
    const reading = readAddresses('mara@bücher.example, MARA@xn--bcher-kva.example');
    expect(reading).toEqual({ ok: true, emails: ['mara@bücher.example'] });
  });
});
