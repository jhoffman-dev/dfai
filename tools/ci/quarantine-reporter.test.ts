import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FullConfig, Suite, TestCase } from '@playwright/test/reporter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { quarantined } from '../../e2e/quarantine.ts';
import QuarantineReporter from './quarantine-reporter.ts';

const ROOT = '/repo';
const CONFIG = { configFile: `${ROOT}/playwright.config.ts` } as FullConfig;

function testCase(
  title: string,
  details: { tags: string[]; annotations: { type: string; description?: string }[] },
): TestCase {
  const project = { type: 'project', project: () => ({ name: 'webkit' }) };
  const file = { type: 'file', title: 'board.spec.ts', parent: project, project: project.project };
  return {
    title,
    parent: file,
    location: { file: `${ROOT}/e2e/board.spec.ts`, line: 1, column: 1 },
    outcome: () => 'flaky',
    ...details,
  } as unknown as TestCase;
}

describe('the quarantine reporter', () => {
  let folder: string;
  let out: string;

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'dfai-quarantine-reporter-'));
    out = join(folder, 'quarantined.json');
    vi.stubEnv('E2E_QUARANTINE_OUT', out);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(folder, { recursive: true, force: true });
  });

  function run(tests: TestCase[]): void {
    const reporter = new QuarantineReporter();
    reporter.onBegin(CONFIG, { allTests: () => tests } as unknown as Suite);
    reporter.onEnd();
  }

  it('writes each quarantined test with the issue it names and how it did', () => {
    const { tag, annotation } = quarantined(812);
    run([
      testCase('moves a card', { tags: [tag], annotations: [annotation] }),
      testCase('sorts', { tags: ['@quarantine'], annotations: [] }),
      testCase('adds a card', { tags: [], annotations: [] }),
    ]);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual([
      {
        file: 'e2e/board.spec.ts',
        title: 'moves a card',
        project: 'webkit',
        issue: 812,
        outcome: 'flaky',
      },
      { file: 'e2e/board.spec.ts', title: 'sorts', project: 'webkit', outcome: 'flaky' },
    ]);
  });

  it('writes an empty list when nothing is quarantined', () => {
    run([]);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual([]);
  });

  it('writes nothing without E2E_QUARANTINE_OUT', () => {
    vi.stubEnv('E2E_QUARANTINE_OUT', '');
    run([]);
    expect(existsSync(out)).toBe(false);
    expect(new QuarantineReporter().printsToStdio()).toBe(false);
  });
});
