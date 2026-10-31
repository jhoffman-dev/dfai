// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { fakeIndexPort, fakeMarkdown, fakeVaultFs, type OpenNotes } from '@dfai/application';
import {
  createVaultPath,
  resolveWikiLinkTarget,
  type EditorDocument,
  type VaultPath,
} from '@dfai/domain';
import type { BlockPicking } from '@dfai/ui';
import { useBlockPicking } from './use-block-links.ts';

/**
 * The `#` picker's note, found as every link in the vault finds it (#225):
 * by name wherever it lives, by path, case folded, the shallowest of
 * namesakes, never a template. Fictional names only.
 */

const HERE = createVaultPath('Notes/Offsite plan.md');
const VAULT = [
  HERE,
  createVaultPath('Projects/Larkspur.md'),
  createVaultPath('Archive/Projects/Larkspur.md'),
  createVaultPath('Areas/Garden/Seed swap.md'),
  createVaultPath('Areas/Seed swap.md'),
  createVaultPath('.atlas/templates/Meeting.md'),
];

const OPEN_NOTES: OpenNotes = {
  state: () => 'closed',
  setPropertiesIfOpen: async () => false,
} as unknown as OpenNotes; // Only what the picker reads; it writes nothing here.

const EMPTY: EditorDocument = { type: 'doc', content: [] };

function picker(notePaths: readonly VaultPath[] = VAULT) {
  const readTextFile = vi.fn(async () => ({ text: 'Pack the tent\n', modified: 1 }));
  // Made once, as the app keeps its ports: only the notes change between renders.
  const ports = {
    fs: fakeVaultFs({ readTextFile }),
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
    { initialProps: { paths: notePaths } },
  );
  return {
    picking: result.current,
    readTextFile,
    /** The picker as the hook hands it over once the vault's notes are these. */
    over: (paths: readonly VaultPath[]) => {
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

describe('useBlockPicking — the note a `#` link names (#225)', () => {
  it.each([
    ['Larkspur', 'Projects/Larkspur.md'],
    ['larkspur', 'Projects/Larkspur.md'],
    ['Archive/Projects/Larkspur', 'Archive/Projects/Larkspur.md'],
    ['Seed swap', 'Areas/Seed swap.md'],
    ['Seed Swap.md', 'Areas/Seed swap.md'],
  ])('finds [[%s#…]] in %s, as the vault resolves it', async (target, expected) => {
    const { picking, readTextFile } = picker();

    expect(await pathOf(picking, target)).toBe(expected);
    expect(resolveWikiLinkTarget(target, VAULT)).toBe(expected);
    expect(readTextFile).toHaveBeenCalledWith(expected);
  });

  it('answers this note for an empty name and for its own, reading nothing', async () => {
    const { picking, readTextFile } = picker();

    expect(await picking.choicesFor('')).toEqual({ same: true, target: '' });
    expect(await picking.choicesFor('offsite plan')).toEqual({
      same: true,
      target: 'offsite plan',
    });
    expect(readTextFile).not.toHaveBeenCalled();
  });

  it('finds nothing for a note that is not there, nor for a template', async () => {
    const { picking } = picker();

    expect(await picking.choicesFor('Quarter close')).toBeNull();
    expect(await picking.choicesFor('Meeting')).toBeNull();
  });

  it('answers each key typed from the notes it was given', async () => {
    const { picking } = picker();
    for (const typed of ['L', 'La', 'Lark', 'Larkspur']) {
      const expected = typed === 'Larkspur' ? 'Projects/Larkspur.md' : null;
      expect(await pathOf(picking, typed)).toBe(expected);
    }
  });

  it('forgets a note once it is gone from the vault, and finds it where it was renamed to', async () => {
    const { picking, over } = picker();
    expect(await pathOf(picking, 'Larkspur')).toBe('Projects/Larkspur.md');

    // Deleted: only the archived namesake is left, so the name now opens that one…
    const withoutIt = VAULT.filter((path) => path !== 'Projects/Larkspur.md');
    expect(await pathOf(over(withoutIt), 'Larkspur')).toBe('Archive/Projects/Larkspur.md');
    // …and with that gone too, nothing.
    const neither = withoutIt.filter((path) => !path.endsWith('/Larkspur.md'));
    expect(await pathOf(over(neither), 'Larkspur')).toBeNull();

    // Renamed into another folder, it is found at its new path.
    const moved = createVaultPath('Areas/Larkspur.md');
    expect(await pathOf(over([...neither, moved]), 'Larkspur')).toBe(moved);
  });
});
