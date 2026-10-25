/**
 * `make_dashboard` (P32-05): a dashboard or view spec checked by the app's
 * own checker, left in the Inbox as a proposal, and written into `.atlas`
 * only by the app's Accept — never by the API's. Over a vault held in memory
 * whose index answers with real SQL, so an answered proposal is found again.
 */
import { describe, expect, it } from 'vitest';
import { createVaultPath, splitFrontmatter } from '@dfai/domain';
import { ProposalRefused } from '../chat/proposals.ts';
import {
  acceptProposalNote,
  AcceptedOnlyInAppError,
  undoAcceptedProposal,
} from '../proposals/accept-proposal.ts';
import { listProposals } from '../proposals/list-proposals.ts';
import { rejectProposalNote } from '../proposals/reject-proposal.ts';
import { automationVault, jsonNote } from '../testing/automation-vault.ts';
import { proposeSpec, SpecRefusedError } from './propose-spec.ts';

const TODAY = '2026-10-23';
const TASK_TYPE = jsonNote(
  {
    name: 'task',
    properties: { status: { kind: 'select', options: ['inbox', 'done'] }, due: 'date' },
  },
  '',
);
const PAYROLL = {
  kind: 'dashboard',
  name: 'Larkspur Payroll',
  description: 'Where the migration stands',
  widgets: [
    { kind: 'bar', title: 'By status', type: 'task', groupBy: 'status' },
    { kind: 'number', type: 'task', note: 'not a key the editor knows' },
  ],
};
const DASHBOARD_FILE = '.atlas/dashboards/Larkspur Payroll.md';

function setUp(notes: Record<string, string> = {}) {
  const vault = automationVault({
    notes: { '.atlas/types/task.md': TASK_TYPE, ...notes },
    today: TODAY,
  });
  const atlasFiles = () =>
    [...vault.files.keys()].filter((path) => path.startsWith('.atlas/')).sort();
  const propose = (spec: unknown) =>
    proposeSpec({ ports: vault.ports, spec, madeBy: 'Claude, in the chat' });
  return { vault, atlasFiles, propose };
}

describe('proposeSpec', () => {
  it('leaves a checked dashboard in the Inbox as a proposal, and writes nothing into .atlas', async () => {
    const { vault, atlasFiles, propose } = setUp();

    const proposed = await propose(PAYROLL);

    expect(proposed).toEqual({
      kind: 'dashboard',
      title: 'Larkspur Payroll',
      proposal: 'Inbox/Proposals/Larkspur Payroll.md',
      problem: null,
    });
    expect(atlasFiles()).toEqual(['.atlas/types/task.md']);
    const { open } = await listProposals({ fs: vault.ports.fs, markdown: vault.ports.markdown });
    expect(open.map(({ proposal }) => proposal)).toMatchObject([
      {
        kind: 'dashboard',
        madeBy: 'Claude, in the chat',
        payload: {
          title: 'Larkspur Payroll',
          spec: {
            description: 'Where the migration stands',
            widgets: [
              { kind: 'bar', title: 'By status', type: 'task', groupBy: 'status' },
              { kind: 'number', type: 'task' },
            ],
          },
        },
      },
    ]);
  });

  it('refuses a spec its checker refuses, with every problem, writing nothing', async () => {
    const { vault, propose } = setUp();
    const before = [...vault.files.keys()];

    const refused = await propose({ ...PAYROLL, widgets: [{ kind: 'donut', type: 'deal' }] }).catch(
      (error: unknown) => error,
    );

    expect(refused).toBeInstanceOf(SpecRefusedError);
    expect((refused as SpecRefusedError).problems).toEqual([
      { at: 'widgets[0]', message: 'There is no type called “deal”.' },
      { at: 'widgets[0]', message: 'A donut needs a property to group by.' },
    ]);
    expect([...vault.files.keys()]).toEqual(before);
  });

  it('proposes the same spec once, however often it is asked — open, or answered since', async () => {
    const { vault, propose } = setUp();

    const first = await propose(PAYROLL);
    expect(await propose(PAYROLL)).toMatchObject({
      proposal: null,
      problem: {
        message: 'It is proposed already, waiting in the Inbox.',
        proposal: 'Inbox/Proposals/Larkspur Payroll.md',
      },
    });

    await rejectProposalNote({
      via: 'app',
      ports: vault.ports,
      path: createVaultPath(first.proposal!),
      today: TODAY,
    });
    expect(await propose(PAYROLL)).toEqual({
      kind: 'dashboard',
      title: 'Larkspur Payroll',
      proposal: null,
      problem: {
        message: `It was already rejected on ${TODAY}.`,
        proposal: 'Archive/Inbox/Proposals/Larkspur Payroll.md',
      },
    });
    const proposals = [...vault.files.keys()].filter((path) => path.includes('Larkspur Payroll'));
    expect(proposals).toEqual(['Archive/Inbox/Proposals/Larkspur Payroll.md']);
    // Something else is something else.
    expect(await propose({ ...PAYROLL, name: 'Payroll by status' })).toMatchObject({
      proposal: 'Inbox/Proposals/Payroll by status.md',
    });
  });
});

describe('answering a dashboard proposal', () => {
  it('writes the dashboard into .atlas/dashboards on the app’s Accept, and Undo takes it back', async () => {
    const { vault, atlasFiles, propose } = setUp();
    const { proposal } = await propose(PAYROLL);

    const accepted = await acceptProposalNote({
      via: 'app',
      ports: vault.ports,
      path: createVaultPath(proposal!),
      today: TODAY,
    });

    expect(accepted.wrote).toMatchObject([{ kind: 'created', path: DASHBOARD_FILE }]);
    expect(atlasFiles()).toEqual([DASHBOARD_FILE, '.atlas/types/task.md']);
    const written = splitFrontmatter(vault.files.get(DASHBOARD_FILE) ?? '');
    expect(vault.properties(DASHBOARD_FILE)).toEqual({
      atlas: 'dashboard',
      description: 'Where the migration stands',
      widgets: [
        { kind: 'bar', title: 'By status', type: 'task', groupBy: 'status' },
        { kind: 'number', type: 'task' },
      ],
    });
    expect(written.body).toBe('# Larkspur Payroll\n');

    await undoAcceptedProposal({ ports: vault.ports, accepted });
    expect(atlasFiles()).toEqual(['.atlas/types/task.md']);
    expect(vault.files.has('Inbox/Proposals/Larkspur Payroll.md')).toBe(true);
  });

  it('writes nothing on Reject', async () => {
    const { vault, atlasFiles, propose } = setUp();
    const { proposal } = await propose(PAYROLL);

    await rejectProposalNote({
      via: 'app',
      ports: vault.ports,
      path: createVaultPath(proposal!),
      today: TODAY,
    });

    expect(atlasFiles()).toEqual(['.atlas/types/task.md']);
    expect(vault.properties('Archive/Inbox/Proposals/Larkspur Payroll.md')).toMatchObject({
      state: 'rejected',
    });
  });

  it('is refused when accepted through the API, writing nothing and leaving it open', async () => {
    const { vault, atlasFiles, propose } = setUp();
    const { proposal } = await propose(PAYROLL);
    const before = vault.files.get(proposal!);

    const refused = await acceptProposalNote({
      ports: vault.ports,
      path: createVaultPath(proposal!),
      today: TODAY,
      via: 'api',
    }).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(AcceptedOnlyInAppError);
    expect(refused).toBeInstanceOf(ProposalRefused);
    expect(atlasFiles()).toEqual(['.atlas/types/task.md']);
    expect(vault.files.get(proposal!)).toBe(before);
  });

  it('numbers past a dashboard of the same name rather than write over it', async () => {
    const mine = jsonNote({ atlas: 'dashboard', widgets: [] }, '');
    const { vault, propose } = setUp({ [DASHBOARD_FILE]: mine });
    const { proposal } = await propose(PAYROLL);

    await acceptProposalNote({
      via: 'app',
      ports: vault.ports,
      path: createVaultPath(proposal!),
      today: TODAY,
    });

    expect(vault.files.get(DASHBOARD_FILE)).toBe(mine);
    expect(vault.properties('.atlas/dashboards/Larkspur Payroll 2.md')).toMatchObject({
      atlas: 'dashboard',
    });
  });

  it('checks the spec again on Accept: a type deleted since refuses it, writing nothing', async () => {
    const { vault, atlasFiles, propose } = setUp();
    const { proposal } = await propose(PAYROLL);
    vault.files.delete('.atlas/types/task.md');

    await expect(
      acceptProposalNote({
        via: 'app',
        ports: vault.ports,
        path: createVaultPath(proposal!),
        today: TODAY,
      }),
    ).rejects.toThrow(
      /no longer passes the dashboard checker\. widgets\[0\]: There is no type called “task”\./,
    );
    expect(atlasFiles()).toEqual([]);
    expect(vault.properties(proposal!)).toMatchObject({ state: 'open' });
  });

  it('makes the folder on Accept in a vault whose disk will not list one it has not got', async () => {
    const { vault, propose } = setUp();
    const { proposal } = await propose(PAYROLL);
    const ports = {
      ...vault.ports,
      fs: {
        ...vault.ports.fs,
        // As a disk does for a folder that is not there: an error, not an empty list.
        listDirectory: async (path: Parameters<typeof vault.ports.fs.listDirectory>[0]) => {
          if (path === '.atlas/dashboards') throw new Error('ENOENT: no such file or directory');
          return vault.ports.fs.listDirectory(path);
        },
      },
    };

    await acceptProposalNote({ via: 'app', ports, path: createVaultPath(proposal!), today: TODAY });

    expect(vault.properties(DASHBOARD_FILE)).toMatchObject({ atlas: 'dashboard' });
  });

  it('writes a view into .atlas/views, its layout settings taken from the type', async () => {
    const { vault, propose } = setUp();
    const { proposal } = await propose({
      kind: 'view',
      name: 'Open tasks',
      type: 'task',
      layout: 'board',
    });

    await acceptProposalNote({
      via: 'app',
      ports: vault.ports,
      path: createVaultPath(proposal!),
      today: TODAY,
    });

    expect(vault.properties('.atlas/views/Open tasks.md')).toMatchObject({
      atlas: 'view',
      type: 'task',
      layout: 'board',
      groupBy: 'status',
    });
  });
});
