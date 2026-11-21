import {
  favoritesAfterDelete,
  favoritesAfterMove,
  moveFavorite,
  parseFavorites,
  serializeFavorites,
  toggleFavorite,
} from './index.ts';

describe('favourites', () => {
  it('reads a list of paths, dropping repeats and non-strings', () => {
    expect(parseFavorites('["A.md", 3, "B.md", "A.md"]')).toEqual({
      kind: 'ok',
      favorites: ['A.md', 'B.md'],
    });
  });

  it('reads malformed text as empty, and says so', () => {
    expect(parseFavorites('{not json')).toMatchObject({ kind: 'malformed', favorites: [] });
    expect(parseFavorites('{"a": 1}')).toMatchObject({ kind: 'malformed', favorites: [] });
  });

  it('writes the same bytes for the same list, and reads them back', () => {
    const text = serializeFavorites(['Projects/Larkspur Payroll.md', 'People/Mara Quill.md']);
    expect(text).toBe('[\n  "Projects/Larkspur Payroll.md",\n  "People/Mara Quill.md"\n]\n');
    expect(parseFavorites(text)).toEqual({
      kind: 'ok',
      favorites: ['Projects/Larkspur Payroll.md', 'People/Mara Quill.md'],
    });
  });

  it('toggles and reorders', () => {
    const list = toggleFavorite(toggleFavorite(['A.md'], 'B.md'), 'C.md');
    expect(list).toEqual(['A.md', 'B.md', 'C.md']);
    expect(toggleFavorite(list, 'B.md')).toEqual(['A.md', 'C.md']);
    expect(moveFavorite(list, 'C.md', 0)).toEqual(['C.md', 'A.md', 'B.md']);
    expect(moveFavorite(list, 'A.md', 99)).toEqual(['B.md', 'C.md', 'A.md']);
    expect(moveFavorite(list, 'Z.md', 0)).toBe(list);
  });

  it('follows a rename or folder move in place, and drops a deleted note', () => {
    const list = ['People/Mara.md', 'Inbox/Idea.md'];
    expect(favoritesAfterMove(list, { from: 'People', to: 'Contacts' })).toEqual([
      'Contacts/Mara.md',
      'Inbox/Idea.md',
    ]);
    expect(favoritesAfterDelete(list, 'Inbox/Idea.md')).toEqual(['People/Mara.md']);
  });
});
