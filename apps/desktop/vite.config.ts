import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = (name: string) =>
  fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url));

/**
 * The markdown reader's table of HTML entities, by file. Left to the bundler,
 * a browser build gets the other one the package ships, which asks `document`
 * to decode each entity — and the index reads notes in a worker (#135), where
 * there is no `document`: the worker died as it loaded. Found through the
 * adapters' own dependency on the reader, since this package does not have one.
 */
const fromAdapters = createRequire(
  new URL('../../packages/adapters/package.json', import.meta.url),
);
const entityTable = createRequire(fromAdapters.resolve('micromark-util-decode-string')).resolve(
  'decode-named-character-reference',
);

/**
 * Writes where each chunk loaded on first use landed into index.html, by the
 * chunk's name, for `src/chunk-files.ts`: a chunk that failed to parse or run
 * can then be imported again under a fresh address. A meta tag, not a script,
 * since it is only data.
 */
function chunkFilesMeta(): Plugin {
  return {
    name: 'atlas-chunk-files',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: (_html, context) => {
        const files = Object.values(context.bundle ?? {}).flatMap((output) =>
          output.type === 'chunk' && output.isDynamicEntry ? [[output.name, output.fileName]] : [],
        );
        return [
          {
            tag: 'meta',
            attrs: { name: 'atlas-chunks', content: JSON.stringify(Object.fromEntries(files)) },
            injectTo: 'head',
          },
        ];
      },
    },
  };
}

/** pdf.js's own folder, found through the adapters' dependency on it, as the entity table is. */
const pdfjsRoot = dirname(
  dirname(dirname(fromAdapters.resolve('pdfjs-dist/legacy/build/pdf.mjs'))),
);

/** foliate-js's own folder, found the same way, for the licence that travels with its code (#505). */
const foliateRoot = dirname(fromAdapters.resolve('foliate-js/epub.js'));

/**
 * The licences of what the EPUB reader's chunk bundles, shipped under `epub/`:
 * foliate-js's own, and the BSD text of the zip.js it vendors, which the npm
 * package does not carry, so the adapters keep a copy beside the code that uses it.
 */
const EPUB_LICENCES: Readonly<Record<string, string>> = {
  'epub/foliate-js-LICENSE': join(foliateRoot, 'LICENSE'),
  'epub/zip.js-LICENSE': fileURLToPath(
    new URL('../../packages/adapters/src/epub/zip.js-LICENSE', import.meta.url),
  ),
};

/**
 * pdf.js's files that are not code (#504): the standard fonts a PDF names
 * without embedding, the character maps of East Asian text, and the image
 * decoders scans are often made with. pdf.js fetches them by address, so they
 * are part of the build, under `pdfjs/`, and never fetched from anywhere else.
 * The JavaScript sandbox in `wasm/` is left out: DFAI runs no PDF's scripts.
 */
const PDFJS_FOLDERS: Readonly<Record<string, (name: string) => boolean>> = {
  cmaps: () => true,
  standard_fonts: () => true,
  wasm: (name) => !name.startsWith('quickjs'),
};

function pdfjsFiles(): Plugin {
  const fileOf = (folder: string, name: string): string | null => {
    const keep = PDFJS_FOLDERS[folder];
    if (keep === undefined || !keep(name)) return null;
    const path = normalize(join(pdfjsRoot, folder, name));
    return path.startsWith(join(pdfjsRoot, folder) + sep) && existsSync(path) ? path : null;
  };
  return {
    name: 'atlas-pdfjs-files',
    configureServer(server) {
      server.middlewares.use('/pdfjs', (request, response, next) => {
        const [folder = '', name = ''] = (request.url ?? '')
          .split('?')[0]!
          .split('/')
          .filter(Boolean);
        const path = fileOf(folder, decodeURIComponent(name));
        if (path === null || !statSync(path).isFile()) return next();
        response.end(readFileSync(path));
      });
    },
    generateBundle() {
      // The notices travel with the files they cover: pdf.js's and the EPUB reader's licences, and the list that names the rest.
      this.emitFile({
        type: 'asset',
        fileName: 'pdfjs/LICENSE',
        source: readFileSync(join(pdfjsRoot, 'LICENSE')),
      });
      for (const [fileName, path] of Object.entries(EPUB_LICENCES)) {
        this.emitFile({ type: 'asset', fileName, source: readFileSync(path) });
      }
      this.emitFile({
        type: 'asset',
        fileName: 'THIRD_PARTY_NOTICES.txt',
        source: readFileSync(new URL('../../THIRD_PARTY_NOTICES.md', import.meta.url)),
      });
      for (const folder of Object.keys(PDFJS_FOLDERS)) {
        for (const name of readdirSync(join(pdfjsRoot, folder))) {
          const path = fileOf(folder, name);
          if (path === null) continue;
          this.emitFile({
            type: 'asset',
            fileName: `pdfjs/${folder}/${name}`,
            source: readFileSync(path),
          });
        }
      }
    },
  };
}

/**
 * The commit this build is made from, short, for Settings → About and the
 * API's status (#481). Null outside a git checkout — a build from a source
 * archive — which the app shows as no build rather than failing to build.
 */
function buildCommit(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
      cwd: fileURLToPath(new URL('.', import.meta.url)),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // No git, or not a checkout: the build simply does not know its commit.
    return null;
  }
}

export default defineConfig({
  plugins: [react(), chunkFilesMeta(), pdfjsFiles()],
  // The MCP server's path in this checkout, so Settings can offer a command that
  // runs it. Only right for a build made from source, which is how DFAI is run.
  define: {
    __ATLAS_MCP_ENTRY__: JSON.stringify(
      fileURLToPath(new URL('../mcp/dist/main.js', import.meta.url)),
    ),
    __ATLAS_BUILD__: JSON.stringify(buildCommit()),
  },
  resolve: {
    alias: {
      // Before '@dfai/ui', which would otherwise claim it as a path inside its index file.
      // A second entry point so the graph page, loaded lazily, keeps d3-force out of
      // the main bundle: the barrel is imported eagerly and everything it exports lands there.
      '@dfai/ui/graph': fileURLToPath(
        new URL('../../packages/ui/src/graph/index.ts', import.meta.url),
      ),
      // The same reader on the window's thread and in the worker, so both read a note alike.
      'decode-named-character-reference': entityTable,
      '@dfai/domain': pkg('domain'),
      '@dfai/application': pkg('application'),
      // Before '@dfai/adapters', as '@dfai/ui/graph' is before '@dfai/ui': pdf.js stays in
      // the reader's chunk, loaded the first time a PDF opens.
      '@dfai/adapters/pdf': fileURLToPath(
        new URL('../../packages/adapters/src/pdf/index.ts', import.meta.url),
      ),
      // The same for foliate-js: it stays in the EPUB reader's chunk, loaded the first time a book opens.
      '@dfai/adapters/epub': fileURLToPath(
        new URL('../../packages/adapters/src/epub/index.ts', import.meta.url),
      ),
      '@dfai/adapters': pkg('adapters'),
      '@dfai/ui': pkg('ui'),
    },
  },
  // Tauri drives the dev server, so the port is fixed and failures must be loud.
  server: { port: 1420, strictPort: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'safari17',
    // Everything start-up loads in one chunk. Left alone, the bundler splits the code
    // the main chunk shares with a page loaded on first use (`pages-on-first-use.ts`)
    // into chunks of their own, which start-up then fetches anyway, compressed worse.
    // The pages can leave the main chunk at all because @dfai/ui declares no side
    // effects: its index file then no longer keeps every page it exports there.
    rolldownOptions: {
      output: { codeSplitting: { groups: [{ name: 'start', tags: ['$initial'] }] } },
    },
  },
  clearScreen: false,
});
