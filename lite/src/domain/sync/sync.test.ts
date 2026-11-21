import { conflictCopyPath, decideSync, isConflictCopyPath, isoDate } from './index.ts';

describe('conflict copies', () => {
  it('names the copy beside the note with the date, numbered when taken', () => {
    const path = 'Projects/Larkspur Payroll.md';
    expect(conflictCopyPath({ path, date: '2026-11-21', taken: [] })).toBe(
      'Projects/Larkspur Payroll (conflict 2026-11-21).md',
    );
    expect(
      conflictCopyPath({
        path,
        date: '2026-11-21',
        taken: ['projects/larkspur payroll (conflict 2026-11-21).md'],
      }),
    ).toBe('Projects/Larkspur Payroll (conflict 2026-11-21) 2.md');
  });

  it('recognises its own copies', () => {
    expect(isConflictCopyPath('Idea (conflict 2026-11-21) 2.md')).toBe(true);
    expect(isConflictCopyPath('Idea (conflict).md')).toBe(false);
  });

  it('formats the local calendar date', () => {
    expect(isoDate(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
});

describe('the three-way decision', () => {
  const cases = [
    { base: 'a', local: 'a', remote: 'a', expected: 'unchanged' },
    { base: 'a', local: 'b', remote: 'b', expected: 'unchanged' },
    { base: null, local: null, remote: null, expected: 'unchanged' },
    { base: 'a', local: 'a', remote: 'b', expected: 'take-remote' },
    { base: null, local: null, remote: 'b', expected: 'take-remote' },
    { base: 'a', local: 'a', remote: null, expected: 'delete-local' },
    { base: 'a', local: 'b', remote: 'a', expected: 'push-local' },
    { base: null, local: 'b', remote: null, expected: 'push-local' },
    { base: 'a', local: null, remote: 'a', expected: 'push-delete' },
    { base: 'a', local: 'b', remote: 'c', expected: 'conflict' },
    { base: null, local: 'b', remote: 'c', expected: 'conflict' },
    // A delete never beats an edit.
    { base: 'a', local: null, remote: 'c', expected: 'take-remote' },
    { base: 'a', local: 'b', remote: null, expected: 'push-local' },
    { base: 'a', local: null, remote: null, expected: 'unchanged' },
  ] as const;

  it.each(cases)('base $base, local $local, remote $remote: $expected', (state) => {
    expect(decideSync(state)).toBe(state.expected);
  });
});
