#!/usr/bin/env node
// Part of `pnpm check:node-builtins`, after `pnpm build`: fails when anything
// of Tauri reached the web build's bundle (#656). The rule is in
// tauri-in-bundle.ts; this only reads the built files and prints.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webBundleProblems } from './tauri-in-bundle.ts';

const dist = fileURLToPath(new URL('../../apps/web/dist', import.meta.url));

let files;
try {
  files = readdirSync(dist, { recursive: true, encoding: 'utf8' }).filter((file) =>
    /\.(m?js|html)$/.test(file),
  );
} catch (error) {
  console.error(`Cannot read the web build (${String(error)}). Run \`pnpm build\` first.`);
  process.exit(1);
}

const sources = files.sort().map((file) => ({
  file: file.replaceAll('\\', '/'),
  source: readFileSync(join(dist, file), 'utf8'),
}));
const problems = webBundleProblems(sources);
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`No Tauri in the web build: ${sources.length} files.`);
