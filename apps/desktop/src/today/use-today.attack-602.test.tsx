// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  createVaultPath,
  REVIEW_PROJECTS_QUERY_MARK,
  REVIEW_TASKS_QUERY_MARK,
  type ObjectType,
} from '@dfai/domain';
import {
  fakeIndexPort,
  fakeVaultFs,
  memoryVault,
  recordingActivity,
  type QueryResult,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import type { OpenEditors } from '../panes/open-editors.ts';
import { useToday } from './use-today.ts';

/**
 * Attack on PR #602 (#108): the Today page's choices against a `focus` of
 * the person's own, and a tick of a chosen repeating task, on a fixed clock.
 */
const NOW = Date.UTC(2026, 9, 13, 15);
const TODAY = '2026-10-13';
const CLOCK = { today: () => TODAY, now: () => NOW };
const PATH = createVaultPath('Tasks/Write the chapter.md');
const ROW = { path: PATH, title: 'Write the chapter' };

const TEXT_FOCUS_TYPES: readonly ObjectType[] = [
  {
    name: 'task',
    label: 'Task',
    properties: [
      {
        key: 'focus',
        kind: 'text',
        label: 'Focus area',
        required: false,
        options: [],
        target: null,
        many: false,
      },
    ],
  },
];
const PLAIN_TYPES: readonly ObjectType[] = [{ name: 'task', label: 'Task', properties: [] }];

const noPane = { setPropertiesIfOpen: async () => false } as unknown as OpenEditors;

function answerWith(focus: string | null) {
  return (sql: string): QueryResult => {
    if (sql.startsWith(REVIEW_TASKS_QUERY_MARK)) {
      return {
        columns: ['path', 'title', 'modified', 'status', 'due', 'defer', 'focus'],
        rows: [[PATH, 'Write the chapter', NOW, 'next-action', TODAY, null, focus]],
        truncated: false,
      };
    }
    if (sql.startsWith(REVIEW_PROJECTS_QUERY_MARK)) {
      return { columns: ['path', 'title', 'status', 'moving'], rows: [], truncated: false };
    }
    return { columns: ['path', 'title', 'type'], rows: [], truncated: false };
  };
}

function setUp({
  taskText,
  types,
  indexedFocus,
}: {
  taskText: string;
  types: readonly ObjectType[];
  indexedFocus: string | null;
}) {
  const memory = memoryVault({ [PATH]: taskText });
  const answer = answerWith(indexedFocus);
  const query = vi.fn(async (sql: string) => answer(sql));
  const ports = {
    index: fakeIndexPort({ query }),
    fs: fakeVaultFs(memory.fs),
    markdown: remarkMarkdown,
  };
  const hook = renderHook(() =>
    useToday({
      ports,
      editors: noPane,
      activity: recordingActivity(),
      clock: CLOCK,
      types,
      vaultKey: 'vault-a',
      indexKey: '1',
      indexReady: true,
      open: true,
      onSettled: vi.fn(),
    }),
  );
  return { ...hook, text: () => memory.files.get(PATH) ?? '' };
}

describe('useToday against a focus of the person’s own (#108)', () => {
  const WRITING =
    '---\ntype: task\nstatus: next-action\ndue: 2026-10-13\nfocus: writing\n---\n\n# Write\n';

  it('does not write today over a text focus when the Task type declares focus as text', async () => {
    const { result, text } = setUp({
      taskText: WRITING,
      types: TEXT_FOCUS_TYPES,
      indexedFocus: null,
    });
    await waitFor(() => expect(result.current.page.today).not.toBeNull());

    await act(async () => result.current.page.onChoose({ ...ROW, choice: 'choose' }));
    await waitFor(() => expect(result.current.page.today).not.toBeNull());

    expect(text()).toBe(WRITING);
  });
});

describe('useToday ticking a chosen repeating task (#108)', () => {
  const CHOSEN_REPEATING =
    '---\ntype: task\nstatus: next-action\ndue: 2026-10-13\nrecurrence: every week\nfocus: 2026-10-13\n---\n\n# Write\n';

  it('a tick takes the day’s choice off, so it is neither Chosen today nor Carried over tomorrow', async () => {
    const { result, text } = setUp({
      taskText: CHOSEN_REPEATING,
      types: PLAIN_TYPES,
      indexedFocus: TODAY,
    });
    await waitFor(() => expect(result.current.page.today).not.toBeNull());

    await act(async () => result.current.page.onDone(ROW));
    await waitFor(() => expect(result.current.notice).not.toBeNull());

    expect(text()).toContain('due: 2026-10-20');
    expect(text()).not.toContain(`focus: ${TODAY}`);
  });
});
