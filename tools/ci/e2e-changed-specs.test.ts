import { describe, expect, it } from 'vitest';
import { changedSpecs } from './e2e-changed-specs.ts';

const everything = () => true;

describe('the e2e spec files a change adds or changes', () => {
  it('are the changed paths that are spec files under e2e/', () => {
    const paths = [
      'e2e/board.spec.ts',
      'e2e/board.attack-274.spec.ts',
      'e2e/web-install.ipad.spec.ts',
      'packages/domain/src/index.ts',
      'e2e/host.ts',
      'tools/perf/budgets.spec.ts',
      'README.md',
    ];
    expect(changedSpecs(paths, everything)).toEqual([
      'e2e/board.spec.ts',
      'e2e/board.attack-274.spec.ts',
      'e2e/web-install.ipad.spec.ts',
    ]);
  });

  it('leave out a spec the change deletes', () => {
    const exists = (path: string) => path !== 'e2e/gone.spec.ts';
    expect(changedSpecs(['e2e/gone.spec.ts', 'e2e/kept.spec.ts'], exists)).toEqual([
      'e2e/kept.spec.ts',
    ]);
  });

  it('name each spec once', () => {
    expect(changedSpecs(['e2e/a.spec.ts', 'e2e/a.spec.ts'], everything)).toEqual(['e2e/a.spec.ts']);
  });

  it('are none for a change with no spec in it', () => {
    expect(changedSpecs(['apps/desktop/src/app.tsx', 'e2e/caret.ts'], everything)).toEqual([]);
    expect(changedSpecs([], everything)).toEqual([]);
  });

  it('keep a path with a space whole, and leave out one with a newline in it', () => {
    expect(changedSpecs(['e2e/quick note.spec.ts', 'e2e/a\nb.spec.ts'], everything)).toEqual([
      'e2e/quick note.spec.ts',
    ]);
  });

  it('do not take a spec outside e2e/, or a file that only ends like one', () => {
    expect(
      changedSpecs(['apps/e2e/x.spec.ts', 'e2e/notes.spec.tsx', 'e2e/x.spec.ts.orig'], everything),
    ).toEqual([]);
  });
});
