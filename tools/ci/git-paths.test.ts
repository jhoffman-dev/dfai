import { describe, expect, it } from 'vitest';
import { gitPaths, unquoteGitPath } from './git-paths.ts';

describe('the paths git diff prints', () => {
  it('are read NUL-separated from -z, spaces and newlines kept', () => {
    expect(gitPaths('e2e/quick note.spec.ts\0e2e/a\nb.spec.ts\0README.md\0')).toEqual([
      'e2e/quick note.spec.ts',
      'e2e/a\nb.spec.ts',
      'README.md',
    ]);
  });

  it('are read a line each without -z, quoted ones unquoted', () => {
    expect(gitPaths('"e2e/caf\\303\\251.spec.ts"\nREADME.md\n\n')).toEqual([
      'e2e/café.spec.ts',
      'README.md',
    ]);
  });
});

describe('a path git quoted', () => {
  it.each([
    ['"e2e/caf\\303\\251.spec.ts"', 'e2e/café.spec.ts'],
    ['"e2e/say \\"hi\\".spec.ts"', 'e2e/say "hi".spec.ts'],
    ['"e2e/back\\\\slash.spec.ts"', 'e2e/back\\slash.spec.ts'],
    ['"e2e/tab\\there.spec.ts"', 'e2e/tab\there.spec.ts'],
    ['"e2e/\\346\\227\\245\\346\\234\\254.spec.ts"', 'e2e/日本.spec.ts'],
  ])('%s is %s', (printed, path) => {
    expect(unquoteGitPath(printed)).toBe(path);
  });

  it('is left alone when it was not quoted', () => {
    expect(unquoteGitPath('e2e/plain.spec.ts')).toBe('e2e/plain.spec.ts');
    expect(unquoteGitPath('"')).toBe('"');
  });
});
