import { createStore, useStore, type StoreApi } from 'zustand';
import { shallow } from 'zustand/shallow';
import type { MeetingsWaiting } from '@dfai/domain';

/**
 * What the meeting import last said waits for the named Mac, for the vault
 * it said it of (ADR-0035 part 1). The import's runner says it; the Inbox
 * reads only its line, so a count draws the Inbox and not the window.
 */
export interface MeetingsWaitingState {
  readonly vault: string | null;
  readonly waiting: MeetingsWaiting | null;
}

export type MeetingsWaitingStore = StoreApi<MeetingsWaitingState>;

export function createMeetingsWaitingStore(): MeetingsWaitingStore {
  return createStore<MeetingsWaitingState>()(() => ({ vault: null, waiting: null }));
}

/** Says what waits for the vault; the same again says nothing, so nothing is drawn for it. */
export function sayMeetingsWaiting(
  store: MeetingsWaitingStore,
  vault: string,
  waiting: MeetingsWaiting | null,
): void {
  store.setState((was) =>
    was.vault === vault && shallow(was.waiting, waiting) ? was : { vault, waiting },
  );
}

/** What waits for the named Mac in the vault at `vaultKey`; null when nothing is said, or it was said of another vault. */
export function useMeetingsWaiting(
  store: MeetingsWaitingStore,
  vaultKey: string | null,
): MeetingsWaiting | null {
  return useStore(store, ({ vault, waiting }) => (vault === vaultKey ? waiting : null));
}
