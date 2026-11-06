import {
  carriesOnAt,
  createVaultPath,
  isUnsent,
  HELD_REFUSAL,
  isOwnCreate,
  isProvisionalVersion,
  nextInQueue,
  queueCreate,
  queuedSaveKey,
  queueSave,
  savesToSend,
  takenElsewhere,
  triedCreate,
  unsentCreatesIn,
  untriedCreate,
  type QueuedSave,
  type VaultPath,
} from '@dfai/domain';
import { isStaleWriteRefusal } from '../notes/note-changed-error.ts';
import { keepTextAsCopy } from '../notes/keep-refused-as-copy.ts';
import { inVault } from '../vault/in-vault.ts';
import {
  HOST_CHANGED_ON_DISK,
  VaultAccessError,
  VaultUnreachableError,
  type HostVaultFsPort,
  type NoteContents,
} from '../vault/ports.ts';
import type {
  ConnectionPort,
  PendingSavesPort,
  SaveQueueChanges,
  SaveQueueLock,
  SaveQueueStore,
} from './ports.ts';
import {
  isCreateRefusal,
  noteAt,
  sendCreate,
  withCreates,
  withCreatesIn,
  type CreateLanded,
  type CreateSending,
} from './queued-creates.ts';

/** What a save says once the sign-out has let every waiting save go. */
export const SAVES_CLOSED = 'signing out: nothing more is saved on this device';
/** What a save says while GitHub has not said who is signed in: the vault is read-only until then. */
export const SAVES_WAIT_FOR_ACCOUNT =
  'saving waits until GitHub says who is signed in; your edit stays here until then';

export interface OfflineSavesDeps {
  /** The vault the saves are sent to: the cached GitHub vault. */
  readonly fs: HostVaultFsPort;
  readonly store: SaveQueueStore;
  readonly connection: ConnectionPort;
  /** What conflict copies are named for (WEB_DEVICE). */
  readonly device: string;
  /** Where a save that failed for some other reason than the network or a refusal is told. */
  readonly report: (error: unknown) => void;
  /** Held for every turn of the queue, across the origin's tabs. */
  readonly lock: SaveQueueLock;
  /** The other tabs, told of each change and telling this one of theirs. */
  readonly changes: SaveQueueChanges;
  /**
   * The login GitHub confirmed is signed in; null until it has, when nothing
   * is queued, sent or shown as waiting: the remembered login is never taken
   * for whoever holds the token now.
   */
  readonly account: () => string | null;
  /** The vault open now, whose saves a read is answered from. */
  readonly vault: () => string | null;
  /**
   * Whose saves wait while GitHub has not confirmed anyone: the remembered
   * login, in a session restored for it; null in a fresh sign-in, whose login
   * is not known until GitHub says. Saves made then wait as that login's and
   * are sent only once GitHub confirms that same login.
   */
  readonly presumed?: () => string | null;
  /**
   * Asks GitHub again who holds the token, before each queued save is sent:
   * the confirmed login, or null when it is someone else or cannot be asked.
   */
  readonly confirm?: () => Promise<string | null>;
}

type Outcome = 'landed' | 'refused' | 'kept' | 'unreachable' | 'unconfirmed';

/**
 * Saving on the web with no network (#667). A note saved offline, or while
 * GitHub cannot be reached, waits in {@link SaveQueueStore} and the save
 * resolves only once it is stored there; later saves of the same edit fold
 * into it. Back online, each is sent in the order it was first queued, held
 * to the version its edit started from, so GitHub's refusal of a note that
 * moved meanwhile is the same as any web write's. A refused save waits
 * still, for the person to keep it as a copy or discard it.
 *
 * Every turn — queueing, folding, sending, settling — runs under the
 * origin-wide lock and decides from the store as it is then, never from
 * what this tab last saw: two tabs never write over, delete or send twice
 * each other's saves. A record is changed only when it is still the one
 * the turn started from. Saves are made and sent as one account only.
 *
 * A new note made offline waits the same way, as a create (#773): read and
 * listed as its queued text, and sent as a create that never lands over a
 * note, numbered when its name was taken by then. A new folder is not
 * queued: it holds no typing, and the cached vault refuses it offline.
 */
export function offlineSaves(deps: OfflineSavesDeps) {
  const { fs, store, connection } = deps;
  let seen = new Map<string, QueuedSave>();
  let closed = false;
  /** The notes whose last save failed to be stored: typing only the pane still holds. */
  const unkept = new Set<string>();
  const listeners = new Set<() => void>();
  const reread = async () => {
    seen = new Map((await store.all()).map((record) => [record.key, record]));
    listeners.forEach((listener) => listener());
  };
  const changed = async () => {
    await reread();
    deps.changes.announce();
  };
  const stopListening = deps.changes.listen(() => void reread().catch(deps.report));
  void deps.lock(reread).catch(deps.report);

  /**
   * Writes `next` over the note's record only if it is still `was`, in its
   * version and its state; says whether it did. A turn that outlived the
   * lock (a hold lapsed while GitHub was slow) never writes over what a
   * later turn landed or carried on from.
   */
  const replace = async (was: QueuedSave, next: QueuedSave): Promise<boolean> => {
    const now = await store.get(was.key);
    if (now === null || now.provisional !== was.provisional) return false;
    if (now.state.kind !== was.state.kind) return false;
    await store.put(next);
    return true;
  };
  const isOpen = async () => !closed && !(await store.isClosed());
  /** Whose saves are queued and shown now: the confirmed login, or the presumed one until then. */
  const whose = () => deps.account() ?? deps.presumed?.() ?? null;
  const confirm = deps.confirm ?? (async () => deps.account());

  /** Sends `save`, once GitHub says again that its own login holds the token. */
  const sentAsItsOwn = async (save: QueuedSave): Promise<Outcome> =>
    (await confirm()) === save.account ? sent(save) : 'unconfirmed';

  /** Stores `save` as waiting, and hands back the version the editor carries on from. */
  const kept = async (save: QueuedSave) => {
    // Stored first: the save is not waiting until it would outlive a reload.
    try {
      await store.put(save);
    } catch (error) {
      unkept.add(save.key);
      throw error;
    }
    unkept.delete(save.key);
    await changed();
    return save.provisional;
  };

  const queued = async (args: Parameters<HostVaultFsPort['writeTextFile']>[0], account: string) => {
    const record = (await store.get(queuedSaveKey(args.vault, args.path))) ?? undefined;
    const decision = queueSave(record, { ...args, account }, nextInQueue(await store.all()));
    if (decision.kind === 'stale') throw new VaultAccessError(HOST_CHANGED_ON_DISK);
    return kept(decision.save);
  };

  /** Sends the save as GitHub takes it: a new note as a create, any other as a save held to its start. */
  const delivered = async (save: QueuedSave): Promise<CreateLanded | null> => {
    if (save.creates === true) return sendCreate(creating(save));
    const at = await fs.writeTextFile({
      vault: save.vault,
      path: createVaultPath(save.path),
      contents: save.contents,
      expectedModified: save.expectedModified,
      ...(save.expectedText !== undefined && { expectedText: save.expectedText }),
    });
    return { at };
  };

  /**
   * Changes the record only if it is still `was` in its version and state,
   * as {@link replace}, built from what is stored now so another turn's
   * attempts are kept; the record after, or null when it was not changed.
   */
  const amend = async (was: QueuedSave, change: (now: QueuedSave) => QueuedSave) => {
    const now = await store.get(was.key);
    if (now === null || now.provisional !== was.provisional) return null;
    if (now.state.kind !== was.state.kind) return null;
    const next = change(now);
    if (next !== now) await store.put(next);
    return next;
  };

  /** What sending `save` as a create needs: its attempts recorded on it as they go. */
  const creating = (save: QueuedSave): CreateSending => ({
    fs,
    save,
    held: async () =>
      unsentCreatesIn(await store.all(), save)
        .filter((other) => other.key !== save.key)
        .map((other) => other.path),
    remember: (attempt) => amend(save, (now) => triedCreate(now, attempt)),
    forget: (attempt) => amend(save, (now) => untriedCreate(now, attempt)),
  });

  const sent = async (save: QueuedSave): Promise<Outcome> => {
    let landed: CreateLanded | null;
    try {
      landed = await delivered(save);
    } catch (error) {
      if (error instanceof VaultUnreachableError) return 'unreachable';
      if (!(save.creates === true ? isCreateRefusal(error) : isStaleWriteRefusal(error))) {
        // Not the network and not a refusal (a rate limit, GitHub failing): it waits to be sent again.
        deps.report(error);
        return 'kept';
      }
      const reason = (error as Error).message;
      await replace(save, { ...save, state: { kind: 'refused', reason } });
      await changed();
      return 'refused';
    }
    // Another turn has the record now (a hold lapsed): what it holds is its to send.
    if (landed === null) return 'kept';
    const state = {
      kind: 'landed',
      at: landed.at,
      ...(landed.as !== undefined && { as: landed.as }),
    } as const;
    await replace(save, { ...save, contents: '', state });
    await changed();
    return 'landed';
  };

  /** The account's next save to send, unless the queue is closed or the device offline. */
  const nextToSend = async (account: string, tried: ReadonlySet<string>) => {
    if (!connection.online() || !(await isOpen())) return undefined;
    return savesToSend(await store.all(), account).find((save) => !tried.has(save.key));
  };

  /**
   * Sends the account's waiting saves in order, each in a turn of its own —
   * a hold is never stretched over many requests — and stops at the network.
   */
  const send = async (account: string): Promise<void> => {
    const tried = new Set<string>();
    for (;;) {
      const outcome = await deps.lock(async () => {
        const next = await nextToSend(account, tried);
        if (next === undefined) return 'done';
        tried.add(next.key);
        return sentAsItsOwn(next);
      });
      // The network gone, or the token no longer the account's: nothing more is sent.
      if (outcome === 'done' || outcome === 'unreachable' || outcome === 'unconfirmed') return;
    }
  };

  /** The account a save is taken for now; refused once the queue is closed, or while nobody is known. */
  const takingFor = async () => {
    if (!(await isOpen())) throw new VaultAccessError(SAVES_CLOSED);
    const account = whose();
    if (account === null) throw new VaultUnreachableError(SAVES_WAIT_FOR_ACCOUNT);
    return account;
  };

  const writeTextFile: HostVaultFsPort['writeTextFile'] = (args) =>
    deps.lock(async () => {
      const account = await takingFor();
      // Not confirmed by GitHub: the save waits on the device, and nothing goes to GitHub.
      const confirmed = deps.account() === account;
      const key = queuedSaveKey(args.vault, args.path);
      let record = (await store.get(key)) ?? undefined;
      const online = () => confirmed && connection.online();
      if (record?.state.kind === 'waiting' && record.account === account && online()) {
        // What waits for this note goes first, in this same turn, as its own login only.
        if ((await sentAsItsOwn(record)) === 'unconfirmed') return queued(args, account);
        record = (await store.get(key)) ?? undefined;
      }
      if ((record !== undefined && isUnsent(record)) || !online()) return queued(args, account);
      const from = carriesOnAt(record, args.expectedModified);
      // A version only this device handed out: GitHub has nothing it names, so it is refused here.
      if (isProvisionalVersion(from)) throw new VaultAccessError(HOST_CHANGED_ON_DISK);
      try {
        const modified = await fs.writeTextFile({ ...args, expectedModified: from });
        unkept.delete(key);
        return modified;
      } catch (error) {
        if (error instanceof VaultUnreachableError) return queued(args, account);
        throw error;
      }
    });

  /**
   * A new note: straight to GitHub when its login is confirmed and online,
   * otherwise — or when GitHub cannot be reached — waiting as a create. A
   * name with a save still waiting is refused as taken, as GitHub refuses
   * one in use, so the note is numbered past it and nothing waiting is replaced.
   */
  const createNote: HostVaultFsPort['createNote'] = (args) =>
    deps.lock(async () => {
      const account = await takingFor();
      const record = (await store.get(queuedSaveKey(args.vault, args.path))) ?? undefined;
      const decision = queueCreate(record, { ...args, account }, nextInQueue(await store.all()));
      if (decision.kind === 'taken') throw new VaultAccessError(HELD_REFUSAL.noteTaken);
      if (deps.account() !== account || !connection.online()) return kept(decision.save);
      try {
        return await fs.createNote(args);
      } catch (error) {
        if (error instanceof VaultUnreachableError) return kept(decision.save);
        throw error;
      }
    });

  /**
   * The new notes waiting in the open vault, as the account sees them. Read
   * outside the lock: a listing decides nothing, and a create is checked
   * against the store again in its own turn.
   */
  const waitingCreates = async () => {
    const account = whose();
    const vault = deps.vault();
    if (account === null || vault === null) return [];
    return unsentCreatesIn(await store.all(), { account, vault });
  };

  const listNotes: HostVaultFsPort['listNotes'] = async (walk) =>
    withCreates(await fs.listNotes(walk), await waitingCreates(), walk);

  const listDirectory: HostVaultFsPort['listDirectory'] = async (folder) =>
    withCreatesIn(folder, await fs.listDirectory(folder), await waitingCreates());

  const readTextFile: HostVaultFsPort['readTextFile'] = async (path) => {
    const account = whose();
    const vault = deps.vault();
    const waiting =
      account === null || vault === null
        ? undefined
        : await deps.lock(async () => {
            const record = await store.get(queuedSaveKey(vault, path));
            return record !== null && record.account === account && isUnsent(record)
              ? record
              : undefined;
          });
    if (waiting === undefined) return fs.readTextFile(path);
    const theirs = waiting.creates === true ? await madeElsewhere(waiting, path) : null;
    // What waits is the newest text there is of the note, at the version the editor carries on from.
    return theirs ?? { text: waiting.contents, modified: waiting.provisional };
  };

  /**
   * The note another device made at a waiting new note's name, if GitHub
   * has one that none of its own creates put there: that note is what is
   * read, and the waiting one is refused, so the person keeps it as a copy
   * beside it or discards it, and neither is hidden.
   */
  const madeElsewhere = async (waiting: QueuedSave, path: VaultPath) => {
    let there: NoteContents | null;
    try {
      there = await noteAt(inVault({ fs, vault: waiting.vault }), path);
    } catch (error) {
      if (!(error instanceof VaultUnreachableError)) throw error;
      // GitHub out of reach: nothing is known to be there, and the waiting text is the note.
      return null;
    }
    if (there === null || isOwnCreate(waiting, { path, text: there.text })) return null;
    await deps.lock(async () => {
      if ((await amend(waiting, takenElsewhere)) !== null) await changed();
    });
    return there;
  };

  /** Settles a refused save once `settle` has done with it; a save still waiting is not the person's to let go. */
  const settleRefused = (
    { vault, path }: { vault: string; path: string },
    settle: (save: QueuedSave) => Promise<void>,
  ) =>
    deps.lock(async () => {
      const save = await store.get(queuedSaveKey(vault, path));
      if (save === null || save.state.kind !== 'refused' || save.account !== whose()) return;
      await settle(save);
      await replace(save, { ...save, contents: '', state: { kind: 'settled' } });
      await changed();
    });

  const pending: PendingSavesPort = {
    stateOf: (vault, path) => {
      const save = seen.get(queuedSaveKey(vault, path));
      const account = whose();
      if (save === undefined || account === null || save.account !== account) return null;
      if (save.state.kind === 'waiting') return { kind: 'waiting' };
      return save.state.kind === 'refused' ? { kind: 'refused', reason: save.state.reason } : null;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    keepAsCopy: (vault, path) =>
      settleRefused({ vault, path }, async (save) => {
        await keepTextAsCopy({
          fs: inVault({ fs, vault }),
          path: createVaultPath(save.path),
          mine: save.contents,
          device: deps.device,
        });
      }),
    discard: (vault, path) => settleRefused({ vault, path }, async () => {}),
  };

  return {
    fs: {
      ...fs,
      writeTextFile,
      createNote,
      readTextFile,
      listNotes,
      listDirectory,
    } satisfies HostVaultFsPort,
    pending,
    /** Sends what `account` left waiting, when online: only ever as the account that made it. */
    send,
    /** How many saves have not reached GitHub, of the accounts `whose` picks (all by default). */
    unsent: (whose: (account: string) => boolean = () => true) =>
      deps.lock(
        async () =>
          (await store.all()).filter((save) => isUnsent(save) && whose(save.account)).length,
      ),
    /** How many notes hold typing whose save failed to be stored: only their panes have it. */
    unkept: () => unkept.size,
    /**
     * The sign-out's one turn across every tab: what has not reached GitHub
     * is counted, the person is asked when anything has, and on a yes the
     * queue is marked closed — so no tab is told a save is stored after it
     * is counted — and every save is let go. On a no, nothing changes.
     */
    closeForSignOut: (ask: (unsent: number) => Promise<boolean>) =>
      deps.lock(async (): Promise<'closed' | 'kept'> => {
        const waiting = (await store.all()).filter(isUnsent).length;
        if (waiting > 0 && !(await ask(waiting))) return 'kept';
        closed = true;
        await store.setClosed(true);
        await store.clear();
        await changed();
        return 'closed';
      }),
    /** Takes saves again: a new session that GitHub confirmed is signed in. */
    reopen: () =>
      deps.lock(async () => {
        closed = false;
        if (await store.isClosed()) await store.setClosed(false);
      }),
    /** Stops hearing the other tabs: the session is over. */
    stop: stopListening,
    /** Lets every save go and takes none after, without asking: what the sign-out does once agreed. */
    clear: () =>
      deps.lock(async () => {
        closed = true;
        await store.setClosed(true);
        await store.clear();
        await changed();
      }),
  };
}

export type OfflineSaves = ReturnType<typeof offlineSaves>;
