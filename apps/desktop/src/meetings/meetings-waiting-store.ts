import { createStore, useStore, type StoreApi } from 'zustand';
import { shallow } from 'zustand/shallow';
import { meetingsWaitingLine, type MeetingsWaiting } from '@dfai/domain';

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

/** The Inbox's line for the vault at `vaultKey`; null when nothing is to be said, or it was said of another vault. */
export function useMeetingsWaitingLine(
  store: MeetingsWaitingStore,
  vaultKey: string | null,
): string | null {
  return useStore(store, ({ vault, waiting }) =>
    vault !== vaultKey || waiting === null ? null : meetingsWaitingLine(waiting),
  );
}
