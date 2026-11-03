import {
  createVaultPath,
  nextInQueue,
  queuedSaveKey,
  queueSave,
  savesToSend,
  type QueuedSave,
  type SaveAsked,
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
import type { ConnectionPort, PendingSavesPort, SaveQueueStore } from './ports.ts';

export interface OfflineSavesDeps {
  /** The vault the saves are sent to: the cached GitHub vault. */
  readonly fs: HostVaultFsPort;
  readonly store: SaveQueueStore;
  readonly connection: ConnectionPort;
  /** What conflict copies are named for (WEB_DEVICE). */
  readonly device: string;
  /** Where a save that failed for some other reason than the network or a refusal is told. */
  readonly report: (error: unknown) => void;
}

/**
 * Saving on the web with no network (#667). A note saved offline, or while
 * GitHub cannot be reached, waits in {@link SaveQueueStore} and the save
 * resolves only once it is stored there; later saves of the same edit fold
 * into it. Back online, each is sent in the order it was first queued, held
 * to the version its edit started from, so GitHub's refusal of a note that
 * moved meanwhile is the same as any web write's. A refused save waits
 * still, for the person to keep it as a copy or discard it.
 *
 * Everything that reads or changes the queue takes turns, sending included:
 * a save made while one is being sent waits for it, and never folds into a
 * save already on its way.
 */
export function offlineSaves(deps: OfflineSavesDeps) {
  const { fs, store, connection } = deps;
  const saves = new Map<string, QueuedSave>();
  /** A sent save's provisional version, and the version it landed at. */
  const landed = new Map<number, number>();
  const listeners = new Set<() => void>();
  const told = () => listeners.forEach((listener) => listener());
  const inTurn = serially();
  const loaded = inTurn(async () => {
    for (const save of await store.all()) saves.set(save.key, save);
    told();
  });

  const queued = async (asked: SaveAsked): Promise<number> => {
    const key = queuedSaveKey(asked.vault, asked.path);
    const decision = queueSave(saves.get(key), asked, nextInQueue(saves.values()));
    if (decision.kind === 'stale') throw new VaultAccessError(HOST_CHANGED_ON_DISK);
    // Stored first: the save is not waiting until it would outlive a reload.
    await store.put(decision.save);
    saves.set(key, decision.save);
    told();
    return decision.save.provisional;
  };

  /** Sends the saves waiting, in order; stops at the first the network keeps back. */
  const sendWaiting = async (): Promise<void> => {
    for (const save of savesToSend(saves.values())) {
      if (!connection.online()) return;
      const outcome = await sent(save);
      if (outcome === 'unreachable') return;
    }
  };

  const sent = async (save: QueuedSave): Promise<'landed' | 'refused' | 'kept' | 'unreachable'> => {
    try {
      const modified = await fs.writeTextFile({
        vault: save.vault,
        path: createVaultPath(save.path),
        contents: save.contents,
        expectedModified: save.expectedModified,
        ...(save.expectedText !== undefined && { expectedText: save.expectedText }),
      });
      await store.remove(save.key);
      saves.delete(save.key);
      landed.set(save.provisional, modified);
      told();
      return 'landed';
    } catch (error) {
      if (error instanceof VaultUnreachableError) return 'unreachable';
      if (!isStaleWriteRefusal(error)) {
        // Not the network and not a refusal (a rate limit, GitHub failing): it waits to be sent again.
        deps.report(error);
        return 'kept';
      }
      const refused = { ...save, refused: (error as Error).message };
      await store.put(refused);
      saves.set(save.key, refused);
      told();
      return 'refused';
    }
  };

  const writeTextFile: HostVaultFsPort['writeTextFile'] = (args) =>
    inTurn(async () => {
      await loaded;
      const key = queuedSaveKey(args.vault, args.path);
      if (saves.get(key)?.refused === null && connection.online()) await sendWaiting();
      // After sending: a save carrying on from one just sent names the version it landed at.
      const asked = { ...args, expectedModified: landedAs(landed, args.expectedModified) };
      if (saves.has(key) || !connection.online()) return queued(asked);
      try {
        return await fs.writeTextFile(asked);
      } catch (error) {
        if (error instanceof VaultUnreachableError) return queued(asked);
        throw error;
      }
    });

  const readTextFile: HostVaultFsPort['readTextFile'] = async (path) => {
    const waiting = await inTurn(async () => {
      await loaded;
      return [...saves.values()].find((save) => save.path === path);
    });
    // What waits is the newest text there is of the note, at the version the editor carries on from.
    return waiting === undefined
      ? fs.readTextFile(path)
      : { text: waiting.contents, modified: waiting.provisional };
  };

  const pending: PendingSavesPort = {
    stateOf: (vault, path) => {
      const save = saves.get(queuedSaveKey(vault, path));
      if (save === undefined) return null;
      return save.refused === null
        ? { kind: 'waiting' }
        : { kind: 'refused', reason: save.refused };
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

  /** Lets a refused save go once `settle` has done with it; a save still waiting is not the person's to let go. */
  const settleRefused = (
    { vault, path }: { vault: string; path: string },
    settle: (save: QueuedSave) => Promise<void>,
  ) =>
    inTurn(async () => {
      const save = saves.get(queuedSaveKey(vault, path));
      if (save === undefined || save.refused === null) return;
      await settle(save);
      await store.remove(save.key);
      saves.delete(save.key);
      told();
    });

  return {
    fs: { ...fs, writeTextFile, readTextFile } satisfies HostVaultFsPort,
    pending,
    /** Sends what waits, when online. Safe to call at any time; calls take turns. */
    send: () =>
      inTurn(async () => {
        await loaded;
        await sendWaiting();
      }),
    /** How many saves have not reached GitHub: waiting, or refused and not yet settled. */
    unsent: () =>
      inTurn(async () => {
        await loaded;
        return saves.size;
      }),
    /** Forgets every save, after the person agreed to at sign-out. */
    clear: () =>
      inTurn(async () => {
        await store.clear();
        saves.clear();
        told();
      }),
  };
}

export type OfflineSaves = ReturnType<typeof offlineSaves>;

/** The version a save carries on from: a sent one's real version once it landed. */
const landedAs = (landed: ReadonlyMap<number, number>, expected: number | null) =>
  expected === null ? null : (landed.get(expected) ?? expected);

/** Runs each task after the one before has settled, whichever way it went. */
function serially() {
  let last: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = last.then(task, task);
    last = run.catch(() => undefined);
    return run;
  };
}
