import { describe, expect, it } from 'vitest';
import { createVaultPath, VAULT_ROOT } from './vault-path.ts';
import { resolveWikiLinkTarget } from '../markdown/resolve-wikilink.ts';
import {
  deleteRefusal,
  landingRefusal,
  isMovable,
  isWithin,
  moveDestination,
  movedPath,
  moveIntoLinkRefusal,
  moveRefusal,
  moveRepointsLinkRefusal,
  moveTargets,
  moveThroughLinkRefusal,
  unsavedThroughLinkRefusal,
  nameClashes,
  newFolderRefusal,
  pathAfterMoves,
  notesUnder,
  renameRefusal,
  type MovableEntry,
} from './vault-moves.ts';

const path = (raw: string) => createVaultPath(raw);
const note = (raw: string): MovableEntry => ({ path: path(raw), kind: 'file' });
const folder = (raw: string): MovableEntry => ({ path: path(raw), kind: 'directory' });

describe('what is inside a folder', () => {
  it('counts the folder itself and everything under it', () => {
    expect(isWithin(path('Projects'), path('Projects'))).toBe(true);
    expect(isWithin(path('Projects/Atlas/plan.md'), path('Projects'))).toBe(true);
  });

  it('does not count a folder whose name only starts the same', () => {
    expect(isWithin(path('Projects Old/a.md'), path('Projects'))).toBe(false);
  });

  it('counts everything as inside the vault itself', () => {
    expect(isWithin(path('a.md'), VAULT_ROOT)).toBe(true);
  });
});

describe('where a path goes when something moves', () => {
  const move = { from: path('Projects'), to: path('Archive/Projects') };

  it('follows the moved entry itself', () => {
    expect(movedPath(path('Projects'), move)).toBe('Archive/Projects');
  });

  it('carries everything under a moved folder', () => {
    expect(movedPath(path('Projects/Atlas/plan.md'), move)).toBe('Archive/Projects/Atlas/plan.md');
  });

  it('leaves alone a path the move does not touch', () => {
    expect(movedPath(path('Projects Old/a.md'), move)).toBeNull();
    expect(movedPath(path('Inbox.md'), move)).toBeNull();
  });
});

describe('which folder an entry may be moved into', () => {
  it('lets a note go into any ordinary folder, the top level included', () => {
    expect(moveRefusal(note('Inbox/a.md'), path('Projects'))).toBeNull();
    expect(moveRefusal(note('Inbox/a.md'), VAULT_ROOT)).toBeNull();
  });

  it('refuses the folder the entry is already in', () => {
    expect(moveRefusal(note('Projects/a.md'), path('Projects'))).toMatch(/already there/);
    expect(moveRefusal(note('a.md'), VAULT_ROOT)).toMatch(/already there/);
  });

  it('refuses to put a folder inside itself or anything under it', () => {
    expect(moveRefusal(folder('Projects'), path('Projects'))).toMatch(/inside itself/);
    expect(moveRefusal(folder('Projects'), path('Projects/Atlas'))).toMatch(/inside itself/);
  });

  it('lets a folder go beside one whose name only starts the same', () => {
    expect(moveRefusal(folder('Projects'), path('Projects Old'))).toBeNull();
  });

  it('keeps views, dashboards and templates in their sections', () => {
    expect(moveRefusal(note('.atlas/dashboards/Home.md'), VAULT_ROOT)).toMatch(/DFAI keeps/);
    expect(moveRefusal(note('.atlas/views/Board.md'), path('.atlas/dashboards'))).toMatch(
      /DFAI keeps/,
    );
  });

  it('never moves .atlas itself', () => {
    expect(moveRefusal(folder('.atlas'), path('Projects'))).toMatch(/DFAI keeps/);
  });

  it('keeps notes out of .atlas', () => {
    expect(moveRefusal(note('a.md'), path('.atlas/views'))).toMatch(/Only DFAI/);
  });

  it('allows a folder that is merely called .atlas further down', () => {
    expect(moveRefusal(note('a.md'), path('Projects/.atlas'))).toBeNull();
  });
});

describe('what can be moved, and where folders can be made', () => {
  it('moves anything outside .atlas and nothing inside it', () => {
    expect(isMovable(note('Inbox/a.md'))).toBe(true);
    expect(isMovable(folder('Projects'))).toBe(true);
    expect(isMovable(note('.atlas/views/Board.md'))).toBe(false);
    expect(isMovable(folder('.atlas'))).toBe(false);
  });

  it('makes folders anywhere but inside .atlas', () => {
    expect(newFolderRefusal(VAULT_ROOT)).toBeNull();
    expect(newFolderRefusal(path('Projects/.atlas'))).toBeNull();
    expect(newFolderRefusal(path('.atlas'))).toMatch(/Only DFAI/);
    expect(newFolderRefusal(path('.atlas/templates'))).toMatch(/Only DFAI/);
  });
});

describe('the Archive, which is entered and left only by archiving', () => {
  it('moves nothing in the Archive, nor the Archive itself', () => {
    expect(isMovable(folder('Archive'))).toBe(false);
    expect(isMovable(folder('archive'))).toBe(false);
    expect(isMovable(note('Archive/Projects/X.md'))).toBe(false);
    expect(moveRefusal(note('Archive/X.md'), path('Projects'))).toMatch(/Unarchive/);
  });

  it('moves nothing into it, so every note there knows where it came from', () => {
    expect(moveRefusal(note('X.md'), path('Archive'))).toMatch(/Archive a note/);
    expect(moveRefusal(note('X.md'), path('Archive/Projects'))).toMatch(/Archive a note/);
    expect(
      moveTargets(note('Projects/X.md'), [path('Archive'), path('Archive/Old'), path('Inbox')]),
    ).toEqual([VAULT_ROOT, 'Inbox']);
  });

  it('still moves a folder that is only called Archive further down', () => {
    expect(isMovable(folder('Projects/Archive'))).toBe(true);
    expect(moveRefusal(note('X.md'), path('Projects/Archive'))).toBeNull();
  });

  it('renames nothing there; its notes go to the Trash, the folder itself does not (A20-05)', () => {
    expect(renameRefusal(folder('Archive'))).toMatch(/Unarchive/);
    expect(renameRefusal(note('Archive/X.md'))).toMatch(/Unarchive/);
    expect(deleteRefusal(folder('Archive'))).toMatch(/Delete notes from the Archive/);
    expect(deleteRefusal(folder('archive'))).toMatch(/Delete notes from the Archive/);
    expect(deleteRefusal(note('Archive/X.md'))).toBeNull();
    expect(deleteRefusal(folder('Archive/Projects'))).toBeNull();
    expect(deleteRefusal(folder('Projects/Archive'))).toBeNull();
  });

  it('lets nothing become the root Archive by a move or a rename (A20-05)', () => {
    expect(moveRefusal(folder('Notes/archive'), path(''))).toMatch(/Only archiving/);
    expect(moveRefusal(folder('Notes/Archive'), path('Projects'))).toBeNull();
    expect(landingRefusal(path('ARCHIVE'))).toMatch(/Only archiving/);
    expect(landingRefusal(path('Archive 2'))).toBeNull();
    expect(landingRefusal(path('Notes/Archive'))).toBeNull();
    expect(landingRefusal(path('Archive.md'))).toBeNull();
  });
});

describe('the folders offered for a move', () => {
  const folders = [path('Projects'), path('Projects/Atlas'), path('Inbox'), path('.atlas/views')];

  it('lists the top level first, then every folder that would accept it', () => {
    expect(moveTargets(note('Inbox/a.md'), folders)).toEqual([
      VAULT_ROOT,
      'Projects',
      'Projects/Atlas',
    ]);
  });

  it('leaves out the folder itself and what is under it', () => {
    expect(moveTargets(folder('Projects'), folders)).toEqual(['Inbox']);
  });
});

describe('where a moved entry lands', () => {
  it('keeps its name in the new folder', () => {
    expect(moveDestination(note('Inbox/a.md'), path('Projects'))).toBe('Projects/a.md');
    expect(moveDestination(folder('Inbox/Old'), VAULT_ROOT)).toBe('Old');
  });
});

describe('what may go to the Trash, or be renamed', () => {
  it('lets any note go, including a view, a dashboard or a template', () => {
    for (const each of [
      'a.md',
      '.atlas/views/Board.md',
      '.atlas/dashboards/Home.md',
      '.atlas/templates/Task.md',
    ]) {
      expect(deleteRefusal(note(each))).toBeNull();
      expect(renameRefusal(note(each))).toBeNull();
    }
  });

  it('lets an ordinary folder go', () => {
    expect(deleteRefusal(folder('Projects'))).toBeNull();
  });

  it('keeps the file of every built-in type, in any case, and lets a type of your own go', () => {
    for (const each of [
      '.atlas/types/person.md',
      '.atlas/types/task.md',
      '.atlas/types/project.md',
      '.atlas/types/artifact.md',
      '.atlas/types/company.md',
      '.atlas/types/term.md',
      '.atlas/types/Person.md',
      '.Atlas/Types/TASK.MD',
    ]) {
      expect(deleteRefusal(note(each))).toMatch(/built-in types stay/);
      expect(renameRefusal(note(each))).toMatch(/built-in types stay/);
    }
    for (const each of [
      '.atlas/types/event.md',
      '.atlas/types/persons.md',
      '.atlas/templates/Person.md',
      'people/person.md',
    ]) {
      expect(deleteRefusal(note(each))).toBeNull();
      expect(renameRefusal(note(each))).toBeNull();
    }
  });

  it('keeps a type file that declares a built-in type under another file name', () => {
    // Hand-written or synced: the type is its `name:`, not its file name (A21-02).
    const entry = { ...note('.atlas/types/People.md'), definesType: 'person' };
    expect(deleteRefusal(entry)).toMatch(/built-in types stay/);
    expect(renameRefusal(entry)).toMatch(/built-in types stay/);
    const own = { ...note('.atlas/types/People.md'), definesType: 'event' };
    expect(deleteRefusal(own)).toBeNull();
    // Only a type's own file defines a type: elsewhere `name:` is any property.
    const elsewhere = { ...note('Notes/People.md'), definesType: 'person' };
    expect(deleteRefusal(elsewhere)).toBeNull();
  });

  it('keeps .atlas and its own folders', () => {
    for (const each of ['.atlas', '.atlas/views', '.atlas/types']) {
      expect(deleteRefusal(folder(each))).toMatch(/DFAI needs/);
      expect(renameRefusal(folder(each))).toMatch(/DFAI needs/);
    }
  });
});

describe('the notes an entry stands for', () => {
  const notes = [path('a.md'), path('Projects/b.md'), path('Projects/Deep/c.md'), path('P.md')];

  it('is the note itself for a note', () => {
    expect(notesUnder(note('a.md'), notes)).toEqual(['a.md']);
  });

  it('is the note itself even when the list leaves it out, as it does a dashboard', () => {
    expect(notesUnder(note('.atlas/dashboards/Home.md'), notes)).toEqual([
      '.atlas/dashboards/Home.md',
    ]);
  });

  it('is every note under a folder, however deep', () => {
    expect(notesUnder(folder('Projects'), notes)).toEqual(['Projects/b.md', 'Projects/Deep/c.md']);
  });

  it('is nothing for an empty folder', () => {
    expect(notesUnder(folder('Empty'), notes)).toEqual([]);
  });
});

describe('links after a move', () => {
  it('still open a moved note, since a link names the note and not its folder', () => {
    const notes = [path('Plan.md'), path('Inbox.md')];
    const move = { from: path('Plan.md'), to: path('Projects/Plan.md') };
    const after = notes.map((each) => movedPath(each, move) ?? each);

    expect(resolveWikiLinkTarget('Plan', after)).toBe('Projects/Plan.md');
    expect(nameClashes(move, notes)).toEqual([]);
  });

  it('are reported when a move changes which of two namesakes a link opens', () => {
    const notes = [path('Projects/Deep/Plan.md'), path('Notes/Plan.md')];
    // Moving the deeper one to the top makes it the shallowest `Plan`.
    const move = { from: path('Projects/Deep/Plan.md'), to: path('Plan.md') };
    expect(nameClashes(move, notes)).toEqual([{ name: 'Plan', opens: 'Plan.md' }]);
  });

  it('are not reported when the only other namesake is archived, which never wins a name (#214)', () => {
    const notes = [path('Projects/Deep/Plan.md'), path('Archive/Plan.md')];
    const move = { from: path('Projects/Deep/Plan.md'), to: path('Plan.md') };
    expect(nameClashes(move, notes)).toEqual([]);
  });

  it('are not reported when the same namesake still wins', () => {
    const notes = [path('Plan.md'), path('Archive/Deep/plan.md')];
    const move = { from: path('Plan.md'), to: path('Projects/Plan.md') };
    expect(nameClashes(move, notes)).toEqual([]);
  });

  it('are reported when a rename takes a name another note already has', () => {
    const notes = [path('Plan.md'), path('Projects/Draft.md')];
    const move = { from: path('Projects/Draft.md'), to: path('Projects/Plan.md') };
    expect(nameClashes(move, notes)).toEqual([{ name: 'Plan', opens: 'Plan.md' }]);
  });

  it('are checked for every note a folder carries', () => {
    const notes = [path('Old/Plan.md'), path('Notes/Plan.md'), path('Old/Solo.md')];
    const move = { from: path('Old'), to: path('Top') };
    // As deep as Notes/Plan.md either way; a tie goes alphabetically.
    expect(nameClashes({ ...move, to: path('A') }, notes)).toEqual([
      { name: 'Plan', opens: 'A/Plan.md' },
    ]);
    expect(nameClashes(move, notes)).toEqual([]);
  });
});

describe('pathAfterMoves (A20-05)', () => {
  const moves = [
    { from: path('A.md'), to: path('Archive/A.md') },
    { from: path('Projects'), to: path('Old/Projects') },
    { from: path('Old/Projects/x.md'), to: path('Old/x.md') },
  ];

  it('follows a path through every move that touches it, in order', () => {
    expect(pathAfterMoves(path('A.md'), moves)).toBe('Archive/A.md');
    expect(pathAfterMoves(path('Projects/y.md'), moves)).toBe('Old/Projects/y.md');
    expect(pathAfterMoves(path('Projects/x.md'), moves)).toBe('Old/x.md');
  });

  it('is null for a path no move touched', () => {
    expect(pathAfterMoves(path('B.md'), moves)).toBeNull();
    expect(pathAfterMoves(path('B.md'), [])).toBeNull();
  });
});

describe('a move by way of a link (#680)', () => {
  it('says the entry is reached through the link, and what to do instead', () => {
    expect(moveThroughLinkRefusal(path('Work/Alias'))).toBe(
      'It is inside “Work/Alias”, which is a link: moving or renaming it here would move what ' +
        'the link points at. Do it where it really is, or move the link.',
    );
  });

  it('says the folder is, or is inside, the link, and where the entry would really land', () => {
    expect(moveIntoLinkRefusal(path('Work/Alias'))).toBe(
      '“Work/Alias” is a link: moving into it would put it where the link points. ' +
        'Move it into that folder itself.',
    );
  });

  it('says which link the move would point elsewhere (PR #684 review)', () => {
    expect(moveRepointsLinkRefusal(path('Work/Projects/shelf'))).toBe(
      'Moving it would point the link “Work/Projects/shelf” at something else: a link is read ' +
        'from where it is. Move it where the link still reaches the same place.',
    );
  });

  it('names the unsaved note open by way of a link, and the link (PR #684 review)', () => {
    expect(unsavedThroughLinkRefusal(path('Work/Alias/Plans/garden.md'), path('Work/Alias'))).toBe(
      '“Work/Alias/Plans/garden.md” has typing not yet saved, and it is open by way of the link ' +
        '“Work/Alias”, which may point into what is moving. Wait for it to save, then try again.',
    );
  });
});
