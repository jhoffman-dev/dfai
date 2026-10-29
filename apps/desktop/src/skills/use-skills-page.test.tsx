// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createVaultPath, parentVaultPath, vaultPathName, type VaultEntry } from '@dfai/domain';
import { fakeVaultFs, VaultAccessError } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { readAgain, vaultReadKey } from '../reads/query-client.ts';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import { useSkillsPage, type SkillOverlay } from './use-skills-page.ts';

const VAULT = '/vaults/larkspur';
const WEEKLY = [
  '---',
  'name: weekly-review',
  'description: Reviews the week.',
  '---',
  '',
  'Read the week’s notes.',
  '',
].join('\n');

/**
 * The vault's files in memory, refusing as the host does: a missing file or
 * folder is a `VaultAccessError`, a create never overwrites, and a write is
 * refused when the file changed since it was read.
 */
function memoryVault(files: Record<string, string>) {
  let clock = 10;
  const notes = new Map(Object.entries(files).map(([path, text]) => [path, { text, modified: 1 }]));
  const dirs = new Set<string>();
  const trashed: string[] = [];
  /** What the host is told to refuse, or to hold until let go, to test what the page does meanwhile. */
  const controls = {
    refuseTrash: false,
    refuseListing: null as string | null,
    hold: null as Promise<void> | null,
  };
  const folders = () => {
    const found = new Set(dirs);
    for (const path of [...notes.keys(), ...dirs]) {
      for (let at = parentVaultPath(createVaultPath(path)) as string; at !== '';) {
        found.add(at);
        at = parentVaultPath(createVaultPath(at));
      }
    }
    return found;
  };
  const entry = (kind: VaultEntry['kind'], path: string) =>
    ({
      kind,
      name: vaultPathName(createVaultPath(path)),
      path: createVaultPath(path),
    }) as VaultEntry;
  const fs = fakeVaultFs({
    listDirectory: async (folder) => {
      if (folder === controls.refuseListing) throw new Error('the host went away');
      if (folder !== '' && !folders().has(folder)) throw new VaultAccessError('no such folder');
      const under = (path: string) => parentVaultPath(createVaultPath(path)) === folder;
      return [
        ...[...folders()].filter(under).map((path) => entry('directory', path)),
        ...[...notes.keys()].filter(under).map((path) => entry('file', path)),
      ];
    },
    readTextFile: async (path) => {
      const note = notes.get(path);
      if (note === undefined) throw new VaultAccessError('no such file');
      return note;
    },
    createFolder: async ({ path }) => {
      dirs.add(path);
    },
    createNote: async ({ path, contents }) => {
      if (notes.has(path)) throw new VaultAccessError('already there');
      clock += 1;
      notes.set(path, { text: contents, modified: clock });
      return clock;
    },
    writeTextFile: async ({ path, contents, expectedModified }) => {
      await controls.hold;
      if (notes.get(path)?.modified !== expectedModified) throw new Error('changed');
      clock += 1;
      notes.set(path, { text: contents, modified: clock });
      return clock;
    },
    trashEntry: async ({ path }) => {
      if (controls.refuseTrash) throw new Error('the Trash is not allowed');
      trashed.push(path);
      for (const key of [...notes.keys()]) if (key.startsWith(`${path}/`)) notes.delete(key);
      for (const key of [...dirs]) if (key === path || key.startsWith(`${path}/`)) dirs.delete(key);
    },
  });
  /** Another program's write: the file changes under the page. */
  const writeOnDisk = (path: string, text: string) => {
    clock += 1;
    notes.set(path, { text, modified: clock });
  };
  /** Holds every write until the answer is let go. */
  const holdWrites = () => {
    let release = () => {};
    controls.hold = new Promise((done) => {
      release = done;
    });
    return () => {
      controls.hold = null;
      release();
    };
  };
  const deleteOnDisk = (path: string) => {
    notes.delete(path);
    dirs.delete(parentVaultPath(createVaultPath(path)));
  };
  return { fs, notes, trashed, writeOnDisk, deleteOnDisk, holdWrites, controls };
}

function renderPage(files: Record<string, string> = {}) {
  const vault = memoryVault(files);
  const { client, wrapper } = queryWrapper();
  const shown = { show: vi.fn(), hide: vi.fn() };
  const onOpenNote = vi.fn();
  /** The window's overlay store, as one overlay at a time; `dropOverlay` is the window closing it. */
  let dropOverlay = () => {};
  const view = renderHook(
    () => {
      const [up, setUp] = useState<SkillOverlay | null>(null);
      dropOverlay = () => setUp(null);
      return useSkillsPage({
        ports: {
          fs: vault.fs,
          markdown: remarkMarkdown,
          overlay: {
            show: (which) => {
              shown.show(which);
              setUp(which);
            },
            hide: (which) => {
              shown.hide(which);
              setUp((was) => (was === which ? null : was));
            },
          },
        },
        overlayUp: up,
        vault: VAULT,
        onOpenNote,
      });
    },
    { wrapper },
  );
  const overlay = shown;
  /** What the window does when its watcher sees a change under `.atlas/skills`. */
  const changedOnDisk = () => act(() => readAgain(client, vaultReadKey(VAULT, 'skills')));
  return {
    ...view,
    ...vault,
    overlay,
    onOpenNote,
    changedOnDisk,
    dropOverlay: () => act(dropOverlay),
  };
}

const SKILL_PATH = '.atlas/skills/weekly-review/SKILL.md';

async function openWeekly(page: ReturnType<typeof renderPage>) {
  await waitFor(() =>
    expect(page.result.current.skills.items?.map(({ name }) => name)).toContain('weekly-review'),
  );
  act(() => page.result.current.onSelect('weekly-review'));
  await waitFor(() => expect(page.result.current.editor).not.toBeNull());
}

describe('useSkillsPage', () => {
  it('lists the skills with the domain’s problems, and the prompt notes', async () => {
    const page = renderPage({
      [SKILL_PATH]: WEEKLY,
      '.atlas/skills/Bad/SKILL.md': '---\nname: Bad\n---\n',
      '.atlas/prompts/morning-brief.md': 'Brief me.\n',
    });
    await waitFor(() => expect(page.result.current.skills.items).toHaveLength(2));
    const [bad, weekly] = page.result.current.skills.items ?? [];
    expect(weekly).toEqual({
      name: 'weekly-review',
      description: 'Reviews the week.',
      problems: [],
    });
    expect(bad?.problems.length).toBeGreaterThan(0);
    expect(bad?.problems.some((problem) => problem.startsWith('Its folder:'))).toBe(true);
    await waitFor(() =>
      expect(page.result.current.prompts.items).toEqual([
        { name: 'morning-brief', path: '.atlas/prompts/morning-brief.md' },
      ]),
    );
    act(() => page.result.current.onOpenPrompt('.atlas/prompts/morning-brief.md'));
    expect(page.onOpenNote).toHaveBeenCalledWith('.atlas/prompts/morning-brief.md');
  });

  it('opens a skill into the editor, with the domain’s count and no problems', async () => {
    const page = renderPage({ [SKILL_PATH]: WEEKLY });
    await openWeekly(page);
    const editor = page.result.current.editor;
    expect(editor?.mode).toBe('edit');
    expect(editor?.draft).toEqual({
      name: 'weekly-review',
      description: 'Reviews the week.',
      instructions: 'Read the week’s notes.\n',
    });
    expect(editor?.descriptionLength).toBe(17);
    expect(editor?.descriptionLimit).toBe(1024);
    expect(editor?.problems).toEqual([]);
    act(() => page.result.current.onChange({ description: 'Week 🌿' }));
    expect(page.result.current.editor?.descriptionLength).toBe(6);
  });

  it('saves only what changed, byte for byte elsewhere', async () => {
    const page = renderPage({ [SKILL_PATH]: WEEKLY });
    await openWeekly(page);
    act(() => page.result.current.onChange({ description: 'Reviews the week with Mara.' }));
    await act(async () => page.result.current.onSave());
    await waitFor(() => expect(page.notes.get(SKILL_PATH)?.text).toContain('with Mara'));
    expect(page.notes.get(SKILL_PATH)?.text).toBe(
      WEEKLY.replace('Reviews the week.', 'Reviews the week with Mara.'),
    );
    expect(page.result.current.notice).toBeNull();
    expect(page.result.current.editor?.changedOnDisk).toBe(false);
  });

  it('says the draft’s problems, in the domain’s words', async () => {
    const page = renderPage({ [SKILL_PATH]: WEEKLY });
    await openWeekly(page);
    act(() => page.result.current.onChange({ description: '<b>bold</b>' }));
    expect(page.result.current.editor?.problems).toEqual([
      { field: 'description', message: 'A skill’s description cannot hold XML tags.' },
    ]);
  });

  it('creates a new skill, then holds it as one to edit', async () => {
    const page = renderPage();
    await waitFor(() => expect(page.result.current.skills.items).toEqual([]));
    act(() => page.result.current.onNew());
    expect(page.result.current.editor?.mode).toBe('new');
    expect(page.result.current.editor?.problems.map(({ field }) => field)).toEqual([
      'name',
      'description',
      'instructions',
    ]);
    act(() =>
      page.result.current.onChange({
        name: 'meeting-notes',
        description: 'Tidies a meeting’s notes.',
        instructions: 'Tidy them.',
      }),
    );
    await act(async () => page.result.current.onSave());
    await waitFor(() => expect(page.result.current.editor?.mode).toBe('edit'));
    expect(page.result.current.selected).toBe('meeting-notes');
    expect(page.notes.get('.atlas/skills/meeting-notes/SKILL.md')?.text).toContain(
      'description: Tidies a meeting’s notes.',
    );
    await waitFor(() =>
      expect(page.result.current.skills.items?.map(({ name }) => name)).toEqual(['meeting-notes']),
    );
  });

  it('says why a create was refused, and keeps what was typed', async () => {
    const page = renderPage({ [SKILL_PATH]: WEEKLY });
    await waitFor(() => expect(page.result.current.skills.items).toHaveLength(1));
    act(() => page.result.current.onNew());
    act(() =>
      page.result.current.onChange({
        name: 'weekly-review',
        description: 'Again.',
        instructions: 'Again.',
      }),
    );
    await act(async () => page.result.current.onSave());
    await waitFor(() =>
      expect(page.result.current.notice).toBe(
        'The skill could not be saved: There is already a skill called “weekly-review”.',
      ),
    );
    expect(page.result.current.editor?.draft.description).toBe('Again.');
    expect(page.notes.get(SKILL_PATH)?.text).toBe(WEEKLY);
  });

  it('takes in a change on disk while nothing is typed over it', async () => {
    const page = renderPage({ [SKILL_PATH]: WEEKLY });
    await openWeekly(page);
    page.writeOnDisk(SKILL_PATH, WEEKLY.replace('Reviews the week.', 'Reviews it.'));
    await page.changedOnDisk();
    await waitFor(() => expect(page.result.current.editor?.draft.description).toBe('Reviews it.'));
    expect(page.result.current.editor?.changedOnDisk).toBe(false);
  });

  it('offers Reload for a change on disk under typing, and Reload takes it in', async () => {
    const page = renderPage({ [SKILL_PATH]: WEEKLY });
    await openWeekly(page);
    act(() => page.result.current.onChange({ instructions: 'Typed here.' }));
    page.writeOnDisk(SKILL_PATH, WEEKLY.replace('Reviews the week.', 'Reviews it.'));
    await page.changedOnDisk();
    await waitFor(() => expect(page.result.current.editor?.changedOnDisk).toBe(true));
    expect(page.result.current.editor?.draft.instructions).toBe('Typed here.');

    act(() => page.result.current.onReload());
    await waitFor(() => expect(page.result.current.editor?.changedOnDisk).toBe(false));
    expect(page.result.current.editor?.draft).toEqual({
      name: 'weekly-review',
      description: 'Reviews it.',
      instructions: 'Read the week’s notes.\n',
    });
  });

  it('refuses a save over a file changed on disk, and offers Reload', async () => {
    const page = renderPage({ [SKILL_PATH]: WEEKLY });
    await openWeekly(page);
    act(() => page.result.current.onChange({ instructions: 'Mine.' }));
    const theirs = WEEKLY.replace('Reviews the week.', 'Theirs.');
    page.writeOnDisk(SKILL_PATH, theirs);
    await act(async () => page.result.current.onSave());
    await waitFor(() => expect(page.result.current.editor?.changedOnDisk).toBe(true));
    expect(page.result.current.notice).toBe(
      'The skill was not saved: it changed on disk since it was opened.',
    );
    expect(page.notes.get(SKILL_PATH)?.text).toBe(theirs);
  });

  it('asks before a delete, naming the other files, and trashes the folder on yes', async () => {
    const page = renderPage({
      [SKILL_PATH]: WEEKLY,
      '.atlas/skills/weekly-review/scripts/run.sh': 'echo\n',
    });
    await openWeekly(page);
    act(() => page.result.current.onDelete());
    await waitFor(() => expect(page.result.current.deleteQuestion).not.toBeNull());
    expect(page.overlay.show).toHaveBeenCalledExactlyOnceWith('skill-delete');
    expect(page.result.current.deleteQuestion?.warning).toContain('1 other file: scripts/run.sh');
    expect(page.trashed).toEqual([]);

    act(() => page.result.current.deleteQuestion?.onConfirm());
    await waitFor(() => expect(page.trashed).toEqual(['.atlas/skills/weekly-review']));
    expect(page.overlay.hide).toHaveBeenCalledExactlyOnceWith('skill-delete');
    await waitFor(() => expect(page.result.current.editor).toBeNull());
    await waitFor(() => expect(page.result.current.skills.items).toEqual([]));
  });

  it('trashes nothing when the delete is cancelled', async () => {
    const page = renderPage({ [SKILL_PATH]: WEEKLY });
    await openWeekly(page);
    act(() => page.result.current.onDelete());
    await waitFor(() => expect(page.result.current.deleteQuestion).not.toBeNull());
    act(() => page.result.current.deleteQuestion?.onCancel());
    expect(page.result.current.deleteQuestion).toBeNull();
    expect(page.overlay.hide).toHaveBeenCalledExactlyOnceWith('skill-delete');
    expect(page.trashed).toEqual([]);
    expect(page.result.current.editor).not.toBeNull();
  });

  it('closes the editor, and opens the same skill again when it is chosen twice', async () => {
    const page = renderPage({ [SKILL_PATH]: WEEKLY });
    await openWeekly(page);
    act(() => page.result.current.onSelect('weekly-review'));
    await waitFor(() => expect(page.result.current.editor?.draft.name).toBe('weekly-review'));
    act(() => page.result.current.onClose());
    expect(page.result.current.editor).toBeNull();
    expect(page.result.current.selected).toBeNull();
  });

  describe('unsaved typing (#626 review)', () => {
    const MEETING = WEEKLY.replace(/weekly-review/g, 'meeting-notes');
    const MEETING_PATH = '.atlas/skills/meeting-notes/SKILL.md';

    it('keeps the typing when the skill already open is chosen again', async () => {
      const page = renderPage({ [SKILL_PATH]: WEEKLY });
      await openWeekly(page);
      act(() => page.result.current.onChange({ instructions: 'Typed here.' }));
      act(() => page.result.current.onSelect('weekly-review'));
      expect(page.result.current.discardQuestion).toBeNull();
      expect(page.result.current.editor?.draft.instructions).toBe('Typed here.');
    });

    it('asks before another skill throws the typing away: Keep stays, Discard goes', async () => {
      const page = renderPage({ [SKILL_PATH]: WEEKLY, [MEETING_PATH]: MEETING });
      await waitFor(() => expect(page.result.current.skills.items).toHaveLength(2));
      await openWeekly(page);
      act(() => page.result.current.onChange({ instructions: 'Typed here.' }));

      act(() => page.result.current.onSelect('meeting-notes'));
      expect(page.overlay.show).toHaveBeenCalledWith('skill-discard');
      expect(page.result.current.discardQuestion?.name).toBe('weekly-review');
      expect(page.result.current.selected).toBe('weekly-review');
      act(() => page.result.current.discardQuestion?.onKeep());
      expect(page.result.current.discardQuestion).toBeNull();
      expect(page.result.current.editor?.draft.instructions).toBe('Typed here.');

      act(() => page.result.current.onSelect('meeting-notes'));
      act(() => page.result.current.discardQuestion?.onDiscard());
      expect(page.result.current.selected).toBe('meeting-notes');
      await waitFor(() => expect(page.result.current.editor?.draft.name).toBe('meeting-notes'));
      expect(page.overlay.hide).toHaveBeenCalledWith('skill-discard');
    });

    it('asks before New or Close throws the typing away too', async () => {
      const page = renderPage({ [SKILL_PATH]: WEEKLY });
      await openWeekly(page);
      act(() => page.result.current.onChange({ instructions: 'Typed here.' }));
      act(() => page.result.current.onNew());
      expect(page.result.current.editor?.mode).toBe('edit');
      expect(page.result.current.discardQuestion).not.toBeNull();
      act(() => page.result.current.discardQuestion?.onKeep());
      act(() => page.result.current.onClose());
      expect(page.result.current.editor).not.toBeNull();
      act(() => page.result.current.discardQuestion?.onDiscard());
      expect(page.result.current.editor).toBeNull();
    });

    it('drops a save’s answer when another skill was chosen while it was written', async () => {
      const page = renderPage({ [SKILL_PATH]: WEEKLY, [MEETING_PATH]: MEETING });
      await waitFor(() => expect(page.result.current.skills.items).toHaveLength(2));
      await openWeekly(page);
      act(() => page.result.current.onChange({ description: 'Saved later.' }));
      const release = page.holdWrites();
      act(() => page.result.current.onSave());
      expect(page.result.current.editor?.saving).toBe(true);
      act(() => page.result.current.onSelect('meeting-notes'));
      act(() => page.result.current.discardQuestion?.onDiscard());
      await waitFor(() => expect(page.result.current.editor?.draft.name).toBe('meeting-notes'));

      await act(async () => release());
      await waitFor(() => expect(page.notes.get(SKILL_PATH)?.text).toContain('Saved later.'));
      expect(page.result.current.selected).toBe('meeting-notes');
      expect(page.result.current.editor?.draft.name).toBe('meeting-notes');
    });
  });

  it('draws the delete question only while the window holds its overlay (#626 review)', async () => {
    const page = renderPage({ [SKILL_PATH]: WEEKLY });
    await openWeekly(page);
    act(() => page.result.current.onDelete());
    await waitFor(() => expect(page.result.current.deleteQuestion).not.toBeNull());
    page.dropOverlay();
    expect(page.result.current.deleteQuestion).toBeNull();
  });

  it('draws the discard question only while the window holds its overlay', async () => {
    const page = renderPage({ [SKILL_PATH]: WEEKLY });
    await openWeekly(page);
    act(() => page.result.current.onChange({ instructions: 'Typed here.' }));
    act(() => page.result.current.onNew());
    expect(page.result.current.discardQuestion).not.toBeNull();
    page.dropOverlay();
    expect(page.result.current.discardQuestion).toBeNull();
  });

  it('keeps Save from a skill changed on disk until it is reloaded (#626 review)', async () => {
    const page = renderPage({ [SKILL_PATH]: WEEKLY });
    await openWeekly(page);
    expect(page.result.current.editor?.canSave).toBe(true);
    act(() => page.result.current.onChange({ instructions: 'Typed here.' }));
    page.writeOnDisk(SKILL_PATH, WEEKLY.replace('Reviews the week.', 'Elsewhere.'));
    await page.changedOnDisk();
    await waitFor(() => expect(page.result.current.editor?.changedOnDisk).toBe(true));
    expect(page.result.current.editor?.canSave).toBe(false);
    act(() => page.result.current.onReload());
    await waitFor(() => expect(page.result.current.editor?.canSave).toBe(true));
  });

  it('keeps Save off while the draft has problems or is being saved', async () => {
    const page = renderPage({ [SKILL_PATH]: WEEKLY });
    await openWeekly(page);
    act(() => page.result.current.onChange({ description: '' }));
    expect(page.result.current.editor?.canSave).toBe(false);
    act(() => page.result.current.onChange({ description: 'Back.' }));
    const release = page.holdWrites();
    act(() => page.result.current.onSave());
    expect(page.result.current.editor?.canSave).toBe(false);
    await act(async () => release());
    await waitFor(() => expect(page.result.current.editor?.canSave).toBe(true));
  });

  describe('where focus goes (#626 review)', () => {
    it('says a skill was just made, so its editor can take the focus', async () => {
      const page = renderPage();
      await waitFor(() => expect(page.result.current.skills.items).toEqual([]));
      act(() => page.result.current.onNew());
      expect(page.result.current.editor?.justCreated).toBe(false);
      act(() =>
        page.result.current.onChange({ name: 'notes', description: 'Notes.', instructions: 'Go.' }),
      );
      await act(async () => page.result.current.onSave());
      await waitFor(() => expect(page.result.current.editor?.justCreated).toBe(true));
    });

    it('sends the focus to the next skill after a delete, or to the list when none is left', async () => {
      const page = renderPage({
        '.atlas/skills/alpha/SKILL.md': WEEKLY.replace(/weekly-review/g, 'alpha'),
        [SKILL_PATH]: WEEKLY,
        '.atlas/skills/zeta/SKILL.md': WEEKLY.replace(/weekly-review/g, 'zeta'),
      });
      await waitFor(() => expect(page.result.current.skills.items).toHaveLength(3));
      const remove = async (name: string) => {
        act(() => page.result.current.onSelect(name));
        await waitFor(() => expect(page.result.current.editor?.draft.name).toBe(name));
        act(() => page.result.current.onDelete());
        await waitFor(() => expect(page.result.current.deleteQuestion).not.toBeNull());
        act(() => page.result.current.deleteQuestion?.onConfirm());
        await waitFor(() => expect(page.result.current.editor).toBeNull());
      };
      await remove('weekly-review');
      expect(page.result.current.focusTarget).toEqual({ kind: 'row', name: 'zeta' });
      act(() => page.result.current.onFocused());
      expect(page.result.current.focusTarget).toBeNull();
      await waitFor(() => expect(page.result.current.skills.items).toHaveLength(2));
      await remove('zeta');
      expect(page.result.current.focusTarget).toEqual({ kind: 'row', name: 'alpha' });
      await waitFor(() => expect(page.result.current.skills.items).toHaveLength(1));
      await remove('alpha');
      expect(page.result.current.focusTarget).toEqual({ kind: 'list' });
    });
  });

  describe('a delete that fails (#626 review)', () => {
    it('says so when the folder cannot be walked, and asks nothing', async () => {
      const page = renderPage({ [SKILL_PATH]: WEEKLY });
      await openWeekly(page);
      page.controls.refuseListing = '.atlas/skills/weekly-review';
      act(() => page.result.current.onDelete());
      await waitFor(() =>
        expect(page.result.current.notice).toBe(
          'The skill could not be deleted: the host went away',
        ),
      );
      expect(page.result.current.deleteQuestion).toBeNull();
      expect(page.overlay.show).not.toHaveBeenCalled();
    });

    it('says so when the Trash refuses, and keeps the skill open', async () => {
      const page = renderPage({ [SKILL_PATH]: WEEKLY });
      await openWeekly(page);
      act(() => page.result.current.onDelete());
      await waitFor(() => expect(page.result.current.deleteQuestion).not.toBeNull());
      page.controls.refuseTrash = true;
      act(() => page.result.current.deleteQuestion?.onConfirm());
      await waitFor(() =>
        expect(page.result.current.notice).toBe(
          'The skill could not be deleted: the Trash is not allowed',
        ),
      );
      expect(page.result.current.editor?.draft.name).toBe('weekly-review');
      expect(page.trashed).toEqual([]);
    });
  });

  describe('a skill deleted on disk while it is open', () => {
    it('closes the editor when nothing was typed', async () => {
      const page = renderPage({ [SKILL_PATH]: WEEKLY });
      await openWeekly(page);
      page.deleteOnDisk(SKILL_PATH);
      await page.changedOnDisk();
      await waitFor(() => expect(page.result.current.editor).toBeNull());
    });

    it('keeps the typing and offers Reload, which closes it', async () => {
      const page = renderPage({ [SKILL_PATH]: WEEKLY });
      await openWeekly(page);
      act(() => page.result.current.onChange({ instructions: 'Typed here.' }));
      page.deleteOnDisk(SKILL_PATH);
      await page.changedOnDisk();
      await waitFor(() => expect(page.result.current.editor?.changedOnDisk).toBe(true));
      expect(page.result.current.editor?.draft.instructions).toBe('Typed here.');
      act(() => page.result.current.onReload());
      expect(page.result.current.editor).toBeNull();
      // The editor it was in has gone, and so has the skill's row: the focus goes to the list.
      expect(page.result.current.focusTarget).toEqual({ kind: 'list' });
    });
  });
});
