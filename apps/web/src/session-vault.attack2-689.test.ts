/*
 * Second attack on PR #689 (#656): where the web stub's session vault takes
 * what the desktop's host refuses, or refuses what it takes. The GitHub vault
 * (#664) is to be built to this same contract, so each gap here is one it
 * would inherit. The host's behaviour cited is in apps/desktop/src-tauri/src
 * (vault.rs, vault_entries.rs, vault_files.rs, vault_file_list.rs). Each case
 * was `it.fails` until the session vault answered as the host does.
 */
import { describe, expect, it } from 'vitest';
import { createVaultPath, type VaultPath } from '@dfai/domain';
import { sessionVaultFs } from './session-vault.ts';

const vault = '/sample';
const p = createVaultPath;
const WALK = { skipDirectories: [] as string[], maxDepth: 10 };

const seeded = () =>
  sessionVaultFs({
    'Welcome.md': '# Welcome\n',
    'Projects/Larkspur.md': '# Larkspur\n',
    'Projects/Old/Plan.md': '# Plan\n',
  });

describe('the session vault refuses what the host refuses (attack 2, #689)', () => {
  // vault_entries.rs move_entry_at: "a folder cannot be moved into itself".
  it('refuses to move a folder into a folder inside it', async () => {
    const fs = seeded();
    await expect(
      fs.moveEntry({ vault, from: p('Projects'), to: p('Projects/Old/Projects') }),
    ).rejects.toThrow();
  });

  it('leaves the tree as it was when a folder is moved into itself', async () => {
    const fs = seeded();
    await fs
      .moveEntry({ vault, from: p('Projects'), to: p('Projects/Old/Projects') })
      .catch(() => undefined);
    const listed = (await fs.listNotes(WALK)).map((note) => note.path).sort();
    expect(listed).toEqual(['Projects/Larkspur.md', 'Projects/Old/Plan.md', 'Welcome.md']);
  });

  // vault.rs resolve_new: "that folder does not exist".
  it('refuses to create a note in a folder that is not there', async () => {
    const fs = seeded();
    await expect(
      fs.createNote({ vault, path: p('Missing/Note.md'), contents: 'x' }),
    ).rejects.toThrow();
  });

  // vault.rs write_text resolves the file, which must exist: a save never recreates a deleted note.
  it('refuses a save to a note that is no longer there', async () => {
    const fs = seeded();
    const { modified } = await fs.readTextFile(p('Welcome.md'));
    await fs.trashEntry({ vault, path: p('Welcome.md') });
    await expect(
      fs.writeTextFile({ vault, path: p('Welcome.md'), contents: 'back', expectedModified: null }),
    ).rejects.toThrow();
    expect(modified).toBeGreaterThan(0);
  });

  // vault.rs write_text: "that is a directory".
  it('refuses a save whose path is a folder', async () => {
    const fs = seeded();
    await expect(
      fs.writeTextFile({ vault, path: p('Projects'), contents: 'x', expectedModified: null }),
    ).rejects.toThrow();
  });

  // vault_files.rs write_binary_file: "a file is replaced whole, from offset 0".
  it('refuses a replace sent at an offset past 0', async () => {
    const fs = seeded();
    await fs.writeBinaryFile({ vault, path: p('t.png'), bytes: new Uint8Array([1, 2]), offset: 0 });
    await expect(
      fs.writeBinaryFile({
        vault,
        path: p('t.png'),
        bytes: new Uint8Array([9]),
        offset: 2,
        replace: true,
      }),
    ).rejects.toThrow();
  });

  // vault_files.rs replace_binary_at: replacing_refuses_a_folder_the_ceiling_and_a_way_out.
  it('refuses to replace a folder with a file', async () => {
    const fs = seeded();
    await expect(
      fs.writeBinaryFile({
        vault,
        path: p('Projects'),
        bytes: new Uint8Array([1]),
        offset: 0,
        replace: true,
      }),
    ).rejects.toThrow();
  });

  // vault_files.rs write_binary_at at offset 0 resolves the parent: it must exist.
  it('refuses bytes written into a folder that is not there', async () => {
    const fs = seeded();
    await expect(
      fs.writeBinaryFile({ vault, path: p('Nope/a.bin'), bytes: new Uint8Array([1]), offset: 0 }),
    ).rejects.toThrow();
  });

  // vault.rs refuse_git_folder: no read or write reaches `.git`, whatever its case.
  it('refuses to write into git’s own folder', async () => {
    const fs = seeded();
    await fs.createFolder({ vault, path: p('.git') }).catch(() => undefined);
    await expect(
      fs.createNote({ vault, path: p('.GIT/config.md'), contents: 'x' }),
    ).rejects.toThrow();
  });

  // vault.rs resolve: a `..` segment is refused by the host whatever the type said.
  it('refuses a path with a .. segment that skipped createVaultPath', async () => {
    const fs = seeded();
    await expect(
      fs.createNote({ vault, path: '../escaped.md' as VaultPath, contents: 'x' }),
    ).rejects.toThrow();
  });

  // ports.ts HostVaultFsPort: "every write names the vault it is meant for and is refused once that is not the open one (R14-01)".
  it('refuses a write meant for another vault', async () => {
    const fs = seeded();
    await expect(
      fs.createNote({ vault: '/another', path: p('Stray.md'), contents: 'x' }),
    ).rejects.toThrow();
  });
});

describe('the session vault takes what the host takes (attack 2, #689)', () => {
  // vault_entries.rs move_entry_at: `if source == target { return Ok(()) }`.
  it('takes a move of an entry onto its own path as nothing to do', async () => {
    const fs = seeded();
    await expect(
      fs.moveEntry({ vault, from: p('Welcome.md'), to: p('Welcome.md') }),
    ).resolves.toBeUndefined();
  });

  // vault.rs read_text reads bytes and refuses only what is not UTF-8.
  it('reads a note as text when it arrived as bytes', async () => {
    const fs = seeded();
    const bytes = new TextEncoder().encode('# Imported\n');
    await fs.writeBinaryFile({ vault, path: p('Imported.md'), bytes, offset: 0 });
    expect((await fs.readTextFile(p('Imported.md'))).text).toBe('# Imported\n');
  });

  it('hands the index a note that arrived as bytes, as the host reads it', async () => {
    const fs = seeded();
    const bytes = new TextEncoder().encode('# Imported\n');
    await fs.writeBinaryFile({ vault, path: p('Imported.md'), bytes, offset: 0 });
    const listed = (await fs.listNotes(WALK)).map((note) => note.path);
    const read = (await fs.readNotes(listed)).map((note) => note.path);
    expect(read).toEqual(listed);
  });

  // vault.rs NoteWalk: skip is "matched on the entry's own name at any level", never a path.
  it('walks into a folder a skip entry names by its path, as the host does', async () => {
    const fs = seeded();
    const listed = await fs.listNotes({ skipDirectories: ['Projects/Old'], maxDepth: 10 });
    expect(listed.map((note) => note.path)).toContain('Projects/Old/Plan.md');
  });
});
