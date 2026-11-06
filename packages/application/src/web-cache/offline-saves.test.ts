import { createVaultPath as p, HELD_REFUSAL, isUnsent, VAULT_ROOT, type QueuedSave } from '@dfai/domain';
import { createNoteFile } from '../notes/create-note.ts';
import { inVault } from '../vault/in-vault.ts';
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
import { offlineSaves, SAVES_CLOSED, SAVES_WAIT_FOR_ACCOUNT } from './offline-saves.ts';

const VAULT = 'github:mara-quill/larkspur-vault#main';
const DEVICE = 'DFAI web';

/**
 * GitHub as the web writes it: each note at a version, a write held to the
 * version it names and refused with the host's words when the note moved.
 */
function github(notes: Record<string, string>) {
  const held = new Map(Object.entries(notes).map(([path, text]) => [path, { text, modified: 1 }]));
  let reachable = true;
  const sent: string[] = [];
  const unreachable = () => {
    if (!reachable) throw new VaultUnreachableError('GitHub could not be reached');
  };
  // Writable, so a test can make one call fail.
  const fs: { -readonly [Call in keyof HostVaultFsPort]: HostVaultFsPort[Call] } = fakeHostVaultFs({
    readTextFile: async (path) => {
      unreachable();
      const note = held.get(path);
      if (note === undefined) throw new VaultAccessError(`${HOST_NO_SUCH_ENTRY}: ${path}`);
      return note;
    },
    listDirectory: async () =>
      [...held.keys()].map((path) => ({ name: path, path: p(path), kind: 'file' }) as never),
    writeTextFile: async ({ path, contents, expectedModified }) => {
      unreachable();
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
    listNotes: async () => {
      unreachable();
      return [...held].map(([path, note]) => ({
        name: path,
        path: p(path),
        modified: note.modified,
        size: note.text.length,
      }));
    },
    createNote: async ({ path, contents }) => {
      unreachable();
      if (held.has(path)) throw new VaultAccessError(HELD_REFUSAL.noteTaken);
      held.set(path, { text: contents, modified: 1 });
      sent.push(`created ${path}: ${contents}`);
      return 1;
    },
  });
  return {
    fs,
    held,
    sent,
    cutOff: (off: boolean) => (reachable = !off),
    /** Another device saves the note: its version moves on. */
    elsewhere: (path: string, text: string) =>
      held.set(path, { text, modified: (held.get(path)?.modified ?? 0) + 100 }),
  };
}

const ACCOUNT = 'mara-quill';

function device(notes: Record<string, string> = { 'Plan.md': 'v1' }) {
  const remote = github(notes);
  const store = memorySaveQueueStore();
  const connection = switchableConnection(true);
  const report = vi.fn();
  const lock = memoryQueueLock();
  const channel = sharedQueueChanges();
  let account: string | null = ACCOUNT;
  /** A tab of the page, or the page after a reload: a queue of its own over the one store. */
  const open = () =>
    offlineSaves({
      fs: remote.fs,
      store,
      connection,
      device: DEVICE,
      report,
      lock,
      changes: channel(),
      account: () => account,
      vault: () => VAULT,
    });
  const saves = open();
  return {
    remote,
    store,
    connection,
    report,
    saves,
    reload: open,
    tab: open,
    send: () => saves.send(ACCOUNT),
    signedInAs: (next: string | null) => (account = next),
  };
}

/** What the store holds that has not reached GitHub. */
const unsentIn = (store: { held: Map<string, QueuedSave> }) =>
  [...store.held.values()].filter(isUnsent);

const save = (
  saves: ReturnType<typeof offlineSaves>,
  contents: string,
  expectedModified: number | null,
  path = 'Plan.md',
) => saves.fs.writeTextFile({ vault: VAULT, path: p(path), contents, expectedModified });

describe('offlineSaves: a save made offline', () => {
  it('waits on the device at a provisional version, and is sent on reconnect', async () => {
    const { saves, remote, connection } = device();
    connection.set(false);
    const provisional = await save(saves, 'offline edit', 1);
    expect(provisional).toBeLessThan(0);
    expect(saves.pending.stateOf(VAULT, 'Plan.md')).toEqual({ kind: 'waiting' });
    expect(remote.held.get('Plan.md')?.text).toBe('v1');
    connection.set(true);
    await saves.send(ACCOUNT);
    expect(remote.held.get('Plan.md')?.text).toBe('offline edit');
    expect(saves.pending.stateOf(VAULT, 'Plan.md')).toBeNull();
  });

  it('is stored before the save resolves, so it outlives a reload, and is sent after it', async () => {
    const { saves, store, connection, reload, remote } = device();
    connection.set(false);
    await save(saves, 'before the reload', 1);
    expect(unsentIn(store).map((queued) => queued.contents)).toEqual(['before the reload']);
    const after = reload();
    expect(await after.unsent()).toBe(1);
    connection.set(true);
    await after.send(ACCOUNT);
    expect(remote.held.get('Plan.md')?.text).toBe('before the reload');
    expect(unsentIn(store).length).toBe(0);
  });

  it('fails the save, keeping nothing as waiting, when the device cannot store it', async () => {
    const { saves, store, connection } = device();
    store.put = async () => Promise.reject(new Error('QuotaExceededError'));
    connection.set(false);
    await expect(save(saves, 'edit', 1)).rejects.toThrow('QuotaExceededError');
    expect(saves.pending.stateOf(VAULT, 'Plan.md')).toBeNull();
  });

  it('folds later saves of the same edit into one, held to where the edit started', async () => {
    const { saves, connection, remote } = device();
    connection.set(false);
    const first = await save(saves, 'one', 1);
    const second = await save(saves, 'one two', first);
    await save(saves, 'one two three', second);
    expect(await saves.unsent()).toBe(1);
    connection.set(true);
    await saves.send(ACCOUNT);
    expect(remote.sent).toEqual(['Plan.md: one two three']);
  });

  it('sends saves of several notes in the order they were first queued', async () => {
    const { saves, connection, remote } = device({ 'A.md': 'a', 'B.md': 'b', 'C.md': 'c' });
    connection.set(false);
    const b = await save(saves, 'b1', 1, 'B.md');
    await save(saves, 'a1', 1, 'A.md');
    await save(saves, 'b2', b, 'B.md');
    await save(saves, 'c1', 1, 'C.md');
    connection.set(true);
    await saves.send(ACCOUNT);
    expect(remote.sent).toEqual(['B.md: b2', 'A.md: a1', 'C.md: c1']);
  });

  it('queues a save GitHub could not be reached for, while the browser said online', async () => {
    const { saves, remote } = device();
    remote.cutOff(true);
    expect(await save(saves, 'edit', 1)).toBeLessThan(0);
    remote.cutOff(false);
    await saves.send(ACCOUNT);
    expect(remote.held.get('Plan.md')?.text).toBe('edit');
  });

  it('stops sending at the network, keeping the rest in order for next time', async () => {
    const { saves, connection, remote, store } = device({ 'A.md': 'a', 'B.md': 'b' });
    connection.set(false);
    await save(saves, 'a1', 1, 'A.md');
    await save(saves, 'b1', 1, 'B.md');
    connection.set(true);
    remote.cutOff(true);
    await saves.send(ACCOUNT);
    expect(unsentIn(store).length).toBe(2);
    remote.cutOff(false);
    await saves.send(ACCOUNT);
    expect(remote.sent).toEqual(['A.md: a1', 'B.md: b1']);
  });
});

describe('offlineSaves: back online', () => {
  it('lets the editor carry on from a sent save at its real version', async () => {
    const { saves, connection, remote } = device();
    connection.set(false);
    const provisional = await save(saves, 'offline', 1);
    connection.set(true);
    await saves.send(ACCOUNT);
    const real = await save(saves, 'online after', provisional);
    expect(real).toBeGreaterThan(0);
    expect(remote.held.get('Plan.md')?.text).toBe('online after');
  });

  it('sends what waits for a note before a newer save of it goes straight through', async () => {
    const { saves, connection, remote } = device();
    connection.set(false);
    const provisional = await save(saves, 'offline', 1);
    connection.set(true);
    await save(saves, 'online', provisional);
    expect(remote.sent).toEqual(['Plan.md: offline', 'Plan.md: online']);
  });

  it('hands the editor the waiting text, so a reloaded pane carries on from it', async () => {
    const { saves, connection, reload } = device();
    connection.set(false);
    await save(saves, 'waiting text', 1);
    const after = reload();
    const read = await after.fs.readTextFile(p('Plan.md'));
    expect(read.text).toBe('waiting text');
    expect(await save(after, 'and more', read.modified)).toBeLessThan(0);
    expect(await after.unsent()).toBe(1);
  });

  it('reads from GitHub a note with nothing waiting', async () => {
    const { saves } = device();
    expect((await saves.fs.readTextFile(p('Plan.md'))).text).toBe('v1');
  });
});

describe('offlineSaves: refused when the note moved', () => {
  async function refusedAfterMacSaved() {
    const setUp = device();
    setUp.connection.set(false);
    const provisional = await save(setUp.saves, 'mine, offline', 1);
    setUp.remote.elsewhere('Plan.md', 'the Mac’s');
    setUp.connection.set(true);
    await setUp.saves.send(ACCOUNT);
    return { ...setUp, provisional };
  }

  it('is refused, never written over the Mac’s text, and kept waiting with the reason', async () => {
    const { saves, remote, store } = await refusedAfterMacSaved();
    expect(remote.held.get('Plan.md')?.text).toBe('the Mac’s');
    expect(saves.pending.stateOf(VAULT, 'Plan.md')).toEqual({
      kind: 'refused',
      reason: HOST_CHANGED_ON_DISK,
    });
    expect(unsentIn(store)[0]?.contents).toBe('mine, offline');
    await saves.send(ACCOUNT);
    expect(remote.held.get('Plan.md')?.text).toBe('the Mac’s');
  });

  it('is refused when the note was deleted elsewhere', async () => {
    const { saves, connection, remote } = device();
    connection.set(false);
    await save(saves, 'mine', 1);
    remote.held.delete('Plan.md');
    connection.set(true);
    await saves.send(ACCOUNT);
    expect(saves.pending.stateOf(VAULT, 'Plan.md')?.kind).toBe('refused');
    expect(remote.held.has('Plan.md')).toBe(false);
  });

  it('keeps later typing in the refused save, still refused', async () => {
    const { saves, provisional, store } = await refusedAfterMacSaved();
    await save(saves, 'mine, and more', provisional);
    expect(unsentIn(store)[0]).toMatchObject({
      contents: 'mine, and more',
      state: { kind: 'refused', reason: HOST_CHANGED_ON_DISK },
    });
  });

  it('refuses as stale a save of the note from anything but the waiting edit', async () => {
    const { saves } = await refusedAfterMacSaved();
    await expect(save(saves, 'another pane', 101)).rejects.toThrow(HOST_CHANGED_ON_DISK);
  });

  it('keeps the refused text as a conflict copy beside the Mac’s, then lets it go', async () => {
    const { saves, remote, store } = await refusedAfterMacSaved();
    await saves.pending.keepAsCopy(VAULT, 'Plan.md');
    const copy = [...remote.held.keys()].find((path) => path.includes('conflict'));
    expect(copy).toBeDefined();
    expect(remote.held.get(copy!)?.text).toBe('mine, offline');
    expect(remote.held.get('Plan.md')?.text).toBe('the Mac’s');
    expect(unsentIn(store).length).toBe(0);
  });

  it('keeps the refused save waiting when its copy cannot be made', async () => {
    const { saves, remote, store } = await refusedAfterMacSaved();
    remote.fs.createNote = async () => Promise.reject(new VaultUnreachableError('offline'));
    await expect(saves.pending.keepAsCopy(VAULT, 'Plan.md')).rejects.toThrow('offline');
    expect(unsentIn(store).length).toBe(1);
  });

  it('discards the refused save only when asked, leaving the Mac’s text', async () => {
    const { saves, remote, store } = await refusedAfterMacSaved();
    await saves.pending.discard(VAULT, 'Plan.md');
    expect(unsentIn(store).length).toBe(0);
    expect(remote.held.get('Plan.md')?.text).toBe('the Mac’s');
  });

  it('never lets go of a save still waiting to be sent, whatever is asked', async () => {
    const { saves, connection, store } = device();
    connection.set(false);
    await save(saves, 'waiting', 1);
    await saves.pending.discard(VAULT, 'Plan.md');
    await saves.pending.keepAsCopy(VAULT, 'Plan.md');
    expect(unsentIn(store).length).toBe(1);
  });
});

describe('offlineSaves: what else can go wrong', () => {
  it('keeps a save GitHub failed for some other reason, reporting it, and sends the rest', async () => {
    const { saves, connection, remote, store, report } = device({ 'A.md': 'a', 'B.md': 'b' });
    connection.set(false);
    await save(saves, 'a1', 1, 'A.md');
    await save(saves, 'b1', 1, 'B.md');
    const writes = remote.fs.writeTextFile;
    remote.fs.writeTextFile = async (args) =>
      args.path === 'A.md' ? Promise.reject(new VaultAccessError('rate limited')) : writes(args);
    connection.set(true);
    await saves.send(ACCOUNT);
    expect(report).toHaveBeenCalledWith(new VaultAccessError('rate limited'));
    expect(unsentIn(store).map((queued: QueuedSave) => queued.path)).toEqual(['A.md']);
    expect(saves.pending.stateOf(VAULT, 'A.md')).toEqual({ kind: 'waiting' });
  });

  it('passes an online refusal straight to the editor, queueing nothing', async () => {
    const { saves, remote, store } = device();
    remote.elsewhere('Plan.md', 'the Mac’s');
    await expect(save(saves, 'stale', 1)).rejects.toThrow(HOST_CHANGED_ON_DISK);
    expect(unsentIn(store).length).toBe(0);
  });

  it('tells each listener of every change until stopped', async () => {
    const { saves, connection } = device();
    const heard = vi.fn();
    const stop = saves.pending.subscribe(heard);
    connection.set(false);
    await save(saves, 'one', 1);
    const times = heard.mock.calls.length;
    expect(times).toBeGreaterThan(0);
    stop();
    await saves.clear();
    expect(heard).toHaveBeenCalledTimes(times);
    expect(await saves.unsent()).toBe(0);
  });
});

/** A queue whose confirmed login, presumed login and re-check a test sets. */
function unconfirmed(notes: Record<string, string> = { 'Plan.md': 'v1', 'Shed.md': 's1' }) {
  const remote = github(notes);
  const store = memorySaveQueueStore();
  const connection = switchableConnection(true);
  const who = { confirmed: null as string | null, presumed: ACCOUNT as string | null };
  let holder = ACCOUNT;
  const saves = offlineSaves({
    fs: remote.fs,
    store,
    connection,
    device: DEVICE,
    report: vi.fn(),
    lock: memoryQueueLock(),
    changes: sharedQueueChanges()(),
    account: () => who.confirmed,
    vault: () => VAULT,
    presumed: () => who.presumed,
    confirm: async () => (holder === who.confirmed ? holder : null),
  });
  return { remote, store, saves, who, handTo: (login: string) => (holder = login) };
}

describe('offlineSaves: review #753', () => {
  it('never hands out a provisional version twice: offline, sent, offline again, then more typing', async () => {
    const { saves, connection, remote } = device();
    connection.set(false);
    const first = await save(saves, 'one', 1);
    connection.set(true);
    await saves.send(ACCOUNT);
    connection.set(false);
    const second = await save(saves, 'one two', first);
    expect(second).not.toBe(first);
    const third = await save(saves, 'one two three', second);
    expect(third).toBeLessThan(0);
    connection.set(true);
    await saves.send(ACCOUNT);
    expect(remote.sent).toEqual(['Plan.md: one', 'Plan.md: one two three']);
  });

  it('carries on after a reload from a save sent before it, with no false conflict', async () => {
    const { saves, connection, remote, reload } = device();
    connection.set(false);
    const first = await save(saves, 'one', 1);
    connection.set(true);
    await saves.send(ACCOUNT);
    const after = reload();
    connection.set(false);
    await save(after, 'one two', first);
    connection.set(true);
    await after.send(ACCOUNT);
    expect(remote.held.get('Plan.md')?.text).toBe('one two');
  });

  it('a second tab never writes over the first tab’s waiting save', async () => {
    const { saves, tab, connection, store } = device();
    const other = tab();
    connection.set(false);
    await other.unsent();
    await save(saves, 'first tab', 1);
    await expect(save(other, 'second tab', 1)).rejects.toThrow(HOST_CHANGED_ON_DISK);
    expect(unsentIn(store).map((queued) => queued.contents)).toEqual(['first tab']);
  });

  it('a tab sending never deletes what another tab folded in meanwhile', async () => {
    const { saves, tab, connection, remote, store } = device();
    const other = tab();
    connection.set(false);
    const first = await save(saves, 'one', 1);
    // The other tab's pane reads the waiting text, and carries on from it.
    const read = await other.fs.readTextFile(p('Plan.md'));
    expect(read).toEqual({ text: 'one', modified: first });
    const writes = remote.fs.writeTextFile;
    let folded: Promise<number> | null = null;
    remote.fs.writeTextFile = async (args) => {
      // Once: the other tab's fold, made while this tab's send is with GitHub.
      remote.fs.writeTextFile = writes;
      folded = save(other, 'one two', read.modified);
      return writes(args);
    };
    connection.set(true);
    await saves.send(ACCOUNT);
    remote.fs.writeTextFile = writes;
    connection.set(false);
    await folded;
    connection.set(true);
    await other.send(ACCOUNT);
    expect(remote.held.get('Plan.md')?.text).toBe('one two');
    expect(unsentIn(store)).toEqual([]);
  });

  it('two tabs sending at once send each save once, with no false refusal', async () => {
    const { saves, tab, connection, remote, store } = device();
    const other = tab();
    connection.set(false);
    await save(saves, 'one', 1);
    connection.set(true);
    await Promise.all([saves.send(ACCOUNT), other.send(ACCOUNT)]);
    expect(remote.sent).toEqual(['Plan.md: one']);
    expect(unsentIn(store)).toEqual([]);
  });

  it('tells another tab when a save starts or stops waiting', async () => {
    const { saves, tab, connection } = device();
    const other = tab();
    const heard = vi.fn();
    other.pending.subscribe(heard);
    connection.set(false);
    await save(saves, 'one', 1);
    await vi.waitFor(() =>
      expect(other.pending.stateOf(VAULT, 'Plan.md')).toEqual({ kind: 'waiting' }),
    );
    expect(heard).toHaveBeenCalled();
  });

  it('never sends one account’s saves under another, nor shows them', async () => {
    const { saves, connection, remote, signedInAs } = device();
    connection.set(false);
    await save(saves, 'hers', 1);
    connection.set(true);
    await saves.send('tobias-fenn');
    expect(remote.sent).toEqual([]);
    signedInAs('tobias-fenn');
    expect(saves.pending.stateOf(VAULT, 'Plan.md')).toBeNull();
    expect(await saves.unsent((account) => account !== 'tobias-fenn')).toBe(1);
  });

  it('queues nothing once cleared at sign-out, so nothing is left behind', async () => {
    const { saves, connection, store } = device();
    connection.set(false);
    await save(saves, 'one', 1);
    await saves.clear();
    await expect(save(saves, 'typed while signing out', 1)).rejects.toThrow(SAVES_CLOSED);
    expect(store.held.size).toBe(0);
  });

  it('where tabs cannot take turns, a send never writes over a save another tab folded in meanwhile', async () => {
    const remote = github({ 'Plan.md': 'v1' });
    const store = memorySaveQueueStore();
    const connection = switchableConnection(false);
    const channel = sharedQueueChanges();
    const open = () =>
      offlineSaves({
        fs: remote.fs,
        store,
        connection,
        device: DEVICE,
        report: vi.fn(),
        // No Web Locks and no storage to fall back on: every turn runs at once.
        lock: (task) => task(),
        changes: channel(),
        account: () => ACCOUNT,
        vault: () => VAULT,
      });
    const one = open();
    const two = open();
    const first = await save(one, 'one', 1);
    const writes = remote.fs.writeTextFile;
    remote.fs.writeTextFile = async (args) => {
      const landed = await writes(args);
      connection.set(false);
      await save(two, 'one two', first);
      return landed;
    };
    connection.set(true);
    await one.send(ACCOUNT);
    expect(unsentIn(store).map((queued) => queued.contents)).toEqual(['one two']);
  });

  it('a tab that was never told of another tab’s save still never writes over it', async () => {
    const remote = github({ 'Plan.md': 'v1' });
    const store = memorySaveQueueStore();
    const connection = switchableConnection(false);
    const lock = memoryQueueLock();
    // No BroadcastChannel: neither tab hears the other.
    const deaf = () => ({ announce: () => {}, listen: () => () => {} });
    const open = () =>
      offlineSaves({
        fs: remote.fs,
        store,
        connection,
        device: DEVICE,
        report: vi.fn(),
        lock,
        changes: deaf(),
        account: () => ACCOUNT,
        vault: () => VAULT,
      });
    const one = open();
    const two = open();
    await two.unsent();
    await save(one, 'first tab', 1);
    await expect(save(two, 'second tab', 1)).rejects.toThrow(HOST_CHANGED_ON_DISK);
    expect(unsentIn(store).map((queued) => queued.contents)).toEqual(['first tab']);
  });

  it('takes no save, and shows none waiting, while GitHub has not said who is signed in', async () => {
    const { saves, connection, store, remote, signedInAs } = device();
    connection.set(false);
    await save(saves, 'hers', 1);
    signedInAs(null);
    await expect(save(saves, 'whose?', 1)).rejects.toThrow(SAVES_WAIT_FOR_ACCOUNT);
    expect(saves.pending.stateOf(VAULT, 'Plan.md')).toBeNull();
    expect((await saves.fs.readTextFile(p('Plan.md'))).text).toBe('v1');
    expect(unsentIn(store).map((queued) => queued.contents)).toEqual(['hers']);
    expect(remote.sent).toEqual([]);
  });

  it('asks before letting saves go at sign-out, in one turn, and keeps them all on a no', async () => {
    const { saves, connection, store } = device();
    connection.set(false);
    await save(saves, 'one', 1);
    const asked: number[] = [];
    expect(await saves.closeForSignOut(async (count) => (asked.push(count), false))).toBe('kept');
    expect(unsentIn(store)).toHaveLength(1);
    expect(await saves.closeForSignOut(async () => true)).toBe('closed');
    expect(asked).toEqual([1]);
    expect(store.held.size).toBe(0);
    await expect(save(saves, 'after', 1)).rejects.toThrow(SAVES_CLOSED);
    await saves.reopen();
    expect(await save(saves, 'next session', 1)).toBeLessThan(0);
  });

  it('counts typing whose save the device could not store, until a later save of it is', async () => {
    const { saves, connection, store } = device();
    connection.set(false);
    const put = store.put;
    store.put = async () => Promise.reject(new Error('QuotaExceededError'));
    await expect(save(saves, 'one', 1)).rejects.toThrow('QuotaExceededError');
    expect(saves.unkept()).toBe(1);
    store.put = put;
    await save(saves, 'one', 1);
    expect(saves.unkept()).toBe(0);
  });

  it('keeps a restored session’s save on the device, as its login’s, and sends it only once confirmed', async () => {
    const { saves, remote, store, who } = unconfirmed();
    expect(await save(saves, 'typed before GitHub answered', 1)).toBeLessThan(0);
    expect(saves.pending.stateOf(VAULT, 'Plan.md')).toEqual({ kind: 'waiting' });
    expect((await saves.fs.readTextFile(p('Plan.md'))).text).toBe('typed before GitHub answered');
    await saves.send(ACCOUNT);
    expect(remote.sent).toEqual([]);
    who.confirmed = ACCOUNT;
    await saves.send(ACCOUNT);
    expect(remote.sent).toEqual(['Plan.md: typed before GitHub answered']);
    expect(unsentIn(store)).toEqual([]);
  });

  it('never sends a save made while unconfirmed under another login GitHub confirms', async () => {
    const { saves, remote, who, handTo } = unconfirmed();
    await save(saves, 'hers', 1);
    who.confirmed = 'tobias-fenn';
    who.presumed = null;
    handTo('tobias-fenn');
    await saves.send('tobias-fenn');
    expect(remote.sent).toEqual([]);
    expect(await saves.unsent((account) => account !== 'tobias-fenn')).toBe(1);
  });

  it('a fresh sign-in whose login is not known sees and adds to nobody’s waiting saves', async () => {
    const { saves, store, who } = unconfirmed();
    await save(saves, 'hers', 1);
    who.presumed = null;
    expect(saves.pending.stateOf(VAULT, 'Plan.md')).toBeNull();
    expect((await saves.fs.readTextFile(p('Plan.md'))).text).toBe('v1');
    await expect(save(saves, 'whose?', -1)).rejects.toThrow(SAVES_WAIT_FOR_ACCOUNT);
    expect(unsentIn(store).map((queued) => queued.contents)).toEqual(['hers']);
  });

  it('asks again before each save it sends, and stops at the first the token no longer matches', async () => {
    const { saves, remote, who, handTo } = unconfirmed();
    who.confirmed = ACCOUNT;
    remote.cutOff(true);
    await save(saves, 'plan', 1);
    await save(saves, 'shed', 1, 'Shed.md');
    remote.cutOff(false);
    const writes = remote.fs.writeTextFile;
    remote.fs.writeTextFile = async (args) => {
      const landed = await writes(args);
      handTo('tobias-fenn');
      return landed;
    };
    await saves.send(ACCOUNT);
    expect(remote.sent).toEqual(['Plan.md: plan']);
  });
});

const make = (saves: ReturnType<typeof offlineSaves>, path: string, contents: string) =>
  saves.fs.createNote({ vault: VAULT, path: p(path), contents });

describe('offlineSaves: a new note made offline (#773)', () => {
  it('waits on the device, says Not saved yet, reads as its text, and is created on reconnect', async () => {
    const { saves, remote, connection, store } = device();
    connection.set(false);
    const provisional = await make(saves, 'Buy seed.md', 'Buy seed');
    expect(provisional).toBeLessThan(0);
    expect(saves.pending.stateOf(VAULT, 'Buy seed.md')).toEqual({ kind: 'waiting' });
    expect(await saves.fs.readTextFile(p('Buy seed.md'))).toEqual({
      text: 'Buy seed',
      modified: provisional,
    });
    expect(remote.held.has('Buy seed.md')).toBe(false);
    connection.set(true);
    await saves.send(ACCOUNT);
    expect(remote.held.get('Buy seed.md')?.text).toBe('Buy seed');
    expect(saves.pending.stateOf(VAULT, 'Buy seed.md')).toBeNull();
    expect(unsentIn(store)).toEqual([]);
  });

  it('folds typing in the new note into its create, and outlives a reload', async () => {
    const { saves, remote, connection, reload } = device();
    connection.set(false);
    const made = await make(saves, 'Buy seed.md', '');
    await save(saves, 'Buy seed and twine', made, 'Buy seed.md');
    const after = reload();
    expect((await after.fs.readTextFile(p('Buy seed.md'))).text).toBe('Buy seed and twine');
    connection.set(true);
    await after.send(ACCOUNT);
    expect(remote.sent).toEqual(['created Buy seed.md: Buy seed and twine']);
  });

  it('lets the editor carry on from the created note at its real version', async () => {
    const { saves, remote, connection } = device();
    connection.set(false);
    const made = await make(saves, 'Buy seed.md', 'one');
    connection.set(true);
    await saves.send(ACCOUNT);
    await save(saves, 'one two', made, 'Buy seed.md');
    expect(remote.held.get('Buy seed.md')?.text).toBe('one two');
  });

  it('numbers a name taken by then, never writing over the note that took it', async () => {
    const { saves, remote, connection, store } = device();
    connection.set(false);
    const made = await make(saves, 'Plan.md', 'mine');
    remote.cutOff(true);
    connection.set(true);
    await saves.send(ACCOUNT);
    remote.cutOff(false);
    await saves.send(ACCOUNT);
    expect(remote.held.get('Plan.md')?.text).toBe('v1');
    expect(remote.held.get('Plan 2.md')?.text).toBe('mine');
    expect(unsentIn(store)).toEqual([]);
    // The pane still names the old path: its next save is refused, never landing on the Mac's note.
    await expect(save(saves, 'mine, more', made, 'Plan.md')).rejects.toThrow(HOST_CHANGED_ON_DISK);
    expect(remote.held.get('Plan.md')?.text).toBe('v1');
  });

  it('counts as created a create whose answer was lost, with no second copy', async () => {
    const { saves, remote, connection } = device({});
    connection.set(false);
    await make(saves, 'Buy seed.md', 'Buy seed');
    // GitHub made it, then the answer never came back.
    remote.held.set('Buy seed.md', { text: 'Buy seed', modified: 1 });
    connection.set(true);
    await saves.send(ACCOUNT);
    expect([...remote.held.keys()]).toEqual(['Buy seed.md']);
    expect(saves.pending.stateOf(VAULT, 'Buy seed.md')).toBeNull();
  });

  it('queues a new note GitHub could not be reached for, while the browser said online', async () => {
    const { saves, remote, store } = device();
    remote.cutOff(true);
    expect(await make(saves, 'Buy seed.md', 'Buy seed')).toBeLessThan(0);
    expect(unsentIn(store).map((queued) => queued.creates)).toEqual([true]);
  });

  it('creates straight on GitHub online, queueing nothing', async () => {
    const { saves, remote, store } = device();
    expect(await make(saves, 'Buy seed.md', 'Buy seed')).toBe(1);
    expect(remote.held.get('Buy seed.md')?.text).toBe('Buy seed');
    expect(store.held.size).toBe(0);
  });

  it('passes an online refusal of a name in use straight back, queueing nothing', async () => {
    const { saves, store } = device();
    await expect(make(saves, 'Plan.md', 'mine')).rejects.toThrow(HELD_REFUSAL.noteTaken);
    expect(store.held.size).toBe(0);
  });

  it('refuses the name of a note still waiting, so a second capture of it is numbered past it', async () => {
    const { saves, remote, connection } = device({ 'Inbox/Seeds.md': 's' });
    connection.set(false);
    const fs = inVault({ fs: saves.fs, vault: VAULT });
    const at = { fs, beside: null, folder: p('Inbox'), notePaths: [] };
    const first = await createNoteFile({ ...at, name: 'Buy seed', contents: 'first' });
    await expect(make(saves, first, 'second')).rejects.toThrow(HELD_REFUSAL.noteTaken);
    const second = await createNoteFile({ ...at, name: 'Buy seed', contents: 'second' });
    expect([first, second]).toEqual(['Inbox/Buy seed.md', 'Inbox/Buy seed 2.md']);
    expect((await saves.fs.readTextFile(p(first))).text).toBe('first');
    connection.set(true);
    await saves.send(ACCOUNT);
    expect(remote.held.get('Inbox/Buy seed.md')?.text).toBe('first');
    expect(remote.held.get('Inbox/Buy seed 2.md')?.text).toBe('second');
  });

  it('lists a new note waiting beside what GitHub lists, in its folder, once', async () => {
    const { saves, connection } = device();
    connection.set(false);
    await make(saves, 'Inbox/Buy seed.md', 'Buy seed');
    await make(saves, 'Plan 2.md', 'p2');
    connection.set(true);
    const notes = await saves.fs.listNotes({ skipDirectories: [], maxDepth: 4 });
    expect(notes.map((note) => note.path).sort()).toEqual(['Inbox/Buy seed.md', 'Plan 2.md', 'Plan.md']);
    expect(notes.find((note) => note.path === 'Inbox/Buy seed.md')).toMatchObject({
      name: 'Buy seed',
      size: 'Buy seed'.length,
    });
    const root = await saves.fs.listDirectory(VAULT_ROOT);
    expect(root.map((entry) => entry.path).sort()).toEqual(['Plan 2.md', 'Plan.md']);
    expect(await saves.fs.listDirectory(p('Inbox'))).toEqual([
      expect.objectContaining({ kind: 'file', name: 'Buy seed.md', path: 'Inbox/Buy seed.md' }),
    ]);
  });

  it('waits refused, with the reason, when its folder went meanwhile; kept as a copy, it is made again', async () => {
    const { saves, remote, connection } = device({});
    connection.set(false);
    await make(saves, 'Inbox/Buy seed.md', 'Buy seed');
    const creates = remote.fs.createNote;
    remote.fs.createNote = async () => Promise.reject(new VaultAccessError(HELD_REFUSAL.noFolder));
    connection.set(true);
    await saves.send(ACCOUNT);
    expect(saves.pending.stateOf(VAULT, 'Inbox/Buy seed.md')).toEqual({
      kind: 'refused',
      reason: HELD_REFUSAL.noFolder,
    });
    expect((await saves.fs.readTextFile(p('Inbox/Buy seed.md'))).text).toBe('Buy seed');
    remote.fs.createNote = creates;
    await saves.pending.keepAsCopy(VAULT, 'Inbox/Buy seed.md');
    expect([...remote.held.values()].map((note) => note.text)).toEqual(['Buy seed']);
    expect(saves.pending.stateOf(VAULT, 'Inbox/Buy seed.md')).toBeNull();
  });

  it('keeps waiting, reported, a create GitHub failed for some other reason', async () => {
    const { saves, remote, connection, report, store } = device();
    connection.set(false);
    await make(saves, 'Buy seed.md', 'Buy seed');
    const creates = remote.fs.createNote;
    remote.fs.createNote = async () => Promise.reject(new VaultAccessError('rate limited'));
    connection.set(true);
    await saves.send(ACCOUNT);
    expect(report).toHaveBeenCalled();
    expect(saves.pending.stateOf(VAULT, 'Buy seed.md')).toEqual({ kind: 'waiting' });
    remote.fs.createNote = creates;
    await saves.send(ACCOUNT);
    expect(remote.held.get('Buy seed.md')?.text).toBe('Buy seed');
    expect(unsentIn(store)).toEqual([]);
  });

  it('a second tab never replaces the first tab’s waiting note', async () => {
    const { saves, tab, connection, store } = device();
    const other = tab();
    connection.set(false);
    await make(saves, 'Buy seed.md', 'first tab');
    await expect(make(other, 'Buy seed.md', 'second tab')).rejects.toThrow(HELD_REFUSAL.noteTaken);
    expect(unsentIn(store).map((queued) => queued.contents)).toEqual(['first tab']);
  });

  it('two tabs sending at once create the note once', async () => {
    const { saves, tab, connection, remote } = device();
    const other = tab();
    connection.set(false);
    await make(saves, 'Buy seed.md', 'Buy seed');
    connection.set(true);
    await Promise.all([saves.send(ACCOUNT), other.send(ACCOUNT)]);
    expect(remote.sent).toEqual(['created Buy seed.md: Buy seed']);
  });

  it('never creates one account’s note under another, nor shows or lists it to them', async () => {
    const { saves, connection, remote, signedInAs } = device();
    connection.set(false);
    await make(saves, 'Hers.md', 'hers');
    connection.set(true);
    await saves.send('tobias-fenn');
    expect(remote.sent).toEqual([]);
    signedInAs('tobias-fenn');
    expect(saves.pending.stateOf(VAULT, 'Hers.md')).toBeNull();
    const listed = await saves.fs.listNotes({ skipDirectories: [], maxDepth: 4 });
    expect(listed.map((note) => note.path)).toEqual(['Plan.md']);
    expect(await saves.unsent((account) => account !== 'tobias-fenn')).toBe(1);
  });

  it('is counted among the unsent at sign-out, and refused once the queue is closed', async () => {
    const { saves, connection } = device();
    connection.set(false);
    await make(saves, 'Buy seed.md', 'Buy seed');
    await save(saves, 'edit', 1);
    const asked: number[] = [];
    expect(await saves.closeForSignOut(async (count) => (asked.push(count), false))).toBe('kept');
    expect(asked).toEqual([2]);
    expect(await saves.closeForSignOut(async () => true)).toBe('closed');
    await expect(make(saves, 'After.md', 'after')).rejects.toThrow(SAVES_CLOSED);
  });

  it('waits as a restored session’s login, and is created only once GitHub confirms it', async () => {
    const { saves, remote, who } = unconfirmed();
    expect(await make(saves, 'Buy seed.md', 'Buy seed')).toBeLessThan(0);
    await saves.send(ACCOUNT);
    expect(remote.held.has('Buy seed.md')).toBe(false);
    who.confirmed = ACCOUNT;
    await saves.send(ACCOUNT);
    expect(remote.held.get('Buy seed.md')?.text).toBe('Buy seed');
  });

  it('takes no new note while GitHub has not said who is signed in', async () => {
    const { saves, store, who } = unconfirmed();
    who.presumed = null;
    await expect(make(saves, 'Buy seed.md', 'x')).rejects.toThrow(SAVES_WAIT_FOR_ACCOUNT);
    expect(store.held.size).toBe(0);
  });

  it('fails the create, keeping nothing waiting, when the device cannot store it', async () => {
    const { saves, connection, store } = device();
    connection.set(false);
    store.put = async () => Promise.reject(new Error('QuotaExceededError'));
    await expect(make(saves, 'Buy seed.md', 'x')).rejects.toThrow('QuotaExceededError');
    expect(store.held.size).toBe(0);
  });
});
