import {
  createVaultPath as p,
  HELD_REFUSAL,
  isUnsent,
  parentVaultPath,
  queuedSaveKey,
  type QueuedSave,
} from '@dfai/domain';
import { describe, expect, it, vi } from 'vitest';
import { fakeHostVaultFs } from '../testing/fake-ports.ts';
import {
  memoryQueueLock,
  memorySaveQueueStore,
  sharedQueueChanges,
  switchableConnection,
} from '../testing/memory-read-cache.ts';
import {
  HOST_CHANGED_ON_DISK,
  HOST_NO_SUCH_ENTRY,
  VaultAccessError,
  VaultUnreachableError,
  type HostVaultFsPort,
} from '../vault/ports.ts';
import { offlineSaves } from './offline-saves.ts';

/*
 * Attack on PR #778 (issue #773): new notes made offline wait as creates,
 * each attempt recorded in `tried` before it is sent. Every test here is a
 * found bug, left failing with `it.fails` until it is fixed.
 */

const VAULT = 'github:mara-quill/larkspur-vault#main';
const ACCOUNT = 'mara-quill';

/** GitHub as the web writes it, as in offline-saves.test.ts. */
function github(notes: Record<string, string>) {
  const held = new Map(Object.entries(notes).map(([path, text]) => [path, { text, modified: 1 }]));
  const sent: string[] = [];
  const fs: { -readonly [Call in keyof HostVaultFsPort]: HostVaultFsPort[Call] } = fakeHostVaultFs({
    readTextFile: async (path) => {
      const note = held.get(path);
      if (note === undefined) throw new VaultAccessError(`${HOST_NO_SUCH_ENTRY}: ${path}`);
      return note;
    },
    listDirectory: async (folder) =>
      [...held.keys()]
        .filter((path) => parentVaultPath(p(path)) === folder)
        .map((path) => ({ name: path, path: p(path), kind: 'file' }) as never),
    writeTextFile: async ({ path, contents, expectedModified }) => {
      const note = held.get(path);
      if (note === undefined && expectedModified !== null)
        throw new VaultAccessError(`${HOST_NO_SUCH_ENTRY}: ${path}`);
      if (note !== undefined && note.modified !== expectedModified)
        throw new VaultAccessError(HOST_CHANGED_ON_DISK);
      const modified = (note?.modified ?? 0) + 10;
      held.set(path, { text: contents, modified });
      sent.push(`${path}: ${contents}`);
      return modified;
    },
    listNotes: async () =>
      [...held].map(([path, note]) => ({
        name: path,
        path: p(path),
        modified: note.modified,
        size: note.text.length,
      })),
    createNote: async ({ path, contents }) => {
      if (held.has(path)) throw new VaultAccessError(HELD_REFUSAL.noteTaken);
      held.set(path, { text: contents, modified: 1 });
      sent.push(`created ${path}: ${contents}`);
      return 1;
    },
  });
  return { fs, held, sent };
}

function device(notes: Record<string, string> = {}) {
  const remote = github(notes);
  const store = memorySaveQueueStore();
  const connection = switchableConnection(true);
  const lock = memoryQueueLock();
  const channel = sharedQueueChanges();
  const open = () =>
    offlineSaves({
      fs: remote.fs,
      store,
      connection,
      device: 'DFAI web',
      report: vi.fn(),
      lock,
      changes: channel(),
      account: () => ACCOUNT,
      vault: () => VAULT,
    });
  return { remote, store, connection, saves: open(), tab: open };
}

const unsentIn = (store: { held: Map<string, QueuedSave> }) =>
  [...store.held.values()].filter(isUnsent);

const make = (saves: ReturnType<typeof offlineSaves>, path: string, contents: string) =>
  saves.fs.createNote({ vault: VAULT, path: p(path), contents });

const save = (
  saves: ReturnType<typeof offlineSaves>,
  contents: string,
  expectedModified: number | null,
  path: string,
) => saves.fs.writeTextFile({ vault: VAULT, path: p(path), contents, expectedModified });

/** GitHub commits the next create, then its answer never comes back. */
const loseTheNextAnswer = (remote: ReturnType<typeof github>) => {
  const creates = remote.fs.createNote;
  remote.fs.createNote = async (args) => {
    remote.fs.createNote = creates;
    await creates(args);
    throw new VaultUnreachableError('the answer never came back');
  };
};

/** The next create never reaches GitHub: nothing is made. */
const dropTheNextCreate = (remote: ReturnType<typeof github>) => {
  const creates = remote.fs.createNote;
  remote.fs.createNote = async () => {
    remote.fs.createNote = creates;
    throw new VaultUnreachableError('never reached GitHub');
  };
};

describe('attack #778: a create sent straight to GitHub', () => {
  it.fails('whose answer was lost online is never made twice', async () => {
    const { saves, remote, store } = device();
    loseTheNextAnswer(remote);
    // Online and confirmed: sent straight, committed, answer lost, so it is queued.
    await make(saves, 'X.md', 'A');
    await saves.send(ACCOUNT);
    expect([...remote.held.keys()]).toEqual(['X.md']);
    expect(unsentIn(store)).toEqual([]);
  });

  it.fails('whose answer was lost online is not refused as made elsewhere when read', async () => {
    const { saves, remote } = device();
    loseTheNextAnswer(remote);
    await make(saves, 'X.md', 'A');
    await saves.fs.readTextFile(p('X.md'));
    expect(saves.pending.stateOf(VAULT, 'X.md')).toEqual({ kind: 'waiting' });
  });
});

describe('attack #778: the tried record', () => {
  it.fails(
    'never counts another device’s note of the same text as its own when its attempt never reached GitHub',
    async () => {
      const { saves, remote, connection } = device();
      connection.set(false);
      const made = await make(saves, 'X.md', 'Buy milk');
      dropTheNextCreate(remote);
      connection.set(true);
      await saves.send(ACCOUNT);
      connection.set(false);
      await save(saves, 'Call Tobias about the hens', made, 'X.md');
      // The Mac quick-adds its own "Buy milk" at the same name meanwhile.
      remote.held.set('X.md', { text: 'Buy milk', modified: 1 });
      connection.set(true);
      await saves.send(ACCOUNT);
      expect(remote.held.get('X.md')?.text).toBe('Buy milk');
      expect(remote.held.get('X 2.md')?.text).toBe('Call Tobias about the hens');
    },
  );

  it.fails('is cleared once the create lands, keeping no typed text on the device', async () => {
    const { saves, remote, connection, store } = device();
    connection.set(false);
    await make(saves, 'X.md', 'A');
    loseTheNextAnswer(remote);
    connection.set(true);
    await saves.send(ACCOUNT);
    await saves.send(ACCOUNT);
    const record = store.held.get(queuedSaveKey(VAULT, 'X.md'));
    expect(record?.state.kind).toBe('landed');
    expect(record?.tried ?? []).toEqual([]);
  });

  it.fails(
    'stays bounded over repeated sends that never reach GitHub, with typing between',
    async () => {
      const { saves, remote, connection, store } = device();
      connection.set(false);
      let version = await make(saves, 'X.md', 'v0');
      for (let round = 1; round <= 5; round += 1) {
        dropTheNextCreate(remote);
        connection.set(true);
        await saves.send(ACCOUNT);
        connection.set(false);
        version = await save(saves, `v${round}`, version, 'X.md');
      }
      // Nothing is at X.md: no attempt so far made a note, so none need be kept.
      expect(remote.held.size).toBe(0);
      expect(store.held.get(queuedSaveKey(VAULT, 'X.md'))?.tried?.length ?? 0).toBeLessThanOrEqual(
        1,
      );
    },
  );

  it.fails(
    'a GitHub failure reading its own note is not taken for "nothing there", so no second note',
    async () => {
      const { saves, remote, connection } = device();
      connection.set(false);
      await make(saves, 'X.md', 'A');
      loseTheNextAnswer(remote);
      connection.set(true);
      await saves.send(ACCOUNT);
      const reads = remote.fs.readTextFile;
      remote.fs.readTextFile = async () => {
        remote.fs.readTextFile = reads;
        throw new Error('GitHub answered 502');
      };
      await saves.send(ACCOUNT);
      await saves.send(ACCOUNT);
      expect([...remote.held.keys()]).toEqual(['X.md']);
    },
  );
});

describe('attack #778: two tabs', () => {
  it.fails(
    'a read racing another tab’s send never refuses its own note as made elsewhere',
    async () => {
      const { saves, remote, connection, tab } = device();
      connection.set(false);
      await make(saves, 'X.md', 'A');
      const two = tab();
      connection.set(true);
      const reads = remote.fs.readTextFile;
      // Between the read's look at the queue and its look at GitHub, tab two sends; its answer is lost.
      remote.fs.readTextFile = async (path) => {
        remote.fs.readTextFile = reads;
        loseTheNextAnswer(remote);
        await two.send(ACCOUNT);
        return reads(path);
      };
      await saves.fs.readTextFile(p('X.md'));
      expect(saves.pending.stateOf(VAULT, 'X.md')).toEqual({ kind: 'waiting' });
    },
  );
});
