#!/usr/bin/env node
// Tells the gate what a change needs: reads `git diff --name-only` output on
// stdin (`-z` or one path a line, quoted or not) and prints, for
// $GITHUB_OUTPUT, `code=true` or `code=false`, and `specs`, the e2e spec files
// to repeat, one a line in GitHub's multi-line form, so a path with a space
// stays one path. The rules are in docs-only.ts, e2e-changed-specs.ts and
// git-paths.ts; this only reads and prints.
import { existsSync } from 'node:fs';
import { text } from 'node:stream/consumers';
import { isDocsOnlyChange } from './docs-only.ts';
import { changedSpecs, SPECS_DELIMITER } from './e2e-changed-specs.ts';
import { gitPaths } from './git-paths.ts';

const changedPaths = gitPaths(await text(process.stdin));
console.log(`code=${!isDocsOnlyChange(changedPaths)}`);
console.log(
  [`specs<<${SPECS_DELIMITER}`, ...changedSpecs(changedPaths, existsSync), SPECS_DELIMITER].join(
    '\n',
  ),
);
