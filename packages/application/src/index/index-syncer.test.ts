import { describe, expect, it } from 'vitest';
import {
  createVaultPath,
  digestOf,
  indexInWindowReport,
  notesNotIndexedReport,
  type NoteChange,
} from '@dfai/domain';
import { recordingActivity } from '../testing/fake-activity.ts';
import { fakeIndexPort, fakeMarkdown, fakeVaultFs } from '../testing/fake-ports.ts';
import { deleteEntry } from '../vault/delete-entry.ts';
import { renameEntry } from '../vault/relocate-entry.ts';
import type { OpenEditorsPort } from '../vault/ports.ts';
import { createNoteChanges, type NoteChangeNews } from './note-changes.ts';
import type { IndexEntry, IndexPort } from './ports.ts';
import { inThreadNoteDeriver } from './note-deriver.ts';
import { INDEX_BATCH_SIZE } from './refresh-index.ts';
import { createIndexSyncer } from './sync-index.ts';

const LARKSPUR = '/vaults/Larkspur';
const KICKOFF = 'meetings/Kickoff.md';
const KICKOFF_TEXT = '---\ntype: meeting\n---\nAgenda with Mara Quill.\n';

/**
 * A vault held in memory, every write a tick later, and an index that keeps
 * what it is handed and answers its manifest from it — as the host's does.
 */
function vaultWithIndex(notes: Record<string, string> = {}) {
  const files = new Map<string, { text: string; modified: number }>();
  let clock = 0;
  const write = (path: string, text: string) => void files.set(path, { text, modified: ++clock });
  for (const [path, text] of Object.entries(notes)) write(path, text);

  const fs = fakeVaultFs({
    listNotes: async () =>
      [...files].map(([path, file]) => ({
        name: path.split('/').at(-1) ?? path,
        path: createVaultPath(path),
        modified: file.modified,
        size: file.text.length,
      })),
    readNotes: async (paths) =>
      paths.flatMap((path) => {
        const file = files.get(path);
        return file === undefined ? [] : [{ path, ...file, size: file.text.length }];
      }),
    readTextFile: async (path) => files.get(path) ?? { text: '', modified: 0 },
    trashEntry: async ({ path }) => void files.delete(path),
    moveEntry: async ({ from, to }) => {
      const file = files.get(from);
      if (file === undefined) return;
      files.delete(from);
      files.set(to, file);
    },
  });

  const held = new Map<string, IndexEntry>();
  const index = fakeIndexPort({
    clear: async () => held.clear(),
    manifest: async () => [...held.values()],
    put: async (indexed) => {
      for (const { path, modified, size, digest, type } of indexed) {
        held.set(path, { path, modified, size, digest, type });
      }
    },
    remove: async (paths) => {
      for (const path of paths) held.delete(path);
    },
    stats: async () => ({ notes: held.size, properties: 0, links: 0 }),
  });

  return {
    fs,
    index,
    held,
    write,
    /** A newer modification time over the same bytes, as a checkout or a sync leaves. */
    touch: (path: string) => write(path, files.get(path)?.text ?? ''),
    /** Another program's write in the tick of the version held, as a coarse disk keeps it (#245). */
    writeInTheSameTick: (path: string, text: string) => {
      const file = files.get(path);
      if (file !== undefined) files.set(path, { text, modified: file.modified });
    },
    erase: (path: string) => void files.delete(path),
    notePaths: () => [...files.keys()].map(createVaultPath),
  };
}

type Vault = ReturnType<typeof vaultWithIndex>;

function syncerOver(
  { fs, index }: Pick<Vault, 'fs' | 'index'>,
  /** The vault open now; unless a test says otherwise, the one last synced. */
  openVault?: () => string | null,
  activity = recordingActivity(),
  markdown = fakeMarkdown(),
) {
  let asked: string | null = null;
  const heard: NoteChangeNews[] = [];
  const changes = createNoteChanges({
    onError: (cause) => {
      throw cause;
    },
  });
  changes.subscribe((news) => heard.push(news));
  const syncer = createIndexSyncer({
    fs,
    index,
    markdown,
    activity,
    changes,
    openVault: openVault ?? (() => asked),
  });
  return {
    heard,
    sync: (fromScratch = false, at = LARKSPUR, recheck?: readonly string[]) => {
      asked = at;
      return syncer.sync({ vault: at, fromScratch, ...(recheck !== undefined && { recheck }) });
    },
    /** Everything heard since the last call. */
    news: () => heard.splice(0).flatMap((each) => each.changes),
  };
}

/** A vault already synced once, so what follows is measured from a known state. */
async function synced(notes: Record<string, string> = {}) {
  const vault = vaultWithIndex(notes);
  const syncer = syncerOver(vault);
  await syncer.sync();
  syncer.news();
  return { vault, ...syncer };
}

const change = (
  kind: NoteChange['kind'],
  path: string,
  text: string,
  type: string | null,
  /** A changed note's text before, which the feed says the digest of (P29-01). */
  was?: string,
) => ({
  kind,
  path,
  type,
  digest: digestOf(text),
  ...(was !== undefined && { before: digestOf(was) }),
});

const editors: OpenEditorsPort = {
  state: () => 'closed',
  flush: async () => {},
  follow: () => {},
  abandon: () => {},
};

describe('the index syncer reports what changed (P28-03)', () => {
  it('reports a new note as added once, with its type and digest', async () => {
    const { vault, sync, news } = await synced({ 'Idea.md': 'a spark' });

    vault.write(KICKOFF, KICKOFF_TEXT);
    await sync();

    expect(news()).toEqual([change('added', KICKOFF, KICKOFF_TEXT, 'meeting')]);
  });

  it('reports an edited note as changed once, as it now is', async () => {
    const { vault, sync, news } = await synced({ [KICKOFF]: KICKOFF_TEXT });

    const edited = `${KICKOFF_TEXT}Decided: ship on Friday.\n`;
    vault.write(KICKOFF, edited);
    await sync();

    expect(news()).toEqual([change('changed', KICKOFF, edited, 'meeting', KICKOFF_TEXT)]);
  });

  it('reports a deleted note as removed once, as it last was', async () => {
    const { vault, sync, news } = await synced({ [KICKOFF]: KICKOFF_TEXT, 'Idea.md': 'a spark' });

    vault.erase(KICKOFF);
    await sync();

    expect(news()).toEqual([change('removed', KICKOFF, KICKOFF_TEXT, 'meeting')]);
  });

  it('publishes nothing when nothing changed, nor when only a modification time did', async () => {
    const { vault, sync, heard } = await synced({ [KICKOFF]: KICKOFF_TEXT });

    await sync();
    vault.touch(KICKOFF);
    await sync();

    expect(vault.held.get(KICKOFF)?.modified).toBe(2);
    expect(heard).toEqual([]);
  });

  it('reports nothing when the index is rebuilt and the notes are as they were', async () => {
    const { vault, sync, heard } = await synced({ [KICKOFF]: KICKOFF_TEXT, 'Idea.md': 'a spark' });

    await sync(true);

    expect(vault.held.size).toBe(2);
    expect(heard).toEqual([]);
  });

  it('reports only what really changed across a rebuild', async () => {
    const { vault, sync, news } = await synced({ [KICKOFF]: KICKOFF_TEXT, 'Idea.md': 'a spark' });

    vault.write('Idea.md', 'a bigger spark');
    await sync(true);

    expect(news()).toEqual([change('changed', 'Idea.md', 'a bigger spark', null, 'a spark')]);
  });

  it('reports nothing when the first sync since opening is a rebuild', async () => {
    const vault = vaultWithIndex({ [KICKOFF]: KICKOFF_TEXT });
    await syncerOver(vault).sync();
    const reopened = syncerOver(vault);

    await reopened.sync(true);

    expect(reopened.heard).toEqual([]);
  });

  it('still rebuilds an index that cannot say what it held, its notes reported as added', async () => {
    const vault = vaultWithIndex({ [KICKOFF]: KICKOFF_TEXT });
    let broken = true;
    const index = {
      ...vault.index,
      manifest: () =>
        broken
          ? Promise.reject(new Error('database disk image is malformed'))
          : vault.index.manifest(),
      clear: async () => {
        broken = false;
        await vault.index.clear();
      },
    };
    const { sync, news } = syncerOver({ fs: vault.fs, index });

    await sync(true);

    expect(news()).toEqual([change('added', KICKOFF, KICKOFF_TEXT, 'meeting')]);
  });

  it('fails a sync that cannot learn what the index held, rather than call every note new', async () => {
    const vault = vaultWithIndex({ [KICKOFF]: KICKOFF_TEXT });
    await syncerOver(vault).sync();
    let failures = 1;
    const index = {
      ...vault.index,
      manifest: () =>
        failures-- > 0 ? Promise.reject(new Error('index is locked')) : vault.index.manifest(),
    };
    const { sync, heard } = syncerOver({ fs: vault.fs, index });

    await expect(sync()).rejects.toThrow('index is locked');
    await sync();

    expect(heard).toEqual([]);
  });

  it('measures the first sync since opening from the index: a note that came while closed is added', async () => {
    const vault = vaultWithIndex({ 'Idea.md': 'a spark' });
    await syncerOver(vault).sync();

    vault.write(KICKOFF, KICKOFF_TEXT);
    const reopened = syncerOver(vault);
    await reopened.sync();

    expect(reopened.news()).toEqual([change('added', KICKOFF, KICKOFF_TEXT, 'meeting')]);
  });

  it('reports a rename in the app as the old path removed and the new one added', async () => {
    const { vault, sync, news } = await synced({ [KICKOFF]: KICKOFF_TEXT });

    await renameEntry({
      ports: { fs: vault.fs, index: vault.index, editors },
      entry: { path: createVaultPath(KICKOFF), kind: 'file' },
      name: 'Kickoff with Larkspur',
      notePaths: vault.notePaths(),
    });
    await sync();

    expect(news()).toEqual([
      change('added', 'meetings/Kickoff with Larkspur.md', KICKOFF_TEXT, 'meeting'),
      change('removed', KICKOFF, KICKOFF_TEXT, 'meeting'),
    ]);
  });

  it('reports a delete in the app once, though the index let go of it first, and not the notes that named it', async () => {
    const task = '---\ntype: task\nproject: [[Kickoff]]\n---\nFollow up\n';
    const { vault, sync, news } = await synced({ [KICKOFF]: KICKOFF_TEXT, 'tasks/Write.md': task });
    // The task names the meeting, so the delete lets go of it too, to be read again.
    vault.index.query = async (sql) => ({
      columns: ['path'],
      rows: sql.includes('FROM relations') ? [['tasks/Write.md']] : [],
      truncated: false,
    });

    await deleteEntry({
      fs: vault.fs,
      index: vault.index,
      editors,
      entry: { path: createVaultPath(KICKOFF), kind: 'file' },
      notePaths: vault.notePaths(),
    });
    expect(vault.held.has('tasks/Write.md')).toBe(false);
    await sync();

    expect(vault.held.has('tasks/Write.md')).toBe(true);
    expect(news()).toEqual([change('removed', KICKOFF, KICKOFF_TEXT, 'meeting')]);
  });

  it('reports a change once when two syncs are asked for at the same time', async () => {
    const { vault, sync, news } = await synced({ [KICKOFF]: KICKOFF_TEXT });

    vault.write('Idea.md', 'a spark');
    await Promise.all([sync(), sync()]);

    expect(news()).toEqual([change('added', 'Idea.md', 'a spark', null)]);
  });

  it('keeps a change found by a sync that failed for the next one to report', async () => {
    const vault = vaultWithIndex({ [KICKOFF]: KICKOFF_TEXT });
    let failing = false;
    const index = {
      ...vault.index,
      put: async (notes: Parameters<IndexPort['put']>[0]) => {
        await vault.index.put(notes);
        if (failing) throw new Error('disk full');
      },
    };
    const { sync, news } = syncerOver({ fs: vault.fs, index });
    await sync();
    news();

    vault.write('Idea.md', 'a spark');
    failing = true;
    await expect(sync()).rejects.toThrow('disk full');
    failing = false;
    await sync();

    expect(news()).toEqual([change('added', 'Idea.md', 'a spark', null)]);
  });

  it('does not measure one vault from what another held', async () => {
    const larkspur = vaultWithIndex({ [KICKOFF]: KICKOFF_TEXT });
    const fenn = vaultWithIndex({ 'Plan.md': 'the plan' });
    await syncerOver(fenn).sync();
    // The host's ports answer for whichever vault is open, as the app's do.
    let open = larkspur;
    const fs = fakeVaultFs({
      listNotes: (options) => open.fs.listNotes(options),
      readNotes: (paths) => open.fs.readNotes(paths),
    });
    const index = fakeIndexPort({
      manifest: () => open.index.manifest(),
      put: (notes) => open.index.put(notes),
      remove: (paths) => open.index.remove(paths),
      stats: () => open.index.stats(),
    });
    const { sync, news } = syncerOver({ fs, index });
    await sync(false, LARKSPUR);
    news();

    open = fenn;
    await sync(false, '/vaults/Fenn');

    // Fenn's own index already holds its note, and Larkspur's meeting did not go anywhere.
    expect(news()).toEqual([]);
  });

  it('publishes nothing for the first sync over an index the host has just made', async () => {
    const vault = vaultWithIndex({ [KICKOFF]: KICKOFF_TEXT, 'Idea.md': 'a spark' });
    const index = { ...vault.index, open: async () => ({ fresh: true }) };
    const { sync, heard } = syncerOver({ fs: vault.fs, index });

    await sync();

    expect(vault.held.size).toBe(2);
    expect(heard).toEqual([]);
  });

  it('measures from the notes it remembers even when the host has made the index afresh', async () => {
    const vault = vaultWithIndex({ [KICKOFF]: KICKOFF_TEXT });
    let fresh = false;
    const index = { ...vault.index, open: async () => ({ fresh }) };
    const { sync, news } = syncerOver({ fs: vault.fs, index });
    await sync();
    news();

    fresh = true;
    vault.held.clear();
    vault.write('Idea.md', 'a spark');
    await sync();

    expect(news()).toEqual([change('added', 'Idea.md', 'a spark', null)]);
  });

  it('keeps a baseline sync over a fresh index a baseline when it fails and is tried again', async () => {
    const vault = vaultWithIndex({ [KICKOFF]: KICKOFF_TEXT, 'Idea.md': 'a spark' });
    let opened = 0;
    let failing = true;
    const index = {
      ...vault.index,
      // Fresh the first time only, as the host is once it has made the file.
      open: async () => ({ fresh: opened++ === 0 }),
      put: async (notes: Parameters<IndexPort['put']>[0]) => {
        await vault.index.put(notes.slice(0, 1));
        if (failing) throw new Error('disk full');
        await vault.index.put(notes);
      },
    };
    const { sync, heard } = syncerOver({ fs: vault.fs, index });

    await expect(sync()).rejects.toThrow('disk full');
    failing = false;
    await sync();

    expect(heard).toEqual([]);
  });

  it('drops a sync whose vault was closed while it ran, publishing and remembering nothing', async () => {
    const { vault } = await synced({ [KICKOFF]: KICKOFF_TEXT });
    let open: string | null = LARKSPUR;
    const index = {
      ...vault.index,
      stats: async () => {
        open = '/vaults/Fenn';
        return vault.index.stats();
      },
    };
    const { sync, heard } = syncerOver({ fs: vault.fs, index }, () => open);

    vault.write('Idea.md', 'a spark');
    expect(await sync()).toBeNull();
    expect(heard).toEqual([]);
  });

  it('drops a sync asked for a vault that is not open, touching nothing', async () => {
    const vault = vaultWithIndex({ [KICKOFF]: KICKOFF_TEXT });
    const { sync, heard } = syncerOver(vault, () => null);

    expect(await sync()).toBeNull();
    expect(vault.held.size).toBe(0);
    expect(heard).toEqual([]);
  });

  it('says which vault the changes happened in', async () => {
    const { vault, sync, heard } = await synced();

    vault.write(KICKOFF, KICKOFF_TEXT);
    await sync();

    expect(heard.map((news) => news.vault)).toEqual([LARKSPUR]);
  });

  it('stops reading a vault closed while it was being built, and settles as dropped (#135)', async () => {
    const notes = Object.fromEntries(
      Array.from({ length: INDEX_BATCH_SIZE * 3 }, (_, n) => [`Note ${n}.md`, `note ${n}`]),
    );
    const vault = vaultWithIndex(notes);
    let open: string | null = LARKSPUR;
    let reads = 0;
    const fs = {
      ...vault.fs,
      readNotes: async (paths: readonly string[]) => {
        reads += 1;
        const files = await vault.fs.readNotes(paths);
        open = null;
        return files;
      },
    };
    const activity = recordingActivity();
    const { sync, heard } = syncerOver({ fs, index: vault.index }, () => open, activity);

    expect(await sync()).toBeNull();

    expect(reads).toBe(1);
    expect(vault.held.size).toBe(0);
    expect(heard).toEqual([]);
    // Closing a vault is not a failure of its index.
    expect(activity.reports).toEqual([]);
  });

  it('indexes an edit made while the index was being built, once, in the sync that follows (#135)', async () => {
    const vault = vaultWithIndex({ 'Idea.md': 'a spark', 'Plan.md': 'first' });
    const puts: string[][] = [];
    let edited = false;
    const index = {
      ...vault.index,
      put: async (notes: Parameters<IndexPort['put']>[0]) => {
        puts.push(notes.map((note) => note.path));
        await vault.index.put(notes);
        // The edit lands after the note was read for this build, before it finishes.
        if (!edited) {
          edited = true;
          vault.write('Idea.md', 'a spark, kindled');
        }
      },
    };
    const { sync, news } = syncerOver({ fs: vault.fs, index });

    const building = sync();
    const following = sync();
    await Promise.all([building, following]);
    await sync();

    expect(puts).toEqual([['Idea.md', 'Plan.md'], ['Idea.md']]);
    expect(vault.held.get('Idea.md')?.digest).toBe(digestOf('a spark, kindled'));
    expect(news()).toContainEqual(expect.objectContaining({ kind: 'changed', path: 'Idea.md' }));
  });

  it('says once which notes could not be indexed, and again only when they change (#135)', async () => {
    const vault = vaultWithIndex({ 'Idea.md': 'a spark', 'Torn.md': 'torn' });
    const markdown = fakeMarkdown();
    const unreadable = new Set(['torn']);
    const failing = {
      ...markdown,
      plainText: (body: string) => {
        if (unreadable.has(body.trim())) throw new Error('unexpected end of note');
        return '';
      },
    };
    const activity = recordingActivity();
    const { sync } = syncerOver({ fs: vault.fs, index: vault.index }, undefined, activity, failing);

    await sync();
    await sync();

    expect(vault.held.has('Idea.md')).toBe(true);
    expect(activity.reports).toEqual([
      notesNotIndexedReport([{ path: 'Torn.md', problem: 'unexpected end of note' }]),
    ]);

    unreadable.add('frayed');
    vault.write('Frayed.md', 'frayed');
    await sync();

    expect(activity.reports).toHaveLength(2);
    expect(activity.reports[1]?.message).toContain('2 notes could not be indexed');
  });
});

describe('createIndexSyncer, attacked (#135)', () => {
  /** A reader that cannot read any note whose words are in `unreadable`. */
  const tearing = (unreadable: ReadonlySet<string>) => ({
    ...fakeMarkdown(),
    plainText: (body: string) => {
      if (unreadable.has(body.trim())) throw new Error('unexpected end of note');
      return '';
    },
  });

  // The expectation here was the opposite as first written (the note dropped
  // from the index). The coordinator decided the other way for #138, for James
  // to overrule: a note that is torn stays findable by what it last said,
  // and is reported once, rather than vanishing from search and every view.
  it('goes on holding, as it last read, a note that has changed and can no longer be read', async () => {
    const vault = vaultWithIndex({ 'Idea.md': 'a spark', 'Plan.md': 'whole' });
    const unreadable = new Set<string>();
    const activity = recordingActivity();
    const { sync } = syncerOver(
      { fs: vault.fs, index: vault.index },
      undefined,
      activity,
      tearing(unreadable),
    );
    await sync();
    expect(vault.held.get('Plan.md')?.digest).toBe(digestOf('whole'));

    // The note is rewritten, and what is there now cannot be read as a note.
    unreadable.add('torn');
    vault.write('Plan.md', 'torn');
    await sync();

    await sync();

    // `IndexRefresh.failed` now says so: the rows of the last version that
    // could be read are kept, and the note is said once in Activity.
    expect(vault.held.get('Plan.md')?.digest).toBe(digestOf('whole'));
    expect(activity.reports).toEqual([
      notesNotIndexedReport([{ path: 'Plan.md', problem: 'unexpected end of note' }]),
    ]);
  });

  it('says once that the index is being built in the window, however many syncs follow', async () => {
    const vault = vaultWithIndex({ 'Idea.md': 'a spark' });
    const markdown = fakeMarkdown();
    const activity = recordingActivity();
    const changes = createNoteChanges({ onError: () => {} });
    const syncer = createIndexSyncer({
      fs: vault.fs,
      index: vault.index,
      markdown,
      deriver: {
        begin: (notePaths) => {
          const deriving = inThreadNoteDeriver(markdown).begin(notePaths);
          return {
            derive: async (files) => ({
              ...(await deriving.derive(files)),
              inWindow: 'The worker could not be started.',
            }),
            end: () => {},
          };
        },
      },
      activity,
      changes,
      openVault: () => LARKSPUR,
    });

    await syncer.sync({ vault: LARKSPUR, fromScratch: false });
    vault.write('Plan.md', 'first');
    await syncer.sync({ vault: LARKSPUR, fromScratch: false });

    expect(activity.reports).toEqual([indexInWindowReport('The worker could not be started.')]);
  });

  it('says once, in Activity and to the person, that the index is not kept here (#761)', async () => {
    const vault = vaultWithIndex({ 'Idea.md': 'a spark' });
    const activity = recordingActivity();
    const told: string[] = [];
    const syncer = createIndexSyncer({
      fs: vault.fs,
      index: {
        ...vault.index,
        open: async () => ({
          ...(await vault.index.open()),
          kept: false,
          notKeptBecause: 'UnknownError: The disk could not be read.',
        }),
      },
      markdown: fakeMarkdown(),
      activity,
      changes: createNoteChanges({ onError: () => {} }),
      openVault: () => LARKSPUR,
      onNotKept: (message) => told.push(message),
    });

    await syncer.sync({ vault: LARKSPUR, fromScratch: false });
    vault.write('Plan.md', 'first');
    await syncer.sync({ vault: LARKSPUR, fromScratch: true });

    expect(vault.held.has('Idea.md')).toBe(true);
    // The cause is kept in Activity: WebKit's UnknownError is a refusal or a real fault.
    expect(activity.reports).toEqual([
      {
        level: 'warning',
        kind: 'index',
        message:
          'Search and lists are rebuilt each visit here, because this browser won’t store them. (UnknownError: The disk could not be read.)',
        subject: null,
        detail: 'UnknownError: The disk could not be read.',
      },
      expect.anything(),
    ]);
    expect(told).toEqual([
      'Search and lists are rebuilt each visit here, because this browser won’t store them.',
    ]);
  });

  it('says nothing of keeping when the index is kept', async () => {
    const vault = vaultWithIndex({ 'Idea.md': 'a spark' });
    const activity = recordingActivity();
    const told: string[] = [];
    const syncer = createIndexSyncer({
      fs: vault.fs,
      index: { ...vault.index, open: async () => ({ fresh: true, kept: true }) },
      markdown: fakeMarkdown(),
      activity,
      changes: createNoteChanges({ onError: () => {} }),
      openVault: () => LARKSPUR,
      onNotKept: (message) => told.push(message),
    });

    await syncer.sync({ vault: LARKSPUR, fromScratch: false });

    expect([activity.reports, told]).toEqual([[], []]);
  });
});

describe('the index syncer and a note changed in the tick it was read in (#245)', () => {
  it('reads again a note it is told was changed, and says so, though its time and size stand', async () => {
    const { vault, sync, news } = await synced({ [KICKOFF]: KICKOFF_TEXT });
    const edited = KICKOFF_TEXT.replace('Mara Quill', 'Mara Quinn');
    expect(edited).toHaveLength(KICKOFF_TEXT.length);
    vault.writeInTheSameTick(KICKOFF, edited);

    await sync(false, LARKSPUR, [KICKOFF]);

    expect(news()).toEqual([change('changed', KICKOFF, edited, 'meeting', KICKOFF_TEXT)]);
    expect(vault.held.get(KICKOFF)?.digest).toBe(digestOf(edited));
  });
});
