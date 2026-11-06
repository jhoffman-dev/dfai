import { cachedReadKey, cachedReadOf, createVaultPath as p, type VaultEntry } from '@dfai/domain';
import { describe, expect, it, vi } from 'vitest';
import { fakeHostVaultFs } from '../testing/fake-ports.ts';
import { memoryReadCacheStore, switchableConnection } from '../testing/memory-read-cache.ts';
import { VaultAccessError, VaultUnreachableError, type HostVaultFsPort } from '../vault/ports.ts';
import {
  cachedVaultFs,
  FOLDER_NEEDS_CONNECTION,
  NEW_FOLDER_NEEDS_CONNECTION,
  NOTE_NEEDS_CONNECTION,
  revalidateKeptNotes,
  WRITE_NEEDS_CONNECTION,
} from './cached-vault-fs.ts';
import { keptReads } from './kept-reads.ts';

const VAULT = 'github:mara-quill/larkspur-vault#main';
const NOW = Date.UTC(2026, 10, 3, 9);

/** A remote vault of notes by path, each at a version, that a test can cut off. */
function remote(notes: Record<string, { text: string; modified: number }>) {
  let reachable = true;
  const unreachable = () => {
    if (!reachable) throw new VaultUnreachableError('GitHub could not be reached: Load failed');
  };
  // Writable, so a test can hold one read back.
  const fs: { -readonly [Call in keyof HostVaultFsPort]: HostVaultFsPort[Call] } = fakeHostVaultFs({
    readTextFile: vi.fn(async (path) => {
      unreachable();
      const note = notes[path];
      if (note === undefined) throw new VaultAccessError('no such file');
      return note;
    }),
    listDirectory: async () => {
      unreachable();
      return Object.keys(notes).map(
        (path): VaultEntry => ({ name: path, path: p(path), kind: 'file' }) as VaultEntry,
      );
    },
    listNotes: async () => {
      unreachable();
      return Object.entries(notes).map(([path, note]) => ({
        name: path,
        path: p(path),
        modified: note.modified,
        size: note.text.length,
      }));
    },
    readNotes: async (paths) => {
      unreachable();
      return paths.map((path) => ({ path, ...notes[path]!, size: 1 }));
    },
    writeTextFile: async ({ path, contents }) => {
      unreachable();
      const modified = (notes[path]?.modified ?? 0) + 1;
      notes[path] = { text: contents, modified };
      return modified;
    },
  });
  return { fs, notes, cutOff: (off: boolean) => (reachable = !off) };
}

function cached(notes: Record<string, { text: string; modified: number }>, capBytes = 1_000_000) {
  const store = memoryReadCacheStore();
  const connection = switchableConnection(true);
  const report = vi.fn();
  let now = NOW;
  let account: string | null = 'mara-quill|' + VAULT;
  const kept = keptReads({
    store,
    clock: { now: () => now },
    capBytes,
    report,
    scope: () => account,
  });
  const server = remote(notes);
  const fs = cachedVaultFs({ fs: server.fs, kept, connection });
  return {
    fs,
    kept,
    store,
    connection,
    server,
    report,
    later: (ms: number) => (now += ms),
    /** Another account's session, or none signed in. */
    signedInAs: (next: string | null) => (account = next),
    revalidate: () => revalidateKeptNotes({ fs: server.fs, kept, connection }),
  };
}

const PLAN = { text: '# Garden plan\n', modified: 4 };

describe('cachedVaultFs: reading with no network', () => {
  it('opens a note read before with the network off, without asking it', async () => {
    const { fs, kept, connection, server } = cached({ 'Plan.md': PLAN });
    await fs.readTextFile(p('Plan.md'));
    await kept.settled();
    connection.set(false);
    expect(await fs.readTextFile(p('Plan.md'))).toEqual(PLAN);
    expect(server.fs.readTextFile).toHaveBeenCalledTimes(1);
  });

  it('answers from the device when online but GitHub cannot be reached', async () => {
    const { fs, kept, server } = cached({ 'Plan.md': PLAN });
    await fs.readTextFile(p('Plan.md'));
    await kept.settled();
    server.cutOff(true);
    expect(await fs.readTextFile(p('Plan.md'))).toEqual(PLAN);
  });

  it('says a note never opened needs a connection', async () => {
    const { fs, connection } = cached({ 'Plan.md': PLAN });
    connection.set(false);
    const reading = fs.readTextFile(p('Plan.md'));
    await expect(reading).rejects.toBeInstanceOf(VaultUnreachableError);
    await expect(reading).rejects.toThrow(NOTE_NEEDS_CONNECTION);
  });

  it('says a folder never listed needs a connection, and lists one listed before', async () => {
    const { fs, kept, connection } = cached({ 'Plan.md': PLAN });
    await fs.listDirectory(p('Garden'));
    await kept.settled();
    connection.set(false);
    expect(await fs.listDirectory(p('Garden'))).toHaveLength(1);
    await expect(fs.listDirectory(p('Other'))).rejects.toThrow(FOLDER_NEEDS_CONNECTION);
  });

  it('keeps the tree for the index: the notes listing, and the notes it read before', async () => {
    const { fs, kept, connection } = cached({ 'Plan.md': PLAN, 'Beans.md': PLAN });
    const options = { skipDirectories: ['.git'], maxDepth: 32 };
    await fs.listNotes(options);
    await fs.readTextFile(p('Plan.md'));
    await kept.settled();
    connection.set(false);
    expect(await fs.listNotes(options)).toHaveLength(2);
    expect((await fs.readNotes(['Plan.md', 'Beans.md'])).map((note) => note.path)).toEqual([
      'Plan.md',
    ]);
  });

  it('passes a refusal through rather than answering it from the device', async () => {
    const { fs } = cached({});
    await expect(fs.readTextFile(p('Gone.md'))).rejects.toThrow('no such file');
  });

  it('reads online from the network, never from what was kept', async () => {
    const { fs, kept, server } = cached({ 'Plan.md': PLAN });
    await fs.readTextFile(p('Plan.md'));
    await kept.settled();
    server.notes['Plan.md'] = { text: '# Moved on\n', modified: 5 };
    expect((await fs.readTextFile(p('Plan.md'))).text).toBe('# Moved on\n');
  });
});

describe('cachedVaultFs: writing', () => {
  it('refuses a save with the network off, so none is ever offered as kept', async () => {
    const { fs, connection, server } = cached({ 'Plan.md': PLAN });
    connection.set(false);
    const saving = fs.writeTextFile({
      vault: VAULT,
      path: p('Plan.md'),
      contents: 'offline',
      expectedModified: 4,
    });
    await expect(saving).rejects.toThrow(WRITE_NEEDS_CONNECTION);
    expect(server.notes['Plan.md']).toEqual(PLAN);
  });

  it('keeps what a save wrote, at the version it landed at', async () => {
    const { fs, kept, connection } = cached({ 'Plan.md': PLAN });
    await fs.writeTextFile({
      vault: VAULT,
      path: p('Plan.md'),
      contents: 'new',
      expectedModified: 4,
    });
    await kept.settled();
    connection.set(false);
    expect(await fs.readTextFile(p('Plan.md'))).toEqual({ text: 'new', modified: 5 });
  });

  it('forgets the listings and what moved once the tree changes', async () => {
    const { fs, kept, store } = cached({ 'Garden/Plan.md': PLAN });
    await fs.readTextFile(p('Garden/Plan.md'));
    await fs.listDirectory(p('Garden'));
    await kept.settled();
    await fs.moveEntry({ vault: VAULT, from: p('Garden'), to: p('Yard') });
    await kept.settled();
    expect([...store.held.keys()]).toEqual([]);
  });

  it('refuses every other write with the network off', async () => {
    const { fs, connection } = cached({});
    connection.set(false);
    const writes = [
      fs.createNote({ vault: VAULT, path: p('New.md'), contents: '' }),
      fs.moveEntry({ vault: VAULT, from: p('A.md'), to: p('B.md') }),
      fs.trashEntry({ vault: VAULT, path: p('A.md') }),
      fs.writeBinaryFile({ vault: VAULT, path: p('a.png'), bytes: new Uint8Array(1), offset: 0 }),
    ];
    for (const write of writes) await expect(write).rejects.toThrow(WRITE_NEEDS_CONNECTION);
  });

  it('refuses a new folder offline saying folders, unlike notes, do not wait (#773)', async () => {
    const { fs, connection, server } = cached({});
    connection.set(false);
    const making = fs.createFolder({ vault: VAULT, path: p('New') });
    await expect(making).rejects.toThrow(NEW_FOLDER_NEEDS_CONNECTION);
    await expect(making).rejects.toBeInstanceOf(VaultUnreachableError);
    expect(server.notes).toEqual({});
  });
});

describe('cachedVaultFs: the rest of the tree and writes online', () => {
  it('answers the index’s bulk read from the device when GitHub cannot be reached', async () => {
    const { fs, kept, server } = cached({ 'Plan.md': PLAN });
    await fs.readTextFile(p('Plan.md'));
    await kept.settled();
    server.cutOff(true);
    expect((await fs.readNotes(['Plan.md'])).map((note) => note.text)).toEqual([PLAN.text]);
    server.cutOff(false);
    expect(await fs.readNotes(['Plan.md'])).toHaveLength(1);
  });

  it('keeps the file listing, and passes a refusal of the bulk read through', async () => {
    const { fs, kept, connection, server } = cached({});
    const options = { extension: 'pdf', skipDirectories: [], maxDepth: 32 };
    await fs.listFiles(options);
    await kept.settled();
    connection.set(false);
    expect(await fs.listFiles(options)).toEqual([]);
    connection.set(true);
    server.fs.readNotes = async () => Promise.reject(new VaultAccessError('refused'));
    const bare = cachedVaultFs({ fs: server.fs, kept, connection });
    await expect(bare.readNotes(['Plan.md'])).rejects.toThrow('refused');
  });

  it('keeps a new note, and forgets the listings each write of the tree changes', async () => {
    const { fs, kept, store, connection } = cached({});
    const listingsKept = async () => {
      await fs.listDirectory(p('Garden'));
      await kept.settled();
      return [...store.held.keys()].some((key) => cachedReadOf(key).kind === 'directory');
    };
    expect(await listingsKept()).toBe(true);
    await fs.createNote({ vault: VAULT, path: p('New.md'), contents: '# New\n' });
    await kept.settled();
    expect([...store.held.keys()]).toEqual([
      cachedReadKey('mara-quill|' + VAULT, 'note', 'New.md'),
    ]);
    for (const write of [
      () => fs.createFolder({ vault: VAULT, path: p('Beds') }),
      () => fs.trashEntry({ vault: VAULT, path: p('New.md') }),
      () =>
        fs.writeBinaryFile({ vault: VAULT, path: p('a.png'), bytes: new Uint8Array(1), offset: 0 }),
    ]) {
      expect(await listingsKept()).toBe(true);
      await write();
      await kept.settled();
      expect([...store.held.keys()].some((key) => cachedReadOf(key).kind === 'directory')).toBe(
        false,
      );
    }
    connection.set(false);
    await expect(fs.readTextFile(p('New.md'))).rejects.toThrow(NOTE_NEEDS_CONNECTION);
  });
});

describe('keptReads: whose reads, and which is newest', () => {
  it('never answers one account with what another account’s session kept', async () => {
    const { fs, kept, connection, signedInAs } = cached({ 'Plan.md': PLAN });
    await fs.readTextFile(p('Plan.md'));
    await kept.settled();
    signedInAs('tobias-fenn|' + VAULT);
    connection.set(false);
    await expect(fs.readTextFile(p('Plan.md'))).rejects.toThrow(NOTE_NEEDS_CONNECTION);
    signedInAs('mara-quill|' + VAULT);
    expect(await fs.readTextFile(p('Plan.md'))).toEqual(PLAN);
  });

  it('keeps nothing and answers nothing while no account is known', async () => {
    const { fs, kept, store, connection, signedInAs } = cached({ 'Plan.md': PLAN });
    signedInAs(null);
    await fs.readTextFile(p('Plan.md'));
    await kept.settled();
    expect(store.held.size).toBe(0);
    connection.set(false);
    await expect(fs.readTextFile(p('Plan.md'))).rejects.toThrow(NOTE_NEEDS_CONNECTION);
  });

  it('never lets a read begun before a save land its older text over the save’s', async () => {
    const { fs, kept, connection, server } = cached({ 'Plan.md': PLAN });
    let answer: (value: { text: string; modified: number }) => void = () => {};
    const reads = server.fs.readTextFile;
    server.fs.readTextFile = () => new Promise((resolve) => (answer = resolve));
    const slowRead = fs.readTextFile(p('Plan.md'));
    server.fs.readTextFile = reads;
    await fs.writeTextFile({
      vault: VAULT,
      path: p('Plan.md'),
      contents: 'saved',
      expectedModified: 4,
    });
    answer(PLAN);
    await slowRead;
    await kept.settled();
    connection.set(false);
    expect(await fs.readTextFile(p('Plan.md'))).toEqual({ text: 'saved', modified: 5 });
  });
});

describe('keptReads: the cap', () => {
  it('evicts the note used longest ago once over the cap', async () => {
    const big = { text: 'x'.repeat(100), modified: 1 };
    const { fs, kept, store, later } = cached({ 'A.md': big, 'B.md': big, 'C.md': big }, 700);
    await fs.readTextFile(p('A.md'));
    later(1);
    await fs.readTextFile(p('B.md'));
    later(1);
    await kept.settled();
    await kept.kept('note', 'A.md');
    later(1);
    await fs.readTextFile(p('C.md'));
    await kept.settled();
    expect([...store.held.keys()].sort()).toEqual(
      [
        cachedReadKey('mara-quill|' + VAULT, 'note', 'A.md'),
        cachedReadKey('mara-quill|' + VAULT, 'note', 'C.md'),
      ].sort(),
    );
  });

  it('keeps no read larger than the cap, and the read still answers', async () => {
    const { fs, kept, store } = cached({ 'A.md': { text: 'x'.repeat(100), modified: 1 } }, 10);
    expect((await fs.readTextFile(p('A.md'))).text).toHaveLength(100);
    await kept.settled();
    expect(store.held.size).toBe(0);
  });

  it('reports a store that fails and still answers the read', async () => {
    const { fs, kept, store, report } = cached({ 'A.md': PLAN });
    store.put = async () => {
      throw new Error('QuotaExceededError');
    };
    expect(await fs.readTextFile(p('A.md'))).toEqual(PLAN);
    await kept.settled();
    expect(report).toHaveBeenCalledWith(new Error('QuotaExceededError'));
  });

  it('changes nothing once stopped, so a late read cannot outlive a sign-out', async () => {
    const { fs, kept, store } = cached({ 'A.md': PLAN });
    kept.stop();
    await fs.readTextFile(p('A.md'));
    await kept.settled();
    expect(store.held.size).toBe(0);
  });
});

describe('revalidateKeptNotes', () => {
  it('reads again a kept note whose version moved, and forgets one gone', async () => {
    const { fs, kept, server, connection, revalidate } = cached({ 'A.md': PLAN, 'B.md': PLAN });
    await fs.readTextFile(p('A.md'));
    await fs.readTextFile(p('B.md'));
    await kept.settled();
    server.notes['A.md'] = { text: 'changed on the Mac', modified: 9 };
    delete server.notes['B.md'];
    await revalidate();
    await kept.settled();
    connection.set(false);
    expect(await fs.readTextFile(p('A.md'))).toEqual({ text: 'changed on the Mac', modified: 9 });
    await expect(fs.readTextFile(p('B.md'))).rejects.toThrow(NOTE_NEEDS_CONNECTION);
  });

  it('reads nothing again when every kept note is at the tree version', async () => {
    const { fs, kept, server, revalidate } = cached({ 'A.md': PLAN });
    await fs.readTextFile(p('A.md'));
    await kept.settled();
    await revalidate();
    expect(server.fs.readTextFile).toHaveBeenCalledTimes(1);
  });

  it('does nothing offline', async () => {
    const { connection, revalidate } = cached({ 'A.md': PLAN });
    connection.set(false);
    await expect(revalidate()).resolves.toBeUndefined();
  });
});
