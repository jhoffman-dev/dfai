#!/usr/bin/env node
// `pnpm check:chunks`, after `pnpm build`: fails when a part loaded on first
// use imports a chunk other than the entry (#552). The rule is in
// shared-chunks.ts; this only reads the build's manifest and prints. A
// manifest's path as the argument checks that one instead.
import { readFileSync } from 'node:fs';
import {
  KNOWN_IMPORTS,
  describeSharedChunk,
  describeStaleImport,
  sharedChunks,
  staleKnownImports,
} from './shared-chunks.ts';

const BUILT = new URL('../../apps/desktop/dist/.vite/manifest.json', import.meta.url);
const path = process.argv[2] ?? BUILT;

let manifest;
try {
  manifest = JSON.parse(readFileSync(path, 'utf8'));
} catch (error) {
  console.error(`Cannot read the build's manifest (${String(error)}). Run \`pnpm build\` first.`);
  process.exit(1);
}

const problems = [
  ...sharedChunks(manifest).map(describeSharedChunk),
  ...staleKnownImports(manifest).map(describeStaleImport),
];
if (problems.length > 0) {
  console.error(problems.join('\n\n'));
  process.exit(1);
}
const parts = Object.values(manifest).filter((chunk) => chunk.isDynamicEntry).length;
const known = KNOWN_IMPORTS.map(({ part, imports }) => `${part} -> ${imports}`).join(', ');
console.log(`No chunk is shared under any of ${parts} parts (known and let through: ${known}).`);
