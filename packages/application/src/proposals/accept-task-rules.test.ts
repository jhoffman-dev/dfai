import { describe, expect, it } from 'vitest';
import { jsonLinesNote, proposalVault, vaultPath } from '../testing/proposal-vault.ts';
import { acceptProposalNote } from './accept-proposal.ts';

/**
 * A proposal that makes a task finished makes it as ticking it done would:
 * a repeating one rolls on to its next date and back to Next Action (ADR-0029).
 */
const PROPOSAL = 'Inbox/Proposals/Pay rent.md';

describe('accepting a proposal that makes a finished task', () => {
  it('rolls a repeating one on to its next date, as the done tick does', async () => {
    const setup = proposalVault({
      [PROPOSAL]: jsonLinesNote({
        type: 'proposal',
        kind: 'task',
        state: 'open',
        payload: {
          title: 'Pay rent',
          properties: { status: 'archive', recurrence: 'monthly', due: '2026-10-01' },
        },
      }),
    });

    await acceptProposalNote({
      via: 'app',
      ports: setup.ports,
      path: vaultPath(PROPOSAL),
      today: '2026-10-08',
    });

    const made = setup.propertiesOf('Tasks/2026/10/Pay rent.md');
    expect(made).toMatchObject({
      type: 'task',
      status: 'next-action',
      due: '2026-11-01',
      lastCompleted: '2026-10-01',
    });
    expect(made).not.toHaveProperty('completed');
  });
});
