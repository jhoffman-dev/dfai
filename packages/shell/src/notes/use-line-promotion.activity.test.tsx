// @vitest-environment jsdom
/**
 * Make task and the Activity log: a refusal — typing not yet saved — is said
 * on the page and not recorded; a promotion the page gave up on is recorded
 * once, naming the note it was made from.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createVaultPath } from '@dfai/domain';
import { fakeVaultFs, recordingActivity, type OpenNotes } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { createToasts } from '../toasts/toasts.ts';
import { useLinePromotion } from './use-line-promotion.ts';

const PLAN = createVaultPath('Tasks/Plan the launch.md');

function promoting({
  dirty,
  read,
}: {
  dirty: boolean;
  read: () => Promise<never> | Promise<{ text: string; modified: number }>;
}) {
  const activity = recordingActivity();
  const openNotes = {
    state: () => (dirty ? 'dirty' : 'closed'),
    setPropertiesIfOpen: async () => false,
    reload: () => {},
  } as unknown as OpenNotes;
  const hook = renderHook(() =>
    useLinePromotion({
      fs: fakeVaultFs({ readTextFile: read }),
      markdown: remarkMarkdown,
      openNotes,
      flush: async () => {},
      path: PLAN,
      notePaths: [PLAN],
      types: [],
      onChanged: () => {},
      onOpenNote: () => {},
      activity,
      toasts: createToasts(),
    }),
  );
  const promote = () => act(() => hook.result.current?.promote({ index: 0, text: 'Order chairs' }));
  return { activity, hook, promote };
}

const TEXT = async () => ({ text: '- [ ] Order chairs\n', modified: 1 });

describe('Make task, and the Activity log', () => {
  it('says a refusal on the page and records nothing', async () => {
    const { activity, hook, promote } = promoting({ dirty: true, read: TEXT });
    await promote();
    await waitFor(() => expect(hook.result.current?.notice?.message).toMatch(/unsaved|typing/i));
    expect(activity.reports).toEqual([]);
  });

  it('records once a promotion it gave up on', async () => {
    const { activity, hook, promote } = promoting({
      dirty: false,
      read: async () => {
        throw new Error('The disk is not answering.');
      },
    });
    await promote();
    await waitFor(() =>
      expect(hook.result.current?.notice?.message).toBe('The disk is not answering.'),
    );
    expect(activity.reports).toEqual([
      expect.objectContaining({
        level: 'error',
        kind: 'save',
        subject: { kind: 'note', path: PLAN },
      }),
    ]);
    expect(activity.reports[0]?.message).toMatch(/^Could not make the task — Plan the launch\./);
  });
});
