// @vitest-environment jsdom
/**
 * A card added in a board's column and lane is given both values as their
 * fields are written — a number as a number, a tick as a tick (issue #6).
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { parseObjectType } from '@dfai/domain';
import { fakeVaultFs, recordingActivity, TaskRuleRefusedError } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { useCardCreation } from './use-card-creation.ts';

const TASK = parseObjectType({
  name: 'task',
  properties: { phase: 'number', flagged: 'checkbox', status: 'select' },
});

function creation({
  groupBy,
  subGroupBy,
  refuse = null,
}: {
  groupBy: string;
  subGroupBy: string | null;
  /** What the write says when it says no: a message the disk gives, or a refusal. */
  refuse?: string | Error | null;
}) {
  const created: string[] = [];
  const errors: string[] = [];
  const activity = recordingActivity();
  const fs = fakeVaultFs({
    createNote: async ({ contents }) => {
      if (refuse !== null) throw typeof refuse === 'string' ? new Error(refuse) : refuse;
      created.push(contents);
      return 0;
    },
  });
  const hook = renderHook(() =>
    useCardCreation({
      activity,
      fs,
      markdown: remarkMarkdown,
      query: { type: 'task', columns: [], filters: [], sorts: [], limit: 50 },
      type: TASK,
      groupBy,
      subGroupBy,
      dateKey: null,
      groupOptions: [],
      notePaths: [],
      onChanged: () => {},
      onError: (message) => errors.push(message),
    }),
  );
  return { hook, created, errors, activity };
}

describe('a card added in a column and a lane', () => {
  it('writes a number column’s value as a number and a ticked lane as a tick', async () => {
    const { hook, created } = creation({ groupBy: 'phase', subGroupBy: 'flagged' });
    act(() => hook.result.current.addCard({ value: '3', lane: 'true', name: 'Ship' }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatch(/^phase: 3$/m);
    expect(created[0]).toMatch(/^flagged: true$/m);
  });

  it('gives a card added to the unticked lane no box at all', async () => {
    const { hook, created } = creation({ groupBy: 'status', subGroupBy: 'flagged' });
    act(() => hook.result.current.addCard({ value: 'doing', lane: 'false', name: 'Ship' }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatch(/^status: doing$/m);
    expect(created[0]).not.toMatch(/flagged/);
  });
});

describe('a card that could not be added', () => {
  it('is recorded once in the Activity log, with no link to a note that is not there', async () => {
    const { hook, errors, activity } = creation({
      groupBy: 'status',
      subGroupBy: null,
      refuse: 'The disk is full.',
    });
    act(() => hook.result.current.addCard({ value: 'doing', name: 'Ship' }));
    await waitFor(() => expect(errors).toEqual(['The disk is full.']));
    expect(activity.reports).toEqual([
      {
        level: 'error',
        kind: 'save',
        message: 'Could not add the card. The disk is full.',
        subject: null,
      },
    ]);
  });

  it('is not recorded when a task rule refuses it, which the board shows to act on', async () => {
    const { hook, created, errors, activity } = creation({
      groupBy: 'status',
      subGroupBy: null,
      refuse: new TaskRuleRefusedError('A rule says no.'),
    });
    act(() => hook.result.current.addCard({ value: 'doing', name: 'Ship' }));
    await waitFor(() => expect(errors).toEqual(['A rule says no.']));
    expect(created).toEqual([]);
    expect(activity.reports).toEqual([]);
  });

  it('is added to the Waiting column with nobody to wait on, asking for no one (#202)', async () => {
    const { hook, created, errors, activity } = creation({ groupBy: 'status', subGroupBy: null });
    act(() => hook.result.current.addCard({ value: 'waiting', name: 'Ship' }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatch(/^status: waiting$/m);
    expect(errors).toEqual([]);
    expect(activity.reports).toEqual([]);
  });

  it('is not recorded when it is added', async () => {
    const { hook, created, activity } = creation({ groupBy: 'status', subGroupBy: null });
    act(() => hook.result.current.addCard({ value: 'doing', name: 'Ship' }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(activity.reports).toEqual([]);
  });
});
