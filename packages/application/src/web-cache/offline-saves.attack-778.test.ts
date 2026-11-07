import {
  createVaultPath as p,
  HELD_REFUSAL,
  isUnsent,
  parentVaultPath,
  queuedSaveKey,
  TRIED_CREATES_KEPT,
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
 * each attempt recorded in `tried`, with its own mark, before it is sent.
 * Every test here was a found bug, seen failing before it was fixed.
 */

const VAULT = 'github:mara-quill/larkspur-vault#main';
const ACCOUNT = 'mara-quill';
const OTHER = 'tobias-fenn';

/** A note as GitHub holds it, with the mark its newest commit carries, if any. */
interface HeldNote {
  readonly text: string;
  readonly modified: number;
  readonly mark?: string;
}

/**
 * GitHub as the web writes it, as in offline-saves.test.ts: a create's
 * mark is kept on its note until another change replaces it, as the newest
 * commit to change the path carries it.
 */
function github(notes: Record<string, string>) {
  const held = new Map<string, HeldNote>(
    Object.entries(notes).map(([path, text]) => [path, { text, modified: 1 }]),
  );
  const sent: string[] = [];
  const fs: { -readonly [Call in keyof HostVaultFsPort]: HostVaultFsPort[Call] } = fakeHostVaultFs({
    readTextFile: async (path) => {
      const note = held.get(path);
      if (note === undefined) throw new VaultAccessError(`${HOST_NO_SUCH_ENTRY}: ${path}`);
      return { text: note.text, modified: note.modified };
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
    createNote: async ({ path, contents, mark }) => {
      if (held.has(path)) throw new VaultAccessError(HELD_REFUSAL.noteTaken);
      held.set(path, { text: contents, modified: 1, ...(mark !== undefined && { mark }) });
      sent.push(`created ${path}: ${contents}`);
      return 1;
    },
  });
  const marks = { markAt: async (path: string) => held.get(path)?.mark ?? null };
  let made = 0;
  return { fs, held, sent, marks, newMark: () => `mark-${(made += 1)}` };
}

function device(
  notes: Record<string, string> = {},
  { lock = memoryQueueLock() }: { lock?: <T>(task: () => Promise<T>) => Promise<T> } = {},
) {
  const remote = github(notes);
  const store = memorySaveQueueStore();
  const connection = switchableConnection(true);
  const channel = sharedQueueChanges();
  const report = vi.fn();
  let account = ACCOUNT;
  const open = () =>
    offlineSaves({
      fs: remote.fs,
      store,
      connection,
      device: 'DFAI web',
      report,
      lock,
      changes: channel(),
      account: () => account,
      vault: () => VAULT,
      marks: remote.marks,
      newMark: remote.newMark,
    });
  return {
    remote,
    store,
    connection,
    report,
    saves: open(),
    tab: open,
    signedInAs: (next: string) => (account = next),
  };
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
  it('whose answer was lost online is never made twice', async () => {
    const { saves, remote, store } = device();
    loseTheNextAnswer(remote);
    // Online and confirmed: sent straight, committed, answer lost, so it is queued.
    await make(saves, 'X.md', 'A');
    await saves.send(ACCOUNT);
    expect([...remote.held.keys()]).toEqual(['X.md']);
    expect(unsentIn(store)).toEqual([]);
  });

  it('whose answer was lost online is not refused as made elsewhere when read', async () => {
    const { saves, remote } = device();
    loseTheNextAnswer(remote);
    await make(saves, 'X.md', 'A');
    await saves.fs.readTextFile(p('X.md'));
    expect(saves.pending.stateOf(VAULT, 'X.md')).toEqual({ kind: 'waiting' });
  });
});

describe('attack #778: the tried record', () => {
  it('never counts another device’s note of the same text as its own when its attempt never reached GitHub', async () => {
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
  });

  it('is cleared once the create lands, keeping no typed text on the device', async () => {
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

  it('stays bounded over repeated sends that never reach GitHub, with typing between', async () => {
    const { saves, remote, connection, store } = device();
    connection.set(false);
    let version = await make(saves, 'X.md', 'v0');
    // Past the cap: an attempt not seen on GitHub is kept, as it may still land, but only so many.
    for (let round = 1; round <= TRIED_CREATES_KEPT + 3; round += 1) {
      dropTheNextCreate(remote);
      connection.set(true);
      await saves.send(ACCOUNT);
      connection.set(false);
      version = await save(saves, `v${round}`, version, 'X.md');
    }
    expect(remote.held.size).toBe(0);
    const tried = store.held.get(queuedSaveKey(VAULT, 'X.md'))?.tried ?? [];
    expect(tried.length).toBe(TRIED_CREATES_KEPT);
    // The newest are the ones kept: the last attempt carried the last typing.
    expect(tried.at(-1)?.text).toBe(`v${TRIED_CREATES_KEPT + 2}`);
  });

  it('a GitHub failure reading its own note is not taken for "nothing there", so no second note', async () => {
    const { saves, remote, connection, report } = device();
    connection.set(false);
    await make(saves, 'X.md', 'A');
    loseTheNextAnswer(remote);
    connection.set(true);
    await saves.send(ACCOUNT);
    const reads = remote.fs.readTextFile;
    const failing = new Error('GitHub answered 502');
    remote.fs.readTextFile = async () => {
      remote.fs.readTextFile = reads;
      throw failing;
    };
    await saves.send(ACCOUNT);
    // Told, and the create waits: nothing is made while its own note could not be read.
    expect(report).toHaveBeenCalledWith(failing);
    expect([...remote.held.keys()]).toEqual(['X.md']);
    await saves.send(ACCOUNT);
    expect([...remote.held.keys()]).toEqual(['X.md']);
  });
});

describe('re-review #778: an attempt not seen on GitHub yet', () => {
  it('is never let go: a create that times out and lands after the next look is found, with no second note', async () => {
    const { saves, remote, connection, store } = device();
    connection.set(false);
    await make(saves, 'X.md', 'A');
    const creates = remote.fs.createNote;
    let late: (() => Promise<number>) | undefined;
    // The request times out, but GitHub applies it moments later.
    remote.fs.createNote = async (args) => {
      late = () => creates(args);
      throw new VaultUnreachableError('GitHub did not answer in time');
    };
    connection.set(true);
    await saves.send(ACCOUNT);
    // The next send looks before the first lands; it lands before the next create is made.
    remote.fs.createNote = async (args) => {
      remote.fs.createNote = creates;
      await late!();
      return creates(args);
    };
    await saves.send(ACCOUNT);
    await saves.send(ACCOUNT);
    expect([...remote.held.keys()]).toEqual(['X.md']);
    expect(remote.held.get('X.md')?.text).toBe('A');
    expect(unsentIn(store)).toEqual([]);
    expect(saves.pending.stateOf(VAULT, 'X.md')).toBeNull();
  });

  it('that landed late is read as its own, never refused as made elsewhere', async () => {
    const { saves, remote, connection } = device();
    connection.set(false);
    await make(saves, 'X.md', 'A');
    const creates = remote.fs.createNote;
    let late: (() => Promise<number>) | undefined;
    remote.fs.createNote = async (args) => {
      late = () => creates(args);
      throw new VaultUnreachableError('GitHub did not answer in time');
    };
    connection.set(true);
    await saves.send(ACCOUNT);
    // The next send looks, finds nothing yet, and its own create is lost to the network too.
    remote.fs.createNote = async () => {
      remote.fs.createNote = creates;
      throw new VaultUnreachableError('gone again');
    };
    await saves.send(ACCOUNT);
    // Then the first lands.
    await late!();
    await saves.fs.readTextFile(p('X.md'));
    expect(saves.pending.stateOf(VAULT, 'X.md')).toEqual({ kind: 'waiting' });
    expect([...remote.held.keys()]).toEqual(['X.md']);
  });
});

describe('attack #778: a read of a waiting create', () => {
  it('whose look at GitHub fails is told, and reads as the waiting text, still waiting', async () => {
    const { saves, remote, connection, report } = device();
    connection.set(false);
    const made = await make(saves, 'X.md', 'A');
    connection.set(true);
    const failing = new Error('GitHub answered 502');
    remote.fs.readTextFile = async () => {
      throw failing;
    };
    await expect(saves.fs.readTextFile(p('X.md'))).resolves.toEqual({ text: 'A', modified: made });
    expect(report).toHaveBeenCalledWith(failing);
    expect(saves.pending.stateOf(VAULT, 'X.md')).toEqual({ kind: 'waiting' });
  });
});

describe('attack #778: two tabs', () => {
  it('a read racing another tab’s send never refuses its own note as made elsewhere', async () => {
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
  });
});

describe('attack #778: a turn whose hold lapsed across a sign-out and another sign-in', () => {
  /**
   * Mara's create is being sent when the hold lapses: she signs out, which
   * lets her save go, and Tobias signs in and makes a note of the same name
   * offline, which takes the same provisional version, the store being
   * empty again. Her turn then goes on.
   */
  async function switchedMidTurn(when: 'recording' | 'landing') {
    const lapsed = <T>(task: () => Promise<T>) => task();
    const { saves, remote, connection, store, signedInAs } = device({}, { lock: lapsed });
    connection.set(false);
    await make(saves, 'X.md', 'Mara’s text');
    const switchAccount = async () => {
      await saves.clear();
      await saves.reopen();
      signedInAs(OTHER);
      connection.set(false);
      await make(saves, 'X.md', 'Tobias’s text');
      connection.set(true);
    };
    if (when === 'recording') {
      // Between her turn's start and the record of its attempt.
      const get = store.get;
      store.get = async (key) => {
        store.get = get;
        await switchAccount();
        return get(key);
      };
    } else {
      // While her create is on its way.
      const creates = remote.fs.createNote;
      remote.fs.createNote = async (args) => {
        remote.fs.createNote = creates;
        await switchAccount();
        return creates(args);
      };
    }
    connection.set(true);
    await saves.send(ACCOUNT);
    return { remote, store };
  }

  it('never sends the other account’s record in its own turn', async () => {
    const { remote, store } = await switchedMidTurn('recording');
    expect(remote.sent.filter((sent) => sent.includes('Tobias’s text'))).toEqual([]);
    const theirs = store.held.get(queuedSaveKey(VAULT, 'X.md'));
    expect(theirs).toMatchObject({ account: OTHER, contents: 'Tobias’s text' });
    expect(theirs?.state.kind).toBe('waiting');
  });

  it('never marks the other account’s record landed, letting its typing go', async () => {
    const { store } = await switchedMidTurn('landing');
    const theirs = store.held.get(queuedSaveKey(VAULT, 'X.md'));
    expect(theirs).toMatchObject({ account: OTHER, contents: 'Tobias’s text' });
    expect(theirs?.state.kind).toBe('waiting');
  });
});
