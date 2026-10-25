/**
 * Accepting a task proposal makes the task in its month (`Tasks/2026/10`) and
 * archives the proposal under the same name, as deep: a bare link to the task
 * must open the task, not the archived proposal.
 */
import { describe, expect, it } from 'vitest';
import { resolveWikiLinkTarget, type VaultPath } from '@dfai/domain';
import { jsonLinesNote, proposalVault, vaultPath } from '../testing/proposal-vault.ts';
import { acceptProposalNote } from './accept-proposal.ts';

// Claude names a proposal after its payload title (claudeNewProposal: name = payload.title),
// so the proposal and the task it makes share a name.
const TITLE = 'Send Mara the payroll file';
const PROPOSAL = `Inbox/Proposals/${TITLE}.md`;
const TASK = `Tasks/2026/10/${TITLE}.md`;

const proposal = jsonLinesNote(
  {
    type: 'proposal',
    kind: 'task',
    state: 'open',
    source: '[[2026-10-01 Standup#^t0003]]',
    made_by: 'after-meeting · run 1',
    payload: { title: TITLE, properties: { status: 'next' } },
  },
  'Mara asked.\n',
);

describe('a bare [[Task]] link after a Claude task proposal is accepted (#214)', () => {
  it('opens the task it names, not the archived proposal of the same name', async () => {
    const setup = proposalVault({
      'Inbox/Meetings/2026-10-01 Standup.md': 'Meeting.\n',
      [PROPOSAL]: proposal,
      // Written by hand in a daily note: the person links the task by its name.
      'Daily/2026/2026-10-14.md': `- [[${TITLE}]]\n`,
    });
    await acceptProposalNote({
      via: 'app',
      ports: setup.ports,
      path: vaultPath(PROPOSAL),
      today: '2026-10-14',
    });

    const paths = setup.paths() as VaultPath[];
    expect(paths).toContain(TASK);
    expect(paths).toContain(`Archive/${PROPOSAL}`);
    // As deep as the task, and "Archive" < "Tasks": by depth and name alone the
    // archived proposal would win the name (found by adv-222). A note in use wins.
    expect(resolveWikiLinkTarget(TITLE, paths)).toBe(TASK);
  });
});
