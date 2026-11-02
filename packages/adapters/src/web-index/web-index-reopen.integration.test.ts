import { afterEach, describe, expect, it } from 'vitest';
import { createVaultPath } from '@dfai/domain';
import {
  createIndexSyncer,
  createNoteChanges,
  inVault,
  type ActivityLog,
  type IndexPort,
  type VaultFsPort,
} from '@dfai/application';
import { remarkMarkdown } from '../markdown/markdown-port.ts';
import { FakeGitHub } from '../github/fake-github.test-support.ts';
import { vaultOver } from '../github/github-vault.test-support.ts';
import { WEB_INDEX } from './web-index-schema.ts';
import { inMemoryWebIndex, type InMemoryWebIndex } from './in-memory-web-index.ts';
import type { MemoryIndexFiles } from './memory-index-files.ts';

/**
 * Opening a GitHub vault in the browser's index (#666): the first open reads
 * every note and says how far it has got; opening it again reads only the
 * notes whose blob changed, or are new, and lets go of the ones gone — told
 * apart by the version each note is held at in the index's manifest. On the
 * real GitHub vault (over its stand-in, in process) and SQLite's WebAssembly.
 */

const NOTES = Object.fromEntries(
  Array.from({ length: 12 }, (_, at) => [
    `Notes/Note ${String(at).padStart(2, '0')}.md`,
    `# Note ${at}\n\nAbout [[Note 00]] and larkspur.\n`,
  ]),
);

/** No activity is asserted on here; the syncer only needs somewhere to say it. */
const quietActivity = (): ActivityLog => {
  const recorder = { record: () => undefined };
  return {
    ...recorder,
    inOpenVault: () => recorder,
    inVault: () => recorder,
    read: async () => [],
    subscribe: () => () => undefined,
  };
};

/** The vault's `readNotes`, each path it was asked for kept. */
function countingReads(fs: VaultFsPort): { fs: VaultFsPort; read: string[] } {
  const read: string[] = [];
  return {
    read,
    fs: {
      ...fs,
      readNotes: async (paths) => {
        read.push(...paths);
        return fs.readNotes(paths);
      },
    },
  };
}

let open: InMemoryWebIndex[] = [];
afterEach(() => {
  for (const each of open) each.close();
  open = [];
});

/** A page opening the vault: a GitHub vault of its own, the index's files from before when given. */
async function openTheVault(
  github: FakeGitHub,
  {
    files,
    index: around = (index) => index,
  }: { files?: MemoryIndexFiles; index?: (index: IndexPort) => IndexPort } = {},
) {
  const { fs: vaultFs, vault } = vaultOver(github);
  const web = await inMemoryWebIndex({
    shape: WEB_INDEX,
    openVault: () => vault,
    ...(files && { files }),
  });
  open.push(web);
  const { fs, read } = countingReads(inVault({ fs: vaultFs, vault }));
  const progress: [number, number][] = [];
  const syncer = createIndexSyncer({
    fs,
    index: around(web.index),
    markdown: remarkMarkdown,
    activity: quietActivity(),
    changes: createNoteChanges({ onError: () => undefined }),
    openVault: () => vault,
  });
  const stats = await syncer.sync({
    vault,
    fromScratch: false,
    onProgress: (done, total) => progress.push([done, total]),
  });
  return { web, read, progress, stats, vaultFs, vault };
}

describe("the browser's index over a GitHub vault (#666)", () => {
  it('reads every note on the first open, and says how far it has got', async () => {
    const github = new FakeGitHub({ files: NOTES });
    const first = await openTheVault(github);
    expect(first.read).toHaveLength(12);
    expect(first.stats?.notes).toBe(12);
    expect(first.progress.at(-1)).toEqual([12, 12]);
  });

  it('reads only the changed, new and gone notes when the vault is opened again', async () => {
    const github = new FakeGitHub({ files: NOTES });
    const first = await openTheVault(github);
    const changed = createVaultPath('Notes/Note 03.md');
    const before = await first.vaultFs.readTextFile(changed);
    const { vault } = first;
    await first.vaultFs.writeTextFile({
      vault,
      path: changed,
      contents: '# Note 3\n\nRewritten.\n',
      expectedModified: before.modified,
    });
    await first.vaultFs.createNote({
      vault,
      path: createVaultPath('Notes/New.md'),
      contents: '# New\n',
    });
    await first.vaultFs.trashEntry({ vault, path: createVaultPath('Notes/Note 11.md') });
    first.web.close();

    const again = await openTheVault(github, { files: first.web.files });
    expect(again.read.sort()).toEqual(['Notes/New.md', 'Notes/Note 03.md']);
    expect(again.stats?.notes).toBe(12);
    const found = await again.web.index.search('rewritten', 10);
    expect(found.map((hit) => hit.path)).toEqual(['Notes/Note 03.md']);
    expect((await again.web.index.manifest()).map((entry) => entry.path)).not.toContain(
      'Notes/Note 11.md',
    );
  });

  it('reads nothing when nothing changed', async () => {
    const github = new FakeGitHub({ files: NOTES });
    const first = await openTheVault(github);
    first.web.close();
    const again = await openTheVault(github, { files: first.web.files });
    expect(again.read).toEqual([]);
  });

  it('reads every note again when the manifest is not kept: the manifest is what saves the reads', async () => {
    const github = new FakeGitHub({ files: NOTES });
    const first = await openTheVault(github);
    first.web.close();
    const forgetful = (index: IndexPort): IndexPort => ({ ...index, manifest: async () => [] });
    const again = await openTheVault(github, { files: first.web.files, index: forgetful });
    expect(again.read).toHaveLength(12);
  });

  it("keeps each note's blob version for change detection, and no time it cannot know", async () => {
    const github = new FakeGitHub({ files: NOTES });
    const { web, vaultFs } = await openTheVault(github);
    const listed = await vaultFs.listNotes({ skipDirectories: [], maxDepth: 10 });
    const held = new Map((await web.index.manifest()).map((entry) => [entry.path, entry.modified]));
    for (const note of listed) expect(held.get(note.path)).toBe(note.modified);
    const times = await web.index.query('SELECT DISTINCT modified FROM files', []);
    expect(times.rows).toEqual([[null]]);
  });

  it('throws an index of another shape away, and one that is not a database, and builds it again', async () => {
    const github = new FakeGitHub({ files: NOTES });
    const first = await openTheVault(github);
    first.web.close();
    first.web.files.stored.set(first.vault, new TextEncoder().encode('not a database at all'));
    const again = await openTheVault(github, { files: first.web.files });
    expect(again.read).toHaveLength(12);
    expect(again.stats?.notes).toBe(12);
  });
});
