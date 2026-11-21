import type { VaultPath } from '../../domain/vault/index.ts';
import {
  RemoteAuthError,
  RemoteUnreachableError,
  type PushCommit,
  type RemoteHead,
  type RemoteVault,
} from '../ports/index.ts';
import { VaultSession, type VaultChange } from '../session/index.ts';
import { FakeRemoteVault, FixedClock, MemoryNoteStore, fakeSha } from '../testing/index.ts';
import { deleteNote, saveNoteText } from '../use-cases/index.ts';
import { createSyncNow, MAX_SYNC_ATTEMPTS, type SyncDeps, type SyncResult } from './index.ts';

const PLAN = 'Projects/Larkspur Payroll.md';
const MARA = 'People/Mara Quill.md';
const TOBIAS = 'People/Tobias Fenn.md';
const INDEX = '_index/notes.md';

/** A remote whose `push` runs `before` first, then the fake's own. */
function pushingThrough(
  remote: FakeRemoteVault,
  before: (commit: PushCommit) => void,
): RemoteVault {
  return {
    head: () => remote.head(),
    tree: (sha) => remote.tree(sha),
    blobs: (shas) => remote.blobs(shas),
    push: (commit): Promise<RemoteHead> => {
      before(commit);
      return remote.push(commit);
    },
  };
}

function setup(remoteFiles: Record<VaultPath, string>, extra: Partial<SyncDeps> = {}) {
  const fake = new FakeRemoteVault(remoteFiles);
  const store = new MemoryNoteStore();
  const session = new VaultSession();
  const changes: VaultChange[] = [];
  session.subscribe((change) => changes.push(change));
  const deps: SyncDeps = {
    store,
    remote: fake,
    session,
    clock: new FixedClock(new Date(2026, 10, 21, 9, 0)),
    remoteIdentity: 'mara-quill/larkspur-notes@main',
    hashBlob: async (text) => fakeSha('blob', text),
    ...extra,
  };
  return { fake, store, session, changes, deps, sync: () => createSyncNow(deps)() };
}

async function texts(store: MemoryNoteStore): Promise<Record<VaultPath, string>> {
  return Object.fromEntries((await store.list()).map(({ path, text }) => [path, text]));
}

const dirtyPaths = async (store: MemoryNoteStore) =>
  (await store.list()).filter(({ dirty }) => dirty).map(({ path }) => path);

function synced(result: SyncResult) {
  if (result.kind !== 'synced') throw new Error(`expected a sync, got ${result.message}`);
  return result;
}

describe('sync', () => {
  it('first sync of an empty device takes every remote file, clean, and tells the session', async () => {
    const { store, session, changes, sync } = setup({
      [PLAN]: 'Rollout.',
      [MARA]: 'Leads payroll.',
    });
    const result = synced(await sync());
    expect(result).toMatchObject({ pulled: 2, pushed: 0, conflicts: [] });
    expect(await texts(store)).toEqual({ [MARA]: 'Leads payroll.', [PLAN]: 'Rollout.' });
    expect(await store.get(PLAN)).toEqual({
      path: PLAN,
      text: 'Rollout.',
      baseSha: fakeSha('blob', 'Rollout.'),
      dirty: false,
    });
    expect(session.file(MARA)?.text).toBe('Leads payroll.');
    expect(changes).toContainEqual({ kind: 'written', path: PLAN });
  });

  it('a second sync right after is a no-op: no blobs, no commit', async () => {
    const { fake, sync } = setup({ [PLAN]: 'Rollout.' });
    await sync();
    const requests = fake.blobRequests.length;
    expect(synced(await sync())).toMatchObject({ pulled: 0, pushed: 0 });
    expect(fake.blobRequests).toHaveLength(requests);
    expect(fake.pushes).toHaveLength(0);
  });

  it('pushes a local edit and a new note as one commit, then marks them clean', async () => {
    const { fake, store, session, deps, sync } = setup({ [PLAN]: 'Rollout.' });
    await sync();
    await saveNoteText(deps, { path: PLAN, text: 'Rollout, v2.' });
    await saveNoteText(deps, { path: TOBIAS, text: 'New hire.' });
    expect(synced(await sync())).toMatchObject({ pushed: 2, pulled: 0 });
    expect(fake.files()).toEqual({ [PLAN]: 'Rollout, v2.', [TOBIAS]: 'New hire.' });
    expect(fake.pushes.map(({ message }) => message)).toEqual(['Notes: 2 changed']);
    expect(await dirtyPaths(store)).toEqual([]);
    expect(session.file(PLAN)).toMatchObject({
      dirty: false,
      baseSha: fakeSha('blob', 'Rollout, v2.'),
    });
    expect(synced(await sync()).pushed).toBe(0);
  });

  it('names a one-note commit after the note', async () => {
    const { fake, deps, sync } = setup({});
    await sync();
    await saveNoteText(deps, { path: MARA, text: 'Hi.' });
    await sync();
    expect(fake.pushes.map(({ message }) => message)).toEqual(['Notes: Mara Quill']);
  });

  it('pulls a remote edit, fetching only the changed blob', async () => {
    const { fake, store, sync } = setup({ [PLAN]: 'Rollout.', [MARA]: 'Leads payroll.' });
    await sync();
    fake.pushFromElsewhere({ upserts: { [PLAN]: 'Rollout, from Claude.' } });
    expect(synced(await sync())).toMatchObject({ pulled: 1, pushed: 0 });
    expect(fake.blobRequests.at(-1)).toEqual([fakeSha('blob', 'Rollout, from Claude.')]);
    expect((await store.get(PLAN))?.text).toBe('Rollout, from Claude.');
  });

  it('pushes a local delete, and pulls a remote one', async () => {
    const { fake, store, session, deps, sync } = setup({ [PLAN]: 'Rollout.', [MARA]: 'Leads.' });
    await sync();
    await deleteNote(deps, { path: PLAN });
    fake.pushFromElsewhere({ deletes: [MARA] });
    expect(synced(await sync())).toMatchObject({ pulled: 1, pushed: 1 });
    expect(fake.files()).toEqual({});
    expect(await store.list()).toEqual([]);
    expect(session.file(MARA)).toBeNull();
  });

  it('keeps both texts when both sides edited: remote at the path, this device’s in a dated copy', async () => {
    const { fake, store, sync, deps } = setup({ [PLAN]: 'Rollout.' });
    await sync();
    await saveNoteText(deps, { path: PLAN, text: 'Mine.' });
    fake.pushFromElsewhere({ upserts: { [PLAN]: 'Theirs.' } });
    const copy = 'Projects/Larkspur Payroll (conflict 2026-11-21).md';
    expect(synced(await sync())).toMatchObject({ conflicts: [{ path: PLAN, copy }], pushed: 1 });
    expect(await texts(store)).toEqual({ [PLAN]: 'Theirs.', [copy]: 'Mine.' });
    expect(fake.files()).toEqual({ [PLAN]: 'Theirs.', [copy]: 'Mine.' });
    expect(await dirtyPaths(store)).toEqual([]);
  });

  it('treats the same edit on both sides as no conflict', async () => {
    const { fake, store, sync, deps } = setup({ [PLAN]: 'Rollout.' });
    await sync();
    await saveNoteText(deps, { path: PLAN, text: 'Same.' });
    fake.pushFromElsewhere({ upserts: { [PLAN]: 'Same.' } });
    expect(synced(await sync())).toMatchObject({ conflicts: [], pushed: 0 });
    expect(await dirtyPaths(store)).toEqual([]);
  });

  it('lets a remote edit beat a local delete', async () => {
    const { fake, store, sync, deps } = setup({ [PLAN]: 'Rollout.' });
    await sync();
    await deleteNote(deps, { path: PLAN });
    fake.pushFromElsewhere({ upserts: { [PLAN]: 'Edited elsewhere.' } });
    expect(synced(await sync())).toMatchObject({ pulled: 1, pushed: 0 });
    expect(await texts(store)).toEqual({ [PLAN]: 'Edited elsewhere.' });
    expect(fake.files()).toEqual({ [PLAN]: 'Edited elsewhere.' });
  });

  it('lets a local edit beat a remote delete', async () => {
    const { fake, store, sync, deps } = setup({ [PLAN]: 'Rollout.' });
    await sync();
    await saveNoteText(deps, { path: PLAN, text: 'Still needed.' });
    fake.pushFromElsewhere({ deletes: [PLAN] });
    expect(synced(await sync())).toMatchObject({ pulled: 0, pushed: 1 });
    expect(fake.files()).toEqual({ [PLAN]: 'Still needed.' });
    expect(await dirtyPaths(store)).toEqual([]);
  });

  it('pulls again and retries when the branch moves during the push', async () => {
    const fake = new FakeRemoteVault({ [PLAN]: 'Rollout.' });
    let moves = 1;
    const remote = pushingThrough(fake, () => {
      if (moves-- > 0) fake.pushFromElsewhere({ upserts: { [MARA]: 'Arrived meanwhile.' } });
    });
    const { store, deps, sync } = setup({}, { remote });
    await sync();
    await saveNoteText(deps, { path: TOBIAS, text: 'Mine.' });
    expect(synced(await sync())).toMatchObject({ pulled: 1, pushed: 1 });
    expect(fake.files()).toEqual({
      [PLAN]: 'Rollout.',
      [MARA]: 'Arrived meanwhile.',
      [TOBIAS]: 'Mine.',
    });
    expect(await dirtyPaths(store)).toEqual([]);
  });

  it('gives up, still dirty, when the branch moves on every attempt', async () => {
    const fake = new FakeRemoteVault({});
    let edits = 0;
    const remote = pushingThrough(fake, () =>
      fake.pushFromElsewhere({ upserts: { [MARA]: `Edit ${++edits}` } }),
    );
    const { store, deps, sync } = setup({}, { remote });
    await saveNoteText(deps, { path: TOBIAS, text: 'Mine.' });
    expect(await sync()).toMatchObject({ kind: 'failed', reason: 'moved' });
    expect(edits).toBe(MAX_SYNC_ATTEMPTS);
    expect(await dirtyPaths(store)).toEqual([TOBIAS]);
  });

  it('leaves everything dirty when the token is refused at the push', async () => {
    const fake = new FakeRemoteVault({ [PLAN]: 'Rollout.' });
    let refuse = false;
    const remote = pushingThrough(fake, () => {
      if (refuse) throw new RemoteAuthError();
    });
    const { store, deps, sync } = setup({}, { remote });
    await sync();
    refuse = true;
    await saveNoteText(deps, { path: PLAN, text: 'Unsent.' });
    await deleteNote(deps, { path: PLAN });
    await saveNoteText(deps, { path: MARA, text: 'Unsent too.' });
    expect(await sync()).toMatchObject({ kind: 'failed', reason: 'auth' });
    expect(await dirtyPaths(store)).toEqual([MARA]);
    expect(fake.files()).toEqual({ [PLAN]: 'Rollout.' });

    refuse = false;
    expect(synced(await sync())).toMatchObject({ pushed: 2 });
    expect(fake.files()).toEqual({ [MARA]: 'Unsent too.' });
  });

  it('never overwrites an edit made while the pull was running', async () => {
    const fake = new FakeRemoteVault({ [PLAN]: 'Rollout.' });
    let typeDuringPull: (() => Promise<unknown>) | null = null;
    const remote: RemoteVault = {
      ...pushingThrough(fake, () => undefined),
      blobs: async (shas) => {
        await typeDuringPull?.();
        return fake.blobs(shas);
      },
    };
    const { store, deps, sync } = setup({}, { remote });
    await sync();
    fake.pushFromElsewhere({ upserts: { [PLAN]: 'Theirs.' } });
    typeDuringPull = () => saveNoteText(deps, { path: PLAN, text: 'Typed meanwhile.' });
    expect(synced(await sync())).toMatchObject({ pulled: 0, pushed: 0 });
    expect((await store.get(PLAN))?.text).toBe('Typed meanwhile.');

    typeDuringPull = null;
    expect(synced(await sync()).conflicts).toHaveLength(1);
    expect(Object.values(await texts(store)).sort()).toEqual(['Theirs.', 'Typed meanwhile.']);
  });

  it('keeps the true base for a path the pull skipped, so a remote edit survives a delete made meanwhile', async () => {
    const fake = new FakeRemoteVault({ [PLAN]: 'Rollout.' });
    let deleteDuringPull: (() => Promise<void>) | null = null;
    const remote: RemoteVault = {
      ...pushingThrough(fake, () => undefined),
      blobs: async (shas) => {
        await deleteDuringPull?.();
        return fake.blobs(shas);
      },
    };
    const { store, deps, sync } = setup({}, { remote });
    await sync();
    fake.pushFromElsewhere({ upserts: { [PLAN]: 'Edited elsewhere.' } });
    deleteDuringPull = () => deleteNote(deps, { path: PLAN });
    await sync();
    deleteDuringPull = null;
    expect(synced(await sync())).toMatchObject({ pulled: 1, pushed: 0 });
    expect(fake.files()).toEqual({ [PLAN]: 'Edited elsewhere.' });
    expect((await store.get(PLAN))?.text).toBe('Edited elsewhere.');
  });

  it('fails, deleting nothing here, when the branch synced before is gone', async () => {
    const fake = new FakeRemoteVault({ [PLAN]: 'Rollout.' });
    let gone = false;
    const remote: RemoteVault = {
      ...pushingThrough(fake, () => undefined),
      head: async () => (gone ? null : fake.head()),
    };
    const { store, deps, sync } = setup({}, { remote });
    await sync();
    gone = true;
    await saveNoteText(deps, { path: MARA, text: 'New.' });
    expect(await sync()).toMatchObject({ kind: 'failed', reason: 'branch-missing' });
    expect(await texts(store)).toEqual({ [PLAN]: 'Rollout.', [MARA]: 'New.' });
    expect(fake.pushes).toEqual([]);
  });

  it('refuses to compare this device with a remote other than the one it synced with', async () => {
    const { store, session, sync } = setup({ [PLAN]: 'Rollout.' });
    await sync();
    const other = createSyncNow({
      store,
      session,
      remote: new FakeRemoteVault({ 'Other.md': 'other repo' }),
      clock: new FixedClock(),
      remoteIdentity: 'tobias-fenn/other@main',
      hashBlob: async (text) => fakeSha('blob', text),
    });
    expect(await other()).toMatchObject({ kind: 'failed', reason: 'remote-changed' });
    expect(await texts(store)).toEqual({ [PLAN]: 'Rollout.' });
  });

  it('pushes a note deleted and made again at the same path, with no conflict', async () => {
    const { fake, deps, sync } = setup({ [PLAN]: 'Rollout.' });
    await sync();
    await deleteNote(deps, { path: PLAN });
    await saveNoteText(deps, { path: PLAN, text: 'Started over.' });
    expect(synced(await sync())).toMatchObject({ pushed: 1, conflicts: [] });
    expect(fake.files()).toEqual({ [PLAN]: 'Started over.' });
  });

  it('says an unreachable remote as such', async () => {
    const { fake, sync } = setup({ [PLAN]: 'Rollout.' });
    fake.failNext(new RemoteUnreachableError());
    expect(await sync()).toMatchObject({ kind: 'failed', reason: 'unreachable' });
  });

  it('pushes the conflict copy’s text even when the push then fails, and keeps it', async () => {
    const fake = new FakeRemoteVault({ [PLAN]: 'Rollout.' });
    let refuse = false;
    const remote = pushingThrough(fake, () => {
      if (refuse) throw new RemoteUnreachableError();
    });
    const { store, deps, sync } = setup({}, { remote });
    await sync();
    await saveNoteText(deps, { path: PLAN, text: 'Mine.' });
    fake.pushFromElsewhere({ upserts: { [PLAN]: 'Theirs.' } });
    refuse = true;
    expect(await sync()).toMatchObject({ kind: 'failed', reason: 'unreachable' });
    expect(await texts(store)).toEqual({
      [PLAN]: 'Theirs.',
      'Projects/Larkspur Payroll (conflict 2026-11-21).md': 'Mine.',
    });
    refuse = false;
    expect(synced(await sync())).toMatchObject({ pushed: 1, conflicts: [] });
  });
});

describe('sync of derived files', () => {
  const derivedFiles = (notes: readonly { path: string }[]) => [
    { path: INDEX, text: notes.map(({ path }) => path).join('\n') },
    // Outside `_index/`: never written, or it could overwrite a note.
    { path: PLAN, text: 'not mine to write' },
  ];

  it('includes the derived files in the push, and never keeps them here', async () => {
    const { fake, store, deps, sync } = setup({ [PLAN]: 'Rollout.' }, { derivedFiles });
    await sync();
    expect(fake.files()).toEqual({ [PLAN]: 'Rollout.', [INDEX]: PLAN });
    await saveNoteText(deps, { path: MARA, text: 'Leads.' });
    expect(synced(await sync())).toMatchObject({ pushed: 2 });
    expect(fake.files()[INDEX]).toBe(`${MARA}\n${PLAN}`);
    expect(fake.pushes.map(({ message }) => message)).toEqual([
      'Index: refresh',
      'Notes: Mara Quill',
    ]);
    expect((await store.list()).map(({ path }) => path)).toEqual([MARA, PLAN]);
  });

  it('heals a stale index once, and removes generated files no longer made', async () => {
    const { fake, sync } = setup(
      { [PLAN]: 'Rollout.', [INDEX]: 'stale', '_index/old.md': 'gone' },
      { derivedFiles },
    );
    expect(synced(await sync())).toMatchObject({ pulled: 1, pushed: 2 });
    expect(fake.files()).toEqual({ [PLAN]: 'Rollout.', [INDEX]: PLAN });
    expect(synced(await sync()).pushed).toBe(0);
    expect(fake.pushes).toHaveLength(1);
  });

  it('ignores remote derived files on pull', async () => {
    const { store, fake, sync } = setup({ [INDEX]: 'by the Action' });
    expect(synced(await sync()).pulled).toBe(0);
    expect(await store.list()).toEqual([]);
    expect(fake.blobRequests).toEqual([]);
  });
});
