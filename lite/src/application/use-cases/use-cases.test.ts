import { FAVORITES_PATH } from '../../domain/favorites/index.ts';
import { VaultSession, type VaultChange } from '../session/index.ts';
import { MemoryNoteStore } from '../testing/index.ts';
import {
  createNoteFromLink,
  createQuickNote,
  deleteNote,
  openVault,
  renameNote,
  reorderFavorite,
  saveNoteText,
  toggleFavoriteNote,
  type VaultDeps,
} from './index.ts';

const MARA = 'People/Mara Quill.md';
const PLAN = 'Projects/Larkspur Payroll.md';

async function opened(extra: Record<string, string> = {}): Promise<VaultDeps> {
  const store = MemoryNoteStore.of({
    [MARA]: 'Leads payroll. #person',
    [PLAN]: 'Rollout with [[Mara Quill|Mara]] and [[People/Mara Quill]].',
    'Inbox/Untitled.md': '',
    [FAVORITES_PATH]: JSON.stringify([MARA]),
    ...extra,
  });
  const deps = { store, session: new VaultSession() };
  await openVault(deps);
  return deps;
}

describe('opening the vault', () => {
  it('loads every file and indexes the visible notes', async () => {
    const store = MemoryNoteStore.of({ [MARA]: '', '_index/README.md': '' });
    const session = new VaultSession();
    expect(await openVault({ store, session })).toEqual({ noteCount: 1, favoritesProblem: null });
    expect(session.file('_index/README.md')).not.toBeNull();
  });

  it('reports a malformed favourites file', async () => {
    const deps = await opened({ [FAVORITES_PATH]: 'nope' });
    expect(deps.session.favorites).toEqual([]);
    expect(deps.session.favoritesProblem).toMatch(/JSON/);
  });
});

describe('creating notes', () => {
  it('makes a quick note in the Inbox with a free name, stored dirty', async () => {
    const deps = await opened();
    const path = await createQuickNote(deps);
    expect(path).toBe('Inbox/Untitled 2.md');
    expect(await deps.store.get(path)).toEqual({ path, text: '', baseSha: null, dirty: true });
    expect(deps.session.folderTree().folders.map((folder) => folder.name)).toContain('Inbox');
  });

  it('makes a note from a link, or opens the one that answers', async () => {
    const deps = await opened();
    expect(await createNoteFromLink(deps, { target: 'Tobias Fenn' })).toMatchObject({
      kind: 'create',
      path: 'Inbox/Tobias Fenn.md',
    });
    expect(deps.session.index.resolve('Tobias Fenn')).toBe('Inbox/Tobias Fenn.md');
    expect(await createNoteFromLink(deps, { target: 'mara quill' })).toEqual({
      kind: 'existing',
      path: MARA,
    });
  });
});

describe('saving a note', () => {
  it('stores the text dirty, keeps its base, and updates the index', async () => {
    const store = new MemoryNoteStore([{ path: MARA, text: 'Old', baseSha: 'b1', dirty: false }]);
    const deps = { store, session: new VaultSession() };
    await openVault(deps);
    const changes: VaultChange[] = [];
    deps.session.subscribe((change) => changes.push(change));
    await saveNoteText(deps, { path: MARA, text: 'New #tag' });
    expect(await store.get(MARA)).toEqual({
      path: MARA,
      text: 'New #tag',
      baseSha: 'b1',
      dirty: true,
    });
    expect(deps.session.index.notesWithTag('tag')).toEqual([MARA]);
    expect(changes).toEqual([{ kind: 'written', path: MARA }]);
  });

  it('does nothing when the text is unchanged', async () => {
    const deps = await opened();
    const before = deps.session.version;
    await saveNoteText(deps, { path: MARA, text: 'Leads payroll. #person' });
    expect(deps.session.version).toBe(before);
  });
});

describe('renaming a note', () => {
  it('rewrites links to it, follows it in favourites, and marks it new', async () => {
    const deps = await opened();
    const result = await renameNote(deps, { from: MARA, to: 'Contacts/Mara Q.md' });
    expect(result).toEqual({ kind: 'renamed', path: 'Contacts/Mara Q.md', retargeted: 2 });
    expect(deps.session.file(PLAN)?.text).toBe(
      'Rollout with [[Mara Q|Mara]] and [[Contacts/Mara Q]].',
    );
    expect(deps.session.file(MARA)).toBeNull();
    expect(await deps.store.get('Contacts/Mara Q.md')).toMatchObject({
      baseSha: null,
      dirty: true,
    });
    expect(deps.session.favorites).toEqual(['Contacts/Mara Q.md']);
    expect(deps.session.index.backlinks('Contacts/Mara Q.md')).toEqual([PLAN]);
  });

  it('refuses a taken path, case aside, and a forbidden name', async () => {
    const deps = await opened();
    expect(
      await renameNote(deps, { from: MARA, to: 'projects/larkspur payroll.md' }),
    ).toMatchObject({ kind: 'refused' });
    expect(await renameNote(deps, { from: MARA, to: 'People/Mara: Q.md' })).toMatchObject({
      kind: 'refused',
    });
    expect(await renameNote(deps, { from: 'Nope.md', to: 'X.md' })).toMatchObject({
      kind: 'refused',
    });
    expect(deps.session.file(MARA)).not.toBeNull();
  });
});

describe('deleting a note', () => {
  it('removes it from the store, the index and the favourites', async () => {
    const deps = await opened();
    await deleteNote(deps, { path: MARA });
    expect(await deps.store.get(MARA)).toBeNull();
    expect(deps.session.index.resolve('Mara Quill')).toBeNull();
    expect(deps.session.favorites).toEqual([]);
    expect(deps.session.file(FAVORITES_PATH)?.text).toBe('[]\n');
  });
});

describe('favourites', () => {
  it('toggles and reorders through the vault file', async () => {
    const deps = await opened();
    await toggleFavoriteNote(deps, { path: PLAN });
    await reorderFavorite(deps, { path: PLAN, index: 0 });
    expect(deps.session.favorites).toEqual([PLAN, MARA]);
    expect(await deps.store.get(FAVORITES_PATH)).toMatchObject({
      text: `[\n  "${PLAN}",\n  "${MARA}"\n]\n`,
      dirty: true,
    });
    await toggleFavoriteNote(deps, { path: MARA });
    expect(deps.session.favorites).toEqual([PLAN]);
  });
});
