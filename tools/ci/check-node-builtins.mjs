#!/usr/bin/env node
// `pnpm check:node-builtins`, after `pnpm build`: fails when a Node built-in,
// or a polyfill of one, reached the app's bundle (#53). The rule is in
// node-builtins.ts; this only reads the build's report and chunks and prints.
// A `dist` folder's path as the argument checks that one instead.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KNOWN_NODE_REFERENCES,
  describeNodeBuiltin,
  describeStaleReference,
  nodeBuiltinsInBundle,
  staleKnownReferences,
} from './node-builtins.ts';

const BUILT = fileURLToPath(new URL('../../apps/desktop/dist', import.meta.url));
const dist = process.argv[2] ?? BUILT;

let report;
try {
  report = JSON.parse(readFileSync(join(dist, '.vite', 'node-builtins.json'), 'utf8'));
} catch (error) {
  console.error(`Cannot read the build's report (${String(error)}). Run \`pnpm build\` first.`);
  process.exit(1);
}

const sources = readdirSync(dist, { recursive: true, encoding: 'utf8' })
  .filter((file) => /\.m?js$/.test(file))
  .sort()
  .map((file) => ({
    file: relative(dist, join(dist, file)).replaceAll('\\', '/'),
    source: readFileSync(join(dist, file), 'utf8'),
  }));

const problems = [
  ...nodeBuiltinsInBundle(report, sources).map(describeNodeBuiltin),
  ...staleKnownReferences(report, sources).map(describeStaleReference),
];
if (problems.length > 0) {
  console.error(problems.join('\n\n'));
  process.exit(1);
}
const known = KNOWN_NODE_REFERENCES.map((k) => `${k.package} -> ${k.modules.join(', ')}`).join(
  '; ',
);
const letThrough = known === '' ? '' : ` (known and let through: ${known})`;
console.log(
  `No Node built-in in the app's bundle: ${report.chunks.length} chunks, ${sources.length} script files${letThrough}.`,
);
