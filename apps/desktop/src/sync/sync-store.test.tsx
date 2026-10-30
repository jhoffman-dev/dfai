// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { SyncController } from './use-sync.ts';
import type { PulledFilesGate } from './use-pulled-files.ts';
import {
  createSyncStore,
  publishSync,
  settleSync,
  useAutomationsHere,
  useSyncBadge,
  useSyncForRunners,
  useSyncForWindow,
} from './sync-store.ts';

// One of each, as a runner's state holds them across its draws.
const SYNCED: ReadonlySet<string> = new Set();
const NO_COUNT: PulledFilesGate['countGate'] = async () => ({ open: false, why: 'no-pull' });
const PULLS: ReadonlyMap<string, number> = new Map();

/** A runner's controller as far as the window reads it; the rest is never touched here. */
function controller(overrides: Partial<SyncController> = {}): SyncController {
  return {
    phase: { kind: 'unknown' },
    thisMac: null,
    settings: null,
    automationsHere: false,
    syncedThisSession: SYNCED,
    syncPulls: PULLS,
    pulledFiles: {
      standing: null,
      acts: async () => true,
      countGate: NO_COUNT,
      slept: false,
      paused: false,
    },
    settle: async () => {},
    ...overrides,
  } as SyncController;
}

function runnerOver() {
  const store = createSyncStore();
  let draws = 0;
  const hook = renderHook(() => {
    draws += 1;
    return useSyncForRunners(store, '/v');
  });
  return { store, hook, draws: () => draws };
}

describe('sync as the window reads it (#326)', () => {
  it('may act on nothing before the runner has said where sync stands', async () => {
    const { hook } = runnerOver();
    expect(hook.result.current).toMatchObject({ automationsHere: false, macKnown: false });
    expect(await hook.result.current.pulledFiles.acts('/v')).toBe(false);
  });

  it('hands the runners a sleep since the pull and the pause, which shut the gates without a new standing (#627 review)', () => {
    const { store, hook } = runnerOver();
    const gate = (slept: boolean, paused: boolean) => ({
      standing: null,
      acts: async () => false,
      countGate: NO_COUNT,
      slept,
      paused,
    });
    act(() =>
      store.setState({ vault: '/v', controller: controller({ pulledFiles: gate(false, false) }) }),
    );
    expect(hook.result.current.pulledFiles).toMatchObject({ slept: false, paused: false });

    act(() =>
      store.setState({ vault: '/v', controller: controller({ pulledFiles: gate(true, false) }) }),
    );
    expect(hook.result.current.pulledFiles.slept).toBe(true);

    act(() =>
      store.setState({ vault: '/v', controller: controller({ pulledFiles: gate(false, true) }) }),
    );
    expect(hook.result.current.pulledFiles).toMatchObject({ slept: false, paused: true });
  });

  it('asks the runner’s gate as it stands now, and keeps the window’s while only its object changes', async () => {
    const { store, hook, draws } = runnerOver();
    const first = vi.fn(async () => false);
    const second = vi.fn(async () => true);
    act(() =>
      store.setState({
        vault: '/v',
        controller: controller({
          pulledFiles: {
            standing: null,
            acts: first,
            countGate: NO_COUNT,
            slept: false,
            paused: false,
          },
        }),
      }),
    );
    const gate = hook.result.current.pulledFiles;
    const drawn = draws();

    // Another vault's gate, standing as the last did: the window is not drawn for it.
    act(() =>
      store.setState({
        vault: '/v',
        controller: controller({
          pulledFiles: {
            standing: null,
            acts: second,
            countGate: NO_COUNT,
            slept: false,
            paused: false,
          },
        }),
      }),
    );
    expect(draws()).toBe(drawn);
    expect(hook.result.current.pulledFiles).toBe(gate);
    expect(await gate.acts('/v')).toBe(true);
    expect(second).toHaveBeenCalledWith('/v', undefined);
    expect(first).not.toHaveBeenCalled();
  });

  it('draws the window when a pull moves the gate’s standing', () => {
    const { store, hook } = runnerOver();
    act(() => store.setState({ vault: '/v', controller: controller() }));
    const standing = { pulledAt: 1 } as unknown as PulledFilesGate['standing'];
    act(() =>
      store.setState({
        controller: controller({
          pulledFiles: {
            standing,
            acts: async () => true,
            countGate: NO_COUNT,
            slept: false,
            paused: false,
          },
        }),
      }),
    );
    expect(hook.result.current.pulledFiles.standing).toBe(standing);
  });

  it('knows the Mac once its id and the settings are both read', () => {
    const { store, hook } = runnerOver();
    act(() => store.setState({ vault: '/v', controller: controller({ thisMac: 'Studio' }) }));
    expect(hook.result.current.macKnown).toBe(false);
    act(() =>
      store.setState({
        controller: controller({
          thisMac: 'Studio',
          settings: {} as SyncController['settings'],
          automationsHere: true,
        }),
      }),
    );
    expect(hook.result.current).toMatchObject({ macKnown: true, automationsHere: true });
  });

  it('waits for the runner’s sync under way before a switch, and at once with none', async () => {
    const store = createSyncStore();
    await expect(settleSync(store)).resolves.toBeUndefined();
    const settle = vi.fn(async () => {});
    store.setState({ vault: '/v', controller: controller({ settle }) });
    await settleSync(store);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('gives a runner of another vault the closed defaults until its own sync is said (#419)', async () => {
    const store = createSyncStore();
    const acts = vi.fn(async () => true);
    publishSync(
      store,
      '/a',
      controller({
        thisMac: 'Studio',
        settings: {} as SyncController['settings'],
        automationsHere: true,
        pulledFiles: { standing: null, acts, countGate: NO_COUNT, slept: false, paused: false },
      }),
    );
    const hook = renderHook(({ vault }: { vault: string }) => useSyncForRunners(store, vault), {
      initialProps: { vault: '/a' },
    });
    expect(hook.result.current).toMatchObject({ automationsHere: true, macKnown: true });

    hook.rerender({ vault: '/b' });
    expect(hook.result.current).toMatchObject({ automationsHere: false, macKnown: false });
    expect(await hook.result.current.pulledFiles.acts('/b')).toBe(false);
    expect(acts).not.toHaveBeenCalled();
  });

  it('draws the window for the conflict warning and the pulls, not for who runs the automations', () => {
    const store = createSyncStore();
    let draws = 0;
    const hook = renderHook(() => {
      draws += 1;
      return useSyncForWindow(store);
    });
    act(() => publishSync(store, '/v', controller()));
    const drawn = draws;
    act(() => publishSync(store, '/v', controller({ thisMac: 'Studio', automationsHere: true })));
    expect(draws).toBe(drawn);
    expect(hook.result.current.conflict).toBeNull();
  });

  it('says nothing new when the runner draws again with every part as it was', () => {
    const store = createSyncStore();
    const first = controller();
    publishSync(store, '/v', first);
    const said = store.getState();
    publishSync(store, '/v', { ...first });
    expect(store.getState()).toBe(said);
    publishSync(store, '/v', { ...first, behind: 2 });
    expect(store.getState().controller?.behind).toBe(2);
  });

  it('draws the sync light only when what it shows changes', () => {
    const store = createSyncStore();
    const notSetUp = { kind: 'not-set-up' } as SyncController['phase'];
    let draws = 0;
    const hook = renderHook(() => {
      draws += 1;
      return useSyncBadge(store);
    });
    expect(hook.result.current).toBeNull();
    act(() => publishSync(store, '/v', controller({ phase: notSetUp })));
    const drawn = draws;
    act(() => publishSync(store, '/v', controller({ phase: notSetUp, thisMac: 'Studio' })));
    expect(draws).toBe(drawn);
  });
});

describe('useAutomationsHere (ADR-0046)', () => {
  it('says whether this Mac runs the vault’s automations, and no for another vault until said', () => {
    const store = createSyncStore();
    const hook = renderHook(({ vault }: { vault: string }) => useAutomationsHere(store, vault), {
      initialProps: { vault: '/a' },
    });
    expect(hook.result.current).toBe(false);
    act(() => publishSync(store, '/a', controller({ automationsHere: true })));
    expect(hook.result.current).toBe(true);
    hook.rerender({ vault: '/b' });
    expect(hook.result.current).toBe(false);
    act(() => publishSync(store, '/a', controller({ automationsHere: false })));
    hook.rerender({ vault: '/a' });
    expect(hook.result.current).toBe(false);
  });

  it('is always no, and draws nothing, when asked of no vault', () => {
    const store = createSyncStore();
    let draws = 0;
    const hook = renderHook(() => {
      draws += 1;
      return useAutomationsHere(store, null);
    });
    act(() => publishSync(store, null, controller({ automationsHere: true })));
    expect(hook.result.current).toBe(false);
    expect(draws).toBe(1);
  });
});
