import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SEARCH_WEIGHTS } from './wasm-index-reads.ts';
import {
  DESCRIBING_PRAGMAS,
  LOCATING_PRAGMA,
  MAX_QUERY_BYTES,
  MAX_QUERY_ROWS,
  QUERY_STEP_BUDGET,
} from './wasm-index-query.ts';

/**
 * The browser's index holds a query to the desktop host's own limits and
 * ranks a search by its weights (#666). Each is a number or a list in
 * `index.rs`; read from there, so one changed on the desktop fails here until
 * the browser's follows, as `index-schema.test.ts` ties the schema.
 */

const INDEX_RS = readFileSync(
  new URL('../../../../apps/desktop/src-tauri/src/index.rs', import.meta.url),
  'utf8',
);

/** The value of a Rust `const NAME: type = value;`, as written. */
function rustConst(name: string): string {
  const found = new RegExp(String.raw`const ${name}: [^=]+= ([^;]+);`).exec(INDEX_RS);
  if (found === null) throw new Error(`index.rs has no const ${name}`);
  return found[1]!.trim();
}

/** A Rust integer expression of literals and `*`: `16 * 1024 * 1024`, `5_000`. */
const rustNumber = (text: string) =>
  text
    .split('*')
    .map((part) => Number(part.trim().replaceAll('_', '')))
    .reduce((product, factor) => product * factor, 1);

describe("the browser index holds the desktop host's limits (#666)", () => {
  it('cuts a result at the same rows and bytes, and stops a query at the same steps', () => {
    expect(MAX_QUERY_ROWS).toBe(rustNumber(rustConst('MAX_QUERY_ROWS')));
    expect(MAX_QUERY_BYTES).toBe(rustNumber(rustConst('MAX_QUERY_BYTES')));
    expect(QUERY_STEP_BUDGET).toBe(rustNumber(rustConst('QUERY_STEP_BUDGET')));
  });

  it('holds every value a query builds to the result cap, as the host’s query connection does', () => {
    const reader = /fn open_for_queries[\s\S]*?\n\}/.exec(INDEX_RS)?.[0] ?? '';
    expect(reader).toMatch(
      /set_limit\(\s*Limit::SQLITE_LIMIT_LENGTH,\s*MAX_QUERY_BYTES as i32\s*\)/,
    );
  });

  it('ranks a search by the same weights', () => {
    expect(JSON.stringify(SEARCH_WEIGHTS)).toBe(rustConst('SEARCH_WEIGHTS'));
  });

  it('lets the same pragmas describe, and refuses the same one that locates', () => {
    const listed = /const DESCRIBING_PRAGMAS: &\[&str\] = &\[([^\]]+)\];/.exec(INDEX_RS)?.[1] ?? '';
    const names = [...listed.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
    expect(names.length).toBeGreaterThan(0);
    expect([...DESCRIBING_PRAGMAS].sort()).toEqual(names.sort());
    expect(JSON.stringify(LOCATING_PRAGMA)).toBe(rustConst('LOCATING_PRAGMA'));
  });
});
