import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readStylesheet } from './styles.test-support.ts';

/**
 * PR #273 under attack: what the token turnover left reading a name that is
 * gone, and what keeps its two dark palettes the same palette.
 */

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const read = (path: string) => readFileSync(here(path), 'utf8');
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '');

const css = stripComments(readStylesheet());
const galleryCss = stripComments(read('./gallery/gallery.css'));

/** Every source file under a folder, tests left out: they read no token. */
function sourcesUnder(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    if (name === 'node_modules' || name === 'dist' || name === 'src-tauri') return [];
    if (statSync(path).isDirectory()) return sourcesUnder(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const SOURCES = [here('.'), here('../../../packages/ui/src')].flatMap(sourcesUnder);

/** A name a stylesheet declares, or a component sets inline (`'--x': …`, `setProperty`). */
const declared = new Set([
  ...[...(css + galleryCss).matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1] ?? ''),
  ...SOURCES.flatMap((path) => [
    ...[...readFileSync(path, 'utf8').matchAll(/['"`](--[a-zA-Z0-9-]+)['"`]\s*[:\],]/g)].map(
      (m) => m[1] ?? '',
    ),
    ...[...readFileSync(path, 'utf8').matchAll(/setProperty\(\s*['"`](--[a-zA-Z0-9-]+)/g)].map(
      (m) => m[1] ?? '',
    ),
  ]),
]);

/** `var(--name)` reads with a whole name; a template (`--status-${tone}-dot`) is skipped. */
const reads = (source: string) =>
  [...source.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)(?![-a-zA-Z0-9$])/g)]
    .filter((match) => source[(match.index ?? 0) + match[0].length] !== '$')
    .map((match) => match[1] ?? '');

describe('tokens after the v2 turnover', () => {
  /**
   * styles.test.ts holds the app's sheet (styles/) to the tokens it declares. The gallery's
   * sheet and the components' inline styles read the same names and nothing
   * held them until #273: `gallery.css` read `--text-hero` after it was
   * deleted, and the gallery's hero numeral fell back to the inherited size.
   */
  it('gallery.css reads only tokens that are declared', () => {
    expect(reads(galleryCss).filter((name) => !declared.has(name))).toEqual([]);
  });

  it('components in the app and packages/ui read only tokens that are declared', () => {
    const missing = SOURCES.flatMap((path) =>
      reads(readFileSync(path, 'utf8'))
        .filter((name) => !declared.has(name))
        .map((name) => `${path.split('/src/').pop() ?? path}: ${name}`),
    );
    expect(missing).toEqual([]);
  });

  /**
   * The system's dark and the chosen dark are written out twice. The existing
   * test holds them to the same *names*; a value changed in one and not the
   * other gives two dark themes, depending on whether the viewer has ever
   * clicked the switch.
   */
  it('gives the system dark and the chosen dark the same value for every token', () => {
    const block = (opening: RegExp) => {
      const start = css.search(opening);
      expect(start).toBeGreaterThanOrEqual(0);
      const body = css.slice(css.indexOf('{', start) + 1);
      return new Map(
        [...body.slice(0, body.indexOf('}')).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map(
          (m) => [m[1] ?? '', (m[2] ?? '').trim()] as const,
        ),
      );
    };
    const system = block(/:root:not\(\[data-theme='light'\]\)\s*\{/);
    const chosen = block(/^\[data-theme='dark'\]\s*\{/m);
    expect(system.size).toBeGreaterThan(40);
    expect(Object.fromEntries(chosen)).toEqual(Object.fromEntries(system));
  });
});
