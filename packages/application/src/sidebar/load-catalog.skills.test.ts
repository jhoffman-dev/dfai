/**
 * A skill's references are never a view or a dashboard (ADR-0050), even
 * when the index, holding a note from before skills were sectioned, still
 * marks one as such.
 */

import { describe, expect, it } from 'vitest';
import type { MarkdownPort } from '../notes/ports.ts';
import { fakeIndexPort, fakeVaultFs } from '../testing/fake-ports.ts';
import { loadSidebarCatalog } from './load-catalog.ts';

const markdown = { frontmatterProperties: () => ({}) } as unknown as MarkdownPort;

describe('the sidebar’s marks from the index, with a skill there', () => {
  it('lists a marked note as a view, but nothing in a skill’s folder', async () => {
    const index = fakeIndexPort({
      query: async () => ({
        columns: ['path', 'key', 'value', 'title'],
        rows: [
          ['Boards/Open.md', 'atlas', 'view', 'Open'],
          ['.atlas/skills/boards/references/Board.md', 'atlas', 'view', 'Board'],
          ['.atlas/Skills/boards/references/Week.md', 'atlas', 'dashboard', 'Week'],
        ],
        truncated: false,
      }),
    });

    const catalog = await loadSidebarCatalog({ fs: fakeVaultFs(), markdown, index });

    expect(catalog.views.map((entry) => entry.path)).toEqual(['Boards/Open.md']);
    expect(catalog.dashboards).toEqual([]);
  });
});
