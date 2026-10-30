// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  createMeetingsWaitingStore,
  sayMeetingsWaiting,
  useMeetingsWaitingLine,
} from './meetings-waiting-store.ts';

const VAULT = '/Users/j/Vault';

describe('the meetings-waiting store (#175)', () => {
  it('gives the Inbox the line for its own vault, and none for another vault’s', () => {
    const store = createMeetingsWaitingStore();
    const here = renderHook(() => useMeetingsWaitingLine(store, VAULT));
    const other = renderHook(() => useMeetingsWaitingLine(store, '/Users/j/Other'));
    expect(here.result.current).toBeNull();

    act(() => sayMeetingsWaiting(store, VAULT, { kind: 'counted', mac: 'Studio', count: 4 }));

    expect(here.result.current).toBe('4 meetings waiting for Studio');
    expect(other.result.current).toBeNull();
  });

  it('gives no line once nothing is to be said', () => {
    const store = createMeetingsWaitingStore();
    const here = renderHook(() => useMeetingsWaitingLine(store, VAULT));
    act(() => sayMeetingsWaiting(store, VAULT, { kind: 'counted', mac: 'Studio', count: 4 }));

    act(() => sayMeetingsWaiting(store, VAULT, null));

    expect(here.result.current).toBeNull();
  });

  it('keeps its state when told the same again, so nothing is drawn for it', () => {
    const store = createMeetingsWaitingStore();
    sayMeetingsWaiting(store, VAULT, { kind: 'counted', mac: 'Studio', count: 2 });
    const before = store.getState();

    sayMeetingsWaiting(store, VAULT, { kind: 'counted', mac: 'Studio', count: 2 });

    expect(store.getState()).toBe(before);
  });
});
