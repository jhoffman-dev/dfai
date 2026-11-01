import { describe, expect, it } from 'vitest';
import { refreshAfterWatch, watchedPathsAreIndexedNotes } from './watched-paths.ts';

describe('watchedPathsAreIndexedNotes (#239)', () => {
  it('is true when every path is a note the index holds', () => {
    expect(watchedPathsAreIndexedNotes(['Alder.md', 'Projects/Larkspur/Plan.md'])).toBe(true);
    expect(watchedPathsAreIndexedNotes(['.atlas/types/task.md'])).toBe(true);
  });

  it.each([
    ['a template', '.atlas/templates/Meeting.md'],
    ['a view', '.atlas/views/Next actions.md'],
    ['a dashboard', '.atlas/dashboards/Week.md'],
    ['an attachment', 'Files/Scan from Mara Quill.pdf'],
    ['a folder', 'Projects/Larkspur'],
    ['a hidden note', '.obsidian/workspace.md'],
    ['a path the vault cannot name', '../outside.md'],
  ])('is false when any path is %s', (_, path) => {
    expect(watchedPathsAreIndexedNotes(['Alder.md', path])).toBe(false);
  });

  it('is false for an event with no paths, which says nothing of what changed', () => {
    expect(watchedPathsAreIndexedNotes([])).toBe(false);
  });

  it('asks a quiet refresh only for notes', () => {
    expect(refreshAfterWatch(['Alder.md']).quiet).toBe(true);
    expect(refreshAfterWatch(['Files/scan.pdf']).quiet).toBe(false);
  });

  // Another program's write in the same tick keeps a note's time and size,
  // so the refresh is told which notes to read again regardless (#245).
  it('names every path it was told of for the refresh to read again', () => {
    expect(refreshAfterWatch(['Alder.md', 'Files/scan.pdf']).recheck).toEqual([
      'Alder.md',
      'Files/scan.pdf',
    ]);
  });
});
