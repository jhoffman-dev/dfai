/**
 * Adversarial tests for the sidebar's walk of `.atlas` once skills live
 * there (PR #620, ADR-0050). §5 says a skill is not in the sidebar; §6 says
 * nothing reads skills at launch, so no host call is added at start-up. The
 * sidebar's catalogue is read at launch by walking `.atlas` and reading every
 * note it finds, so a skill's folder must be neither read nor listed by it.
 */

import { describe, expect, it, vi } from 'vitest';
import { createVaultPath, type VaultEntry } from '@dfai/domain';
import type { QueryResult } from '../index/ports.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import { fakeIndexPort, fakeVaultFs } from '../testing/fake-ports.ts';
import { loadSidebarCatalog } from './load-catalog.ts';

/** Frontmatter as one JSON object, which is enough to classify a note. */
const markdown = {
  frontmatterProperties: (frontmatter: string | null) =>
    frontmatter === null
      ? {}
      : (JSON.parse(frontmatter.replace(/^---\n|\n---\n?$/g, '')) as object),
} as unknown as MarkdownPort;

const noteWith = (properties: Record<string, unknown>): string =>
  `---\n${JSON.stringify(properties)}\n---\n\nSome text.\n`;

/** A vault whose `.atlas` holds these files, recording every folder listed and note read. */
function atlasVault(files: Record<string, string>) {
  const listed: string[] = [];
  const read: string[] = [];
  const entry = (path: string, kind: VaultEntry['kind']): VaultEntry =>
    ({ kind, name: path.split('/').at(-1) ?? path, path: createVaultPath(path) }) as VaultEntry;
  const fs = fakeVaultFs({
    listDirectory: async (folder) => {
      listed.push(folder);
      const children = new Map<string, VaultEntry>();
      for (const path of Object.keys(files)) {
        if (!path.startsWith(`${folder}/`)) continue;
        const rest = path.slice(folder.length + 1);
        const [head] = rest.split('/');
        const child = `${folder}/${head ?? ''}`;
        children.set(child, entry(child, rest.includes('/') ? 'directory' : 'file'));
      }
      return [...children.values()];
    },
    readNotes: async (paths) =>
      paths.flatMap((path) => {
        read.push(path);
        const text = files[path];
        return text === undefined ? [] : [{ path, text, modified: 1, size: text.length }];
      }),
  });
  return { fs, listed, read };
}

const index = fakeIndexPort({
  query: vi.fn(async (): Promise<QueryResult> => ({
    columns: ['path', 'key', 'value', 'title'],
    rows: [],
    truncated: false,
  })),
});

/** A skill that teaches dashboards, with an example dashboard among its references. */
const FILES = {
  '.atlas/dashboards/Progress.md': noteWith({ atlas: 'dashboard' }),
  '.atlas/skills/dashboards/SKILL.md':
    '---\n{"name":"dashboards","description":"Builds dashboards."}\n---\n\nStep.\n',
  '.atlas/skills/dashboards/references/Example.md': noteWith({ atlas: 'dashboard' }),
  '.atlas/skills/dashboards/references/Board.md': noteWith({ atlas: 'view', type: 'task' }),
};

describe('the sidebar’s walk of .atlas, with a skill there', () => {
  it('lists nothing in a skill’s folder as a view or a dashboard', async () => {
    const { fs } = atlasVault(FILES);

    const catalog = await loadSidebarCatalog({ fs, markdown, index });

    expect(catalog.dashboards.map((entry) => entry.path)).toEqual([
      '.atlas/dashboards/Progress.md',
    ]);
    expect(catalog.views).toEqual([]);
  });

  it('reads no file in a skill’s folder (ADR-0050 §6: no host call added at start-up)', async () => {
    const vault = atlasVault(FILES);

    await loadSidebarCatalog({ fs: vault.fs, markdown, index });

    // The walk does read `.atlas`; it must stop at the skills.
    expect(vault.read).toContain('.atlas/dashboards/Progress.md');
    expect(vault.read.filter((path) => path.startsWith('.atlas/skills'))).toEqual([]);
    expect(vault.listed.filter((path) => path.startsWith('.atlas/skills'))).toEqual([]);
  });
});
