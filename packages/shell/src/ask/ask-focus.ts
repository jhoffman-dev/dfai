/**
 * Whether Ask was asked for the keys (#37), and in which pane: ⌘J and the
 * sidebar's Ask ask; a tab brought back at launch, or Ask in the pane not
 * worked in, does not. The Ask in that pane takes them once and says so.
 */
export interface AskFocusRequest {
  readonly pane: number;
  /** Each request its own number, so asking twice is two requests. */
  readonly serial: number;
}

export interface AskFocus {
  /** Asks that the Ask in `pane` take the keys. */
  readonly request: (pane: number) => void;
  /**
   * The latest request, taken or not: what a subscriber reads. Taking it does
   * not change it, so the Ask that took the keys is not drawn again for that.
   */
  readonly latest: () => AskFocusRequest | null;
  /** Whether a request is still to be taken: an Ask mounted after it was taken takes no keys. */
  readonly pending: (request: AskFocusRequest | null) => boolean;
  /** The keys were taken for the request numbered `serial`. */
  readonly taken: (serial: number) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createAskFocus(): AskFocus {
  let latest: AskFocusRequest | null = null;
  let serial = 0;
  let takenUpTo = 0;
  const listeners = new Set<() => void>();
  return {
    request: (pane) => {
      latest = { pane, serial: (serial += 1) };
      for (const listener of listeners) listener();
    },
    latest: () => latest,
    pending: (request) => request !== null && request.serial > takenUpTo,
    taken: (spent) => {
      takenUpTo = Math.max(takenUpTo, spent);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
