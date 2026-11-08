import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FullConfig, Suite, TestCase } from '@playwright/test/reporter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import E2eFlakeReporter from './e2e-flake-reporter.ts';

const ROOT = '/repo';
const CONFIG = { rootDir: `${ROOT}/e2e`, configFile: `${ROOT}/playwright.config.ts` } as FullConfig;

/** A test as Playwright hands it to a reporter: in a `describe`, in a file, in a project. */
function testCase(title: string, statuses: string[]): TestCase {
  const project = { type: 'project', project: () => ({ name: 'ipad' }) };
  const file = { type: 'file', title: 'board.spec.ts', parent: project, project: project.project };
  const describeSuite = {
    type: 'describe',
    title: 'board',
    parent: file,
    project: project.project,
  };
  return {
    title,
    parent: describeSuite,
    location: { file: `${ROOT}/e2e/board.spec.ts`, line: 3, column: 1 },
    expectedStatus: 'passed',
    results: statuses.map((status) => ({
      status,
      errors: status === 'passed' ? [] : [{ message: 'Timed out 5000ms' }],
    })),
  } as unknown as TestCase;
}

function run(tests: TestCase[], shard: FullConfig['shard'] = null): void {
  const reporter = new E2eFlakeReporter();
  reporter.onBegin({ ...CONFIG, shard }, { allTests: () => tests } as unknown as Suite);
  reporter.onEnd();
}

describe('the e2e flake reporter', () => {
  let folder: string;
  let out: string;

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'dfai-flake-reporter-'));
    out = join(folder, 'flakes.json');
    vi.stubEnv('E2E_FLAKES_OUT', out);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(folder, { recursive: true, force: true });
  });

  it('writes each test that failed a try, named from the repository root', () => {
    run([testCase('moves a card', ['failed', 'passed']), testCase('adds a card', ['passed'])]);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual([
      {
        file: 'e2e/board.spec.ts',
        title: 'board › moves a card',
        project: 'ipad',
        tries: 2,
        failures: 1,
        passed: true,
        errorLines: ['Timed out 5000ms'],
      },
    ]);
  });

  it('writes an empty list when nothing failed, so every shard hands one on', () => {
    run([testCase('adds a card', ['passed'])]);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual([]);
  });

  it('writes beside the records which shard of how many it was, one of one without --shard', () => {
    run([], { current: 3, total: 8 });
    expect(JSON.parse(readFileSync(join(folder, 'shard.json'), 'utf8'))).toEqual({
      current: 3,
      total: 8,
    });
    run([]);
    expect(JSON.parse(readFileSync(join(folder, 'shard.json'), 'utf8'))).toEqual({
      current: 1,
      total: 1,
    });
  });

  it('writes nothing without E2E_FLAKES_OUT', () => {
    vi.stubEnv('E2E_FLAKES_OUT', '');
    run([testCase('moves a card', ['failed', 'passed'])]);
    expect(existsSync(out)).toBe(false);
  });

  it('prints nothing of its own, leaving the terminal to the list reporter', () => {
    expect(new E2eFlakeReporter().printsToStdio()).toBe(false);
  });
});
