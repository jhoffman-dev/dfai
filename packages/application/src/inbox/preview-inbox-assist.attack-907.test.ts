import { describe, expect, it } from 'vitest';
import { createVaultPath, inboxItem, REVIEW_TASKS_QUERY_MARK } from '@dfai/domain';
import { fakeModel, type ScriptedRound } from '../testing/fake-model.ts';
import { fakeIndexPort, fakeMarkdown, fakeVaultFs } from '../testing/fake-ports.ts';
import { previewInboxAssist, type InboxAssistPorts } from './preview-inbox-assist.ts';

/**
 * Attack on #906 (PR #907). The open tasks the title rule reads include the
 * Inbox's own tasks, so two captures of one task are each listed as the
 * other's duplicate. A later slice archives the copy a duplicate line names
 * as this item: planning both would archive both, and the task is lost.
 */

const NOW = Date.UTC(2026, 10, 17, 9, 0, 0);
const FIRST = inboxItem({
  path: createVaultPath('Inbox/Renew Larkspur contract.md'),
  title: 'Renew Larkspur contract',
  type: 'task',
});
const SECOND = inboxItem({
  path: createVaultPath('Inbox/Renew Larkspur contract 1.md'),
  title: 'Renew Larkspur contract',
  type: 'task',
});

const entry = (item: string, duplicateOf: string) => ({
  item,
  kind: 'task',
  projects: [],
  due: null,
  waitingOn: null,
  confidence: 'high',
  why: 'The same renewal.',
  duplicateOf,
  people: [],
});
const table = (columns: string[], rows: unknown[][]) => ({ columns, rows, truncated: false });

function ports(round: ScriptedRound): InboxAssistPorts {
  const model = fakeModel([round]);
  return {
    recordAsk: () => undefined,
    provider: () => ({ ...model, status: async () => ({ ready: true }) }),
    deadline: () => new AbortController().signal,
    clock: { now: () => NOW, today: () => '2026-11-17', localNow: () => '2026-11-17T09:00:00' },
    fs: fakeVaultFs({
      readNotes: async (paths) =>
        paths.map((path) => ({
          path,
          text: 'Before December.\n',
          modified: NOW - 3_600_000,
          size: 1,
        })),
    }),
    markdown: fakeMarkdown(),
    index: fakeIndexPort({
      notesOfType: async () => [],
      query: async (sql) =>
        sql.startsWith(REVIEW_TASKS_QUERY_MARK)
          ? table(
              ['path', 'title', 'status', 'project'],
              [
                [FIRST.path, FIRST.title, 'inbox', null],
                [SECOND.path, SECOND.title, 'inbox', null],
              ],
            )
          : table([], []),
    }) as InboxAssistPorts['index'],
    unsaved: () => false,
  };
}

describe('attack-907: duplicates within one batch', () => {
  it('never plans two Inbox items as duplicates of each other', async () => {
    const round: ScriptedRound = [
      {
        type: 'text',
        text: JSON.stringify({
          items: [entry(FIRST.path, SECOND.path), entry(SECOND.path, FIRST.path)],
        }),
      },
    ];
    const outcome = await previewInboxAssist(ports(round), {
      items: [FIRST, SECOND],
      previewed: [],
    });
    if (outcome.kind !== 'plan') throw new Error(`no plan: ${outcome.message}`);
    const duplicates = outcome.rows.filter((row) => row.step.kind === 'duplicate');
    expect(duplicates.length).toBeLessThan(2);
  });
});
