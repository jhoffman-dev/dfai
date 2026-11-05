#!/usr/bin/env node
// Puts the e2e shards' durations together, for when the shards drift apart:
//   gh run download <main run id> -p 'e2e-durations-*' -D e2e-durations
//   node tools/ci/e2e-durations.mjs tools/ci/e2e-durations.json e2e-durations/*/e2e-durations.json
// Each shard's e2e-shard-reporter.ts wrote what its files took; together
// they are the record the next deal is made from.
import { readFileSync, writeFileSync } from 'node:fs';
import { mergeDurations } from './e2e-shards.ts';

const [out, ...parts] = process.argv.slice(2);
if (out === undefined || parts.length === 0) {
  console.error('usage: e2e-durations.mjs <durations out.json> <shard durations.json>...');
  process.exit(2);
}
const files = mergeDurations(parts.map((part) => JSON.parse(readFileSync(part, 'utf8'))));
const $comment =
  "Seconds each e2e spec file's tests took on CI, between them, for dealing the files out " +
  'over the shards (tools/ci/e2e-shard-reporter.ts). Files under a second are left out. ' +
  'Written by tools/ci/e2e-durations.mjs from the e2e-durations-* artifacts of a gate run; ' +
  'a stale entry only skews the balance.';
writeFileSync(out, `${JSON.stringify({ $comment, files }, null, 2)}\n`);
console.log(`${Object.keys(files).length} durations from ${parts.length} shards written to ${out}`);
