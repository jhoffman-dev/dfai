// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { NO_KINDLE_SYNC_RECORD, type KindleSyncRecord, type KindleSyncReport } from '@dfai/domain';
import { fakeIndexPort, fakeVaultFs, type KindleSync } from '@dfai/application';
import { useKindleSync, type KindleHost, type KindleWindowOptions } from './use-kindle-sync.ts';

/*
 * Regressions found reviewing PR #514 (#508): Disconnect pressed while a sync is under way,
 * through the window's hook as Settings and ⌘K press it.
 */

const START = Date.UTC(2026, 9, 22, 9, 0);
const SYNCED: KindleSyncReport = { kind: 'synced', books: [], added: 0 };
const CONNECTED: KindleSyncRecord = { connected: true, lastHoldAt: null, last: null };

/** A host whose one sync waits until the test lets it end, then says it went through. */
function slowHost(start: KindleSyncRecord) {
  let kept = start;
  let finish = () => {};
  const sync: KindleSync = () =>
    new Promise((resolve) => {
      finish = () => resolve(SYNCED);
    });
  const kindle: KindleHost = {
    notebook: {
      fetchLibrary: () => Promise.reject(new Error('not here')),
      fetchAnnotations: () => Promise.reject(new Error('not here')),
    },
    session: { connect: async () => {}, disconnect: async () => {} },
    sync,
    delay: { wait: async () => {} },
    records: { read: () => kept, write: (record) => void (kept = record) },
    vaults: { isOn: () => true, set: () => {} },
  };
  return { kindle, finish: () => finish(), kept: () => kept };
}

function render(kindle: KindleHost, overrides: Partial<KindleWindowOptions> = {}) {
  const options: KindleWindowOptions = {
    kindle,
    fs: fakeVaultFs(),
    markdown: {
      frontmatterProperties: () => ({}),
      noteBlocks: () => ({ quotes: [], hidden: [] }),
    },
    index: fakeIndexPort(),
    openNotes: { state: () => 'closed', reload: () => {} },
    rng: { next: () => 0.5 },
    clock: { now: () => Date.now(), today: () => '2026-10-22' },
    vaultKey: '/Users/mara/Vault',
    indexReady: true,
    onWrote: () => {},
    ...overrides,
  };
  return renderHook((props: KindleWindowOptions) => useKindleSync(props), {
    initialProps: options,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(START);
});
afterEach(() => vi.useRealTimers());

const settle = () => act(async () => {});

describe('useKindleSync, Disconnect during a sync (regression)', () => {
  it('stays disconnected after Disconnect pressed during the launch sync', async () => {
    const host = slowHost(CONNECTED);
    const { result } = render(host.kindle);
    await settle();
    // The automatic sync does not make the card busy, so Disconnect is enabled.
    expect(result.current.view.busy).toBeNull();
    act(() => result.current.disconnect());
    await settle();
    expect(result.current.view.connected).toBe(false);
    await act(async () => host.finish());
    await settle();
    expect(result.current.view.connected).toBe(false);
    expect(host.kept().connected).toBe(false);
  });

  it('stays disconnected after ⌘K Disconnect during the sync Connect started', async () => {
    const host = slowHost(NO_KINDLE_SYNC_RECORD);
    const { result } = render(host.kindle);
    act(() => result.current.connect());
    await settle();
    // Connected now, so ⌘K offers Disconnect while Connect's sync runs.
    expect(result.current.view.connected).toBe(true);
    act(() => result.current.disconnect());
    await settle();
    await act(async () => host.finish());
    await settle();
    expect(result.current.view.connected).toBe(false);
  });
});
