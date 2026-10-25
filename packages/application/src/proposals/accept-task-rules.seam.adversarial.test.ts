import { describe, expect, it } from 'vitest';
import { jsonLinesNote, proposalVault, vaultPath } from '../testing/proposal-vault.ts';
import { acceptProposalNote } from './accept-proposal.ts';

// Seam #64 (proposals) x #66 (GTD task rules, ADR-0029): every write that
// makes or changes a task is held to the task rules, "whoever makes it".
const TODAY = '2026-10-08';
const PROPOSAL = 'Inbox/Proposals/Chase Tobias.md';

const proposal = (kind: string, properties: Record<string, unknown>, title = 'Chase Tobias') =>
  jsonLinesNote({
    type: 'proposal',
    kind,
    state: 'open',
    payload: { title, properties },
  });

const accept = (files: Record<string, string>, payload?: unknown) => {
  const setup = proposalVault(files);
  const accepted = acceptProposalNote({
    via: 'app',
    ports: setup.ports,
    path: vaultPath(PROPOSAL),
    today: TODAY,
    ...(payload !== undefined && { payload }),
  });
  return { setup, accepted };
};

describe('accepting a task proposal is held to the GTD task rules', () => {
  it('accepts a task proposal that makes a task Waiting with nobody to wait on (#202)', async () => {
    const { setup, accepted } = accept({ [PROPOSAL]: proposal('task', { status: 'waiting' }) });
    await accepted;
    expect(setup.propertiesOf('Tasks/2026/10/Chase Tobias.md')).toMatchObject({
      type: 'task',
      status: 'waiting',
    });
    expect(setup.propertiesOf('Tasks/2026/10/Chase Tobias.md')).not.toHaveProperty('waiting_on');
  });

  it('accepts a follow-up proposal edited to Waiting with nobody to wait on (#202)', async () => {
    const { setup, accepted } = accept(
      { [PROPOSAL]: proposal('follow-up', { status: 'next' }) },
      { title: 'Chase Tobias', properties: { status: 'waiting' } },
    );
    await accepted;
    expect(setup.propertiesOf('Tasks/2026/10/Chase Tobias.md')).toMatchObject({
      status: 'waiting',
    });
  });

  it('dates a task proposal accepted already finished (Archive) with completed: today', async () => {
    const { setup, accepted } = accept({ [PROPOSAL]: proposal('task', { status: 'archive' }) });
    await accepted;
    expect(setup.propertiesOf('Tasks/2026/10/Chase Tobias.md')).toMatchObject({
      type: 'task',
      status: 'archive',
      completed: TODAY,
    });
  });
});
