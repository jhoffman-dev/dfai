/**
 * `workSwitch` makes a runner's switch without `workOffered` (#920), so it is
 * for tests alone. The package's one entry re-exports its test support, and
 * ESLint fences that support out of `apps/web` only; this holds the rest:
 * no file the app builds names it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../../../..');
const SOURCES = ['packages', 'apps'];

/** A test, a suite's support file, or test support: what the app does not build. */
const TEST_FILE = /\.(test|test-support|spec)\.[cm]?tsx?$|(^|\/)testing\//;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
      return [];
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.[cm]?tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('workSwitch is reached from tests alone (#920)', () => {
  it('is named by no file the app builds', () => {
    const files = SOURCES.flatMap((top) => sourceFiles(join(ROOT, top)))
      .map((path) => relative(ROOT, path))
      .filter((path) => path.includes('/src/') && !TEST_FILE.test(path));
    expect(files.length).toBeGreaterThan(100);
    // Imported or called; a doc comment pointing tests at it names it in backticks, and is no use.
    const uses = /import\s*(type\s*)?\{[^}]*\bworkSwitch\b[^}]*\}|\bworkSwitch\s*\(/;
    const naming = files.filter((path) => uses.test(readFileSync(join(ROOT, path), 'utf8')));
    expect(naming).toEqual([]);
  });
});
