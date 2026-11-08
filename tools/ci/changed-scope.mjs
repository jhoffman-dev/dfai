#!/usr/bin/env node
// Tells the gate what a change needs: reads changed paths, one per line, on
// stdin and prints, for $GITHUB_OUTPUT, `code=true` or `code=false` and
// `specs=` the e2e spec files to repeat, space-separated. The rules are in
// docs-only.ts and e2e-changed-specs.ts; this only reads and prints.
import { existsSync } from 'node:fs';
import { text } from 'node:stream/consumers';
import { isDocsOnlyChange } from './docs-only.ts';
import { changedSpecs } from './e2e-changed-specs.ts';

const changedPaths = (await text(process.stdin)).split('\n').filter((path) => path !== '');
console.log(`code=${!isDocsOnlyChange(changedPaths)}`);
console.log(`specs=${changedSpecs(changedPaths, existsSync).join(' ')}`);
