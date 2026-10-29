import { describe, expect, it } from 'vitest';
import { granolaNoteToFields } from '../meetings/mapping/granola-note.ts';
import { readAttendees } from '../meetings/mapping/meeting-attendees.ts';
import type { MeetingAttendee } from '../meetings/meeting-header.ts';
import { planPersonMerge, type MergeNote } from '../people/person-merge-plan.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import { matchAttendees, type DirectoryPerson } from './attendee-matching.ts';
import { isOwnerAttendee, sameAddress } from './vault-owner.ts';

/*
 * PR #604 attack (#199), end to end: an address that is another mailbox is
 * never linked, merged, or read as the owner. A missed match is acceptable.
 */

const attendee = (name: string, email: string | null): MeetingAttendee => ({
  name,
  email,
  group: false,
});

const person = (name: string, emails: string[]): DirectoryPerson => ({
  path: createVaultPath(`People/${name}.md`),
  name,
  emails,
  aliases: [],
  company: null,
});

const linkedPaths = (listed: string, people: DirectoryPerson[]) =>
  matchAttendees([attendee('M. Q.', listed)], people, []).linked.map((each) => each.person.path);

describe('Person matching never links a near-miss address', () => {
  it.each([
    ['a Cyrillic а in the local part', 'mаra@larkspur.example'],
    ['a Cyrillic а in the domain', 'mara@lаrkspur.example'],
    ['a ZWSP in the local part', 'ma​ra@larkspur.example'],
    ['a ZWSP in the domain', 'mara@lark​spur.example'],
    ['a ZWJ in the domain', 'mara@lark‍spur.example'],
    ['a fullwidth local part', 'ｍａｒａ@larkspur.example'],
  ])('links %s to its own note, not to mara@larkspur.example', (_, lookalike) => {
    const mara = person('Mara Quill', ['mara@larkspur.example']);
    const other = person('Mara Lookalike', [lookalike]);
    expect(linkedPaths(lookalike, [mara, other])).toEqual([other.path]);
    expect(linkedPaths('mara@larkspur.example', [mara, other])).toEqual([mara.path]);
  });

  it('links an attendee at a capital-Σ domain to the σ host DNS reads, not the ς one', () => {
    // UTS #46 reads `larkspur.ΟΔΟΣ` as xn--pxavbq (σ); `larkspur.οδος` is xn--pxavbm, another host.
    const finalSigma = person('Mara Final', ['mara@larkspur.οδος']);
    const medialSigma = person('Mara Medial', ['mara@larkspur.οδοσ']);
    expect(linkedPaths('mara@larkspur.ΟΔΟΣ', [finalSigma, medialSigma])).not.toContain(
      finalSigma.path,
    );
  });

  it('does not link `mara@www.larkspur.example` to the note at `mara@larkspur.example`', () => {
    // `www.larkspur.example` is another mail domain; hostKey's `www.` strip is for sites.
    const mara = person('Mara Quill', ['mara@larkspur.example']);
    expect(linkedPaths('mara@www.larkspur.example', [mara])).toEqual([]);
  });
});

describe('person merge keeps every other mailbox', () => {
  const note = (path: string, email: string): MergeNote => ({
    path: createVaultPath(path),
    properties: { type: 'person', email },
    body: '',
  });

  it('adds a homoglyph address the kept note does not hold', () => {
    const plan = planPersonMerge({
      kept: note('People/Mara Quill.md', 'mara@larkspur.example'),
      duplicates: [note('People/Mara.md', 'mаra@larkspur.example')],
    });
    expect(plan.emailsAdded).toEqual(['mаra@larkspur.example']);
  });

  it('adds a `Name <>` entry that is not the kept note’s `Name <>` entry', () => {
    const plan = planPersonMerge({
      kept: note('People/Mara Quill.md', 'Mara Quill <>'),
      duplicates: [note('People/Dana Reyes.md', 'Dana Reyes <>')],
    });
    expect(plan.emailsAdded).toEqual(['Dana Reyes <>']);
  });

  it('reads two empty `<>` addresses as two texts, not one address', () => {
    expect(sameAddress('Mara Quill <>', 'Dana Reyes <>')).toBe(false);
  });
});

describe('the owner is never read from a near-miss address', () => {
  const LA = 'America/Los_Angeles';
  const speakerOf = (ownerEmail: string, selfEmails: string[]) =>
    (
      granolaNoteToFields(
        {
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
        },
        { timeZone: LA, selfEmails },
      ).turns as { speaker: string }[]
    )[0]?.speaker;

  it.each([
    ['a Cyrillic а', 'mаra@larkspur.example'],
    ['a ZWSP', 'mara​@larkspur.example'],
    ['a fullwidth domain', 'mara@ｌａｒｋｓｐｕｒ.example'],
    ['an empty `<>`', 'Mara Quill <>'],
  ])('does not name the owner You at %s', (_, owner) => {
    expect(speakerOf(owner, ['mara@larkspur.example'])).toBe('Mara Quill');
  });

  it('does not name a ς-host owner You for a σ-host selfEmail', () => {
    expect(speakerOf('mara@larkspur.ΟΔΟΣ', ['mara@larkspur.οδος'])).toBe('Mara Quill');
  });

  it('does not read an attendee at a homoglyph as the owner', () => {
    expect(
      isOwnerAttendee({
        attendee: attendee('mq', 'mara@lаrkspur.example'),
        selfName: null,
        selfEmails: ['mara@larkspur.example'],
      }),
    ).toBe(false);
  });
});

describe('group detection never spreads to a near-miss address', () => {
  it.each([
    ['a Cyrillic а', 'payroll@lаrkspur.example'],
    ['a ZWSP', 'payroll​@larkspur.example'],
    ['a +tag', 'payroll+x@larkspur.example'],
    ['a subdomain', 'payroll@eu.larkspur.example'],
  ])('reads an attendee at %s as no group', (_, listed) => {
    const [read] = readAttendees(
      [{ name: 'Payroll', email: listed }],
      ['payroll@larkspur.example'],
    );
    expect(read?.group).toBeUndefined();
  });

  it('keeps two attendees whose addresses differ by a homoglyph', () => {
    const read = readAttendees(
      [
        { name: 'Mara Quill', email: 'mara@larkspur.example' },
        { name: 'Mara Lookalike', email: 'mаra@larkspur.example' },
      ],
      [],
    );
    expect(read).toHaveLength(2);
  });
});
