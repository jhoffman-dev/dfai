// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  createIndexStatusStore,
  useIndexFailure,
  useIndexPhase,
  useIndexReady,
  useIndexStatus,
} from './index-status-store.ts';
import { useHeldIndexKey } from './index-key.test-support.ts';

const LARKSPUR = '/vaults/Larkspur';
const QUILL = '/vaults/Quill';

/** Every selector, over one store, for the vault a test says is open. */
function selectorsOver(open: string | null) {
  const store = createIndexStatusStore();
  let renders = 0;
  const hook = renderHook(
    ({ vault }: { vault: string | null }) => {
      renders += 1;
      return {
        ready: useIndexReady(store, vault),
        phase: useIndexPhase(store, vault),
        failure: useIndexFailure(store, vault),
        key: useHeldIndexKey(store, vault),
        status: useIndexStatus(store, vault),
      };
    },
    { initialProps: { vault: open } },
  );
  return { store, ...hook, renders: () => renders };
}

describe('the index status store (#238)', () => {
  it('is ready only for the vault it was synced for', () => {
    const { store, result, rerender } = selectorsOver(LARKSPUR);
    act(() => store.setState({ vault: LARKSPUR, phase: 'ready', notes: 3, revision: 4 }));
    expect(result.current).toMatchObject({ ready: true, phase: 'ready', key: 'ready:4' });
    expect(result.current.status).toEqual({ kind: 'ready', notes: 3, revision: 4 });

    // Another vault opened, before its first sync has begun: building, not the last vault's ready.
    rerender({ vault: QUILL });
    expect(result.current).toMatchObject({ ready: false, phase: 'building', key: 'building' });
    expect(result.current.status.kind).toBe('working');
  });

  it('is idle while no vault is open, whatever the store last held', () => {
    const { store, result } = selectorsOver(null);
    act(() => store.setState({ vault: LARKSPUR, phase: 'failed', message: 'locked' }));
    expect(result.current).toMatchObject({ ready: false, phase: 'idle', failure: null });
    expect(result.current.status).toEqual({ kind: 'idle' });
  });

  it('says why the open vault failed, and nothing once it has not', () => {
    const { store, result } = selectorsOver(LARKSPUR);
    act(() => store.setState({ vault: LARKSPUR, phase: 'failed', message: 'the disk went away' }));
    expect(result.current.failure).toBe('the disk went away');
    expect(result.current.status).toEqual({ kind: 'failed', message: 'the disk went away' });
    act(() => store.setState({ phase: 'ready', message: null }));
    expect(result.current.failure).toBeNull();
  });

  it('draws again only when something a selector reads has moved', () => {
    const { store, result, renders } = selectorsOver(LARKSPUR);
    act(() => store.setState({ vault: LARKSPUR, phase: 'ready', notes: 3, revision: 1 }));
    const status = result.current.status;
    const drawn = renders();

    act(() => store.setState({ vault: LARKSPUR, phase: 'ready', notes: 3, revision: 1 }));
    expect(renders()).toBe(drawn);
    expect(result.current.status).toBe(status);

    act(() => store.setState({ revision: 2 }));
    expect(result.current.key).toBe('ready:2');
    expect(result.current.status).toEqual({ kind: 'ready', notes: 3, revision: 2 });
  });
});
