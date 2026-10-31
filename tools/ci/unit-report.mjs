#!/usr/bin/env node
// In the `coverage` job, after the shards' reports are merged:
//   node tools/ci/unit-report.mjs <merged report.json> <listed files.json> <durations out.json>
// Fails when a test file `vitest list` finds has no result in the merged
// report, a file no shard ran. Then writes the durations the shards are dealt
// by (unit-shards.ts); CI uploads them as the `unit-durations` artifact, to
// copy over tools/ci/unit-durations.json when the shards drift apart.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { durationsFromReport, filesNotRun } from './unit-shards.ts';

const [reportPath, listedPath, out] = process.argv.slice(2);
if (out === undefined) {
  console.error(
    'usage: unit-report.mjs <merged report.json> <listed files.json> <durations out.json>',
  );
  process.exit(2);
}
const { testResults } = JSON.parse(readFileSync(reportPath, 'utf8'));
const listed = JSON.parse(readFileSync(listedPath, 'utf8')).map(({ file }) => file);
const missing = filesNotRun(
  listed,
  testResults.map(({ name }) => name),
);
if (missing.length > 0) {
  console.error(`${missing.length} test files ran on no shard:\n${missing.join('\n')}`);
  process.exit(1);
}
console.log(`Every one of the ${listed.length} test files ran on a shard.`);

const root = fileURLToPath(new URL('../..', import.meta.url));
const files = durationsFromReport(testResults, root);
const $comment =
  "Seconds each unit test file's tests took on CI, for dealing them out over the shards " +
  '(tools/ci/unit-shards.ts). Files under a second are left out. Written by ' +
  "tools/ci/unit-report.mjs from the coverage job's merged report; a stale entry only " +
  'skews the balance.';
writeFileSync(out, `${JSON.stringify({ $comment, files }, null, 2)}\n`);
console.log(`${Object.keys(files).length} durations written to ${out}`);
