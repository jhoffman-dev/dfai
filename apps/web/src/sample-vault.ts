import { createVaultPath } from '@dfai/domain';
import {
  fakeHostVaultFs,
  memoryIndexPort,
  memoryVault,
  type VaultLocation,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import type { IndexPorts, NotePorts, OnHost, VaultPorts } from '@dfai/shell';

/**
 * The web stub's vault (#656): a few notes held in memory, on the same
 * in-memory ports the shell's own tests run on, so the shell draws a real
 * vault with no host behind it. The GitHub vault (#664) and the browser's
 * index (#666) take its place.
 */

export const SAMPLE_LOCATION: VaultLocation = { absolutePath: '/sample', name: 'Sample vault' };

export const SAMPLE_NOTES: Readonly<Record<string, string>> = {
  'Welcome.md': '# Welcome\n\nThis is DFAI in a browser, on a vault held in memory.\n',
  'Larkspur garden.md': '# Larkspur garden\n\n- [ ] Ask Mara Quill about the seed order\n',
};

/** Every port the shell reads the vault through, on one copy of the sample notes. */
export function sampleVault(): {
  vault: OnHost<VaultPorts>;
  notes: OnHost<NotePorts>;
  index: OnHost<IndexPorts>;
} {
  const memory = memoryVault({ ...SAMPLE_NOTES });
  const notesNow = () => [...memory.files].filter(([path]) => path.endsWith('.md'));
  const fs = fakeHostVaultFs({
    ...memory.fs,
    listNotes: async () =>
      notesNow().map(([path, text]) => ({
        name: path.split('/').at(-1) ?? path,
        path: createVaultPath(path),
        modified: 1,
        size: text.length,
      })),
    readNotes: async (paths) =>
      paths.flatMap((path) => {
        const text = memory.files.get(path);
        return text === undefined ? [] : [{ path, text, modified: 1, size: text.length }];
      }),
  });
  return {
    vault: {
      fs,
      picker: { pickDirectory: async () => SAMPLE_LOCATION },
      store: { read: async () => SAMPLE_LOCATION, write: async () => {} },
      watch: { start: async () => {}, onChange: async () => () => {} },
    },
    notes: { fs, markdown: remarkMarkdown },
    // On the window's thread: a sample this small needs no worker, and the browser's index brings its own (#666).
    index: { fs, index: memoryIndexPort(), markdown: remarkMarkdown },
  };
}
