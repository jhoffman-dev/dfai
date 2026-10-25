import { describe, expect, it } from 'vitest';
import type { VaultPath } from '@dfai/domain';
import { acceptProposalNote } from '../proposals/accept-proposal.ts';
import { listProposals } from '../proposals/list-proposals.ts';
import { MEETING_BODY } from '../testing/meeting-files.ts';
import {
  jsonLinesMarkdown,
  jsonLinesNote,
  proposalVault,
  vaultPath,
  type ProposalVault,
} from '../testing/proposal-vault.ts';
import { atlasQueryIndex } from '../testing/query-index.ts';
import { linkMeeting, MeetingLinkRefusedError, type MeetingLinkPorts } from './link-meeting.ts';
import { undoMeetingLink } from './undo-meeting-link.ts';

const TODAY = '2026-10-06';
const MEETING = 'Inbox/Meetings/2026-10-06 Standup.md';

const meeting = (
  attendees: readonly Record<string, unknown>[],
  more: Record<string, unknown> = {},
) =>
  jsonLinesNote(
    {
      type: 'meeting',
      atlas_import: 'meeting/v1',
      atlas_import_outcome: 'imported',
      title: 'Standup',
      date: '2026-10-06',
      start: '09:30',
      provider: 'gemini',
      external_id: 'gemini-7f3a9c21',
      attendees,
      ...more,
    },
    MEETING_BODY,
  );

/** A meeting whose summary names nobody and which has no transcript: its attendees alone say who was there. */
const unspokenMeeting = (attendees: readonly Record<string, unknown>[]) =>
  jsonLinesNote(
    {
      type: 'meeting',
      atlas_import: 'meeting/v1',
      atlas_import_outcome: 'imported',
      title: 'Standup',
      date: '2026-10-06',
      start: '09:30',
      provider: 'gemini',
      external_id: 'gemini-unspoken',
      attendees,
      project: '[[Ledger migration]]',
    },
    '\n## Summary\n\nStandup.\n',
  );

const PEOPLE = {
  'People/Mara Quill.md': jsonLinesNote({
    type: 'person',
    email: 'mara@larkspur.example',
    company: '[[Larkspur Payroll]]',
  }),
  'People/Tobias Fenn.md': jsonLinesNote({ type: 'person', aliases: ['Toby'] }),
  'People/Tobias Lin.md': jsonLinesNote({ type: 'person', aliases: ['Toby'] }),
  'Companies/Larkspur Payroll.md': jsonLinesNote({
    type: 'company',
    domains: ['larkspur.example'],
  }),
  'Projects/Ledger migration.md': jsonLinesNote({
    type: 'project',
    status: 'active',
    owner: '[[Mara Quill]]',
  }),
  '.atlas/types/meeting.md': jsonLinesNote({
    name: 'meeting',
    properties: {
      people: { kind: 'relation', target: 'person', many: true },
      companies: { kind: 'relation', target: 'company', many: true },
      project: { kind: 'relation', target: 'project' },
    },
  }),
};

const MARA = { name: 'Mara Quill', email: 'mara@larkspur.example' };
const ADA = { name: 'Ada Venn', email: 'ada@larkspur.example' };

/** A vault whose index holds these notes as the files are now: it lags whatever is written after. */
function vault(files: Record<string, string>): { setup: ProposalVault; ports: MeetingLinkPorts } {
  const setup = proposalVault({ ...PEOPLE, ...files });
  const query = atlasQueryIndex({ files: { ...PEOPLE, ...files }, markdown: jsonLinesMarkdown() });
  return { setup, ports: { ...setup.ports, index: { ...setup.ports.index, query } } };
}

const link = (ports: MeetingLinkPorts, selfName: string | null = null) =>
  linkMeeting({ ports, path: vaultPath(MEETING), today: TODAY, selfName });

const proposalsIn = (setup: ProposalVault) =>
  setup.paths().filter((path) => path.startsWith('Inbox/Proposals/'));

describe('linkMeeting', () => {
  it('links an attendee whose email matches a person, and their company, without a proposal', async () => {
    const { setup, ports } = vault({ [MEETING]: meeting([MARA]) });
    const run = await link(ports);
    expect(setup.propertiesOf(MEETING)).toMatchObject({
      people: ['[[Mara Quill]]', '[[Tobias Fenn]]'],
      companies: ['[[Larkspur Payroll]]'],
    });
    expect(run.linked).toEqual([
      'People/Mara Quill.md',
      'People/Tobias Fenn.md',
      'Companies/Larkspur Payroll.md',
    ]);
    expect(run.done).toEqual([
      {
        kind: 'set',
        path: MEETING,
        key: 'people',
        before: { absent: true },
        after: { value: ['[[Mara Quill]]', '[[Tobias Fenn]]'] },
      },
      {
        kind: 'set',
        path: MEETING,
        key: 'companies',
        before: { absent: true },
        after: { value: ['[[Larkspur Payroll]]'] },
      },
    ]);
    expect(proposalsIn(setup).filter((path) => !path.includes('Ledger'))).toEqual([]);
  });

  it('links the transcript’s named speakers who are surely people', async () => {
    const { setup, ports } = vault({ [MEETING]: meeting([]) });
    await link(ports);
    // The transcript's speakers are Mara Quill and Tobias Fenn (MEETING_BODY).
    expect(setup.propertiesOf(MEETING)?.['people']).toEqual(['[[Mara Quill]]', '[[Tobias Fenn]]']);
  });

  it('proposes an unknown attendee as a person; accepting makes them and links the meeting', async () => {
    const { setup, ports } = vault({ [MEETING]: meeting([MARA, ADA]) });
    const run = await link(ports);
    const open = (await listProposals(setup.ports)).open.map(({ proposal }) => proposal);
    const person = open.find((proposal) => proposal.kind === 'person');
    expect(person?.payload).toMatchObject({
      title: 'Ada Venn',
      properties: { email: 'ada@larkspur.example', company: '[[Larkspur Payroll]]' },
      linkFrom: { note: MEETING, property: 'people' },
    });
    expect(run.proposed).toContain(person?.path);

    await acceptProposalNote({ via: 'app', ports: setup.ports, path: person!.path, today: TODAY });

    expect(setup.propertiesOf('People/Ada Venn.md')).toEqual({
      type: 'person',
      email: 'ada@larkspur.example',
      company: '[[Larkspur Payroll]]',
    });
    expect(setup.propertiesOf(MEETING)?.['people']).toEqual([
      '[[Mara Quill]]',
      '[[Tobias Fenn]]',
      '[[Ada Venn]]',
    ]);
  });

  it('refuses to accept a person while their meeting has unsaved typing, making no one', async () => {
    const { setup, ports } = vault({
      [MEETING]: meeting([ADA], { project: '[[Ledger migration]]' }),
    });
    const [person] = (await link(ports)).proposed;
    setup.dirty.add(MEETING);
    await expect(
      acceptProposalNote({ via: 'app', ports: setup.ports, path: person!, today: TODAY }),
    ).rejects.toThrow(/unsaved typing/);
    expect(setup.paths()).not.toContain('People/Ada Venn.md');
  });

  it('proposes each person an alias could be, linking neither, and never a group', async () => {
    const team = { name: 'Payroll team', email: 'team@larkspur.example', group: true };
    // No transcript: its speakers would link Tobias Fenn, which answers the ambiguity.
    const untranscribed = meeting([{ name: 'Toby' }, team]).replace(/## Transcript[\s\S]*$/, '');
    const { setup, ports } = vault({ [MEETING]: untranscribed });
    await link(ports);
    const open = (await listProposals(setup.ports)).open.map(({ proposal }) => proposal);
    const proposed = open.map(({ kind, payload }) => [
      kind,
      'link' in payload ? payload.link : payload.title,
    ]);
    expect(proposed.sort()).toEqual([
      ['link', '[[Tobias Fenn]]'],
      ['link', '[[Tobias Lin]]'],
    ]);
    expect(setup.propertiesOf(MEETING)?.['people']).toBeUndefined();
    expect(setup.propertiesOf(MEETING)?.['companies']).toEqual(['[[Larkspur Payroll]]']);
  });

  it('proposes the open project its people are tied to, once, for a meeting with none', async () => {
    const { setup, ports } = vault({ [MEETING]: meeting([MARA]) });
    await link(ports);
    const open = (await listProposals(setup.ports)).open.map(({ proposal }) => proposal);
    expect(open.map(({ kind, confidence, payload }) => [kind, confidence, payload])).toEqual([
      [
        'link',
        'medium',
        {
          note: MEETING,
          property: 'project',
          link: '[[Ledger migration]]',
          digest: null,
          meeting: { provider: 'gemini', externalId: 'gemini-7f3a9c21' },
        },
      ],
    ]);
  });

  it('proposes nothing twice, however often it runs — the index lagging its own writes', async () => {
    const { setup, ports } = vault({ [MEETING]: meeting([MARA, ADA]) });
    await link(ports);
    const first = proposalsIn(setup);
    const again = await link(ports);
    expect(again.proposed).toEqual([]);
    expect(again.done).toEqual([]);
    expect(proposalsIn(setup)).toEqual(first);
  });

  it('does not propose again what was answered and archived — for another meeting too', async () => {
    const answered = jsonLinesNote({
      type: 'proposal',
      kind: 'person',
      state: 'rejected',
      // Rejected from some earlier meeting: it is the person who was answered, not that meeting's card.
      proposal_id: 'meeting links:person:email:ada@larkspur.example',
      payload: { title: 'Ada Venn' },
    });
    const { setup, ports } = vault({
      [MEETING]: meeting([ADA], { project: '[[Ledger migration]]' }),
      'Archive/Inbox/Proposals/Ada Venn — Standup.md': answered,
    });
    const run = await link(ports);
    expect(run.proposed).toEqual([]);
    expect(proposalsIn(setup)).toEqual([]);
  });

  it('never proposes the vault’s owner', async () => {
    const { setup, ports } = vault({
      [MEETING]: meeting([{ name: 'James Hoffman', email: 'james@home.example' }], {
        project: '[[Ledger migration]]',
      }),
    });
    await link(ports, 'James Hoffman');
    expect(proposalsIn(setup)).toEqual([]);
  });

  it.each(['Hoffman, James', '  james   hoffman '])(
    'never proposes the vault’s owner however the attendee list spells them (%j)',
    async (spelling) => {
      const { setup, ports } = vault({
        [MEETING]: meeting([{ name: spelling, email: 'jh@elsewhere.example' }], {
          project: '[[Ledger migration]]',
        }),
      });
      await link(ports, 'James Hoffman');
      expect(proposalsIn(setup)).toEqual([]);
    },
  );

  it('never proposes an attendee at one of the vault’s selfEmails, with no name or Person note for the owner (#173)', async () => {
    const files = {
      [MEETING]: meeting([{ name: 'mq', email: 'MQ@Home.example' }], {
        project: '[[Ledger migration]]',
      }),
    };
    const owned = vault(files);
    const unowned = vault(files);

    await linkMeeting({
      ports: owned.ports,
      path: vaultPath(MEETING),
      today: TODAY,
      selfName: null,
      selfEmails: ['mq@home.example'],
    });
    await link(unowned.ports);

    expect(proposalsIn(owned.setup)).toEqual([]);
    // With no address set, the same attendee is someone new.
    expect(proposalsIn(unowned.setup)).toHaveLength(1);
  });

  it('links an attendee at one of the vault’s selfEmails as the owner, though a group rule made it a group (#173)', async () => {
    const files = { [MEETING]: unspokenMeeting([{ ...MARA, group: true }]) };
    const owned = vault(files);
    const unowned = vault(files);

    const run = await linkMeeting({
      ports: owned.ports,
      path: vaultPath(MEETING),
      today: TODAY,
      selfName: null,
      selfEmails: ['mara@larkspur.example'],
    });
    await link(unowned.ports);

    expect(run.linked).toContain('People/Mara Quill.md');
    expect(owned.setup.propertiesOf(MEETING)?.['people']).toEqual(['[[Mara Quill]]']);
    // Without the owner's word for it, the group stays a group: nobody is linked.
    expect(unowned.setup.propertiesOf(MEETING)?.['people']).toBeUndefined();
  });

  describe('where the owner’s addresses come from (#173)', () => {
    /**
     * A second note at Mara's address: matching alone cannot say which of the
     * two `mq` is, and no transcript speaker says either.
     */
    const files = {
      'People/M Quill.md': jsonLinesNote({ type: 'person', email: 'mara@larkspur.example' }),
      [MEETING]: unspokenMeeting([{ name: 'mq', email: 'mara@larkspur.example' }]),
    };

    it('reads the owner’s Person note’s addresses as theirs while selfEmails holds none', async () => {
      const { setup, ports } = vault(files);
      await linkMeeting({ ports, path: vaultPath(MEETING), today: TODAY, selfName: 'Mara Quill' });
      expect(proposalsIn(setup)).toEqual([]);
    });

    it('reads only selfEmails once it holds any, and asks about the attendee the note’s address no longer settles', async () => {
      const { setup, ports } = vault(files);
      await linkMeeting({
        ports,
        path: vaultPath(MEETING),
        today: TODAY,
        selfName: 'Mara Quill',
        selfEmails: ['mq@home.example'],
      });
      expect(proposalsIn(setup).length).toBeGreaterThan(0);
    });
  });

  it('leaves a meeting with unsaved typing as it is, and says so', async () => {
    const { setup, ports } = vault({ [MEETING]: meeting([MARA]) });
    setup.dirty.add(MEETING);
    const run = await link(ports);
    expect(run.done).toEqual([]);
    expect(run.linked).toEqual([]);
    expect(run.left).toEqual([
      { path: MEETING, reason: expect.stringMatching(/unsaved typing/) as string },
    ]);
    expect(setup.propertiesOf(MEETING)?.['people']).toBeUndefined();
  });

  it('leaves a relation holding something other than links, and says so', async () => {
    const { setup, ports } = vault({
      [MEETING]: meeting([MARA], {
        people: { lead: '[[Tobias Fenn]]' },
        project: '[[Ledger migration]]',
      }),
    });
    const run = await link(ports);
    expect(setup.propertiesOf(MEETING)?.['people']).toEqual({ lead: '[[Tobias Fenn]]' });
    expect(setup.propertiesOf(MEETING)?.['companies']).toEqual(['[[Larkspur Payroll]]']);
    expect(run.left).toEqual([
      {
        path: MEETING,
        reason: 'Its people holds something other than links, so it was left as it is.',
      },
    ]);
  });

  it('passes on a fault reading the meeting, rather than calling it missing', async () => {
    const { ports } = vault({ [MEETING]: meeting([]) });
    const failing = {
      ...ports,
      fs: { ...ports.fs, readTextFile: async () => Promise.reject(new Error('disk on fire')) },
    };
    await expect(link(failing)).rejects.toThrow('disk on fire');
  });

  it('refuses what is not a meeting, or not there', async () => {
    const { ports } = vault({ [MEETING]: jsonLinesNote({ type: 'task' }) });
    await expect(link(ports)).rejects.toThrow(MeetingLinkRefusedError);
    const { ports: empty } = vault({});
    await expect(link(empty)).rejects.toThrow(/no meeting at/);
  });
});

describe('undoMeetingLink', () => {
  it('puts the relations back and takes away its open proposals', async () => {
    const { setup, ports } = vault({ [MEETING]: meeting([MARA, ADA]) });
    const before = setup.propertiesOf(MEETING);
    const run = await link(ports);
    const undone = await undoMeetingLink({ ports, run, today: TODAY });
    expect(setup.propertiesOf(MEETING)).toEqual(before);
    expect(proposalsIn(setup)).toEqual([]);
    expect(undone.withdrawn).toEqual(run.proposed);
    expect(undone.restored.map(({ kind }) => kind)).toEqual(['restored', 'restored']);
  });

  it('keeps a relation changed since, and a proposal already answered', async () => {
    const { setup, ports } = vault({ [MEETING]: meeting([MARA, ADA]) });
    const run = await link(ports);
    const person = run.proposed.find((path) => path.includes('Ada Venn')) as VaultPath;
    await acceptProposalNote({ via: 'app', ports: setup.ports, path: person, today: TODAY });
    const undone = await undoMeetingLink({ ports, run, today: TODAY });
    expect(setup.propertiesOf(MEETING)?.['people']).toEqual([
      '[[Mara Quill]]',
      '[[Tobias Fenn]]',
      '[[Ada Venn]]',
    ]);
    expect(setup.propertiesOf(MEETING)?.['companies']).toBeUndefined();
    expect(undone.left.map(({ path }) => path)).toEqual([MEETING, person]);
  });

  it('leaves a proposal with unsaved typing, or gone since, and says why', async () => {
    const { setup, ports } = vault({ [MEETING]: meeting([MARA, ADA, { name: 'Odile' }]) });
    const run = await link(ports);
    const [typing, gone] = run.proposed.filter((path) => !path.includes('Ledger'));
    setup.dirty.add(typing!);
    await ports.fs.trashEntry({ path: gone! });
    const undone = await undoMeetingLink({ ports, run, today: TODAY });
    expect(undone.left).toEqual([
      { path: typing, reason: 'It has unsaved typing, so it was left as it is.' },
      { path: gone, reason: expect.any(String) as string },
    ]);
    expect(setup.paths()).toContain(typing);
  });

  it('puts back only what linking declares it writes', async () => {
    const { setup, ports } = vault({ [MEETING]: meeting([], { title: 'Kept' }) });
    const forged = {
      meeting: vaultPath(MEETING),
      linked: [],
      done: [
        {
          kind: 'set' as const,
          path: vaultPath(MEETING),
          key: 'title',
          before: { value: 'Other' },
          after: { value: 'Kept' },
        },
        {
          kind: 'set' as const,
          path: vaultPath('People/Mara Quill.md'),
          key: 'people',
          before: { absent: true as const },
          after: { value: [] },
        },
      ],
      filed: null,
      proposed: [],
      left: [],
      passedOver: [],
      unproposed: null,
    };
    const undone = await undoMeetingLink({ ports, run: forged, today: TODAY });
    expect(undone.restored).toEqual([]);
    expect(setup.propertiesOf(MEETING)?.['title']).toBe('Kept');
  });
});
