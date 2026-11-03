import { createVaultPath as p, type QueuedSave } from '@dfai/domain';
import { describe, expect, it, vi } from 'vitest';
import { fakeHostVaultFs } from '../testing/fake-ports.ts';
import { memorySaveQueueStore, switchableConnection } from '../testing/memory-read-cache.ts';
import {
  HOST_CHANGED_ON_DISK,
  HOST_NO_SUCH_ENTRY,
  VaultAccessError,
  VaultUnreachableError,
  type HostVaultFsPort,
} from '../vault/ports.ts';
import { offlineSaves } from './offline-saves.ts';

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
    createNote: async ({ path, contents }) => {
      held.set(path, { text: contents, modified: 1 });
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

function device(notes: Record<string, string> = { 'Plan.md': 'v1' }) {
  const remote = github(notes);
  const store = memorySaveQueueStore();
  const connection = switchableConnection(true);
  const report = vi.fn();
  const open = () => offlineSaves({ fs: remote.fs, store, connection, device: DEVICE, report });
  return { remote, store, connection, report, saves: open(), reload: open };
}

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
    await saves.send();
    expect(remote.held.get('Plan.md')?.text).toBe('offline edit');
    expect(saves.pending.stateOf(VAULT, 'Plan.md')).toBeNull();
  });

  it('is stored before the save resolves, so it outlives a reload, and is sent after it', async () => {
    const { saves, store, connection, reload, remote } = device();
    connection.set(false);
    await save(saves, 'before the reload', 1);
    expect([...store.held.values()].map((queued) => queued.contents)).toEqual([
      'before the reload',
    ]);
    const after = reload();
    expect(await after.unsent()).toBe(1);
    connection.set(true);
    await after.send();
    expect(remote.held.get('Plan.md')?.text).toBe('before the reload');
    expect(store.held.size).toBe(0);
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
    await saves.send();
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
    await saves.send();
    expect(remote.sent).toEqual(['B.md: b2', 'A.md: a1', 'C.md: c1']);
  });

  it('queues a save GitHub could not be reached for, while the browser said online', async () => {
    const { saves, remote } = device();
    remote.cutOff(true);
    expect(await save(saves, 'edit', 1)).toBeLessThan(0);
    remote.cutOff(false);
    await saves.send();
    expect(remote.held.get('Plan.md')?.text).toBe('edit');
  });

  it('stops sending at the network, keeping the rest in order for next time', async () => {
    const { saves, connection, remote, store } = device({ 'A.md': 'a', 'B.md': 'b' });
    connection.set(false);
    await save(saves, 'a1', 1, 'A.md');
    await save(saves, 'b1', 1, 'B.md');
    connection.set(true);
    remote.cutOff(true);
    await saves.send();
    expect(store.held.size).toBe(2);
    remote.cutOff(false);
    await saves.send();
    expect(remote.sent).toEqual(['A.md: a1', 'B.md: b1']);
  });
});

describe('offlineSaves: back online', () => {
  it('lets the editor carry on from a sent save at its real version', async () => {
    const { saves, connection, remote } = device();
    connection.set(false);
    const provisional = await save(saves, 'offline', 1);
    connection.set(true);
    await saves.send();
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
    await setUp.saves.send();
    return { ...setUp, provisional };
  }

  it('is refused, never written over the Mac’s text, and kept waiting with the reason', async () => {
    const { saves, remote, store } = await refusedAfterMacSaved();
    expect(remote.held.get('Plan.md')?.text).toBe('the Mac’s');
    expect(saves.pending.stateOf(VAULT, 'Plan.md')).toEqual({
      kind: 'refused',
      reason: HOST_CHANGED_ON_DISK,
    });
    expect([...store.held.values()][0]?.contents).toBe('mine, offline');
    await saves.send();
    expect(remote.held.get('Plan.md')?.text).toBe('the Mac’s');
  });

  it('is refused when the note was deleted elsewhere', async () => {
    const { saves, connection, remote } = device();
    connection.set(false);
    await save(saves, 'mine', 1);
    remote.held.delete('Plan.md');
    connection.set(true);
    await saves.send();
    expect(saves.pending.stateOf(VAULT, 'Plan.md')?.kind).toBe('refused');
    expect(remote.held.has('Plan.md')).toBe(false);
  });

  it('keeps later typing in the refused save, still refused', async () => {
    const { saves, provisional, store } = await refusedAfterMacSaved();
    await save(saves, 'mine, and more', provisional);
    expect([...store.held.values()][0]).toMatchObject({
      contents: 'mine, and more',
      refused: HOST_CHANGED_ON_DISK,
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
    expect(store.held.size).toBe(0);
  });

  it('keeps the refused save waiting when its copy cannot be made', async () => {
    const { saves, remote, store } = await refusedAfterMacSaved();
    remote.fs.createNote = async () => Promise.reject(new VaultUnreachableError('offline'));
    await expect(saves.pending.keepAsCopy(VAULT, 'Plan.md')).rejects.toThrow('offline');
    expect(store.held.size).toBe(1);
  });

  it('discards the refused save only when asked, leaving the Mac’s text', async () => {
    const { saves, remote, store } = await refusedAfterMacSaved();
    await saves.pending.discard(VAULT, 'Plan.md');
    expect(store.held.size).toBe(0);
    expect(remote.held.get('Plan.md')?.text).toBe('the Mac’s');
  });

  it('never lets go of a save still waiting to be sent, whatever is asked', async () => {
    const { saves, connection, store } = device();
    connection.set(false);
    await save(saves, 'waiting', 1);
    await saves.pending.discard(VAULT, 'Plan.md');
    await saves.pending.keepAsCopy(VAULT, 'Plan.md');
    expect(store.held.size).toBe(1);
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
    await saves.send();
    expect(report).toHaveBeenCalledWith(new VaultAccessError('rate limited'));
    expect([...store.held.values()].map((queued: QueuedSave) => queued.path)).toEqual(['A.md']);
    expect(saves.pending.stateOf(VAULT, 'A.md')).toEqual({ kind: 'waiting' });
  });

  it('passes an online refusal straight to the editor, queueing nothing', async () => {
    const { saves, remote, store } = device();
    remote.elsewhere('Plan.md', 'the Mac’s');
    await expect(save(saves, 'stale', 1)).rejects.toThrow(HOST_CHANGED_ON_DISK);
    expect(store.held.size).toBe(0);
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
