import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { StillRunning } from './still-running-reporter.ts';

describe('StillRunning', () => {
  it('names the files and tests that started and did not end', () => {
    const running = new StillRunning();
    running.fileStarted('a.test.ts');
    running.testStarted('a.test.ts', 'a > done');
    running.testStarted('a.test.ts', 'a > stuck');
    running.testEnded('a.test.ts', 'a > done');
    running.fileStarted('b.test.ts');
    running.fileEnded('b.test.ts');

    expect(running.describe()).toBe(
      'Still running when the run was stopped:\n  a.test.ts\n    > a > stuck\n',
    );
  });

  it('says nothing when everything ended', () => {
    const running = new StillRunning();
    running.fileStarted('a.test.ts');
    running.fileEnded('a.test.ts');

    expect(running.describe()).toBe('');
  });
});

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const VITEST = fileURLToPath(new URL('../../node_modules/vitest/vitest.mjs', import.meta.url));
const FIXTURE_CONFIG = fileURLToPath(
  new URL('./still-running-fixture/vitest.config.ts', import.meta.url),
);
const REPORTER = fileURLToPath(new URL('./still-running-reporter.ts', import.meta.url));

/** Waits, on a clock that cannot hang the test, for the fixture to write its marker. */
async function markerWritten(marker: string): Promise<void> {
  await expect.poll(() => existsSync(marker), { timeout: 30_000, interval: 50 }).toBe(true);
}

/** Starts Vitest on a test that never ends, stops it with SIGTERM once that test is looping, and returns its stderr. */
async function stopAHungRun(): Promise<string> {
  const folder = mkdtempSync(join(tmpdir(), 'still-running-'));
  const marker = join(folder, 'looping');
  try {
    const child = spawn(
      process.execPath,
      [VITEST, 'run', '--config', FIXTURE_CONFIG, '--reporter=dot', `--reporter=${REPORTER}`],
      {
        cwd: ROOT,
        env: { ...process.env, CI: 'true', NO_COLOR: '1', STILL_RUNNING_MARKER: marker },
      },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const closed = new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', () => resolve());
    });
    try {
      await markerWritten(marker);
    } finally {
      child.kill('SIGTERM');
    }
    await closed;
    return stderr;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

describe('StillRunningReporter, in a real run', () => {
  // A worker stuck in a synchronous loop never sends which test it began, so
  // the file is what can be named.
  it('names the hung file when the run is stopped', async () => {
    const stderr = await stopAHungRun();

    expect(stderr).toContain('Still running when the run was stopped:\n  never-ends.fixture.ts\n');
  }, 60_000);
});
