import {
  carriesOnAt,
  createVaultPath,
  isUnsent,
  nextInQueue,
  queuedSaveKey,
  queueSave,
  savesToSend,
  type QueuedSave,
} from '@dfai/domain';
import { isStaleWriteRefusal } from '../notes/note-changed-error.ts';
import { keepTextAsCopy } from '../notes/keep-refused-as-copy.ts';
import { inVault } from '../vault/in-vault.ts';
import {
  HOST_CHANGED_ON_DISK,
  VaultAccessError,
  VaultUnreachableError,
  type HostVaultFsPort,
} from '../vault/ports.ts';
import type {
  ConnectionPort,
  PendingSavesPort,
  SaveQueueChanges,
  SaveQueueLock,
  SaveQueueStore,
} from './ports.ts';

/** What a save says once the sign-out has let every waiting save go. */
export const SAVES_CLOSED = 'signing out: nothing more is saved on this device';

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
  /** The login saves are made as now; null while none is known, when nothing is queued. */
  readonly account: () => string | null;
}

type Outcome = 'landed' | 'refused' | 'kept' | 'unreachable';

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
 */
export function offlineSaves(deps: OfflineSavesDeps) {
  const { fs, store, connection } = deps;
  let seen = new Map<string, QueuedSave>();
  let closed = false;
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

  /** Writes `next` over the note's record only if it is still `was`; says whether it did. */
  const replace = async (was: QueuedSave, next: QueuedSave): Promise<boolean> => {
    const now = await store.get(was.key);
    if (now === null || now.provisional !== was.provisional) return false;
    await store.put(next);
    return true;
  };

  const queued = async (args: Parameters<HostVaultFsPort['writeTextFile']>[0], account: string) => {
    const record = (await store.get(queuedSaveKey(args.vault, args.path))) ?? undefined;
    const decision = queueSave(record, { ...args, account }, nextInQueue(await store.all()));
    if (decision.kind === 'stale') throw new VaultAccessError(HOST_CHANGED_ON_DISK);
    // Stored first: the save is not waiting until it would outlive a reload.
    await store.put(decision.save);
    await changed();
    return decision.save.provisional;
  };

  const sent = async (save: QueuedSave): Promise<Outcome> => {
    let modified: number;
    try {
      modified = await fs.writeTextFile({
        vault: save.vault,
        path: createVaultPath(save.path),
        contents: save.contents,
        expectedModified: save.expectedModified,
        ...(save.expectedText !== undefined && { expectedText: save.expectedText }),
      });
    } catch (error) {
      if (error instanceof VaultUnreachableError) return 'unreachable';
      if (!isStaleWriteRefusal(error)) {
        // Not the network and not a refusal (a rate limit, GitHub failing): it waits to be sent again.
        deps.report(error);
        return 'kept';
      }
      const reason = (error as Error).message;
      await replace(save, { ...save, state: { kind: 'refused', reason } });
      await changed();
      return 'refused';
    }
    await replace(save, { ...save, contents: '', state: { kind: 'landed', at: modified } });
    await changed();
    return 'landed';
  };

  /** Sends the account's waiting saves, in order, as the store has them; stops at the network. */
  const sendWaiting = async (account: string): Promise<void> => {
    const tried = new Set<string>();
    for (;;) {
      if (!connection.online()) return;
      const next = savesToSend(await store.all(), account).find((save) => !tried.has(save.key));
      if (next === undefined) return;
      tried.add(next.key);
      if ((await sent(next)) === 'unreachable') return;
    }
  };

  const writeTextFile: HostVaultFsPort['writeTextFile'] = (args) =>
    deps.lock(async () => {
      if (closed) throw new VaultAccessError(SAVES_CLOSED);
      const account = deps.account();
      if (account === null) return fs.writeTextFile(args);
      const key = queuedSaveKey(args.vault, args.path);
      let record = (await store.get(key)) ?? undefined;
      if (record?.state.kind === 'waiting' && connection.online()) {
        await sendWaiting(account);
        record = (await store.get(key)) ?? undefined;
      }
      if ((record !== undefined && isUnsent(record)) || !connection.online())
        return queued(args, account);
      try {
        return await fs.writeTextFile({
          ...args,
          expectedModified: carriesOnAt(record, args.expectedModified),
        });
      } catch (error) {
        if (error instanceof VaultUnreachableError) return queued(args, account);
        throw error;
      }
    });

  const readTextFile: HostVaultFsPort['readTextFile'] = async (path) => {
    const account = deps.account();
    const waiting = await deps.lock(async () =>
      (await store.all()).find(
        (record) => record.path === path && record.account === account && isUnsent(record),
      ),
    );
    // What waits is the newest text there is of the note, at the version the editor carries on from.
    return waiting === undefined
      ? fs.readTextFile(path)
      : { text: waiting.contents, modified: waiting.provisional };
  };

  /** Settles a refused save once `settle` has done with it; a save still waiting is not the person's to let go. */
  const settleRefused = (
    { vault, path }: { vault: string; path: string },
    settle: (save: QueuedSave) => Promise<void>,
  ) =>
    deps.lock(async () => {
      const save = await store.get(queuedSaveKey(vault, path));
      if (save === null || save.state.kind !== 'refused' || save.account !== deps.account()) return;
      await settle(save);
      await replace(save, { ...save, contents: '', state: { kind: 'settled' } });
      await changed();
    });

  const pending: PendingSavesPort = {
    stateOf: (vault, path) => {
      const save = seen.get(queuedSaveKey(vault, path));
      if (save === undefined || save.account !== deps.account()) return null;
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
    fs: { ...fs, writeTextFile, readTextFile } satisfies HostVaultFsPort,
    pending,
    /** Sends what `account` left waiting, when online: only ever as the account that made it. */
    send: (account: string) => deps.lock(() => sendWaiting(account)),
    /** How many saves have not reached GitHub, of the accounts `whose` picks (all by default). */
    unsent: (whose: (account: string) => boolean = () => true) =>
      deps.lock(
        async () =>
          (await store.all()).filter((save) => isUnsent(save) && whose(save.account)).length,
      ),
    /** Stops hearing the other tabs: the session is over. */
    stop: stopListening,
    /** Lets every save go, after the person agreed at sign-out; nothing is saved here after. */
    clear: () =>
      deps.lock(async () => {
        closed = true;
        await store.clear();
        await changed();
      }),
  };
}

export type OfflineSaves = ReturnType<typeof offlineSaves>;
