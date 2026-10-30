// @vitest-environment jsdom
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createVaultPath, type SidebarTreeRow, type VaultEntry } from '@dfai/domain';
import { VaultTree, type TreeEditing } from './vault-tree.tsx';
import { MovePicker } from './move-picker.tsx';
import { DeleteDialog, type DeletionSubject } from './delete-dialog.tsx';
import type { MenuCommand } from './menu-items.tsx';

/**
 * Pages as something to edit: a row's menu, naming in place, the folder picker
 * and the question before a delete. What each command does is the app's; here
 * the components only have to offer it, run it and get out of the way.
 */

const row = (path: string, kind: 'file' | 'directory', depth = 0): SidebarTreeRow => ({
  entry: { kind, name: path.split('/').at(-1) ?? '', path: createVaultPath(path) } as VaultEntry,
  depth,
  isExpanded: false,
  isLoaded: true,
  label: (path.split('/').at(-1) ?? '').replace(/\.md$/, ''),
  icon: kind === 'directory' ? 'folder' : 'doc',
  opensArchive: false,
});

const ROWS = [row('Projects', 'directory'), row('one.md', 'file')];

/** The tree with editing on, holding its menu's open state as the app does. */
function EditableTree({
  editing,
  onSelectFile = vi.fn(),
}: {
  editing: Partial<TreeEditing>;
  onSelectFile?: (path: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <VaultTree
      rows={ROWS}
      open={new Set()}
      starred={new Set()}
      onToggleDirectory={vi.fn()}
      onSelectFile={onSelectFile}
      onToggleFavorite={vi.fn()}
      editing={{
        menuFor: () => [],
        menuOpen,
        onMenuOpenChange: setMenuOpen,
        renaming: null,
        onRename: vi.fn(),
        onCancelRename: vi.fn(),
        canDrop: () => true,
        onDrop: vi.fn(),
        ...editing,
      }}
    />
  );
}

const commands =
  (onSelect: (label: string) => void): ((entry: VaultEntry) => MenuCommand[]) =>
  (entry) => [
    { label: 'Rename', onSelect: () => onSelect(`Rename ${entry.path}`) },
    { label: 'Move to…', onSelect: () => onSelect(`Move ${entry.path}`), disabled: true },
    { label: 'Delete…', onSelect: () => onSelect(`Delete ${entry.path}`), destructive: true },
  ];

describe('a row in Pages', () => {
  it('offers its menu from its Options button, and runs what is chosen for that row', async () => {
    const chosen = vi.fn();
    render(<EditableTree editing={{ menuFor: commands(chosen) }} />);

    await userEvent.click(screen.getByRole('button', { name: 'Options for one' }));
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Rename', 'Move to…', 'Delete…']);
    // A command the app has ruled out is shown but cannot be chosen.
    expect(within(menu).getByRole('menuitem', { name: 'Move to…' })).toHaveProperty(
      'ariaDisabled',
      'true',
    );
    // Delete sits apart from the rest.
    expect(within(menu).getAllByRole('separator')).toHaveLength(1);

    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Delete…' }));
    expect(chosen).toHaveBeenCalledWith('Delete one.md');
  });

  it('opens its menu on a right-click without opening the note', async () => {
    const chosen = vi.fn();
    const onSelectFile = vi.fn();
    render(<EditableTree editing={{ menuFor: commands(chosen) }} onSelectFile={onSelectFile} />);

    await userEvent.pointer({
      keys: '[MouseRight]',
      target: screen.getByRole('treeitem', { name: 'one' }),
    });
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    expect(chosen).toHaveBeenCalledWith('Rename one.md');
    expect(onSelectFile).not.toHaveBeenCalled();
  });

  it('opens its menu from the keyboard with Shift+F10', async () => {
    const chosen = vi.fn();
    render(<EditableTree editing={{ menuFor: commands(chosen) }} />);

    screen.getByRole('treeitem', { name: 'one' }).focus();
    await userEvent.keyboard('{Shift>}{F10}{/Shift}');
    expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeDefined();
  });

  it('leaves Space to pick a row up, so Enter is what opens it', async () => {
    const onSelectFile = vi.fn();
    render(<EditableTree editing={{}} onSelectFile={onSelectFile} />);
    screen.getByRole('treeitem', { name: 'one' }).focus();

    await userEvent.keyboard('[Space]');
    await userEvent.keyboard('[Escape]');
    expect(onSelectFile).not.toHaveBeenCalled();
    await userEvent.keyboard('[Enter]');
    expect(onSelectFile).toHaveBeenCalledWith('one.md', 'here');
  });
});

describe('naming a row in place', () => {
  it('starts with the name selected, and keeps what is typed on Enter', async () => {
    const onRename = vi.fn();
    render(<EditableTree editing={{ renaming: createVaultPath('Projects'), onRename }} />);

    const field = screen.getByRole('textbox', { name: 'Name for Projects' });
    await waitFor(() => expect(document.activeElement).toBe(field));
    await userEvent.keyboard('Archive{Enter}');
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename.mock.calls[0]?.[0]).toMatchObject({ name: 'Archive' });
  });

  it('keeps the old name on Escape', async () => {
    const onRename = vi.fn();
    const onCancelRename = vi.fn();
    render(
      <EditableTree
        editing={{ renaming: createVaultPath('Projects'), onRename, onCancelRename }}
      />,
    );
    const field = screen.getByRole('textbox', { name: 'Name for Projects' });
    await waitFor(() => expect(document.activeElement).toBe(field));
    await userEvent.keyboard('Something else{Escape}');
    expect(onRename).not.toHaveBeenCalled();
    expect(onCancelRename).toHaveBeenCalledTimes(1);
  });

  it('does not open or pick up the row while it is being typed in', async () => {
    const onSelectFile = vi.fn();
    render(
      <EditableTree
        editing={{ renaming: createVaultPath('one.md') }}
        onSelectFile={onSelectFile}
      />,
    );
    const field = screen.getByRole('textbox', { name: 'Name for one' });
    await userEvent.click(field);
    await userEvent.keyboard('a b');
    expect((field as HTMLInputElement).value).toContain('a b');
    expect(onSelectFile).not.toHaveBeenCalled();
  });
});

describe('MovePicker', () => {
  const destinations = [
    { path: '', name: 'Pages', place: '' },
    { path: 'Projects', name: 'Projects', place: 'Pages' },
    { path: 'Projects/Atlas', name: 'Atlas', place: 'Pages / Projects' },
  ];

  it('lists the folders and moves on Enter to the one selected', async () => {
    const onPick = vi.fn();
    render(
      <MovePicker subject="one" destinations={destinations} onPick={onPick} onClose={vi.fn()} />,
    );
    expect(screen.getByRole('dialog', { name: 'Move one to…' })).toBeDefined();
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Pages↵',
      'ProjectsPages',
      'AtlasPages / Projects',
    ]);

    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Find a folder' })),
    );
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(onPick).toHaveBeenCalledWith('Projects/Atlas');
  });

  it('narrows the list by what is typed, by name or by place', async () => {
    const onPick = vi.fn();
    render(
      <MovePicker subject="one" destinations={destinations} onPick={onPick} onClose={vi.fn()} />,
    );
    await userEvent.type(screen.getByRole('searchbox', { name: 'Find a folder' }), 'atl');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    await userEvent.keyboard('{Enter}');
    expect(onPick).toHaveBeenCalledWith('Projects/Atlas');
  });

  it('says so when there is nowhere else to put it', () => {
    render(<MovePicker subject="one" destinations={[]} onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('There is nowhere else to put it.')).toBeDefined();
  });

  it('closes on Escape without moving anything', async () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(
      <MovePicker subject="one" destinations={destinations} onPick={onPick} onClose={onClose} />,
    );
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
  });
});

describe('DeleteDialog', () => {
  const folder: DeletionSubject = {
    name: 'Old',
    kind: 'folder',
    notes: 3,
    otherFiles: 0,
    unsaved: [],
  };

  it('names what goes, how many notes go with a folder, and that it can come back', () => {
    render(<DeleteDialog subject={folder} onConfirm={vi.fn()} onClose={vi.fn()} />);
    const dialog = screen.getByRole('alertdialog', { name: 'Move “Old” to the Trash?' });
    expect(dialog.textContent).toContain('The 3 notes in it go too.');
    expect(dialog.textContent).toContain('You can get it back from the Trash in Finder.');
  });

  it('puts the focus on Cancel, so Enter alone deletes nothing', async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<DeleteDialog subject={folder} onConfirm={onConfirm} onClose={onClose} />);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' })),
    );
    await userEvent.keyboard('{Enter}');
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('deletes only when Move to Trash is pressed', async () => {
    const onConfirm = vi.fn();
    render(<DeleteDialog subject={folder} onConfirm={onConfirm} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('warns about unsaved typing that would be lost, and says nothing when there is none', () => {
    const { unmount } = render(
      <DeleteDialog
        subject={{ name: 'one', kind: 'note', notes: 1, otherFiles: 0, unsaved: ['one'] }}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert').textContent).toBe('Unsaved changes to one will be lost.');
    unmount();
    render(<DeleteDialog subject={folder} onConfirm={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('alertdialog')).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each([
    [3, 300, 'The 3 notes and 300 other files in it go too.'],
    [1, 1, 'The 1 note and 1 other file in it go too.'],
    [0, 2, 'The 2 other files in it go too.'],
    [2, null, 'The 2 notes in it go too.'],
  ])('with %s notes and %s other files, says what goes', (notes, otherFiles, words) => {
    render(
      <DeleteDialog
        subject={{ ...folder, notes, otherFiles }}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole('alertdialog').textContent).toContain(words);
  });

  it('names the links in a folder, which go as links (#169)', () => {
    render(
      <DeleteDialog
        subject={{ ...folder, notes: 1, otherFiles: 0, links: ['scripts', 'ref.md'] }}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole('alertdialog').textContent).toContain(
      'The 1 note in it goes too. These are links, so only the links go and what they point ' +
        'at stays where it is: scripts, ref.md.',
    );
  });

  it('says only the link goes for a folder that is a link (#169)', () => {
    render(
      <DeleteDialog
        subject={{ ...folder, notes: 2, otherFiles: 0, link: true }}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const text = screen.getByRole('alertdialog').textContent ?? '';
    expect(text).toContain(
      'It is a link: only the link goes to the Trash, and what it points at stays where it is.',
    );
    expect(text).not.toContain('notes in it');
  });

  it('says a folder with nothing in it has no notes to lose', () => {
    render(
      <DeleteDialog subject={{ ...folder, notes: 0 }} onConfirm={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByRole('alertdialog').textContent).toContain('It has no notes in it.');
  });
});
