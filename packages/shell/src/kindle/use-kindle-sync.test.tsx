// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  KINDLE_AUTO_SYNC_INTERVAL_MS,
  KINDLE_NOT_INTO_VAULT_MESSAGE,
  KINDLE_SIGN_IN_MESSAGE,
  NO_KINDLE_SYNC_RECORD,
  type KindleSyncRecord,
  type KindleSyncReport,
} from '@dfai/domain';
import { fakeIndexPort, fakeVaultFs, type KindleSync } from '@dfai/application';
import { useKindleSync, type KindleHost, type KindleWindowOptions } from './use-kindle-sync.ts';

const START = Date.UTC(2026, 9, 22, 9, 0);

const VAULT = '/Users/mara/Vault';

/** Where the choices live: the vaults turned on, `VAULT` unless told otherwise. */
function memoryVaults(on: readonly string[] = [VAULT]) {
  const kept = new Set(on);
  return {
    kept,
    isOn: (vault: string) => kept.has(vault),
    set: (vault: string, turnedOn: boolean) =>
      void (turnedOn ? kept.add(vault) : kept.delete(vault)),
  };
}

function memoryRecords(start: KindleSyncRecord = NO_KINDLE_SYNC_RECORD) {
  let kept = start;
  return {
    read: () => kept,
    write: (record: KindleSyncRecord) => {
      kept = record;
    },
  };
}

/** A host whose sync answers `report` and counts its runs, and whose session records its calls. */
function host(report: KindleSyncReport, start?: KindleSyncRecord, vaults = memoryVaults()) {
  const calls: string[] = [];
  const ran: { vault?: string }[] = [];
  const sync: KindleSync = async (ports) => {
    calls.push('sync');
    ran.push(ports.vault === undefined ? {} : { vault: ports.vault });
    return report;
  };
  const kindle: KindleHost = {
    notebook: {
      fetchLibrary: () => Promise.reject(new Error('not here')),
      fetchAnnotations: () => Promise.reject(new Error('not here')),
    },
    session: {
      connect: async () => void calls.push('connect'),
      disconnect: async () => void calls.push('disconnect'),
    },
    sync,
    delay: { wait: async () => {} },
    records: memoryRecords(start),
    vaults,
  };
  return { kindle, calls, ran, vaults };
}

const SYNCED: KindleSyncReport = { kind: 'synced', books: [], added: 0 };
const CONNECTED: KindleSyncRecord = { connected: true, lastHoldAt: null, last: null };

/** The window's options over `kindle`: a vault open and its index ready, unless overridden. */
function optionsFor(
  kindle: KindleHost,
  overrides: Partial<KindleWindowOptions> = {},
): KindleWindowOptions {
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
    ...overrides,
  };
}

function render(kindle: KindleHost, overrides: Partial<KindleWindowOptions> = {}) {
  return renderHook((props: KindleWindowOptions) => useKindleSync(props), {
    initialProps: optionsFor(kindle, overrides),
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(START);
});
afterEach(() => vi.useRealTimers());

const settle = () => act(async () => {});

describe('useKindleSync', () => {
  it('syncs nothing by itself before Kindle is connected', async () => {
    const { kindle, calls } = host(SYNCED);
    const { result } = render(kindle);
    await settle();
    expect(calls).toEqual([]);
    expect(result.current.view).toMatchObject({ connected: false, last: null });
  });

  it('once connected, syncs when the index is ready and again every four hours', async () => {
    const { kindle, calls } = host(SYNCED, CONNECTED);
    const { rerender, result } = render(kindle, { indexReady: false });
    await settle();
    expect(calls).toEqual([]);
    rerender(optionsFor(kindle));
    await settle();
    expect(calls).toEqual(['sync']);
    await act(async () => {
      vi.advanceTimersByTime(KINDLE_AUTO_SYNC_INTERVAL_MS);
    });
    expect(calls).toEqual(['sync', 'sync']);
    expect(result.current.toast).toBeNull();
  });

  it('says what a Sync now found, plainly, on the card and in a toast', async () => {
    const { kindle } = host({ kind: 'sign_in_required', books: [], added: 0 }, CONNECTED);
    const { result } = render(kindle);
    act(() => result.current.syncNow());
    expect(result.current.view.busy).toBe('syncing');
    await settle();
    expect(result.current.view.busy).toBeNull();
    expect(result.current.toast).toBe(KINDLE_SIGN_IN_MESSAGE);
    expect(result.current.view.last).toMatchObject({ message: KINDLE_SIGN_IN_MESSAGE, ok: false });
    act(() => result.current.dismissToast(result.current.toastShown));
    expect(result.current.toast).toBeNull();
  });

  it('connects, then syncs, and disconnects', async () => {
    const { kindle, calls } = host(SYNCED);
    const { result } = render(kindle);
    act(() => result.current.connect());
    await settle();
    expect(calls).toEqual(['connect', 'sync']);
    expect(result.current.view.connected).toBe(true);
    act(() => result.current.disconnect());
    await settle();
    expect(calls).toEqual(['connect', 'sync', 'disconnect']);
    expect(result.current.view).toMatchObject({ connected: false, last: null });
  });

  it('shows why Connect did not go through', async () => {
    const { kindle } = host(SYNCED);
    const refusing: KindleHost = {
      ...kindle,
      session: { ...kindle.session, connect: () => Promise.reject(new Error('Not on this Mac.')) },
    };
    const { result } = render(refusing);
    act(() => result.current.connect());
    await settle();
    expect(result.current.view).toMatchObject({ connected: false, problem: 'Not on this Mac.' });
  });

  it('refreshes the vault after a sync added highlights', async () => {
    const onWrote = vi.fn();
    const { kindle } = host({ kind: 'synced', books: [], added: 3 }, CONNECTED);
    render(kindle, { onWrote });
    await settle();
    expect(onWrote).toHaveBeenCalledOnce();
  });

  it('writes into the vault it was told of, so a sync of another vault is another sync', async () => {
    const { kindle, ran } = host(SYNCED, CONNECTED);
    render(kindle);
    await settle();
    expect(ran).toEqual([{ vault: VAULT }]);
  });
});

describe('useKindleSync, a vault the person has not turned it on for (ADR-0044)', () => {
  it('syncs nothing by itself, though connected and the index is ready', async () => {
    const { kindle, calls } = host(SYNCED, CONNECTED, memoryVaults([]));
    const { result } = render(kindle);
    await settle();
    await act(async () => {
      vi.advanceTimersByTime(KINDLE_AUTO_SYNC_INTERVAL_MS);
    });
    expect(calls).toEqual([]);
    expect(result.current.view.intoVault).toBe(false);
  });

  it('answers Sync now by saying how to turn it on, and syncs nothing', async () => {
    const { kindle, calls } = host(SYNCED, CONNECTED, memoryVaults([]));
    const { result } = render(kindle);
    act(() => result.current.syncNow());
    await settle();
    expect(calls).toEqual([]);
    expect(result.current.toast).toBe(KINDLE_NOT_INTO_VAULT_MESSAGE);
    expect(result.current.view.busy).toBeNull();
  });

  it('connects, then says how to turn it on rather than syncing', async () => {
    const { kindle, calls } = host(SYNCED, undefined, memoryVaults([]));
    const { result } = render(kindle);
    act(() => result.current.connect());
    await settle();
    expect(calls).toEqual(['connect']);
    expect(result.current.view.connected).toBe(true);
    expect(result.current.toast).toBe(KINDLE_NOT_INTO_VAULT_MESSAGE);
  });

  it('syncs at once when the person turns it on, and keeps the choice for this vault only', async () => {
    const { kindle, calls, vaults } = host(SYNCED, CONNECTED, memoryVaults([]));
    const { result, rerender } = render(kindle);
    await settle();
    expect(calls).toEqual([]);
    act(() => result.current.setIntoVault(true));
    await settle();
    expect(calls).toEqual(['sync']);
    expect(result.current.view.intoVault).toBe(true);
    expect([...vaults.kept]).toEqual([VAULT]);
    // Another vault was never turned on.
    rerender(optionsFor(kindle, { vaultKey: '/Users/mara/Other Vault' }));
    await settle();
    expect(result.current.view.intoVault).toBe(false);
    expect(calls).toEqual(['sync']);
  });

  it('stops syncing by itself when the person turns it off', async () => {
    const { kindle, calls } = host(SYNCED, CONNECTED);
    const { result } = render(kindle);
    await settle();
    act(() => result.current.setIntoVault(false));
    await act(async () => {
      vi.advanceTimersByTime(KINDLE_AUTO_SYNC_INTERVAL_MS);
    });
    expect(calls).toEqual(['sync']);
  });

  it('keeps no choice with no vault open', async () => {
    const { kindle, vaults } = host(SYNCED, CONNECTED, memoryVaults([]));
    const { result } = render(kindle, { vaultKey: null });
    act(() => result.current.setIntoVault(true));
    expect(result.current.view.intoVault).toBe(false);
    expect(vaults.kept.size).toBe(0);
  });
});

describe('useKindleSync, presses that come twice (⌘K)', () => {
  it('opens one sign-in window for Connect pressed twice before the first returns', async () => {
    const { kindle, calls } = host(SYNCED);
    let signedIn = () => {};
    const slow: KindleHost = {
      ...kindle,
      session: {
        ...kindle.session,
        connect: () =>
          new Promise<void>((resolve) => {
            calls.push('connect');
            signedIn = resolve;
          }),
      },
    };
    const { result } = render(slow);
    act(() => {
      result.current.connect();
      result.current.connect();
    });
    expect(result.current.view.busy).toBe('connecting');
    await act(async () => signedIn());
    await settle();
    expect(calls.filter((call) => call === 'connect')).toEqual(['connect']);
  });

  it('disconnects once for Disconnect pressed twice, and takes none while the sign-in window is open', async () => {
    const { kindle, calls } = host(SYNCED, CONNECTED);
    const { result } = render(kindle);
    await settle();
    act(() => {
      result.current.disconnect();
      result.current.disconnect();
    });
    await settle();
    expect(calls.filter((call) => call === 'disconnect')).toEqual(['disconnect']);
  });

  it('runs one Sync now for Sync now pressed twice', async () => {
    const { kindle, calls } = host(SYNCED, {
      ...CONNECTED,
      last: { at: 1, message: 'x', ok: true },
    });
    const { result } = render(kindle);
    await settle();
    calls.length = 0;
    act(() => {
      result.current.syncNow();
      result.current.syncNow();
    });
    await settle();
    expect(calls).toEqual(['sync']);
  });
});
