import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * How every app's Vite build finds the workspace packages, from their
 * sources: `apps/desktop` and `apps/web` compose the same shell (#656), so
 * they resolve it alike. Order matters: a string entry also claims every path
 * below it, so a subpath comes before the package it is under.
 */

const source = (path: string) => fileURLToPath(new URL(`../../packages/${path}`, import.meta.url));
const pkg = (name: string) => source(`${name}/src/index.ts`);

/** Resolves a module as `@dfai/adapters` itself would, from its own dependencies. */
export const fromAdapters = createRequire(
  new URL('../../packages/adapters/package.json', import.meta.url),
);

/**
 * The markdown reader's table of HTML entities, by file. Left to the bundler,
 * a browser build gets the other one the package ships, which asks `document`
 * to decode each entity — and the index reads notes in a worker (#135), where
 * there is no `document`: the worker died as it loaded. Found through the
 * adapters' own dependency on the reader, since no app has one.
 */
const entityTable = createRequire(fromAdapters.resolve('micromark-util-decode-string')).resolve(
  'decode-named-character-reference',
);

export function workspaceAliases(): Record<string, string> {
  return {
    // Before '@dfai/ui', which would otherwise claim it as a path inside its index file.
    // A second entry point so the graph page, loaded lazily, keeps d3-force out of
    // the main bundle: the barrel is imported eagerly and everything it exports lands there.
    '@dfai/ui/graph': source('ui/src/graph/index.ts'),
    // The same reader on the window's thread and in the worker, so both read a note alike.
    'decode-named-character-reference': entityTable,
    '@dfai/domain': pkg('domain'),
    '@dfai/application': pkg('application'),
    // Before '@dfai/adapters', as '@dfai/ui/graph' is before '@dfai/ui': pdf.js stays in
    // the reader's chunk, loaded the first time a PDF opens.
    '@dfai/adapters/pdf': source('adapters/src/pdf/index.ts'),
    // The same for foliate-js: it stays in the EPUB reader's chunk, loaded the first time a book opens.
    '@dfai/adapters/epub': source('adapters/src/epub/index.ts'),
    // Only the desktop's composition root imports it (#656).
    '@dfai/adapters/tauri': source('adapters/src/tauri/index.ts'),
    '@dfai/adapters': pkg('adapters'),
    '@dfai/ui': pkg('ui'),
    // Before '@dfai/shell', for the same reason: the shell's one stylesheet.
    '@dfai/shell/styles.css': source('shell/src/styles/index.css'),
    '@dfai/shell': pkg('shell'),
  };
}
