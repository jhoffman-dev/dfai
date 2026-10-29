// @vitest-environment jsdom
/**
 * Attack on PR #612 (#225): the `#` picker's link index while the vault's
 * notes change under an open picker — added, renamed, case-only renamed,
 * spelled NFC or NFD, an archived namesake — and on a vault of 20,000 notes,
 * where it must be built once per set of notes, not once per key.
 * Fictional names only.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { fakeIndexPort, fakeMarkdown, fakeVaultFs, type OpenNotes } from '@dfai/application';
import { createVaultPath, type EditorDocument, type VaultPath } from '@dfai/domain';
import type { BlockPicking } from '@dfai/ui';
import type * as Domain from '@dfai/domain';
import { useBlockPicking } from './use-block-links.ts';

const builds = vi.hoisted(() => ({ count: 0 }));
vi.mock('@dfai/domain', async (original) => {
  const actual = await original<typeof Domain>();
  return {
    ...actual,
    createWikiLinkResolver: (notes: readonly VaultPath[]) => {
      builds.count += 1;
      return actual.createWikiLinkResolver(notes);
    },
  };
});

const HERE = createVaultPath('Notes/Offsite plan.md');
const OPEN_NOTES = {
  state: () => 'closed',
  setPropertiesIfOpen: async () => false,
} as unknown as OpenNotes; // Only what the picker reads; it writes nothing here.
const EMPTY: EditorDocument = { type: 'doc', content: [] };

function picker(initial: readonly VaultPath[]) {
  let onDisk = new Set<string>(initial);
  const ports = {
    fs: fakeVaultFs({
      readTextFile: async (at: VaultPath) => {
        if (!onDisk.has(at)) throw new Error(`no such file: ${at}`);
        return { text: 'Pack the tent\n', modified: 1 };
      },
    }),
    markdown: { ...fakeMarkdown(), parseBody: () => ({ blocks: [], doc: EMPTY }) },
    index: fakeIndexPort({ manifest: async () => [] }),
    openNotes: OPEN_NOTES,
    rng: { next: () => 0.5 },
    onChanged: vi.fn(),
    onRefused: vi.fn(),
  };
  const { result, rerender } = renderHook(
    ({ paths }: { paths: readonly VaultPath[] }) =>
      useBlockPicking({ ...ports, notePath: HERE, notePaths: paths }),
    { initialProps: { paths: initial } },
  );
  return {
    current: () => result.current,
    /** Gone from the disk, before the tree the page is handed has caught up. */
    removedOnDisk: (path: VaultPath) => void onDisk.delete(path),
    /** The vault's notes are now these, on disk and in the tree the page is handed. */
    becomes: (paths: readonly VaultPath[]) => {
      onDisk = new Set(paths);
      rerender({ paths });
      return result.current;
    },
  };
}

const pathOf = async (picking: BlockPicking, target: string) => {
  const found = await picking.choicesFor(target);
  if (found === null) return null;
  return found.same ? HERE : found.path;
};

describe('useBlockPicking — notes changing while the picker is open (#225, PR #612)', () => {
  it('finds a note added after the picker was first asked', async () => {
    const vault = [HERE, createVaultPath('Projects/Larkspur.md')];
    const open = picker(vault);
    expect(await pathOf(open.current(), 'Seed swap')).toBeNull();

    const added = createVaultPath('Areas/Seed swap.md');
    expect(await pathOf(open.becomes([...vault, added]), 'Seed swap')).toBe(added);
  });

  it('follows a case-only rename to the path as the disk now spells it', async () => {
    const before = createVaultPath('Projects/larkspur.md');
    const open = picker([HERE, before]);
    expect(await pathOf(open.current(), 'Larkspur')).toBe(before);

    const after = createVaultPath('Projects/Larkspur.md');
    expect(await pathOf(open.becomes([HERE, after]), 'Larkspur')).toBe(after);
  });

  it('finds a note however its accent was spelled, NFC typed and NFD on disk', async () => {
    const decomposed = createVaultPath('Areas/Café plan.md');
    const open = picker([HERE, decomposed]);
    expect(await pathOf(open.current(), 'Café plan')).toBe(decomposed);
  });

  it('opens the archived namesake once the note in use is removed, and nothing once both are', async () => {
    const inUse = createVaultPath('Projects/Larkspur.md');
    const archived = createVaultPath('Archive/Projects/Larkspur.md');
    const open = picker([HERE, inUse, archived]);
    expect(await pathOf(open.current(), 'Larkspur')).toBe(inUse);

    expect(await pathOf(open.becomes([HERE, archived]), 'Larkspur')).toBe(archived);
    expect(await pathOf(open.becomes([HERE]), 'Larkspur')).toBeNull();
  });
});

describe('useBlockPicking — a note deleted before the tree catches up (#225, PR #612)', () => {
  it('answers that there is nothing to pick, rather than failing the picker', async () => {
    const gone = createVaultPath('Projects/Larkspur.md');
    const open = picker([HERE, gone]);
    open.removedOnDisk(gone);

    await expect(open.current().choicesFor('Larkspur')).resolves.toBeNull();
  });
});

describe('useBlockPicking — a vault of 20,000 notes (#225, PR #612)', () => {
  const VAULT = [
    HERE,
    ...Array.from({ length: 20_000 }, (_, at) =>
      createVaultPath(`Areas/Area ${at % 50}/Note ${at}.md`),
    ),
  ];

  it('builds the index once for every key typed against the same notes', async () => {
    const open = picker(VAULT);
    builds.count = 0;
    const typed = 'Note 19999';
    for (let end = 1; end <= typed.length; end += 1) {
      await open.current().choicesFor(typed.slice(0, end));
    }
    expect(builds.count).toBe(1);
    expect(await pathOf(open.current(), typed)).toBe('Areas/Area 49/Note 19999.md');
  });

  it('builds it again once the notes change, and not before', async () => {
    const open = picker(VAULT);
    builds.count = 0;
    await open.current().choicesFor('Note 1');
    open.becomes(VAULT); // The same array: nothing changed.
    await open.current().choicesFor('Note 12');
    expect(builds.count).toBe(1);

    const renamed = VAULT.map((at) =>
      at === 'Areas/Area 1/Note 1.md' ? createVaultPath('Areas/Area 1/Note one.md') : at,
    );
    expect(await pathOf(open.becomes(renamed), 'Note 1')).toBeNull();
    expect(builds.count).toBe(2);
  });
});
