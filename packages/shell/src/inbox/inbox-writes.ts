import { createStore, type StoreApi } from 'zustand';
import type { EntryMove, VaultPath } from '@dfai/domain';
import type { ClarifyUndo } from '@dfai/application';
import type { InboxRefusal } from '@dfai/ui';
import { createAnswerQueue, type AnswerQueue } from '../proposals/answer-queue.ts';
import type { LeavingRow } from './leaving-rows.ts';

/** What the last action left to say, and the vault it was said of. */
export interface InboxSaid {
  readonly vaultKey: string | null;
  readonly problem: string | null;
  /** One for each row whose last clarification was refused or left unfinished. */
  readonly refusals: readonly InboxRefusal[];
  readonly last: { readonly title: string; readonly undo: ClarifyUndo } | null;
}

/** The vault open, its notes and its index's key, as the page last rendered them. */
export interface InboxSeen {
  readonly vaultKey: string | null;
  readonly notePaths: readonly VaultPath[];
  readonly indexKey: string;
}

/** What every Inbox tab draws from: the rows in flight, and what the last action said. */
export interface InboxWritesState {
  /** Rows that have left the list before the index says so, and the vault they left in. */
  readonly leaving: { readonly vaultKey: string | null; readonly rows: readonly LeavingRow[] };
  /** One more each time a refresh asked for after some writes lands, so the Inbox is read again after it. */
  readonly caughtUp: number;
  readonly said: InboxSaid | null;
}

/**
 * The Inbox's writes in flight, held by the window for the vault rather than
 * by the tab that asked for them (tab-model.md, PR B): the clarifications are
 * written one after another (#217) in one queue whichever tab queued them,
 * and every Inbox tab — switched back to, or a second one in a split — sees
 * the rows already leaving as gone, so none is offered twice while its note
 * is moving. The hooks read the store by selector and keep the rest here.
 */
export interface InboxWrites {
  readonly store: StoreApi<InboxWritesState>;
  readonly queue: AnswerQueue;
  /** What the tabs keep between renders and share, read when a write begins or ends. */
  readonly held: {
    wroteSinceDrained: boolean;
    /** Rows written since the last refresh was asked for, as each is on the page. */
    unrefreshed: LeavingRow[];
    /** The latest the page knows, read when a write begins or ends rather than when it was asked for. */
    latest: InboxSeen;
    ownMoves: { vaultKey: string | null; moves: readonly EntryMove[] };
    readonly undone: WeakSet<ClarifyUndo>;
    /** One clock for the page's reads and writes, so a read can be told from one begun before a refresh landed. */
    readonly moment: { current: number };
    /** What the tab showing the page does once the queue drains: set by the hook as it renders. */
    onDrained: () => void;
  };
}

export function createInboxWrites(): InboxWrites {
  const held: InboxWrites['held'] = {
    wroteSinceDrained: false,
    unrefreshed: [],
    latest: { vaultKey: null, notePaths: [], indexKey: '' },
    ownMoves: { vaultKey: null, moves: [] },
    undone: new WeakSet<ClarifyUndo>(),
    moment: { current: 0 },
    onDrained: () => {},
  };
  return {
    store: createStore<InboxWritesState>()(() => ({
      leaving: { vaultKey: null, rows: [] },
      caughtUp: 0,
      said: null,
    })),
    queue: createAnswerQueue(() => held.onDrained()),
    held,
  };
}
