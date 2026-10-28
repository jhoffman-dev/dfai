import { describe, expect, it } from 'vitest';
import { createVaultPath, startTrail, stepBack, stepTo, type VaultGraph } from '@dfai/domain';
import { fakeIndexPort, fakeVaultFs } from '../testing/fake-ports.ts';
import { TemplateEditRefusedError } from '../vault/template-guard.ts';
import type { RelatedAnswer, RelatedQuery } from '../embeddings/related-by-meaning.ts';
import { acceptRelatedNote } from './accept-related-note.ts';
import { findRelatedNotes } from './find-related-notes.ts';
import { EmptyTrailError, saveTrail } from './save-trail.ts';

const PROGRESS = { done: 2, total: 3, failure: null };

const manifestOf = (...paths: string[]) =>
  fakeIndexPort({
    manifest: async () =>
      paths.map((path) => ({ path, digest: path, type: null, modified: 1, size: 1 })),
  });

/** Files on a pretend disk, written only against the modification time they were read at. */
function disk(files: Record<string, string>) {
  const held = new Map(Object.entries(files));
  const modified = new Map<string, number>([...held.keys()].map((path) => [path, 1]));
  const writes: { path: string; contents: string; expectedModified: number | null }[] = [];
  const fs = fakeVaultFs({
    readTextFile: async (path) => ({
      text: held.get(path) ?? '',
      modified: modified.get(path) ?? 0,
    }),
    writeTextFile: async ({ path, contents, expectedModified }) => {
      if (expectedModified !== modified.get(path)) throw new Error('changed on disk');
      writes.push({ path, contents, expectedModified });
      held.set(path, contents);
      modified.set(path, (modified.get(path) ?? 0) + 1);
      return modified.get(path) as number;
    },
    createNote: async ({ path, contents }) => {
      if (held.has(path)) throw new Error('taken');
      held.set(path, contents);
      return 1;
    },
  });
  return { fs, held, writes, modified };
}

describe('findRelatedNotes', () => {
  const graph: VaultGraph = {
    nodes: [],
    edges: [
      {
        id: 'a',
        source: createVaultPath('Plan.md'),
        target: createVaultPath('Budget.md'),
        kind: 'link',
        label: null,
      },
      {
        id: 'b',
        source: createVaultPath('Mara Quill.md'),
        target: createVaultPath('Plan.md'),
        kind: 'relation',
        label: 'Owner',
      },
    ],
  };

  function semantic(answer: Partial<RelatedAnswer> = {}, on = true) {
    const asked: RelatedQuery[] = [];
    return {
      asked,
      access: {
        isOn: () => on,
        related: async (query: RelatedQuery): Promise<RelatedAnswer> => {
          asked.push(query);
          return {
            notes: [{ path: 'Garden.md', title: 'Garden', target: 'Garden', score: 0.7 }],
            embedded: true,
            progress: PROGRESS,
            ...answer,
          };
        },
      },
    };
  }

  it('offers the notes by meaning, leaving out every note linked either way and those dismissed', async () => {
    const { asked, access } = semantic();
    const state = await findRelatedNotes({
      semantic: access,
      graph,
      dismissed: new Set(['Bees.md']),
      path: 'Plan.md',
      limit: 5,
    });
    expect(state).toEqual({
      kind: 'ready',
      notes: [{ path: 'Garden.md', title: 'Garden', target: 'Garden', score: 0.7 }],
      progress: PROGRESS,
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.path).toBe('Plan.md');
    expect(asked[0]!.limit).toBe(5);
    expect([...asked[0]!.exclude.linked].sort()).toEqual(['Budget.md', 'Mara Quill.md']);
    expect([...asked[0]!.exclude.dismissed]).toEqual(['Bees.md']);
  });

  it('says the note is not built yet while it has no vectors', async () => {
    const { access } = semantic({ notes: [], embedded: false });
    const state = await findRelatedNotes({
      semantic: access,
      graph,
      dismissed: new Set(),
      path: 'New.md',
    });
    expect(state).toEqual({ kind: 'not-built', progress: PROGRESS });
  });

  it('says it is off, without asking, where search by meaning is not on', async () => {
    const { asked, access } = semantic({}, false);
    const state = await findRelatedNotes({
      semantic: access,
      graph,
      dismissed: new Set(),
      path: 'Plan.md',
    });
    expect(state).toEqual({ kind: 'off' });
    expect(asked).toHaveLength(0);
  });

  it('says it is unavailable where the app offers no search by meaning', async () => {
    const state = await findRelatedNotes({
      semantic: null,
      graph,
      dismissed: new Set(),
      path: 'Plan.md',
    });
    expect(state).toEqual({ kind: 'unavailable' });
  });
});

describe('acceptRelatedNote', () => {
  const index = manifestOf('Plan.md', 'Home/Garden.md', 'Bees.md', 'Old/Bees.md');

  it('writes a real link under a Related section, keeping every byte before it', async () => {
    const before = '---\ntype: plan\n---\nPay day moves to Friday.\n';
    const { fs, held, writes } = disk({ 'Plan.md': before });
    const wrote = await acceptRelatedNote({
      fs,
      index,
      note: createVaultPath('Plan.md'),
      target: createVaultPath('Home/Garden.md'),
    });
    expect(wrote).toBe(true);
    expect(held.get('Plan.md')).toBe(`${before}\n## Related\n\n- [[Garden]]\n`);
    expect(writes[0]!.expectedModified).toBe(1);
  });

  it('names a note by its path when another of the same name would open instead', async () => {
    const { fs, held } = disk({ 'Plan.md': 'Plan\n' });
    await acceptRelatedNote({
      fs,
      index,
      note: createVaultPath('Plan.md'),
      target: createVaultPath('Old/Bees.md'),
    });
    expect(held.get('Plan.md')).toContain('- [[Old/Bees]]');
  });

  it('starts the section on a line of its own after frontmatter closed on the last byte', async () => {
    const { fs, held } = disk({ 'Plan.md': '---\ntype: plan\n---' });
    await acceptRelatedNote({
      fs,
      index,
      note: createVaultPath('Plan.md'),
      target: createVaultPath('Home/Garden.md'),
    });
    expect(held.get('Plan.md')).toBe('---\ntype: plan\n---\n## Related\n\n- [[Garden]]\n');
  });

  it('writes nothing when the section already links it', async () => {
    const { fs, writes } = disk({ 'Plan.md': '## Related\n\n- [[Garden]]\n' });
    const wrote = await acceptRelatedNote({
      fs,
      index,
      note: createVaultPath('Plan.md'),
      target: createVaultPath('Home/Garden.md'),
    });
    expect(wrote).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it('refuses to write into a template', async () => {
    const { fs, writes } = disk({ '.atlas/templates/Plan.md': 'Plan\n' });
    await expect(
      acceptRelatedNote({
        fs,
        index,
        note: createVaultPath('.atlas/templates/Plan.md'),
        target: createVaultPath('Home/Garden.md'),
      }),
    ).rejects.toThrow(TemplateEditRefusedError);
    expect(writes).toHaveLength(0);
  });

  it('fails rather than overwrite an edit made since the file was read', async () => {
    const { fs, modified } = disk({ 'Plan.md': 'Plan\n' });
    const racing = {
      ...fs,
      readTextFile: async (path: ReturnType<typeof createVaultPath>) => {
        const read = await fs.readTextFile(path);
        modified.set(path, 9);
        return read;
      },
    };
    await expect(
      acceptRelatedNote({
        fs: racing,
        index,
        note: createVaultPath('Plan.md'),
        target: createVaultPath('Home/Garden.md'),
      }),
    ).rejects.toThrow('changed on disk');
  });
});

describe('saveTrail', () => {
  const index = manifestOf('Ideas/Payroll.md', 'Ideas/Budget.md', 'Mara Quill.md', 'Budget.md');

  it('saves every step walked as a numbered list of links, beside the first note', async () => {
    const { fs, held } = disk({});
    const walked = ['Ideas/Budget.md', 'Mara Quill.md'].reduce(
      stepTo,
      startTrail('Ideas/Payroll.md'),
    );
    // Stepped back: the steps ahead are still part of the path saved.
    const path = await saveTrail({ fs, index, trail: stepBack(walked) });
    expect(path).toBe('Ideas/Trail from Payroll.md');
    expect(held.get(path)).toBe('1. [[Payroll]]\n2. [[Ideas/Budget]]\n3. [[Mara Quill]]\n');
  });

  it('numbers the name when a trail from the note is already saved', async () => {
    const { fs } = disk({ 'Ideas/Trail from Payroll.md': '1. [[Payroll]]\n' });
    const taken = manifestOf('Ideas/Payroll.md', 'Ideas/Trail from Payroll.md');
    const path = await saveTrail({ fs, index: taken, trail: startTrail('Ideas/Payroll.md') });
    expect(path).toBe('Ideas/Trail from Payroll 2.md');
  });

  it('refuses a trail of no steps', async () => {
    const { fs } = disk({});
    await expect(saveTrail({ fs, index, trail: { steps: [], at: 0 } })).rejects.toThrow(
      EmptyTrailError,
    );
  });
});
