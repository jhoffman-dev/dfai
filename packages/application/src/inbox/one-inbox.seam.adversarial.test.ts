/**
 * Adversarial tests on the One Inbox seam (#65 x #64 x #60, PR #90): the
 * Inbox listing, the Proposals section and the meeting import each claim
 * part of `Inbox/`. What one hands to another must land somewhere: no note
 * is in neither list, no proposal is filed as a note, and nothing accepted
 * is judged as a broken meeting.
 */
import { describe, expect, it } from 'vitest';
import { createVaultPath, type NoteChange, type VaultPath } from '@dfai/domain';
import type { ArchivePorts } from '../archive/archive-notes.ts';
import { importArrivedMeetings } from '../meetings/import-arrived-meetings.ts';
import { acceptProposalNote } from '../proposals/accept-proposal.ts';
import { listProposals } from '../proposals/list-proposals.ts';
import { automationVault } from '../testing/automation-vault.ts';
import { recordingActivity } from '../testing/fake-activity.ts';
import { memoryVault } from '../testing/fake-git.ts';
import { fakeIndexPort, fakeMarkdown, fakeVaultFs } from '../testing/fake-ports.ts';
import { jsonLinesNote, proposalVault, vaultPath } from '../testing/proposal-vault.ts';
import { atlasQueryIndex } from '../testing/query-index.ts';
import { listInbox } from './list-inbox.ts';
import { processInboxItems } from './process-inbox.ts';

const TODAY = '2026-10-08';
const path = (raw: string): VaultPath => createVaultPath(raw);

describe('One Inbox — a note in Inbox/Proposals that the Proposals section does not list', () => {
  // listProposals: "A note there of another type is not a proposal and is left to the Inbox."
  const PLAIN = 'Inbox/Proposals/Ideas for the offsite.md';
  const NESTED = 'Inbox/Proposals/Older/Call Tobias.md';

  it('a plain note dropped into Inbox/Proposals is listed by the Inbox or by the Proposals section', async () => {
    const query = atlasQueryIndex({
      markdown: fakeMarkdown(),
      files: { [PLAIN]: 'Book the hall for Larkspur Payroll.\n' },
    });
    const inbox = await listInbox({ index: fakeIndexPort({ query }) });

    const proposals = await listProposals(
      proposalVault({ [PLAIN]: 'Book the hall for Larkspur Payroll.\n' }).ports,
    );
    const inProposals = [...proposals.open, ...proposals.stranded]
      .map((listed) => listed.proposal.path as string)
      .concat(proposals.unreadable.map((item) => item.path as string));
    const inInbox = inbox.items.map((item) => item.path as string);

    expect([...inInbox, ...inProposals]).toContain(PLAIN);
  });

  it('an open proposal one folder down in Inbox/Proposals is listed by the Inbox or by the Proposals section', async () => {
    const proposal = {
      type: 'proposal',
      kind: 'task',
      state: 'open',
      payload: { title: 'Call Tobias' },
    };
    const query = atlasQueryIndex({
      markdown: fakeMarkdown(),
      files: { [NESTED]: '---\ntype: proposal\nkind: task\n---\n' },
    });
    const inbox = await listInbox({ index: fakeIndexPort({ query }) });
    const proposals = await listProposals(
      proposalVault({ [NESTED]: jsonLinesNote(proposal) }).ports,
    );

    const listed = [
      ...inbox.items.map((item) => item.path as string),
      ...proposals.open.map((item) => item.proposal.path as string),
      ...proposals.unreadable.map((item) => item.path as string),
    ];
    expect(listed).toContain(NESTED);
  });
});

describe('One Inbox — a proposal moved out of Inbox/Proposals by hand', () => {
  it('Process refuses a note that is a proposal by its type, wherever in the Inbox it sits', async () => {
    const MOVED = 'Inbox/Send Mara the payroll file.md';
    const memory = memoryVault({
      'Projects/DFAI.md': '---\ntype: project\nstatus: active\n---\n\n# DFAI\n',
      [MOVED]: '---\ntype: proposal\nkind: task\nstate: open\n---\n\nMara asked for it.\n',
    });
    const ports: ArchivePorts = {
      fs: fakeVaultFs(memory.fs),
      markdown: fakeMarkdown(),
      index: fakeIndexPort(),
      editors: {
        state: () => 'closed',
        flush: async () => {},
        follow: () => {},
        abandon: () => {},
        reload: () => {},
      },
    };

    const outcome = await processInboxItems({
      ports,
      paths: [path(MOVED)],
      notePaths: [...memory.files.keys()].map(path),
      project: path('Projects/DFAI.md'),
      today: TODAY,
    });

    // "A proposal is answered, not filed": it must not become a filed note under DFAI.
    expect(outcome.moves).toEqual([]);
    expect(memory.files.has(MOVED)).toBe(true);
    expect(memory.files.has('Projects/DFAI/Send Mara the payroll file.md')).toBe(false);
  });
});

describe('One Inbox — a proposal whose payload folder is where meeting files land', () => {
  it('the task accepted into Inbox/Meetings is not stamped by the meeting import as a broken meeting', async () => {
    const PROPOSAL = 'Inbox/Proposals/Send the payroll file.md';
    const TASK = 'Inbox/Meetings/Send Mara the payroll file.md';
    const setup = proposalVault({
      [PROPOSAL]: jsonLinesNote({
        type: 'proposal',
        kind: 'task',
        state: 'open',
        source: '[[2026-10-01 Standup#^t0003]]',
        payload: {
          title: 'Send Mara the payroll file',
          folder: 'Inbox/Meetings',
          properties: { status: 'next' },
        },
      }),
    });

    // Fix 5 (PR #90 review): proposedWriteRefusal now refuses where meeting
    // files land, so the task is never written there for the import to judge.
    await expect(
      acceptProposalNote({
        via: 'app',
        ports: setup.ports,
        path: vaultPath(PROPOSAL),
        today: TODAY,
      }),
    ).rejects.toThrow(/where meeting files land/);
    expect(setup.paths()).not.toContain(TASK);
    expect(setup.paths()).toContain(PROPOSAL);

    // Even so, the sync's report of that path finds nothing there to stamp.
    const vault = automationVault({ notes: {}, today: TODAY });
    const change: NoteChange = { kind: 'added', path: TASK, type: 'task', digest: '' };
    await importArrivedMeetings({
      ports: vault.ports,
      changes: [change],
      today: TODAY,
      activity: recordingActivity(),
    });

    const after = vault.files.get(TASK) ?? '';
    expect(after).not.toContain('atlas_import_outcome');
    expect(after).not.toContain('atlas_import_error');
  });
});
