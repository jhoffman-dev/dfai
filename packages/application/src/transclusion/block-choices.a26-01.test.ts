import { describe, expect, it } from 'vitest';
import { createVaultPath, type EditorDocument } from '@dfai/domain';
import { fakeIndexPort, fakeMarkdown, fakeVaultFs } from '../testing/fake-ports.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import { createBlockChoicesReader } from './link-block.ts';

/*
 * A26-01: the `#` picker asks for a note's blocks on every key typed after
 * it. The note is read and parsed once for each version of its file — the
 * index says which version it is — not once a keystroke.
 */

const plans = createVaultPath('Plans.md');

function reader(files: Record<string, string>) {
  let modified = 1;
  let reads = 0;
  let parses = 0;
  const markdown: MarkdownPort = {
    ...fakeMarkdown(),
    parseBody: (body) => {
      parses += 1;
      const doc: EditorDocument = {
        type: 'doc',
        content: body
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] })),
      };
      return { blocks: [], doc };
    },
  };
  const fs = fakeVaultFs({
    readTextFile: async (path) => {
      reads += 1;
      return { text: files[path] ?? '', modified };
    },
  });
  const index = fakeIndexPort({
    manifest: async () => [{ path: plans, modified, size: 1, digest: '', type: null }],
  });
  return {
    choices: createBlockChoicesReader({ fs, markdown, index }),
    counts: () => ({ reads, parses }),
    save: (path: string, text: string) => {
      files[path] = text;
      modified += 1;
    },
  };
}

describe('createBlockChoicesReader', () => {
  it('reads a note once for as long as its file is the same version', async () => {
    const vault = reader({ [plans]: 'Pack the tent\nBook the train\n' });
    for (let key = 0; key < 5; key += 1) {
      const entries = await vault.choices.read(plans);
      expect(entries?.map((entry) => entry.text)).toEqual(['Pack the tent', 'Book the train']);
    }
    expect(vault.counts()).toEqual({ reads: 1, parses: 1 });
  });

  it('reads it again once the index says its file changed', async () => {
    const vault = reader({ [plans]: 'Pack the tent\n' });
    await vault.choices.read(plans);
    vault.save(plans, 'Pack the big tent\n');
    const entries = await vault.choices.read(plans);
    expect(entries?.map((entry) => entry.text)).toEqual(['Pack the big tent']);
    expect(vault.counts()).toEqual({ reads: 2, parses: 2 });
  });

  it('reads a note the index does not know every time, as the index only spares reads', async () => {
    const vault = reader({ [plans]: 'Pack\n', 'Other.md': 'Other\n' });
    const other = createVaultPath('Other.md');
    await vault.choices.read(other);
    await vault.choices.read(other);
    expect(vault.counts().reads).toBe(2);
  });
});

describe('createBlockChoicesReader — a note that is not there (#225, PR #612)', () => {
  const failing = (listed: readonly string[]) =>
    createBlockChoicesReader({
      fs: fakeVaultFs({
        readTextFile: async () => {
          throw new Error('the disk stopped answering');
        },
        readNotes: async (paths) =>
          paths
            .filter((path) => listed.includes(path))
            .map((path) => ({ path: createVaultPath(path), text: '', modified: 1, size: 0 })),
      }),
      markdown: fakeMarkdown(),
      index: fakeIndexPort({ manifest: async () => [] }),
    });

  it('answers null for a note deleted before the tree caught up', async () => {
    await expect(failing([]).read(plans)).resolves.toBeNull();
  });

  it('passes on a failure to read a note that is there', async () => {
    await expect(failing([plans]).read(plans)).rejects.toThrow('the disk stopped answering');
  });
});
