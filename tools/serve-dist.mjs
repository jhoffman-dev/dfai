#!/usr/bin/env node
// Serves apps/desktop/dist for the end-to-end tests, or another app's (`DIST_APP=web`, #667).
//
// Playwright starts this directly, so it can also stop it. Running `vite preview`
// through a package-manager wrapper leaves the real server orphaned when the tests
// finish, and the CI step then hangs forever with every test already passed.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'apps',
  process.env.DIST_APP === 'web' ? 'web' : 'desktop',
  'dist',
);
const PORT = Number(process.env.PORT ?? 4173);

const TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  // pdf.js's worker is a module of its own (#504): a worker served as anything else is refused.
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  // The web app manifest (#668), served as Firebase Hosting serves it.
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const relative = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  const target = relative === '/' ? 'index.html' : relative.slice(1);

  try {
    const body = await readFile(join(ROOT, target));
    response.writeHead(200, {
      'content-type': TYPES[extname(target)] ?? 'application/octet-stream',
    });
    response.end(body);
  } catch {
    // Single-page app: anything unknown falls back to the entry document.
    try {
      const body = await readFile(join(ROOT, 'index.html'));
      response.writeHead(200, { 'content-type': TYPES['.html'] }).end(body);
    } catch {
      response.writeHead(404).end('not found');
    }
  }
}).listen(PORT, function () {
  // The port it got, not the one asked for: `PORT=0` asks for any free one (web-install.ipad.spec.ts).
  console.log(`serving ${ROOT} on http://localhost:${this.address().port}`);
});
