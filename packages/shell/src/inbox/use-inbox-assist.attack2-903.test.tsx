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
import { assistAsks, type AskStorage } from './assist-asks-store.ts';
import { useInboxAssist, type InboxAssistWiring } from './use-inbox-assist.ts';

/**
 * Adversarial second pass on #903 (#900): two windows on one machine share
 * Suggest's kept asks, and between them still ask no more than the hour allows.
 */

const NOW = Date.UTC(2026, 11, 1, 9, 0, 0);
const LOCAL_NOW = '2026-12-01T09:00:00';
const CALL: InboxItem = inboxItem({
  path: createVaultPath('Inbox/Call Mara Quill.md'),
  title: 'Call Mara Quill',
  type: null,
});

function sharedStorage(): AskStorage {
  const kept = new Map<string, string>();
  return { read: (key) => kept.get(key) ?? null, write: (key, text) => void kept.set(key, text) };
}

function aWindow(stream: ModelProvider['stream'], storage: AskStorage) {
  const provider: ModelProvider = {
    id: 'claude-code',
    status: async () => ({ ready: true }),
    stream,
  };
  const wiring: InboxAssistWiring = {
    claude: { provider: () => provider, deadline: () => new AbortController().signal },
    asks: assistAsks(storage),
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
  return renderHook(() =>
    useInboxAssist({ wiring, ports, clock, items: [CALL], vaultKey: '/vault' }),
  );
}

describe('attack2-903: two windows, one ask left', () => {
  it('asks Claude once between them', async () => {
    // Claude never answers: both asks stay in flight.
    const never = new Promise<void>(() => {});
    const stream = vi.fn(async function* (): AsyncIterable<ModelEvent> {
      await never;
      yield { type: 'text', text: '' };
    });
    const storage = sharedStorage();
    const seed = assistAsks(storage);
    const at = localTimeMs(LOCAL_NOW)! - 60_000;
    for (let n = 0; n < 29; n += 1) seed.record('/vault', at);
    const first = aWindow(stream, storage);
    const second = aWindow(stream, storage);
    act(() => {
      first.result.current!.onSuggest();
      second.result.current!.onSuggest();
    });
    await waitFor(() =>
      expect(
        stream.mock.calls.length === 2 ||
          [first, second].some((each) => each.result.current!.view?.kind === 'not-now'),
      ).toBe(true),
    );
    expect(stream).toHaveBeenCalledTimes(1);
  });
});
