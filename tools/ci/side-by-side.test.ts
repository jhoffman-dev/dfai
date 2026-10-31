import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/* tools/ci/side-by-side.sh, the `static` job's way of running its checks at once. */

const SCRIPT = join(import.meta.dirname, 'side-by-side.sh');

const run = (...commands: string[]) =>
  spawnSync('bash', [SCRIPT, ...commands], { encoding: 'utf8' });

describe('side-by-side.sh', () => {
  it('runs the commands at once and prints each whole, in the order given', () => {
    // The first waits on a file only the second writes: run one after the other, it never ends.
    const flag = join(import.meta.dirname, `.side-by-side-${process.pid}`);
    const result = run(
      `for i in $(seq 1 100); do [ -f '${flag}' ] && break; sleep 0.05; done; [ -f '${flag}' ] && echo first saw it; rm -f '${flag}'`,
      `echo second; touch '${flag}'`,
    );
    expect(result.status).toBe(0);
    expect(result.stdout.indexOf('first saw it')).toBeGreaterThan(-1);
    expect(result.stdout.indexOf('first saw it')).toBeLessThan(result.stdout.indexOf('second'));
  });

  it('fails when any command fails, naming it and still printing the others', () => {
    const result = run('echo fine', 'echo broke; exit 3', 'echo also fine');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('::group::echo broke; exit 3 (exit 3)');
    expect(result.stdout).toContain('::error::failed: echo broke; exit 3');
    expect(result.stdout).toContain('also fine');
    expect(result.stdout).not.toContain('failed: echo fine');
  });

  it('fails a command whose failure is on the left of a pipe', () => {
    expect(run('false | cat').status).toBe(1);
  });

  it('refuses to run nothing', () => {
    expect(run().status).toBe(2);
  });
});
