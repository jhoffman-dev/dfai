/**
 * One Inbox (#112): the page, the sidebar's count and the weekly review's all
 * read `listInbox`, so what it lists is what each of them shows. Run against
 * a real index filled from the notes, so the statement is what is asserted.
 */
import { describe, expect, it } from 'vitest';
import { createVaultPath, GTD_STATUSES } from '@dfai/domain';
import type { ArchivePorts } from '../archive/archive-notes.ts';
import { acceptProposalNote } from '../proposals/accept-proposal.ts';
import { readWeeklyReview } from '../review/read-weekly-review.ts';
import { memoryVault } from '../testing/fake-git.ts';
import { fakeIndexPort, fakeMarkdown, fakeVaultFs } from '../testing/fake-ports.ts';
import {
  jsonLinesMarkdown,
  jsonLinesNote,
  proposalVault,
  vaultPath,
} from '../testing/proposal-vault.ts';
import { atlasQueryIndex } from '../testing/query-index.ts';
import { clarifyInboxItem } from './clarify-inbox-item.ts';
import { listInbox, listVaultInbox } from './list-inbox.ts';

const TODAY = '2026-10-11';
const GTD = { tasksStartInInbox: true };

const GTD_TASK_TYPE = jsonLinesNote({
  name: 'task',
  properties: { status: { kind: 'select', options: [...GTD_STATUSES], done: 'archive' } },
});

describe('One Inbox — an accepted task proposal', () => {
  const PROPOSAL = 'Inbox/Proposals/Send the payroll file.md';
  const accepted = async (properties: Record<string, unknown>) => {
    const setup = proposalVault({
      [PROPOSAL]: jsonLinesNote({
        type: 'proposal',
        kind: 'task',
        state: 'open',
        payload: { title: 'Send Mara the payroll file', folder: 'Tasks', properties },
      }),
    });
    await acceptProposalNote({
      via: 'app',
      ports: setup.ports,
      path: vaultPath(PROPOSAL),
      today: TODAY,
    });
    const files = Object.fromEntries(
      [...setup.fixture.files].map(([path, stored]) => [path, stored.text]),
    );
    const query = atlasQueryIndex({ markdown: jsonLinesMarkdown(), files });
    return fakeIndexPort({ query });
  };
  const TASK = 'Tasks/Send Mara the payroll file.md';

  it('lands outside the Inbox folder and still waits in the Inbox when it says Inbox', async () => {
    const index = await accepted({ status: 'inbox' });
    for (const tasksStartInInbox of [false, true]) {
      const { items } = await listInbox({ index, tasksStartInInbox });
      expect(items.map((item) => item.path)).toEqual([TASK]);
      expect(items[0]?.task?.status).toBe('inbox');
    }
  });

  it('waits in the Inbox with no status at all, which is what a proposal that names none makes', async () => {
    const index = await accepted({});
    const { items } = await listInbox({ index, ...GTD });
    expect(items.map((item) => [item.path, item.task?.status])).toEqual([[TASK, null]]);
  });

  it('does not wait once the proposal gave it another status', async () => {
    const index = await accepted({ status: 'next-action' });
    expect((await listInbox({ index, ...GTD })).items).toEqual([]);
  });
});

describe('One Inbox — a task once it is clarified', () => {
  const CALL = 'Inbox/Call the bank.md';
  const IMPORTED = 'Tasks/Imported.md';
  const start = () =>
    memoryVault({
      [CALL]: '---\ntype: task\nstatus: inbox\n---\n\nAbout the loan.\n',
      [IMPORTED]: '---\ntype: task\nstatus: inbox\n---\n\nFrom Notion.\n',
      'Inbox/Idea.md': 'A thought.\n',
    });
  const portsOf = (memory: ReturnType<typeof memoryVault>): ArchivePorts => ({
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
  });
  const listed = async (memory: ReturnType<typeof memoryVault>) => {
    const files = Object.fromEntries(memory.files);
    const query = atlasQueryIndex({ markdown: fakeMarkdown(), files });
    const { items } = await listInbox({ index: fakeIndexPort({ query }), ...GTD });
    return items.map((item) => item.path).sort();
  };

  it('leaves the list on a status alone, with no project, wherever it lives', async () => {
    const memory = start();
    expect(await listed(memory)).toEqual([CALL, 'Inbox/Idea.md', IMPORTED]);

    for (const at of [CALL, IMPORTED]) {
      await clarifyInboxItem({
        ports: portsOf(memory),
        path: createVaultPath(at),
        clarification: { status: 'next-action' },
        notePaths: [...memory.files.keys()].map(createVaultPath),
        today: TODAY,
      });
    }

    expect(await listed(memory)).toEqual(['Inbox/Idea.md']);
    // Neither moved: a single action needs no project.
    expect(memory.files.has(CALL)).toBe(true);
    expect(memory.files.has(IMPORTED)).toBe(true);
  });
});

describe('One Inbox — the weekly review counts what the page lists', () => {
  const files = {
    '.atlas/types/task.md': GTD_TASK_TYPE,
    'Inbox/Captured.md': jsonLinesNote({ type: 'task', status: 'inbox' }),
    'Inbox/Decided.md': jsonLinesNote({ type: 'task', status: 'next-action' }),
    'Inbox/Idea.md': 'A thought.\n',
    'Tasks/Imported.md': jsonLinesNote({ type: 'task', status: 'inbox' }),
    'Tasks/Moving.md': jsonLinesNote({ type: 'task', status: 'in-progress' }),
  };
  const WAITING = ['Inbox/Captured.md', 'Inbox/Idea.md', 'Tasks/Imported.md'];

  it('reads the vault’s Task type, so a task given a status has left both', async () => {
    const setup = proposalVault(files);
    const index = fakeIndexPort({
      query: atlasQueryIndex({ markdown: jsonLinesMarkdown(), files }),
    });
    const ports = { index, fs: setup.ports.fs, markdown: setup.ports.markdown };

    const page = await listVaultInbox(ports);
    const review = await readWeeklyReview({
      ...ports,
      clock: { today: () => TODAY, now: () => Date.UTC(2026, 9, 11, 12) },
    });

    expect(page.items.map((item) => item.path).sort()).toEqual(WAITING);
    expect(review.inbox.toFile).toBe(WAITING.length);
  });

  it('keeps the whole folder in a vault whose Task type has statuses of its own', async () => {
    const legacy = Object.fromEntries(
      Object.entries(files).filter(([path]) => path !== '.atlas/types/task.md'),
    );
    const setup = proposalVault(legacy);
    const index = fakeIndexPort({
      query: atlasQueryIndex({ markdown: jsonLinesMarkdown(), files: legacy }),
    });
    const page = await listVaultInbox({
      index,
      fs: setup.ports.fs,
      markdown: setup.ports.markdown,
    });
    expect(page.items.map((item) => item.path).sort()).toEqual([
      'Inbox/Captured.md',
      'Inbox/Decided.md',
      'Inbox/Idea.md',
      'Tasks/Imported.md',
    ]);
  });
});
