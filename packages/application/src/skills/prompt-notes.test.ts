import { describe, expect, it } from 'vitest';
import { createVaultPath, type VaultEntry } from '@dfai/domain';
import { fakeVaultFs } from '../testing/fake-ports.ts';
import { VaultAccessError } from '../vault/ports.ts';
import { listPromptNotes } from './prompt-notes.ts';

const file = (path: string): VaultEntry =>
  ({ kind: 'file', name: path.split('/').pop(), path: createVaultPath(path) }) as VaultEntry;
const folder = (path: string): VaultEntry =>
  ({ kind: 'directory', name: path.split('/').pop(), path: createVaultPath(path) }) as VaultEntry;

/** A host that lists `listings` by folder and refuses any other folder as missing. */
const fsListing = (listings: Readonly<Record<string, readonly VaultEntry[]>>) =>
  fakeVaultFs({
    listDirectory: async (path) => {
      const listed = listings[path];
      if (listed === undefined) throw new VaultAccessError('no such folder');
      return listed;
    },
  });

describe('listPromptNotes', () => {
  it('lists the notes directly in .atlas/prompts by name, leaving out folders and other files', async () => {
    const fs = fsListing({
      '.atlas/prompts': [
        file('.atlas/prompts/morning-brief.md'),
        file('.atlas/prompts/after-a-meeting.md'),
        file('.atlas/prompts/notes.txt'),
        folder('.atlas/prompts/old'),
      ],
    });
    expect(await listPromptNotes(fs)).toEqual([
      { name: 'after-a-meeting', path: '.atlas/prompts/after-a-meeting.md' },
      { name: 'morning-brief', path: '.atlas/prompts/morning-brief.md' },
    ]);
  });

  it('finds none in a vault with no prompts folder, or no .atlas at all', async () => {
    expect(await listPromptNotes(fsListing({ '.atlas': [folder('.atlas/types')] }))).toEqual([]);
    expect(await listPromptNotes(fsListing({}))).toEqual([]);
  });

  it('fails when .atlas lists a prompts folder the host then will not list', async () => {
    const fs = fsListing({ '.atlas': [folder('.atlas/Prompts')] });
    await expect(listPromptNotes(fs)).rejects.toBeInstanceOf(VaultAccessError);
  });

  it('passes on a failure that is not the host refusing a folder', async () => {
    const broken = new Error('the host went away');
    const fs = fakeVaultFs({
      listDirectory: async () => {
        throw broken;
      },
    });
    await expect(listPromptNotes(fs)).rejects.toBe(broken);
  });
});
