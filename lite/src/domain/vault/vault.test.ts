import {
  buildFolderTree,
  cleanNoteName,
  flattenFolderTree,
  folderOf,
  isHiddenPath,
  isVisibleNote,
  noteNameProblem,
  noteTitle,
  pathAfterMove,
  uniqueNotePath,
} from './index.ts';

describe('paths', () => {
  it('takes the title from the file name and the folder from the rest', () => {
    expect(noteTitle('Meetings/2026/11/2026-11-21 Weekly sync.md')).toBe('2026-11-21 Weekly sync');
    expect(folderOf('Inbox/Idea.md')).toBe('Inbox');
    expect(folderOf('Idea.md')).toBe('');
  });

  it('follows a note or a folder through a move', () => {
    expect(pathAfterMove('People/Mara.md', { from: 'People/Mara.md', to: 'Mara.md' })).toBe(
      'Mara.md',
    );
    expect(pathAfterMove('People/Mara.md', { from: 'People', to: 'Contacts' })).toBe(
      'Contacts/Mara.md',
    );
    expect(pathAfterMove('Peoples/Mara.md', { from: 'People', to: 'Contacts' })).toBeNull();
  });
});

describe('file names', () => {
  it('turns forbidden characters into spaces and trims dots', () => {
    expect(cleanNoteName('Q3: plan / #draft [x]')).toBe('Q3 plan draft x');
    expect(cleanNoteName('..hidden.')).toBe('hidden');
    expect(cleanNoteName('***')).toBe('');
  });

  it('says why a typed name cannot be used', () => {
    expect(noteNameProblem('Larkspur Payroll')).toBeNull();
    expect(noteNameProblem(' ')).toMatch(/name/);
    expect(noteNameProblem('a|b')).toMatch(/\|/);
    expect(noteNameProblem('.env')).toMatch(/dot/);
  });
});

describe('a new note’s path', () => {
  it('numbers Untitled past the names taken, case aside', () => {
    expect(uniqueNotePath({ folder: 'Inbox', taken: [] })).toBe('Inbox/Untitled.md');
    expect(
      uniqueNotePath({ folder: 'Inbox', taken: ['Inbox/untitled.md', 'Inbox/Untitled 2.md'] }),
    ).toBe('Inbox/Untitled 3.md');
  });

  it('cleans a typed name and falls back to Untitled', () => {
    expect(uniqueNotePath({ folder: '', name: 'Plan: Q3', taken: [] })).toBe('Plan Q3.md');
    expect(uniqueNotePath({ folder: '', name: '///', taken: [] })).toBe('Untitled.md');
  });
});

describe('what is hidden', () => {
  it('hides the index, the app folder and dotfiles, and anything not markdown', () => {
    expect(isHiddenPath('_index/README.md')).toBe(true);
    expect(isHiddenPath('.dfai-lite/favorites.json')).toBe(true);
    expect(isHiddenPath('Projects/.draft.md')).toBe(true);
    expect(isHiddenPath('Projects/_index.md')).toBe(false);
    expect(isVisibleNote('Resources/diagram.png')).toBe(false);
    expect(isVisibleNote('Inbox/Idea.md')).toBe(true);
  });
});

describe('the folder tree', () => {
  const tree = buildFolderTree([
    'Projects/Note 10.md',
    'Projects/note 2.md',
    'Inbox/Idea.md',
    'Projects/Larkspur/Plan.md',
    'Root.md',
    '_index/README.md',
    '.dfai-lite/favorites.json',
  ]);

  it('builds folders from paths, sorted as Finder sorts, hidden paths left out', () => {
    expect(tree.folders.map((folder) => folder.name)).toEqual(['Inbox', 'Projects']);
    const projects = tree.folders[1];
    expect(projects?.notes).toEqual(['Projects/note 2.md', 'Projects/Note 10.md']);
    expect(projects?.noteCount).toBe(3);
    expect(tree.noteCount).toBe(5);
  });

  it('flattens only expanded folders, folders before notes', () => {
    const rows = flattenFolderTree(tree, new Set(['Projects']));
    expect(rows.map((row) => `${row.depth}:${row.name}`)).toEqual([
      '0:Inbox',
      '0:Projects',
      '1:Larkspur',
      '1:note 2',
      '1:Note 10',
      '0:Root',
    ]);
  });
});
