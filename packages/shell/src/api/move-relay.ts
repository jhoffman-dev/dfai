import type { EntryMove } from '@dfai/domain';

/**
 * Where a move made through the local API is passed on to: one object for the
 * life of the app, pointed at whatever follows moves now.
 *
 * The API serves once, with deps that must stay put (`useLocalApi`), while
 * what follows a move — the pane layout, a view's drafts — is rebuilt every
 * time the layout changes, and is made further down the app than the API's
 * deps. Until it is pointed anywhere, a move is followed by nothing.
 */
export interface MoveRelay {
  readonly follow: (move: EntryMove) => void;
  readonly point: (target: (move: EntryMove) => void) => void;
}

export function createMoveRelay(): MoveRelay {
  let target: (move: EntryMove) => void = () => {};
  return {
    follow: (move) => target(move),
    point: (next) => {
      target = next;
    },
  };
}
