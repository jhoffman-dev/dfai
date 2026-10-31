import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * Attack on PR #648: tools/ci/side-by-side.sh, which runs format, typecheck
 * and lint at once in the `static` job. `it.fails` marks a gap.
 */

const SCRIPT = join(import.meta.dirname, 'side-by-side.sh');

const run = (...commands: string[]) =>
  spawnSync('bash', [SCRIPT, ...commands], { encoding: 'utf8', timeout: 30_000 });

describe('side-by-side.sh, attacked', () => {
  it('fails when a command is killed by a signal', () => {
    expect(run('kill -9 $$', 'true').status).toBe(1);
  });

  it('fails when a command closes its output and fails', () => {
    expect(run('exec >&- 2>&-; exit 3').status).toBe(1);
  });

  it.fails('refuses an empty command rather than counting it as passed', () => {
    // An unset variable in the workflow (`"$LINT"`) becomes '' and the check it named never runs.
    expect(run('', 'true').status).not.toBe(0);
  });
});
