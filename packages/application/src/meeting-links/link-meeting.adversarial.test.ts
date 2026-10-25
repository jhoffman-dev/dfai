import { describe, expect, it } from 'vitest';
import type { VaultPath } from '@dfai/domain';
import { archiveNotes } from '../archive/archive-notes.ts';
import { processInboxItems } from '../inbox/process-inbox.ts';
import { acceptProposalNote } from '../proposals/accept-proposal.ts';
import { MEETING_BODY } from '../testing/meeting-files.ts';
import {
  jsonLinesMarkdown,
  jsonLinesNote,
  proposalVault,
  vaultPath,
  type ProposalVault,
} from '../testing/proposal-vault.ts';
import { atlasQueryIndex } from '../testing/query-index.ts';
import { linkMeeting, type MeetingLinkPorts } from './link-meeting.ts';

const TODAY = '2026-10-06';
const MEETING = 'Inbox/Meetings/2026-10-06 Standup.md';
const OTHER_MEETING = 'Inbox/Meetings/2026-10-07 Standup.md';
const PROJECT = 'Projects/Ledger migration.md';

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
      // A project already: only the person proposals are in play.
      project: '[[Ledger migration]]',
      ...more,
    },
    MEETING_BODY,
  );

const VAULT = {
  'People/Mara Quill.md': jsonLinesNote({ type: 'person', email: 'mara@larkspur.example' }),
  'People/Tobias Fenn.md': jsonLinesNote({ type: 'person' }),
  [PROJECT]: jsonLinesNote({ type: 'project', status: 'active' }),
  '.atlas/types/meeting.md': jsonLinesNote({
    name: 'meeting',
    properties: {
      people: { kind: 'relation', target: 'person', many: true },
      companies: { kind: 'relation', target: 'company', many: true },
      project: { kind: 'relation', target: 'project' },
    },
  }),
};

const ADA = { name: 'Ada Venn', email: 'ada@larkspur.example' };

/** A vault whose index holds these notes as the files are now: it lags whatever is written after. */
function vault(files: Record<string, string>): { setup: ProposalVault; ports: MeetingLinkPorts } {
  const setup = proposalVault({ ...VAULT, ...files });
  const query = atlasQueryIndex({ files: { ...VAULT, ...files }, markdown: jsonLinesMarkdown() });
  return { setup, ports: { ...setup.ports, index: { ...setup.ports.index, query } } };
}

const link = (ports: MeetingLinkPorts, path = MEETING) =>
  linkMeeting({ ports, path: vaultPath(path), today: TODAY });

/** The ports with an index that has read every note as it is now: what it is a moment after a sync. */
function freshIndex(setup: ProposalVault): ProposalVault['ports'] {
  const files = Object.fromEntries(
    [...setup.fixture.files].map(([path, note]) => [path, note.text]),
  );
  const query = atlasQueryIndex({ files, markdown: jsonLinesMarkdown() });
  return { ...setup.ports, index: { ...setup.ports.index, query } };
}

const fileUnderProject = (setup: ProposalVault) =>
  processInboxItems({
    ports: setup.ports,
    paths: [vaultPath(MEETING)],
    notePaths: setup.paths().map(vaultPath),
    project: vaultPath(PROJECT),
    today: TODAY,
    updateLinks: true,
  });

const personProposal = (proposed: readonly VaultPath[]) =>
  proposed.find((path) => path.includes('Ada Venn')) as VaultPath;

describe('linking a meeting, adversarially', () => {
  it('a person proposed from a meeting can still be accepted once the meeting is filed', async () => {
    const { setup, ports } = vault({ [MEETING]: meeting([ADA]) });
    const person = personProposal((await link(ports)).proposed);
    // The Inbox's Process files the meeting under its project, as it does every Inbox note.
    const filed = await processInboxItems({
      ports: setup.ports,
      paths: [vaultPath(MEETING)],
      notePaths: setup.paths().map(vaultPath),
      project: vaultPath(PROJECT),
      today: TODAY,
      updateLinks: true,
    });
    const moved = filed.moves[0]?.move.to as string;
    // Filed out of the older Inbox/Meetings into the meeting's month (#214).
    expect(moved).toMatch(/^Meetings\/2026\/10\//);

    await acceptProposalNote({ via: 'app', ports: setup.ports, path: person, today: TODAY });

    expect(setup.paths()).toContain('People/Ada Venn.md');
    expect(setup.propertiesOf(moved)?.['people']).toContain('[[Ada Venn]]');
  });

  it('an accept that cannot link the meeting leaves no new person behind', async () => {
    const { setup, ports } = vault({ [MEETING]: meeting([ADA]) });
    const person = personProposal((await link(ports)).proposed);
    const failing = {
      ...setup.ports,
      fs: {
        ...setup.ports.fs,
        writeTextFile: (write: Parameters<typeof setup.ports.fs.writeTextFile>[0]) =>
          write.path === MEETING
            ? Promise.reject(new Error('disk full'))
            : setup.ports.fs.writeTextFile(write),
      },
    };

    await expect(
      acceptProposalNote({ via: 'app', ports: failing, path: person, today: TODAY }),
    ).rejects.toThrow();

    // The proposal is still open; the person it would make must not exist without it.
    expect(setup.paths()).not.toContain('People/Ada Venn.md');
  });

  it('two people from one meeting accepted at once are both linked, or the refused one is not made', async () => {
    const ben = { name: 'Ben Aldous', email: 'ben@larkspur.example' };
    const { setup, ports } = vault({ [MEETING]: meeting([ADA, ben]) });
    const { proposed } = await link(ports);
    const ada = personProposal(proposed);
    const benProposal = proposed.find((path) => path.includes('Ben Aldous')) as VaultPath;

    // Accepting the Inbox's proposals one after another without waiting, as a quick reader does.
    await Promise.allSettled([
      acceptProposalNote({ via: 'app', ports: setup.ports, path: ada, today: TODAY }),
      acceptProposalNote({ via: 'app', ports: setup.ports, path: benProposal, today: TODAY }),
    ]);

    const people = (setup.propertiesOf(MEETING)?.['people'] ?? []) as string[];
    for (const name of ['Ada Venn', 'Ben Aldous']) {
      const made = setup.paths().includes(`People/${name}.md`);
      expect({ name, made, linked: people.includes(`[[${name}]]`) }).toEqual({
        name,
        made,
        linked: made,
      });
    }
  });

  it('accepting a person the meeting already links in another spelling adds no second link', async () => {
    const { setup, ports } = vault({
      [MEETING]: meeting([ADA], { people: ['[[ada venn]]'] }),
    });
    const person = personProposal((await link(ports)).proposed);

    await acceptProposalNote({ via: 'app', ports: setup.ports, path: person, today: TODAY });

    const people = setup.propertiesOf(MEETING)?.['people'] as string[];
    expect(people.filter((item) => item.toLowerCase() === '[[ada venn]]')).toHaveLength(1);
  });

  it('proposes nothing twice on a re-run when two meetings’ proposals share a name', async () => {
    const { setup, ports } = vault({
      [MEETING]: meeting([ADA]),
      [OTHER_MEETING]: meeting([ADA], { external_id: 'gemini-0b1c2d3e', date: '2026-10-07' }),
    });
    await link(ports, MEETING);
    await link(ports, OTHER_MEETING);
    const before = setup.paths().filter((path) => path.startsWith('Inbox/Proposals/'));

    // The index has not caught up with either write yet.
    const again = await link(ports, OTHER_MEETING);

    expect(again.proposed).toEqual([]);
    expect(setup.paths().filter((path) => path.startsWith('Inbox/Proposals/'))).toEqual(before);
  });

  describe('a proposal is input: it never redirects a write', () => {
    const OTHER = 'Notes/Other note.md';
    const other = jsonLinesNote({ type: 'note', title: 'Other note' });

    it('refuses a person proposal whose meeting was archived since, writing nothing in the Archive', async () => {
      const { setup, ports } = vault({ [MEETING]: meeting([ADA]) });
      const person = personProposal((await link(ports)).proposed);
      const archived = await archiveNotes({
        ports: setup.ports,
        paths: [vaultPath(MEETING)],
        notePaths: setup.paths().map(vaultPath),
        today: TODAY,
      });
      const there = archived.moves[0]?.move.to as string;
      expect(there).toMatch(/^Archive\//);
      const before = setup.fixture.files.get(there)?.text;

      await expect(
        acceptProposalNote({ via: 'app', ports: freshIndex(setup), path: person, today: TODAY }),
      ).rejects.toThrow(/archived/);

      expect(setup.fixture.files.get(there)?.text).toBe(before);
      expect(setup.paths()).not.toContain('People/Ada Venn.md');
      expect(setup.paths()).toContain(person);
    });

    it('does not write the note a hand-edited source names when the meeting is gone', async () => {
      const { setup, ports } = vault({ [MEETING]: meeting([ADA]), [OTHER]: other });
      const person = personProposal((await link(ports)).proposed);
      const edited = setup.fixture.files
        .get(person)
        ?.text.replace(/\[\[2026-10-06 Standup\]\]/, '[[Other note]]') as string;
      setup.fixture.files.set(person, {
        ...(setup.fixture.files.get(person) as object),
        text: edited,
      } as never);
      setup.fixture.files.delete(MEETING);

      await acceptProposalNote({
        via: 'app',
        ports: freshIndex(setup),
        path: person,
        today: TODAY,
      });

      expect(setup.fixture.files.get(OTHER)?.text).toBe(other);
      expect(setup.propertiesOf(OTHER)?.['people']).toBeUndefined();
    });

    it('does not take a hand-edited source for the meeting unless it is that meeting', async () => {
      const { setup, ports } = vault({ [MEETING]: meeting([ADA]), [OTHER]: other });
      const person = personProposal((await link(ports)).proposed);
      const filed = (await fileUnderProject(setup)).moves[0]?.move.to as string;
      const edited = setup.fixture.files
        .get(person)
        ?.text.replace(/\[\[2026-10-06 Standup\]\]/, '[[Other note]]') as string;
      setup.fixture.files.set(person, {
        ...(setup.fixture.files.get(person) as object),
        text: edited,
      } as never);

      await acceptProposalNote({
        via: 'app',
        ports: freshIndex(setup),
        path: person,
        today: TODAY,
      });

      expect(setup.fixture.files.get(OTHER)?.text).toBe(other);
      // The index knows the filed meeting by its id, whatever the source says.
      expect(setup.propertiesOf(filed)?.['people']).toContain('[[Ada Venn]]');
    });

    it('writes to the filed meeting, not to a newer meeting now at the Inbox path', async () => {
      const { setup, ports } = vault({ [MEETING]: meeting([ADA]) });
      const person = personProposal((await link(ports)).proposed);
      const filed = (await fileUnderProject(setup)).moves[0]?.move.to as string;
      const newer = meeting([], { external_id: 'gemini-other-meeting' });
      setup.fixture.files.set(MEETING, {
        ...(setup.fixture.files.get(filed) as object),
        text: newer,
      } as never);

      await acceptProposalNote({
        via: 'app',
        ports: freshIndex(setup),
        path: person,
        today: TODAY,
      });

      expect(setup.fixture.files.get(MEETING)?.text).toBe(newer);
      expect(setup.propertiesOf(filed)?.['people']).toContain('[[Ada Venn]]');
    });

    it('refuses when the only note at the path is another meeting and the meeting is nowhere', async () => {
      const { setup, ports } = vault({ [MEETING]: meeting([ADA]) });
      const person = personProposal((await link(ports)).proposed);
      const newer = meeting([], { external_id: 'gemini-other-meeting' });
      setup.fixture.files.set(MEETING, {
        ...(setup.fixture.files.get(MEETING) as object),
        text: newer,
      } as never);

      await expect(
        acceptProposalNote({ via: 'app', ports: freshIndex(setup), path: person, today: TODAY }),
      ).rejects.toThrow(/no longer the meeting/);

      expect(setup.fixture.files.get(MEETING)?.text).toBe(newer);
      expect(setup.paths()).not.toContain('People/Ada Venn.md');
    });
  });

  describe('a link proposal outlives the filing of its meeting', () => {
    const SAM = { name: 'Sam Okoro' };
    const TWO_SAMS = {
      'People/Sam Okoro.md': jsonLinesNote({ type: 'person' }),
      'Clients/Sam Okoro.md': jsonLinesNote({ type: 'person' }),
    };

    it('accepts one of the people an attendee could be after the meeting is filed', async () => {
      const { setup, ports } = vault({ ...TWO_SAMS, [MEETING]: meeting([SAM]) });
      const proposals = (await link(ports)).proposed;
      expect(proposals).toHaveLength(2);
      const filed = (await fileUnderProject(setup)).moves[0]?.move.to as string;

      const wanted = proposals.find(
        (path) =>
          setup.propertiesOf(path)?.['payload'] &&
          JSON.stringify(setup.propertiesOf(path)).includes('People/Sam Okoro'),
      ) as VaultPath;
      await acceptProposalNote({
        via: 'app',
        ports: freshIndex(setup),
        path: wanted,
        today: TODAY,
      });

      expect(setup.propertiesOf(filed)?.['people']).toContain('[[People/Sam Okoro]]');
    });

    it('refuses once the meeting is archived, and leaves the Archive as it is', async () => {
      const { setup, ports } = vault({ ...TWO_SAMS, [MEETING]: meeting([SAM]) });
      const [first] = (await link(ports)).proposed as [VaultPath];
      const archived = await archiveNotes({
        ports: setup.ports,
        paths: [vaultPath(MEETING)],
        notePaths: setup.paths().map(vaultPath),
        today: TODAY,
      });
      const there = archived.moves[0]?.move.to as string;
      const before = setup.fixture.files.get(there)?.text;

      await expect(
        acceptProposalNote({ via: 'app', ports: freshIndex(setup), path: first, today: TODAY }),
      ).rejects.toThrow(/archived/);
      expect(setup.fixture.files.get(there)?.text).toBe(before);
    });
  });

  it('refuses to link a person onto a note at their path that is not a person', async () => {
    const { setup, ports } = vault({
      [MEETING]: meeting([ADA]),
      'People/Ada Venn.md': jsonLinesNote({ type: 'project', status: 'active' }),
    });
    const person = personProposal((await link(ports)).proposed);
    const before = setup.fixture.files.get(MEETING)?.text;

    await expect(
      acceptProposalNote({ via: 'app', ports: freshIndex(setup), path: person, today: TODAY }),
    ).rejects.toThrow(/not a person/);

    expect(setup.fixture.files.get(MEETING)?.text).toBe(before);
  });
});
