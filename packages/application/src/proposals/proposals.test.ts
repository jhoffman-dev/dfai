import { describe, expect, it } from 'vitest';
import { digestOf, type VaultPath } from '@dfai/domain';
import {
  jsonLinesNote,
  proposalVault,
  vaultPath,
  type ProposalVault,
} from '../testing/proposal-vault.ts';
import { ProposalRefused } from '../chat/proposals.ts';
import { VaultAccessError } from '../vault/ports.ts';
import { acceptProposalNote, undoAcceptedProposal } from './accept-proposal.ts';
import type { ProposalPorts } from './proposal-file.ts';
import { listProposals } from './list-proposals.ts';
import { rejectProposalNote, undoRejectedProposal } from './reject-proposal.ts';

const TODAY = '2026-10-08';
const MEETING = 'Inbox/Meetings/2026-10-01 Standup.md';
const PROPOSAL = 'Inbox/Proposals/Send the payroll file.md';
const TASK = 'Tasks/2026/10/Send Mara the payroll file.md';

const taskProposal = (more: Record<string, unknown> = {}) =>
  jsonLinesNote(
    {
      type: 'proposal',
      kind: 'task',
      state: 'open',
      confidence: 'high',
      source: '[[2026-10-01 Standup#^t0003]]',
      made_by: 'after-meeting · run 1',
      payload: {
        title: 'Send Mara the payroll file',
        properties: { status: 'next', meeting: '[[2026-10-01 Standup]]' },
      },
      ...more,
    },
    'Mara asked for it by Friday.\n',
  );

const MARA = jsonLinesNote({ type: 'person', companies: ['[[Fenn & Co]]'] }, 'Mara.\n');
const PERSON_TYPE = jsonLinesNote({
  name: 'person',
  properties: { companies: { kind: 'relation', target: 'company', many: true } },
});

const linkProposal = (digest = digestOf(MARA)) =>
  jsonLinesNote({
    type: 'proposal',
    kind: 'link',
    source: '[[2026-10-01 Standup#^t0001]]',
    payload: {
      note: 'People/Mara Quill.md',
      property: 'companies',
      link: '[[Larkspur Payroll]]',
      digest,
    },
  });

function vault(files: Record<string, string> = {}): ProposalVault {
  return proposalVault({ [MEETING]: 'Meeting.\n', [PROPOSAL]: taskProposal(), ...files });
}

const accept = (setup: ProposalVault, path = PROPOSAL, payload?: unknown) =>
  acceptProposalNote({
    via: 'app',
    ports: setup.ports,
    path: vaultPath(path),
    today: TODAY,
    ...(payload !== undefined && { payload }),
  });

describe('acceptProposalNote — a task', () => {
  it('creates the task citing its block and linking its meeting, and archives the proposal', async () => {
    const setup = vault();
    const accepted = await accept(setup);

    expect(setup.propertiesOf(TASK)).toEqual({
      type: 'task',
      status: 'next',
      meeting: '[[2026-10-01 Standup]]',
      source: '[[2026-10-01 Standup#^t0003]]',
    });
    expect(setup.paths()).not.toContain(PROPOSAL);
    expect(accepted.archivedAt).toBe(`Archive/${PROPOSAL}`);
    expect(setup.propertiesOf(`Archive/${PROPOSAL}`)).toMatchObject({
      state: 'accepted',
      answered_via: 'app',
      archived: TODAY,
    });
    expect(accepted).toMatchObject({
      proposal: PROPOSAL,
      headline: 'Send Mara the payroll file',
      archiveProblem: null,
      wrote: [{ kind: 'created', path: TASK }],
    });
  });

  it('keeps the proposal’s body and the rest of its frontmatter where it is archived', async () => {
    const setup = vault();
    await accept(setup);
    const archived = setup.fixture.files.get(`Archive/${PROPOSAL}`)?.text ?? '';
    expect(archived).toContain('Mara asked for it by Friday.\n');
    expect(setup.propertiesOf(`Archive/${PROPOSAL}`)).toMatchObject({
      kind: 'task',
      payload: { title: 'Send Mara the payroll file' },
    });
  });

  it('accepts an edited payload, writing what was edited and keeping it on the proposal', async () => {
    const setup = vault();
    const edited = { title: 'Send Mara the Q4 file', properties: { status: 'doing' } };
    await accept(setup, PROPOSAL, edited);

    expect(setup.propertiesOf('Tasks/2026/10/Send Mara the Q4 file.md')).toMatchObject({
      status: 'doing',
    });
    expect(setup.paths()).not.toContain(TASK);
    expect(setup.propertiesOf(`Archive/${PROPOSAL}`)).toMatchObject({ payload: edited });
  });

  it('refuses an edited payload the proposal’s rules would not take, writing nothing', async () => {
    const setup = vault();
    await expect(accept(setup, PROPOSAL, { title: '' })).rejects.toThrow(/needs a title/);
    expect(setup.fixture.writes).toEqual([]);
  });

  it('makes the folder its payload names', async () => {
    const setup = vault({
      [PROPOSAL]: taskProposal({ payload: { title: 'Call Tobias', folder: 'Work/Tasks' } }),
    });
    await accept(setup);
    expect(setup.propertiesOf('Work/Tasks/Call Tobias.md')).toMatchObject({ type: 'task' });
  });
});

describe('acceptProposalNote — refusals', () => {
  it('makes the task under a numbered name when a note is already where it would go, leaving that note as it is', async () => {
    const setup = vault({ [TASK]: 'Already made by hand.\n' });

    const accepted = await accept(setup);

    expect(accepted.wrote).toMatchObject([
      { kind: 'created', path: 'Tasks/2026/10/Send Mara the payroll file 2.md' },
    ]);
    expect(setup.paths()).toContain('Tasks/2026/10/Send Mara the payroll file 2.md');
    expect(setup.fixture.files.get(TASK)?.text).toBe('Already made by hand.\n');
  });

  it('refuses a proposal already decided', async () => {
    const setup = vault({ [PROPOSAL]: taskProposal({ state: 'rejected' }) });
    await expect(accept(setup)).rejects.toThrow('It was already rejected.');
  });

  it('refuses a note outside Inbox/Proposals, or one that is not a proposal', async () => {
    const setup = vault({ 'Notes/X.md': taskProposal(), 'Inbox/Proposals/Y.md': 'Plain.\n' });
    await expect(accept(setup, 'Notes/X.md')).rejects.toThrow(/not in Inbox\/Proposals/);
    await expect(accept(setup, 'Inbox/Proposals/Y.md')).rejects.toThrow(/is not a proposal/);
    await expect(accept(setup, 'Inbox/Proposals/Z.md')).rejects.toThrow(/no proposal at/);
  });

  it('refuses a proposal with unsaved typing in a pane', async () => {
    const setup = vault();
    setup.dirty.add(PROPOSAL);
    await expect(accept(setup)).rejects.toThrow(/unsaved typing/);
    expect(setup.fixture.writes).toEqual([]);
  });

  it('takes the task back when the proposal changed while it was being accepted', async () => {
    const setup = vault();
    const { fs } = setup.ports;
    const sneaky = {
      ...setup.ports,
      fs: {
        ...fs,
        createNote: async (args: Parameters<typeof fs.createNote>[0]) => {
          await fs.createNote(args);
          // Someone edits the proposal between the task's write and its stamp.
          const before = setup.fixture.files.get(PROPOSAL);
          if (before !== undefined) {
            setup.fixture.files.set(PROPOSAL, { ...before, modified: before.modified + 1000 });
          }
          return 0;
        },
      },
    };
    await expect(
      acceptProposalNote({ via: 'app', ports: sneaky, path: vaultPath(PROPOSAL), today: TODAY }),
    ).rejects.toThrow(/changed since it was read\. Nothing was kept\./);
    expect(setup.paths()).not.toContain(TASK);
    expect(setup.propertiesOf(PROPOSAL)).toMatchObject({ state: 'open' });
  });

  it('makes one task when the same proposal is accepted twice at once', async () => {
    const setup = vault();
    const outcomes = await Promise.allSettled([accept(setup), accept(setup)]);

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
    const refused = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(String(refused?.status === 'rejected' && refused.reason)).toMatch(
      /was made just now; nothing was written|already a note at|already accepted/,
    );
    expect(setup.fixture.writes.filter((write) => write.path === TASK)).toHaveLength(1);
    expect(setup.paths().filter((path) => path.endsWith('payroll file.md'))).toEqual([
      `Archive/${PROPOSAL}`,
      TASK,
    ]);
  });
});

describe('acceptProposalNote — a link', () => {
  const files = (proposal: string) => ({
    [PROPOSAL]: proposal,
    'People/Mara Quill.md': MARA,
    '.atlas/types/person.md': PERSON_TYPE,
  });

  it('adds the link to the note’s relation, leaving its body as it was', async () => {
    const setup = vault(files(linkProposal()));
    await accept(setup);
    expect(setup.propertiesOf('People/Mara Quill.md')).toEqual({
      type: 'person',
      companies: ['[[Fenn & Co]]', '[[Larkspur Payroll]]'],
    });
    expect(setup.fixture.files.get('People/Mara Quill.md')?.text).toMatch(/\nMara\.\n$/);
  });

  it('finds the note’s type however its type: is cased, as type files are matched', async () => {
    const shouting = jsonLinesNote({ type: 'Person', companies: ['[[Fenn & Co]]'] }, 'Mara.\n');
    const proposalFor = jsonLinesNote({
      type: 'proposal',
      kind: 'link',
      payload: {
        note: 'People/Mara Quill.md',
        property: 'companies',
        link: '[[Larkspur Payroll]]',
        digest: digestOf(shouting),
      },
    });
    const setup = vault({ ...files(proposalFor), 'People/Mara Quill.md': shouting });
    await accept(setup);
    expect(setup.propertiesOf('People/Mara Quill.md')?.['companies']).toEqual([
      '[[Fenn & Co]]',
      '[[Larkspur Payroll]]',
    ]);
  });

  it('refuses when the note changed since the proposal was made, with the reason', async () => {
    const setup = vault(files(linkProposal('00000000')));
    await expect(accept(setup)).rejects.toThrow(
      'Mara Quill changed since this was proposed, so it was left as it is.',
    );
    expect(setup.fixture.writes).toEqual([]);
    expect(setup.paths()).toContain(PROPOSAL);
  });

  it('refuses when the note has unsaved typing', async () => {
    const setup = vault(files(linkProposal()));
    setup.dirty.add('People/Mara Quill.md');
    await expect(accept(setup)).rejects.toThrow(/Mara Quill has unsaved typing/);
  });

  it('makes one write when accepted twice at once', async () => {
    const setup = vault(files(linkProposal()));
    const outcomes = await Promise.allSettled([accept(setup), accept(setup)]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(
      setup.fixture.writes.filter((write) => write.path === 'People/Mara Quill.md'),
    ).toHaveLength(1);
  });

  it('puts the note back as it was on undo', async () => {
    const setup = vault(files(linkProposal()));
    const accepted = await accept(setup);
    await undoAcceptedProposal({ ports: setup.ports, accepted });
    expect(setup.fixture.files.get('People/Mara Quill.md')?.text).toBe(MARA);
  });
});

describe('undoAcceptedProposal', () => {
  it('removes the task and puts the proposal back in the Inbox, open', async () => {
    const setup = vault();
    const accepted = await accept(setup);
    const back = await undoAcceptedProposal({ ports: setup.ports, accepted });

    expect(back).toBe(PROPOSAL);
    expect(setup.paths()).not.toContain(TASK);
    expect(setup.propertiesOf(PROPOSAL)).toMatchObject({ state: 'open', kind: 'task' });
    expect(setup.propertiesOf(PROPOSAL)).not.toHaveProperty('archived');
    expect(setup.propertiesOf(PROPOSAL)).not.toHaveProperty('answered_via');
    expect((await listProposals(setup.ports)).open).toHaveLength(1);
  });

  it('refuses, removing nothing, when the task changed since it was accepted', async () => {
    const setup = vault();
    const accepted = await accept(setup);
    const task = setup.fixture.files.get(TASK);
    if (task === undefined) throw new Error('no task');
    setup.fixture.files.set(TASK, {
      text: `${task.text}Done half.\n`,
      modified: task.modified + 9,
    });

    await expect(undoAcceptedProposal({ ports: setup.ports, accepted })).rejects.toThrow(
      /changed since/,
    );
    expect(setup.paths()).toContain(TASK);
    expect(setup.paths()).toContain(`Archive/${PROPOSAL}`);
  });
});

describe('rejectProposalNote', () => {
  it('archives the proposal with state: rejected, writing nothing it proposed', async () => {
    const setup = vault();
    const rejected = await rejectProposalNote({
      via: 'app',
      ports: setup.ports,
      path: vaultPath(PROPOSAL),
      today: TODAY,
    });

    expect(rejected).toEqual({
      proposal: PROPOSAL,
      archivedAt: `Archive/${PROPOSAL}`,
      archiveProblem: null,
    });
    expect(setup.propertiesOf(`Archive/${PROPOSAL}`)).toMatchObject({
      state: 'rejected',
      answered_via: 'app',
    });
    expect(setup.paths()).not.toContain(TASK);
    expect((await listProposals(setup.ports)).open).toEqual([]);

    // Taking the reject back opens it again, in the Inbox, as if never answered.
    const back = await undoRejectedProposal({ ports: setup.ports, rejected });
    expect(back).toBe(PROPOSAL);
    expect(setup.propertiesOf(PROPOSAL)).toMatchObject({ state: 'open' });
    expect(setup.paths()).not.toContain(`Archive/${PROPOSAL}`);
    expect((await listProposals(setup.ports)).open).toHaveLength(1);
  });

  it('refuses one already accepted', async () => {
    const setup = vault({ [PROPOSAL]: taskProposal({ state: 'accepted' }) });
    await expect(
      rejectProposalNote({
        via: 'app',
        ports: setup.ports,
        path: vaultPath(PROPOSAL),
        today: TODAY,
      }),
    ).rejects.toThrow('It was already accepted.');
  });
});

describe('listProposals', () => {
  it('lists the open proposals, newest first, and the ones it cannot read with why', async () => {
    const setup = vault({
      'Inbox/Proposals/Waiting.md': taskProposal({ payload: { title: 'Waiting' } }),
      'Inbox/Proposals/Done.md': taskProposal({ state: 'accepted' }),
      'Inbox/Proposals/Broken.md': taskProposal({ kind: 'meeting' }),
      'Inbox/Proposals/Plain note.md': 'Not a proposal.\n',
      'Archive/Inbox/Proposals/Gone.md': taskProposal(),
    });
    // Changed last, so listed first, though its name sorts after the other's.
    const later = setup.fixture.files.get('Inbox/Proposals/Waiting.md');
    if (later !== undefined) {
      setup.fixture.files.set('Inbox/Proposals/Waiting.md', { ...later, modified: 999 });
    }

    const listing = await listProposals(setup.ports);
    expect(listing.open.map((listed) => listed.proposal.path)).toEqual([
      'Inbox/Proposals/Waiting.md',
      PROPOSAL,
    ]);
    expect(listing.unreadable).toEqual([
      { path: 'Inbox/Proposals/Broken.md', problem: expect.stringMatching(/no kind DFAI knows/) },
    ]);
    // Answered but never filed away: listed apart, never just gone.
    expect(listing.stranded.map((listed) => listed.proposal.path)).toEqual([
      'Inbox/Proposals/Done.md',
    ]);
  });

  it('says a proposal whose frontmatter cannot be read cannot be, rather than leaving it out', async () => {
    const setup = vault();
    const markdown = { ...setup.ports.markdown, frontmatterProblem: () => 'bad indentation' };
    const listing = await listProposals({ fs: setup.ports.fs, markdown });
    expect(listing.unreadable).toEqual([
      { path: PROPOSAL, problem: 'Its frontmatter cannot be read: bad indentation' },
    ]);
  });

  it('is empty in a vault with no proposals', async () => {
    const setup = proposalVault({ 'A.md': 'A.\n' });
    expect(await listProposals(setup.ports)).toEqual({
      open: [],
      stranded: [],
      unreadable: [],
      manyValued: [],
    });
  });
});

describe('acceptProposalNote — when the vault moves under it', () => {
  const linkFiles = (proposal: string) => ({
    [PROPOSAL]: proposal,
    'People/Mara Quill.md': MARA,
    '.atlas/types/person.md': PERSON_TYPE,
  });

  it('refuses a link whose note is gone, or whose property is no relation of its type', async () => {
    const gone = vault({ [PROPOSAL]: linkProposal() });
    await expect(accept(gone)).rejects.toThrow('Mara Quill is not there any more.');

    const plain = vault({ ...linkFiles(linkProposal()), '.atlas/types/person.md': '' });
    await expect(accept(plain)).rejects.toThrow(/no relation called companies/);
  });

  it('refuses a proposal it cannot read, saying why', async () => {
    const setup = vault({ [PROPOSAL]: taskProposal({ kind: 'meeting' }) });
    await expect(accept(setup)).rejects.toThrow(/no kind DFAI knows/);
  });

  it('refuses a link when its note changes between the read and the write', async () => {
    const setup = vault(linkFiles(linkProposal()));
    const { fs } = setup.ports;
    const racing = {
      ...setup.ports,
      fs: {
        ...fs,
        writeTextFile: async (args: Parameters<typeof fs.writeTextFile>[0]) => {
          const mara = setup.fixture.files.get('People/Mara Quill.md');
          if (args.path === 'People/Mara Quill.md' && mara !== undefined) {
            setup.fixture.files.set(args.path, { ...mara, modified: mara.modified + 50 });
          }
          return fs.writeTextFile(args);
        },
      },
    };
    await expect(
      acceptProposalNote({ via: 'app', ports: racing, path: vaultPath(PROPOSAL), today: TODAY }),
    ).rejects.toThrow('People/Mara Quill.md changed just now; nothing was written.');
    expect(setup.propertiesOf(PROPOSAL)).not.toHaveProperty('state');
    expect(setup.paths()).toContain(PROPOSAL);
  });

  it('passes on a failure that is not a change, writing nothing it proposed', async () => {
    const setup = vault();
    const broken = {
      ...setup.ports,
      fs: {
        ...setup.ports.fs,
        createNote: async () => {
          throw new Error('the disk is full');
        },
      },
    };
    await expect(
      acceptProposalNote({ via: 'app', ports: broken, path: vaultPath(PROPOSAL), today: TODAY }),
    ).rejects.toThrow('the disk is full');
    expect(setup.propertiesOf(PROPOSAL)).toMatchObject({ state: 'open' });
  });

  it('says so when the proposal changed and what it made could not be taken back', async () => {
    const setup = vault();
    const { fs } = setup.ports;
    const tangled = {
      ...setup.ports,
      fs: {
        ...fs,
        writeTextFile: async (args: Parameters<typeof fs.writeTextFile>[0]) => {
          // The proposal is edited, and so is the new task, just before the stamp.
          for (const path of [PROPOSAL, TASK]) {
            const note = setup.fixture.files.get(path);
            if (note !== undefined) setup.fixture.files.set(path, { ...note, modified: 9999 });
          }
          return fs.writeTextFile(args);
        },
      },
    };
    await expect(
      acceptProposalNote({ via: 'app', ports: tangled, path: vaultPath(PROPOSAL), today: TODAY }),
    ).rejects.toThrow(
      /“Send Mara the payroll file” was written, but the proposal could not be marked accepted .* taking it back failed/,
    );
    expect(setup.paths()).toContain(TASK);
  });

  it('accepts all the same when the proposal cannot be archived, and says why', async () => {
    const setup = vault();
    let asked = 0;
    // Clean when Accept checks it; typing arrives before the Archive moves it.
    const typing = {
      ...setup.ports,
      editors: {
        ...setup.ports.editors,
        state: (path: VaultPath) => (path === PROPOSAL && (asked += 1) > 1 ? 'dirty' : 'closed'),
      },
    } satisfies ProposalPorts;
    const accepted = await acceptProposalNote({
      via: 'app',
      ports: typing,
      path: vaultPath(PROPOSAL),
      today: TODAY,
    });

    expect(accepted.archivedAt).toBeNull();
    expect(accepted.archiveProblem).toMatch(/unsaved typing/);
    expect(setup.propertiesOf(PROPOSAL)).toMatchObject({ state: 'accepted' });
    const listing = await listProposals(setup.ports);
    expect(listing.open).toEqual([]);
    expect(listing.stranded.map((listed) => listed.proposal.path)).toEqual([PROPOSAL]);

    const back = await undoAcceptedProposal({ ports: setup.ports, accepted });
    expect(back).toBe(PROPOSAL);
    expect(setup.propertiesOf(PROPOSAL)).toMatchObject({ state: 'open' });
    expect(setup.paths()).not.toContain(TASK);
  });

  it('undoes what it made but says so when the proposal cannot leave the Archive', async () => {
    const setup = vault();
    const accepted = await accept(setup);
    setup.dirty.add(`Archive/${PROPOSAL}`);

    await expect(undoAcceptedProposal({ ports: setup.ports, accepted })).rejects.toThrow(
      /What it made was taken back, but the proposal stays in the Archive: .*unsaved typing/,
    );
    expect(setup.paths()).not.toContain(TASK);
  });
});

describe('undo and link reads that fail', () => {
  it('says what was undone when the proposal cannot be marked open again', async () => {
    const setup = vault();
    const accepted = await accept(setup);
    const { fs } = setup.ports;
    const stuck = {
      ...setup.ports,
      fs: {
        ...fs,
        writeTextFile: async (args: Parameters<typeof fs.writeTextFile>[0]) => {
          if (args.path === PROPOSAL) throw new Error('the disk is full');
          return fs.writeTextFile(args);
        },
      },
    };
    await expect(undoAcceptedProposal({ ports: stuck, accepted })).rejects.toThrow(
      `What it made was taken back and the proposal is at ${PROPOSAL}, but it could not be marked open again: the disk is full`,
    );
    expect(setup.paths()).not.toContain(TASK);
  });

  it('passes on a failure reading a link’s note that is not its absence', async () => {
    const setup = vault({
      [PROPOSAL]: linkProposal(),
      'People/Mara Quill.md': MARA,
      '.atlas/types/person.md': PERSON_TYPE,
    });
    const { fs } = setup.ports;
    const failing = {
      ...setup.ports,
      fs: {
        ...fs,
        readTextFile: async (path: VaultPath) => {
          if (path === 'People/Mara Quill.md') throw new Error('permission denied');
          return fs.readTextFile(path);
        },
      },
    };
    await expect(
      acceptProposalNote({ via: 'app', ports: failing, path: vaultPath(PROPOSAL), today: TODAY }),
    ).rejects.toThrow('permission denied');
  });
});

describe('undoRejectedProposal — when the proposal is back but cannot be opened again', () => {
  it('says where it is and why, rather than failing without a word', async () => {
    const setup = vault();
    const rejected = await rejectProposalNote({
      via: 'app',
      ports: setup.ports,
      path: vaultPath(PROPOSAL),
      today: TODAY,
    });
    const ports: ProposalPorts = {
      ...setup.ports,
      fs: {
        ...setup.ports.fs,
        writeTextFile: async () => {
          throw new Error('the disk is full');
        },
      },
    };
    const undone = undoRejectedProposal({ ports, rejected });
    await expect(undone).rejects.toBeInstanceOf(ProposalRefused);
    await expect(undone).rejects.toThrow(
      /back at .*could not be marked open again: the disk is full/,
    );
    // It did leave the Archive: only the mark is missing.
    expect(setup.paths()).toContain(PROPOSAL);
  });
});

describe('listProposals — which shared slots hold many values', () => {
  const twoLinks = {
    [PROPOSAL]: linkProposal(),
    'Inbox/Proposals/Second.md': jsonLinesNote({
      type: 'proposal',
      kind: 'link',
      payload: {
        note: 'People/Mara Quill.md',
        property: 'companies',
        link: '[[Other Co]]',
        digest: null,
      },
    }),
  };

  it('reads a slot’s note that is not there as one that holds one', async () => {
    const setup = proposalVault({ ...twoLinks });
    expect((await listProposals(setup.ports)).manyValued).toEqual([]);
  });

  it('propagates a fault reading the note, rather than reading it as a single value', async () => {
    const setup = proposalVault({ 'People/Mara Quill.md': MARA, ...twoLinks });
    const ports: ProposalPorts = {
      ...setup.ports,
      fs: {
        ...setup.ports.fs,
        readTextFile: async (path) => {
          if (path === 'People/Mara Quill.md') throw new Error('input/output error');
          return setup.ports.fs.readTextFile(path);
        },
      },
    };
    await expect(listProposals(ports)).rejects.toThrow('input/output error');
  });

  it('reads a refused read (denied or gone) as a note with no many-valued slot', async () => {
    const setup = proposalVault({ 'People/Mara Quill.md': MARA, ...twoLinks });
    const ports: ProposalPorts = {
      ...setup.ports,
      fs: {
        ...setup.ports.fs,
        readTextFile: async (path) => {
          if (path === 'People/Mara Quill.md') throw new VaultAccessError('denied');
          return setup.ports.fs.readTextFile(path);
        },
      },
    };
    expect((await listProposals(ports)).manyValued).toEqual([]);
  });
});
