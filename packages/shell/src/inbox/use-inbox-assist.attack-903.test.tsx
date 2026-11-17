// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  fakeIndexPort,
  fakeMarkdown,
  fakeVaultFs,
  type ArchivePorts,
  type ModelEvent,
  type ModelProvider,
} from '@dfai/application';
import { createVaultPath, inboxItem, localTimeMs, type InboxItem } from '@dfai/domain';
import { assistAsks, useInboxAssist, type InboxAssistWiring } from './use-inbox-assist.ts';

/**
 * Adversarial pass on #903 (#900): Suggest's asks are held to the hour's
 * allowance however the bar is pressed, and every ask that reached Claude
 * is counted.
 */

const NOW = Date.UTC(2026, 11, 1, 9, 0, 0);
const LOCAL_NOW = '2026-12-01T09:00:00';
const CALL: InboxItem = inboxItem({
  path: createVaultPath('Inbox/Call Mara Quill.md'),
  title: 'Call Mara Quill',
  type: null,
});

function setUp(stream: ModelProvider['stream']) {
  const provider: ModelProvider = {
    id: 'claude-code',
    status: async () => ({ ready: true }),
    stream,
  };
  const wiring: InboxAssistWiring = {
    claude: { provider: () => provider, deadline: () => new AbortController().signal },
    asks: assistAsks(),
  };
  const ports = {
    fs: fakeVaultFs({
      readNotes: async (paths) =>
        paths.map((path) => ({ path, text: 'Mara’s number', modified: NOW - 3_600_000, size: 13 })),
    }),
    markdown: fakeMarkdown(),
    index: fakeIndexPort(),
    editors: { state: () => 'closed' },
  } as unknown as ArchivePorts;
  const clock = { now: () => NOW, today: () => '2026-12-01', localNow: () => LOCAL_NOW };
  const hook = renderHook(() =>
    useInboxAssist({ wiring, ports, clock, items: [CALL], vaultKey: '/vault' }),
  );
  return { hook, wiring };
}

describe('attack-903: the allowance holds however Suggest is pressed', () => {
  it('with one ask left, press, Dismiss, press asks Claude once', async () => {
    // Claude never answers: the first ask stays in flight.
    const never = new Promise<void>(() => {});
    const stream = vi.fn(async function* (): AsyncIterable<ModelEvent> {
      await never;
      yield { type: 'text', text: '' };
    });
    const { hook, wiring } = setUp(stream);
    const at = localTimeMs(LOCAL_NOW)! - 60_000;
    for (let n = 0; n < 29; n += 1) wiring.asks.record('/vault', at);
    act(() => hook.result.current!.onSuggest());
    await waitFor(() => expect(stream).toHaveBeenCalledTimes(1));
    act(() => hook.result.current!.onDismiss());
    act(() => hook.result.current!.onSuggest());
    // Settled either way: refused for the spent hour, or a second ask under way.
    await waitFor(() =>
      expect(hook.result.current!.view?.kind === 'not-now' || stream.mock.calls.length > 1).toBe(
        true,
      ),
    );
    expect(stream).toHaveBeenCalledTimes(1);
    expect(hook.result.current!.view?.kind).toBe('not-now');
  });

  it('counts an ask that reached Claude and then failed unexpectedly', async () => {
    const stream = vi.fn(async function* (): AsyncIterable<ModelEvent> {
      yield { type: 'text', text: '{"items": [' };
      throw new TypeError('the stream broke');
    });
    const { hook, wiring } = setUp(stream);
    act(() => hook.result.current!.onSuggest());
    await waitFor(() => expect(hook.result.current!.view?.kind).toBe('not-now'));
    expect(stream).toHaveBeenCalledTimes(1);
    expect(wiring.asks.asked('/vault')).toHaveLength(1);
  });
});
