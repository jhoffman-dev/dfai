/**
 * #911: the list that turns on Apply for the rows that move a note is test
 * support only. No source that ships may import it; a test may. Read from
 * the files as they are in the checkout.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(new URL('.', import.meta.url).pathname, '../../../..');
const SKIP = new Set(['node_modules', 'dist', 'target', '.git', 'coverage', 'test-results']);

function sources(at: string): string[] {
  return readdirSync(at).flatMap((name) => {
    if (SKIP.has(name)) return [];
    const path = join(at, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/u.test(name) ? [path] : [];
  });
}

/** A file that ships: not a test, not a test's support. */
const ships = (path: string) =>
  !/\.(test|spec)\.tsx?$/u.test(path) && !/(^|\/)(testing|e2e)\//u.test(relative(ROOT, path));

describe('EVERY_ASSIST_KIND', () => {
  const shipped = ['packages', 'apps'].flatMap((top) => sources(join(ROOT, top))).filter(ships);

  it('is named by no source that ships', () => {
    expect(shipped.length).toBeGreaterThan(500);
    const naming = shipped.filter((path) =>
      readFileSync(path, 'utf8').includes('EVERY_ASSIST_KIND'),
    );
    expect(naming.map((path) => relative(ROOT, path))).toEqual([]);
  });

  it('would be caught: the check sees a shipping file that names it', () => {
    const own = join(ROOT, 'packages/domain/src/testing/every-assist-kind.ts');
    expect(ships(own)).toBe(false);
    expect(ships(join(ROOT, 'packages/application/src/inbox/apply-inbox-assist.ts'))).toBe(true);
  });
});
