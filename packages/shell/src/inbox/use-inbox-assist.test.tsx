// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  fakeIndexPort,
  fakeMarkdown,
  fakeVaultFs,
  type ArchivePorts,
  type ModelProvider,
} from '@dfai/application';
import { createVaultPath, inboxItem, type InboxItem } from '@dfai/domain';
import { assistAsks, useInboxAssist, type InboxAssistWiring } from './use-inbox-assist.ts';

/**
 * #900: Suggest's hook does nothing until pressed; pressed, it shows the
 * plan as words the page draws, counts its ask, and drops an answer that
 * arrives after it was dismissed.
 */

const NOW = Date.UTC(2026, 11, 1, 9, 0, 0);
const CALL: InboxItem = inboxItem({
  path: createVaultPath('Inbox/Call Mara Quill.md'),
  title: 'Call Mara Quill',
  type: null,
});
const ANSWER = JSON.stringify({
  items: [
    {
      item: CALL.path,
      kind: 'note',
      projects: [],
      due: null,
      waitingOn: null,
      confidence: 'high',
      why: 'Words to keep.',
      duplicateOf: null,
      people: [],
    },
  ],
});

function setUp() {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const stream = vi.fn(async function* () {
    await held;
    yield { type: 'text' as const, text: ANSWER };
  });
  const provider: ModelProvider = {
    id: 'claude-code',
    status: async () => ({ ready: true }),
    stream,
  };
  const wiring: InboxAssistWiring = {
    claude: { provider: () => provider, deadline: () => new AbortController().signal },
    asks: assistAsks(),
  };
  // Only what Suggest reads: the moves and writes an ArchivePorts also holds are never reached.
  const ports = {
    fs: fakeVaultFs({
      readNotes: async (paths) =>
        paths.map((path) => ({ path, text: 'Mara’s number', modified: NOW - 3_600_000, size: 13 })),
    }),
    markdown: fakeMarkdown(),
    index: fakeIndexPort(),
    editors: { state: () => 'closed' },
  } as unknown as ArchivePorts;
  const clock = {
    now: () => NOW,
    today: () => '2026-12-01',
    localNow: () => '2026-12-01T09:00:00',
  };
  const hook = renderHook(
    ({ on }: { on: boolean }) =>
      useInboxAssist({
        wiring: on ? wiring : null,
        ports,
        clock,
        items: [CALL],
        vaultKey: '/vault',
      }),
    { initialProps: { on: true } },
  );
  return { hook, wiring, stream, release };
}

describe('useInboxAssist', () => {
  it('is null where Claude is not offered, and asks nothing until pressed', () => {
    const { hook, stream } = setUp();
    expect(hook.result.current?.view).toBeNull();
    hook.rerender({ on: false });
    expect(hook.result.current).toBeNull();
    expect(stream).not.toHaveBeenCalled();
  });

  it('shows it is asking, then the plan as words, and counts the ask', async () => {
    const { hook, wiring, release } = setUp();
    act(() => hook.result.current!.onSuggest());
    expect(hook.result.current!.view).toEqual({ kind: 'asking' });
    release();
    await waitFor(() => expect(hook.result.current!.view?.kind).toBe('plan'));
    expect(hook.result.current!.view).toEqual({
      kind: 'plan',
      summary: '1 item: would leave 1',
      rows: [
        {
          path: CALL.path,
          title: 'Call Mara Quill',
          does: 'Leave it',
          why: 'Nowhere clear to file it.',
          tone: 'leave',
          people: [],
          action: { kind: 'none' },
        },
      ],
      more: null,
      canApplyAll: false,
      canUndoAll: false,
      busy: false,
      said: '',
    });
    expect(wiring.asks.asked('/vault')).toEqual([Date.UTC(2026, 11, 1, 9, 0, 0)]);
  });

  it('drops an answer that arrives after it was dismissed, but still counts the ask', async () => {
    const { hook, wiring, stream, release } = setUp();
    act(() => hook.result.current!.onSuggest());
    await waitFor(() => expect(stream).toHaveBeenCalledTimes(1));
    act(() => hook.result.current!.onDismiss());
    release();
    await waitFor(() => expect(wiring.asks.asked('/vault')).toHaveLength(1));
    expect(hook.result.current!.view).toBeNull();
  });
});
