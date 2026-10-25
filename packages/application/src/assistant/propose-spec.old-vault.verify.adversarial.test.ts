/**
 * Verify pass on PR #549: a vault made before the Proposal type listed
 * `dashboard` and `view` among its kinds still reads, lists and accepts a
 * dashboard or view proposal.
 */
import { describe, expect, it } from 'vitest';
import { createVaultPath } from '@dfai/domain';
import { acceptProposalNote } from '../proposals/accept-proposal.ts';
import { listProposals } from '../proposals/list-proposals.ts';
import { automationVault, jsonNote } from '../testing/automation-vault.ts';
import { proposeSpec } from './propose-spec.ts';

const TODAY = '2026-10-23';
const OLD_PROPOSAL_TYPE = jsonNote(
  {
    name: 'proposal',
    label: 'Proposal',
    properties: {
      kind: {
        kind: 'select',
        options: ['task', 'decision', 'follow-up', 'person', 'link', 'term', 'project'],
        required: true,
      },
      state: { kind: 'select', options: ['open', 'accepted', 'rejected'], required: true },
    },
  },
  '',
);
const TASK_TYPE = jsonNote(
  { name: 'task', properties: { status: { kind: 'select', options: ['inbox', 'done'] } } },
  '',
);

function setUp() {
  return automationVault({
    notes: { '.atlas/types/task.md': TASK_TYPE, '.atlas/types/proposal.md': OLD_PROPOSAL_TYPE },
    today: TODAY,
  });
}

describe('a vault whose Proposal type predates dashboard and view (verify-549)', () => {
  it.each([
    [{ kind: 'dashboard', name: 'Quince board', widgets: [{ kind: 'number', type: 'task' }] }],
    [{ kind: 'view', name: 'Quince tasks', type: 'task', layout: 'table' }],
  ])('lists and accepts %j', async (spec) => {
    const vault = setUp();
    const { proposal } = await proposeSpec({ ports: vault.ports, spec, madeBy: 'Claude' });

    const { open } = await listProposals({ fs: vault.ports.fs, markdown: vault.ports.markdown });
    expect(open.map(({ proposal: listed }) => listed.kind)).toEqual([spec.kind]);
    const accepted = await acceptProposalNote({
      via: 'app',
      ports: vault.ports,
      path: createVaultPath(proposal!),
      today: TODAY,
    });
    expect(accepted.wrote).toHaveLength(1);
  });
});
