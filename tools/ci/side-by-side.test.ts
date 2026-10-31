import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/* tools/ci/side-by-side.sh, the `static` job's way of running its checks at once. */

const SCRIPT = join(import.meta.dirname, 'side-by-side.sh');

const run = (...commands: string[]) =>
  spawnSync('bash', [SCRIPT, ...commands], { encoding: 'utf8', timeout: 30_000 });

describe('side-by-side.sh', () => {
  it('runs the commands at once and prints each whole, in the order given', () => {
    // The first waits to hear from the second through a pipe: run one after the other, it never would.
    const folder = mkdtempSync(join(tmpdir(), 'side-by-side-'));
    try {
      const pipe = join(folder, 'pipe');
      execFileSync('mkfifo', [pipe]);
      const result = run(
        `exec 3<>'${pipe}'; read -r -t 10 -u 3 heard && echo "first heard $heard"`,
        `echo second; echo hello > '${pipe}'`,
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('first heard hello');
      expect(result.stdout.indexOf('first heard')).toBeLessThan(result.stdout.indexOf('second'));
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
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
