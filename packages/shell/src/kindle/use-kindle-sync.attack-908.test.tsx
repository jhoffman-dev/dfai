// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  KINDLE_AUTO_SYNC_INTERVAL_MS,
  KINDLE_SIGN_IN_MESSAGE,
  type KindleSyncRecord,
  type KindleSyncReport,
} from '@dfai/domain';
import { fakeIndexPort, fakeVaultFs, type KindleSync } from '@dfai/application';
import { useKindleSync, type KindleHost, type KindleWindowOptions } from './use-kindle-sync.ts';

/*
 * Attack on PR #908 (#901, slice 2): Kindle switched off while a sync it
 * asked for is under way, or while its toast is up. Fictional vault only.
 */

const START = Date.UTC(2026, 9, 22, 9, 0);
const VAULT = '/Users/mara/Vault';
const CONNECTED: KindleSyncRecord = { connected: true, lastHoldAt: null, last: null };
const SIGN_IN: KindleSyncReport = { kind: 'sign_in_required', books: [], added: 0 };

/** A host whose syncs each wait until the test ends them with `report`. */
function slowHost(report: KindleSyncReport) {
  let kept: KindleSyncRecord = CONNECTED;
  const pending: (() => void)[] = [];
  const calls: string[] = [];
  const sync: KindleSync = () =>
    new Promise((resolve) => {
      calls.push('sync');
      pending.push(() => resolve(report));
    });
  const kindle: KindleHost = {
    notebook: {
      fetchLibrary: () => Promise.reject(new Error('not here')),
      fetchAnnotations: () => Promise.reject(new Error('not here')),
    },
    session: { connect: async () => {}, disconnect: async () => {} },
    sync,
    delay: { wait: async () => {} },
    records: {
      read: () => kept,
      write: (record) => {
        kept = record;
      },
    },
    vaults: { isOn: (vault: string) => vault === VAULT, set: () => {} },
  };
  return { kindle, calls, finishAll: () => pending.splice(0).forEach((finish) => finish()) };
}

function optionsFor(kindle: KindleHost, enabled: boolean): KindleWindowOptions {
  return {
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
    vaultKey: VAULT,
    indexReady: true,
    onWrote: () => {},
    enabled,
  };
}

const settle = () => act(async () => {});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useKindleSync, switched off mid-flight (attack #908)', () => {
  it('raises no toast for a Sync now that ends after Kindle was switched off', async () => {
    const { kindle, finishAll } = slowHost(SIGN_IN);
    const { result, rerender } = renderHook((props: KindleWindowOptions) => useKindleSync(props), {
      initialProps: optionsFor(kindle, true),
    });
    await settle();
    // The automatic sync on mount is under way; Sync now joins nothing and waits too.
    finishAll();
    await settle();
    vi.setSystemTime(START + KINDLE_AUTO_SYNC_INTERVAL_MS);
    act(() => result.current.syncNow());
    rerender(optionsFor(kindle, false));
    finishAll();
    await settle();
    expect(result.current.toast).toBeNull();
  });

  it('does not bring back an old toast when Kindle is switched on again', async () => {
    const { kindle, finishAll } = slowHost(SIGN_IN);
    const { result, rerender } = renderHook((props: KindleWindowOptions) => useKindleSync(props), {
      initialProps: optionsFor(kindle, true),
    });
    await settle();
    finishAll();
    await settle();
    act(() => result.current.syncNow());
    finishAll();
    await settle();
    expect(result.current.toast).toBe(KINDLE_SIGN_IN_MESSAGE);
    rerender(optionsFor(kindle, false));
    // Days later the person switches Kindle back on: the old words are not news.
    vi.setSystemTime(START + 3 * 24 * 60 * 60 * 1000);
    rerender(optionsFor(kindle, true));
    expect(result.current.toast).toBeNull();
  });
});
