import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moduleScript } from './code-node.ts';
import { moduleListProblems } from './module-list.ts';

/*
 * Attack on #847 (#825): lists the check passes whose built Code node throws
 * in n8n, and correct lists it rejects. Each "throws" case first proves the
 * break by building the node with `moduleScript` exactly as `pnpm n8n:build`
 * does and running it, then asks the check about the same list.
 */

const folder = mkdtempSync(join(tmpdir(), 'module-list-attack-847-'));
afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

// The first check in a process pays for TypeScript's start-up: paid here, so no test's time carries it.
beforeAll(() => {
  moduleListProblems([], []);
}, 30_000);

/** A fixture module on disk, named by the absolute path a list may hold. */
function fixture(file: string, text: string): string {
  const path = join(folder, file);
  writeFileSync(path, text);
  return path;
}

/** The Code node `pnpm n8n:build` makes from `modules` and `run`, run once. */
const runBuilt = (modules: readonly string[], run: string) => () =>
  new Function(`${modules.map(moduleScript).join('\n')}\n// --- n8n ---\n${run}\n`)();

const A = fixture('a.ts', 'export function twice(n: number): number {\n  return n * 2;\n}\n');

describe('the module-list check against what the built node does (attack #847)', () => {
  it('flags a node whose own lines use a module the list does not hold', () => {
    const run = 'return verifyStandardWebhook;';
    expect(runBuilt([], run)).toThrow(ReferenceError);
    expect(moduleListProblems([], [run])).not.toEqual([]);
  });

  it('flags the same module listed twice', () => {
    const list = ['./sha256.ts', './sha256.ts', './standard-webhook.ts'];
    const run = 'return typeof verifyStandardWebhook;';
    expect(runBuilt(list, run)).toThrow(SyntaxError);
    expect(moduleListProblems(list, [run])).not.toEqual([]);
  });

  it('flags two listed modules that export the same name', () => {
    const other = fixture(
      'other.ts',
      'export function twice(n: number): number {\n  return n + n;\n}\n',
    );
    const run = 'return twice(2);';
    expect(runBuilt([A, other], run)).toThrow(SyntaxError);
    expect(moduleListProblems([A, other], [run])).not.toEqual([]);
  });

  it('flags a module that imports a name under another name', () => {
    const alias = fixture(
      'alias.ts',
      "import { twice as double } from './a.ts';\nexport function quad(n: number): number {\n  return double(double(n));\n}\n",
    );
    const run = 'return quad(1);';
    expect(runBuilt([A, alias], run)).toThrow(ReferenceError);
    expect(moduleListProblems([A, alias], [run])).not.toEqual([]);
  });

  it('flags a module that imports another as a namespace', () => {
    const spaced = fixture(
      'spaced.ts',
      "import * as a from './a.ts';\nexport function quad(n: number): number {\n  return a.twice(a.twice(n));\n}\n",
    );
    const run = 'return quad(1);';
    expect(runBuilt([A, spaced], run)).toThrow(ReferenceError);
    expect(moduleListProblems([A, spaced], [run])).not.toEqual([]);
  });

  it('flags a module that re-exports another', () => {
    const passOn = fixture('pass-on.ts', "export { twice } from './a.ts';\n");
    const user = fixture(
      'pass-on-user.ts',
      "import { twice } from './pass-on.ts';\nexport function quad(n: number): number {\n  return twice(twice(n));\n}\n",
    );
    const list = [A, passOn, user];
    const run = 'return quad(1);';
    expect(runBuilt(list, run)).toThrow(SyntaxError);
    expect(moduleListProblems(list, [run])).not.toEqual([]);
  });

  it('flags a module that loads another by dynamic import()', () => {
    // Not run here: in n8n the node is one script, so './a.ts' does not exist beside it.
    const lazy = fixture(
      'lazy.ts',
      "export async function lazyTwice(n: number): Promise<number> {\n  const { twice } = await import('./a.ts');\n  return twice(n);\n}\n",
    );
    expect(moduleListProblems([lazy], ['return lazyTwice(1);'])).not.toEqual([]);
  });
});

describe('the module-list check against correct lists (attack #847)', () => {
  it('passes a module whose import is used only as a type, without the type keyword', () => {
    fixture('shape.ts', 'export interface Shape {\n  n: number;\n}\nexport const UNIT = 1;\n');
    const user = fixture(
      'shape-user.ts',
      "import { Shape } from './shape.ts';\nexport function size(s: Shape): number {\n  return s.n;\n}\n",
    );
    const run = 'return size({ n: 3 });';
    expect(runBuilt([user], run)()).toBe(3);
    expect(moduleListProblems([user], [run])).toEqual([]);
  });

  it('passes an import that names a listed module without its .ts extension', () => {
    const bare = fixture(
      'bare.ts',
      "import { twice } from './a';\nexport function quad(n: number): number {\n  return twice(twice(n));\n}\n",
    );
    const run = 'return quad(1);';
    expect(runBuilt([A, bare], run)()).toBe(4);
    expect(moduleListProblems([A, bare], [run])).toEqual([]);
  });
});
