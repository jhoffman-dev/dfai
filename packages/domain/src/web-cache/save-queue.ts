/**
 * Saves made on the web with no network (#667): each waits on the device,
 * one per note, and is sent once back online, held to the version the edit
 * started from, so GitHub refuses it if the note moved meanwhile, as it
 * refuses any web write. A refused save waits too, until the person keeps
 * it as a copy or discards it: a queued save is never dropped by the queue.
 *
 * The editor is handed a provisional version for a queued save, below zero
 * where no blob version is (`versionOfBlob` is never negative), so its next
 * save is known as the same edit going on. A note's record outlives its
 * save: once sent it says where the save landed, so an edit carrying on
 * from it starts there, and no provisional version is ever handed out twice.
 *
 * A new note made offline (#773) waits the same way, as a create: held to
 * nothing being at its path, so it never lands over a note, and numbered
 * when it is sent if its name was taken by then. Each create it tries is
 * recorded before it goes, with a mark no other create carries, which its
 * commit carries too. A note found at its name later is known as its own
 * only when the newest change there carries the mark of a create it tried,
 * with exactly that text: a lost answer is never sent twice, and another
 * device's note is never its own, even one of the very same text.
 */

/** Where a note's queued save stands. */
export type QueuedSaveState =
  /** Waiting to be sent. */
  | { readonly kind: 'waiting' }
  /** Sent, and refused by GitHub: waiting for the person to keep it as a copy or discard it. */
  | { readonly kind: 'refused'; readonly reason: string }
  /**
   * Sent, and landed at this version; `as` is the path a create landed at
   * instead of its own, its name having been taken by then.
   */
  | { readonly kind: 'landed'; readonly at: number; readonly as?: string }
  /** Refused, then kept as a copy or discarded by the person. */
  | { readonly kind: 'settled' };

/** A create sent for a new note: the path it was tried at, the text it carried, and its mark. */
export interface CreateAttempt {
  readonly path: string;
  readonly text: string;
  /** Unique to this attempt, and carried by its commit: what tells its note from another of the same text. */
  readonly mark: string;
}

/** A note found on GitHub: its path, its text, and the mark the newest change to it carries, if any. */
export interface FoundNote {
  readonly path: string;
  readonly text: string;
  readonly mark: string | null;
}

export interface QueuedSave {
  /** The note's vault and path, which a save is queued by. */
  readonly key: string;
  /** The GitHub login the save was made as: it is only ever sent as them. */
  readonly account: string;
  readonly vault: string;
  readonly path: string;
  /** The newest text saved; nothing, once it is sent or settled. */
  readonly contents: string;
  /** A new note made offline: sent as a create, never as a save over what is there. */
  readonly creates?: true;
  /** The creates tried for it, each recorded before it was sent. */
  readonly tried?: readonly CreateAttempt[];
  /** The version the edit started from, as GitHub had it: what the save is held to when sent. */
  readonly expectedModified: number | null;
  readonly expectedText?: string;
  /** When it was first queued, among the others: the order saves are sent in. */
  readonly order: number;
  /** The version the editor was handed for it. */
  readonly provisional: number;
  readonly state: QueuedSaveState;
}

/** A save asked for, as the vault is asked it, by the account signed in. */
export interface SaveAsked {
  readonly account: string;
  readonly vault: string;
  readonly path: string;
  readonly contents: string;
  readonly expectedModified: number | null;
  readonly expectedText?: string;
}

/** A new note asked for, as the vault is asked it, by the account signed in. */
export interface CreateAsked {
  readonly account: string;
  readonly vault: string;
  readonly path: string;
  readonly contents: string;
}

export type QueueDecision =
  | { readonly kind: 'queued'; readonly save: QueuedSave }
  /** The edit did not start from what is queued or on GitHub: refused as stale, as the host refuses it. */
  | { readonly kind: 'stale' };

export const queuedSaveKey = (vault: string, path: string): string => `${vault}\u0000${path}`;

export const isProvisionalVersion = (version: number | null): boolean =>
  version !== null && version < 0;

/** Whether the save has not reached GitHub: waiting, or refused and not yet settled. */
export const isUnsent = (save: QueuedSave): boolean =>
  save.state.kind === 'waiting' || save.state.kind === 'refused';

/**
 * Where an edit naming `expected` stands on GitHub: at the version a sent
 * save landed at when it carries on from that save, otherwise as it says.
 * A note created under another name than its own is not at this path: the
 * edit stays at its provisional version, refused as stale, so it is never
 * written over whatever took the name.
 */
export function carriesOnAt(
  record: QueuedSave | undefined,
  expected: number | null,
): number | null {
  if (record?.state.kind !== 'landed' || expected !== record.provisional) return expected;
  return record.state.as === undefined ? record.state.at : expected;
}

/**
 * Where a save goes in the queue. A save that carries on from the one
 * waiting or refused for its note (it names that save's provisional
 * version) takes its place, keeping the version it started from and its
 * turn. Any other save of a note with one unsent started from something
 * older, and is stale; so is one by another account. A save carrying on
 * from one that was sent starts afresh where that landed; one carrying on
 * from a save the person discarded, or from one not there at all, is stale.
 */
export function queueSave(
  record: QueuedSave | undefined,
  asked: SaveAsked,
  next: { order: number; provisional: number },
): QueueDecision {
  if (record !== undefined && isUnsent(record)) {
    if (asked.account !== record.account || asked.expectedModified !== record.provisional)
      return { kind: 'stale' };
    return {
      kind: 'queued',
      save: { ...record, contents: asked.contents, provisional: next.provisional },
    };
  }
  const from = carriesOnAt(record, asked.expectedModified);
  if (isProvisionalVersion(from)) return { kind: 'stale' };
  const carried = from !== asked.expectedModified;
  return {
    kind: 'queued',
    save: {
      key: queuedSaveKey(asked.vault, asked.path),
      account: asked.account,
      vault: asked.vault,
      path: asked.path,
      contents: asked.contents,
      expectedModified: from,
      // What was read is not what the landed save left: the version alone holds it then.
      ...(asked.expectedText !== undefined && !carried && { expectedText: asked.expectedText }),
      order: next.order,
      provisional: next.provisional,
      state: { kind: 'waiting' },
    },
  };
}

/**
 * Where a new note goes in the queue. The name is taken while a save of
 * that path has not reached GitHub, whoever made it: the create is refused
 * as the host refuses a name in use, so its maker numbers it, and what
 * waits there is never replaced. Otherwise it waits as a create of its own.
 */
export function queueCreate(
  record: QueuedSave | undefined,
  asked: CreateAsked,
  next: { order: number; provisional: number },
): { readonly kind: 'queued'; readonly save: QueuedSave } | { readonly kind: 'taken' } {
  if (record !== undefined && isUnsent(record)) return { kind: 'taken' };
  return {
    kind: 'queued',
    save: {
      key: queuedSaveKey(asked.vault, asked.path),
      account: asked.account,
      vault: asked.vault,
      path: asked.path,
      contents: asked.contents,
      creates: true,
      expectedModified: null,
      order: next.order,
      provisional: next.provisional,
      state: { kind: 'waiting' },
    },
  };
}

/** The account's new notes in `vault` that have not reached GitHub: what its listings show besides GitHub's. */
export function unsentCreatesIn(
  records: Iterable<QueuedSave>,
  { account, vault }: { account: string; vault: string },
): readonly QueuedSave[] {
  return [...records].filter(
    (save) =>
      save.creates === true && isUnsent(save) && save.account === account && save.vault === vault,
  );
}

/** What a waiting new note says once another device made a note of its name. */
export const CREATE_TAKEN_ELSEWHERE =
  'a note of this name was made elsewhere; keep yours as a copy beside it, or discard it';

const sameAttempt = (a: CreateAttempt, b: CreateAttempt) => a.mark === b.mark;

/**
 * How many tried creates a record keeps, the newest. Each send keeps at most
 * one (an attempt refused as taken is taken back), so this many sends must
 * go unanswered after an attempt before it is let go unseen: by then its
 * request has long ended, landed or not. Bounded because each holds its text.
 */
export const TRIED_CREATES_KEPT = 20;

/**
 * The record with `attempt` among its tried creates, recorded before the
 * create is sent, without the attempts in `cannotLand` (see
 * {@link attemptsThatCannotLand}), and no more than the newest
 * {@link TRIED_CREATES_KEPT}.
 */
export function triedCreate(
  save: QueuedSave,
  attempt: CreateAttempt,
  cannotLand: readonly CreateAttempt[] = [],
): QueuedSave {
  const kept = (save.tried ?? []).filter(
    (made) => !cannotLand.some((gone) => sameAttempt(made, gone)),
  );
  const tried = kept.some((made) => sameAttempt(made, attempt))
    ? kept
    : [...kept, { path: attempt.path, text: attempt.text, mark: attempt.mark }];
  return { ...save, tried: tried.slice(-TRIED_CREATES_KEPT) };
}

/**
 * The tried creates that can no longer land: their path is held by a note
 * whose newest change carries another mark, or none, and a create never
 * lands over a note. An attempt whose path was empty when looked at may
 * still land (its request timed out, say, and GitHub applied it after),
 * so it is never among them.
 */
export function attemptsThatCannotLand(
  save: QueuedSave,
  found: readonly FoundNote[],
): readonly CreateAttempt[] {
  return (save.tried ?? []).filter((made) =>
    found.some((note) => note.path === made.path && note.mark !== made.mark),
  );
}

/** The record without `attempt`: one GitHub refused as taken made nothing there. */
export function untriedCreate(save: QueuedSave, attempt: CreateAttempt): QueuedSave {
  const tried = save.tried ?? [];
  if (!tried.some((made) => sameAttempt(made, attempt))) return save;
  return { ...save, tried: tried.filter((made) => !sameAttempt(made, attempt)) };
}

/**
 * Whether the note found is the new note's own: the newest change at its
 * path carries the mark of a create it tried there, with exactly that text.
 * The text alone cannot tell (GitHub versions a note by its text): another
 * device's note of the same name and text, made where an attempt of this
 * one never arrived, carries no mark of this one's.
 */
export function isOwnCreate(save: QueuedSave, found: FoundNote): boolean {
  return (save.tried ?? []).some(
    (made) => made.mark === found.mark && made.path === found.path && made.text === found.text,
  );
}

/**
 * The record once its text is on GitHub, or let go by the person: no typing
 * is kept on the device, that of its tried creates included.
 */
export function withTextLetGo(save: QueuedSave, state: QueuedSaveState): QueuedSave {
  const next: { -readonly [Field in keyof QueuedSave]: QueuedSave[Field] } = {
    ...save,
    contents: '',
    state,
  };
  delete next.tried;
  return next;
}

/**
 * Whether the record stored now is still the one a turn began from: the
 * same account's, in the same vault, at the same version and state. A turn
 * that outlived its hold never changes a record a later turn made — nor one
 * another account queued after a sign-out let the first go, which numbers
 * its versions from the start again.
 */
export const isStillTheRecord = (now: QueuedSave, was: QueuedSave): boolean =>
  now.account === was.account &&
  now.vault === was.vault &&
  now.provisional === was.provisional &&
  now.state.kind === was.state.kind;

/**
 * A waiting new note whose name another device took meanwhile: refused,
 * so the person sees that note and keeps theirs as a copy or discards it.
 * Anything but a waiting create is left as it is.
 */
export function takenElsewhere(save: QueuedSave): QueuedSave {
  if (save.creates !== true || save.state.kind !== 'waiting') return save;
  return { ...save, state: { kind: 'refused', reason: CREATE_TAKEN_ELSEWHERE } };
}

/** The account's saves still to send, in the order they were first queued. Refused ones wait for the person. */
export function savesToSend(records: Iterable<QueuedSave>, account: string): readonly QueuedSave[] {
  return [...records]
    .filter((save) => save.state.kind === 'waiting' && save.account === account)
    .sort((a, b) => a.order - b.order || (a.key < b.key ? -1 : 1));
}

/** The turn and provisional version the next new save takes, past every one ever queued and kept. */
export function nextInQueue(records: Iterable<QueuedSave>): { order: number; provisional: number } {
  let order = 0;
  let provisional = -1;
  for (const save of records) {
    order = Math.max(order, save.order + 1);
    provisional = Math.min(provisional, save.provisional - 1);
  }
  return { order, provisional };
}
