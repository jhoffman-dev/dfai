/**
 * Adversarial tests for renaming a dashboard proposal before the app's Accept
 * (P32-05, PR #549): the name as edited is checked again, and lands only in
 * `.atlas/dashboards`. Fictional vault held in memory.
 */
import { describe, expect, it } from 'vitest';
import { createVaultPath } from '@dfai/domain';
import { acceptProposalNote } from '../proposals/accept-proposal.ts';
import { automationVault, jsonNote } from '../testing/automation-vault.ts';
import { proposeSpec } from './propose-spec.ts';

const TODAY = '2026-10-23';
const TASK_TYPE = jsonNote({ name: 'task', properties: { status: 'text' } }, '');
const WIDGETS = [{ kind: 'number', type: 'task' }];

async function proposed() {
  const vault = automationVault({ notes: { '.atlas/types/task.md': TASK_TYPE }, today: TODAY });
  const { proposal } = await proposeSpec({
    ports: vault.ports,
    spec: { kind: 'dashboard', name: 'Orchard', widgets: WIDGETS },
    madeBy: 'Claude, in the chat',
  });
  const created = () =>
    [...vault.files.keys()].filter(
      (path) => path.startsWith('.atlas/') && !path.startsWith('.atlas/types/'),
    );
  const acceptAs = (title: string) =>
    acceptProposalNote({
      via: 'app',
      ports: vault.ports,
      path: createVaultPath(proposal!),
      today: TODAY,
      payload: { title, spec: { widgets: WIDGETS } },
    });
  return { acceptAs, created };
}

describe('renaming a dashboard proposal before Accept', () => {
  it.each(['../../Notes/Orchard', '.atlas/views/Orchard', '\\..\\Orchard', ' ./. Orchard'])(
    'keeps the renamed %j inside .atlas/dashboards',
    async (title) => {
      const { acceptAs, created } = await proposed();

      await acceptAs(title).catch(() => undefined);

      for (const path of created()) expect(path).toMatch(/^\.atlas\/dashboards\/[^/]+\.md$/);
    },
  );

  it('refuses a renamed name too long for a file, writing nothing', async () => {
    const { acceptAs, created } = await proposed();

    await expect(acceptAs('o'.repeat(300))).rejects.toThrow(/too long/);
    expect(created()).toEqual([]);
  });
});
