import { describe, expect, it } from 'vitest';
import {
  HIDDEN_DIRECTORY_NAMES,
  isAtlasNote,
  isTemplateNote,
  templateEditRefusal,
  isVisibleEntry,
} from './vault-visibility.ts';
import { createVaultPath } from './vault-path.ts';
import type { VaultEntry } from './vault-entry.ts';

const named = (name: string, kind: VaultEntry['kind'] = 'directory'): VaultEntry =>
  ({ kind, name, path: createVaultPath(name) }) as VaultEntry;

/** An entry somewhere inside the vault rather than at its root. */
const at = (path: string, kind: VaultEntry['kind'] = 'directory'): VaultEntry =>
  ({ kind, name: path.split('/').at(-1) ?? path, path: createVaultPath(path) }) as VaultEntry;

describe('isVisibleEntry', () => {
  it.each(['Notes', 'today.md', 'Daily Notes', 'archive.2025'])('shows %j', (name) => {
    expect(isVisibleEntry(named(name))).toBe(true);
  });

  it.each(['.git', '.obsidian', '.trash', 'node_modules', '.atlas-cache', '.DS_Store'])(
    'hides %j',
    (name) => {
      expect(isVisibleEntry(named(name))).toBe(false);
    },
  );

  it.each(['Node_Modules', 'NODE_MODULES', 'Notes/Node_Modules/Plan.md'])(
    'hides %j, which a disk that ignores case files in a folder the walk prunes (A20-06)',
    (path) => {
      expect(isVisibleEntry(at(path))).toBe(false);
    },
  );

  it('hides other dotfiles', () => {
    expect(isVisibleEntry(named('.env', 'file'))).toBe(false);
  });

  it('shows .atlas, because it holds notes you are meant to open', () => {
    expect(isVisibleEntry(named('.atlas'))).toBe(true);
  });

  it.each([
    '.atlas/views',
    '.atlas/dashboards',
    '.atlas/templates',
    '.atlas/templates/Daily.md',
    '.atlas/templates/work/Task.md',
    '.atlas/skills',
    '.atlas/skills/weekly-review',
    '.atlas/skills/weekly-review/SKILL.md',
    '.atlas/skills/weekly-review/examples/sample.md',
    '.atlas/Skills/weekly-review/SKILL.md',
  ])('hides %j, which a place of its own already lists', (path) => {
    expect(isVisibleEntry(at(path))).toBe(false);
  });

  it.each([
    '.atlas/types',
    '.atlas/sources',
    '.atlas/types/task.md',
    '.atlas/templates-old/Daily.md',
    '.atlas/skills-old/SKILL.md',
    '.atlas/sources/Milestones.md',
    '.atlas/settings.md',
  ])('shows %j, which no other section lists', (path) => {
    expect(isVisibleEntry(at(path, path.endsWith('.md') ? 'file' : 'directory'))).toBe(true);
  });

  it('shows a new .atlas subfolder rather than hiding it by default', () => {
    // Failing toward reachable: a note you can reach and did not expect beats a
    // note you cannot reach at all.
    expect(isVisibleEntry(at('.atlas/whatever-comes-next'))).toBe(true);
  });

  it('does not hide a folder elsewhere that happens to be called views', () => {
    expect(isVisibleEntry(at('projects/views'))).toBe(true);
  });

  it('still hides a dotfile inside a visible folder', () => {
    expect(isVisibleEntry(at('projects/.env', 'file'))).toBe(false);
  });
});

/**
 * Adversarial pass: `listVaultNotes`
 * (packages/application/src/vault/read-vault.ts:23) asks this about every note
 * in the vault as a flat list, where nothing has already ruled out the folder
 * the note sits in.
 */
describe('isVisibleEntry, asked about a note rather than the folder holding it', () => {
  it.each(['.trash/deleted.md', '.git/COMMIT_EDITMSG', '.obsidian/workspace.md'])(
    'keeps %j out of user space, as it keeps the folder out',
    (path) => {
      expect(isVisibleEntry(at(path, 'file'))).toBe(false);
    },
  );

  it.each(['.atlas/views/Board.md', '.atlas/dashboards/Home.md'])(
    'leaves %j to the section that already lists it',
    (path) => {
      expect(isVisibleEntry(at(path, 'file'))).toBe(false);
    },
  );
});

/**
 * `HIDDEN_DIRECTORY_NAMES` is handed to the host so it can stop walking at those
 * folders (ADR-0014). That is only sound while every name in it is hidden by
 * this rule wherever it appears — otherwise the host would be dropping notes
 * this rule would have kept, which is the host deciding again.
 */
describe('HIDDEN_DIRECTORY_NAMES, the list the host is told not to descend into', () => {
  it.each([...HIDDEN_DIRECTORY_NAMES])('hides %j at the root', (name) => {
    expect(isVisibleEntry(at(name))).toBe(false);
  });

  it.each([...HIDDEN_DIRECTORY_NAMES])('hides a note under %j at any depth', (name) => {
    expect(isVisibleEntry(at(`${name}/note.md`, 'file'))).toBe(false);
    expect(isVisibleEntry(at(`Projects/${name}/note.md`, 'file'))).toBe(false);
    expect(isVisibleEntry(at(`.atlas/${name}/note.md`, 'file'))).toBe(false);
  });

  it('does not list .atlas, whose visibility depends on where a note sits', () => {
    // Pruning .atlas in the host is exactly what this card undid; listing it
    // here would quietly put it back.
    expect(HIDDEN_DIRECTORY_NAMES).not.toContain('.atlas');
  });
});

describe('isAtlasNote', () => {
  it('is true for anything under the vault’s own .atlas folder', () => {
    expect(isAtlasNote('.atlas/templates/Task.md')).toBe(true);
    expect(isAtlasNote('.atlas/views/Board.md')).toBe(true);
  });

  it('is false for the vault’s notes, a lookalike folder and a nested .atlas', () => {
    expect(isAtlasNote('tasks/P16-04.md')).toBe(false);
    expect(isAtlasNote('.atlas-notes/Mine.md')).toBe(false);
    expect(isAtlasNote('Projects/.atlas/Note.md')).toBe(false);
  });
});

describe('isTemplateNote', () => {
  it('is true for a note in the vault’s templates folder, however deep', () => {
    expect(isTemplateNote('.atlas/templates/Dashboard.md')).toBe(true);
    expect(isTemplateNote('.atlas/templates/work/Task.md')).toBe(true);
  });

  it('is false for the rest of .atlas, a lookalike folder and a nested one', () => {
    expect(isTemplateNote('.atlas/dashboards/Progress.md')).toBe(false);
    expect(isTemplateNote('.atlas/templates-old/Task.md')).toBe(false);
    expect(isTemplateNote('Projects/.atlas/templates/Task.md')).toBe(false);
  });
});

describe('templateEditRefusal (issue #15)', () => {
  it('refuses a note flow that would change a template', () => {
    expect(templateEditRefusal('.atlas/templates/Company.md')).toMatch(/Templates page/);
  });

  it('has nothing to say about any other note', () => {
    expect(templateEditRefusal('Larkspur Payroll.md')).toBeNull();
    expect(templateEditRefusal('.atlas/types/company.md')).toBeNull();
  });
});
