import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FullConfig, Suite, TestCase, TestResult, TestRun } from '@playwright/test/reporter';
import { afterEach, describe, expect, it, vi } from 'vitest';
import E2eShardReporter from './e2e-shard-reporter.ts';

const ROOT = '/repo';
/** Files with and without a recorded duration (e2e-durations.json), and one in a second project. */
const FILES = [
  'e2e/inbox.attack-247.spec.ts',
  'e2e/meetings-waiting.spec.ts',
  'e2e/kindle-sync.spec.ts',
  'e2e/a-new-one.spec.ts',
  'e2e/another-new-one.spec.ts',
  ...Array.from({ length: 20 }, (_, at) => `e2e/f${at}.spec.ts`),
];
const IPAD_FILES = ['e2e/web-install.ipad.spec.ts'];

/** A run's root suite as Playwright hands it over: projects, then their files. */
function corpus(): { suite: Suite; fileSuites: Suite[] } {
  const fileSuite = (path: string) => ({ location: { file: `${ROOT}/${path}` } }) as Suite;
  const webkit = FILES.map(fileSuite);
  const ipad = IPAD_FILES.map(fileSuite);
  const suite = { suites: [{ suites: webkit }, { suites: ipad }] } as unknown as Suite;
  return { suite, fileSuites: [...webkit, ...ipad] };
}

/** The file paths a shard keeps, and whether it took the sharding from Playwright. */
async function deal(shard: FullConfig['shard']): Promise<{ kept: string[]; took: boolean }> {
  const { suite, fileSuites } = corpus();
  const excluded = new Set<Suite>();
  let took = false;
  const testRun = {
    exclude: (target: Suite) => excluded.add(target),
    skipSharding: () => {
      took = true;
    },
  } as unknown as TestRun;
  const config = { rootDir: ROOT, shard } as FullConfig;
  await new E2eShardReporter().preprocess({ config, suite, testRun });
  const kept = fileSuites
    .filter((file) => !excluded.has(file))
    .map((file) => file.location!.file.slice(ROOT.length + 1));
  return { kept, took };
}

describe('dealing the e2e spec files over the CI shards by duration', () => {
  it('runs every file on exactly one of the shards', async () => {
    for (const total of [1, 3, 8]) {
      const kept: string[] = [];
      for (let current = 1; current <= total; current++) {
        const shard = await deal({ current, total });
        expect(shard.took).toBe(true);
        kept.push(...shard.kept);
      }
      expect(kept.sort()).toEqual([...FILES, ...IPAD_FILES].sort());
    }
  });

  it('keeps the slowest recorded files on different shards', async () => {
    const slowest = ['e2e/inbox.attack-247.spec.ts', 'e2e/meetings-waiting.spec.ts'];
    const shardsOf = await Promise.all(
      [1, 2, 3, 4, 5, 6, 7, 8].map((current) => deal({ current, total: 8 })),
    );
    const holding = slowest.map((file) => shardsOf.findIndex(({ kept }) => kept.includes(file)));
    expect(holding.every((at) => at >= 0)).toBe(true);
    expect(new Set(holding).size).toBe(slowest.length);
  });

  it('leaves a run with no --shard alone: every file, and Playwright keeps the sharding', async () => {
    const { kept, took } = await deal(null);
    expect(took).toBe(false);
    expect(kept).toEqual([...FILES, ...IPAD_FILES]);
  });
});

describe("writing what a shard's files took", () => {
  const folders: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  async function finishedRun(): Promise<void> {
    const reporter = new E2eShardReporter();
    const { suite } = corpus();
    const testRun = {
      exclude: () => undefined,
      skipSharding: () => undefined,
    } as unknown as TestRun;
    await reporter.preprocess({
      config: { rootDir: ROOT, shard: null } as FullConfig,
      suite,
      testRun,
    });
    const ran = (path: string, duration: number) =>
      reporter.onTestEnd(
        { location: { file: `${ROOT}/${path}` } } as TestCase,
        { duration } as TestResult,
      );
    ran('e2e/kindle-sync.spec.ts', 16_400);
    ran('e2e/kindle-sync.spec.ts', 10_100);
    ran('e2e/f1.spec.ts', 2_000);
    reporter.onEnd();
  }

  it("writes each file's seconds, by path from the root, to E2E_DURATIONS_OUT", async () => {
    const folder = mkdtempSync(join(tmpdir(), 'e2e-durations-'));
    folders.push(folder);
    const out = join(folder, 'e2e-durations.json');
    vi.stubEnv('E2E_DURATIONS_OUT', out);
    await finishedRun();
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({
      'e2e/f1.spec.ts': 2,
      'e2e/kindle-sync.spec.ts': 26.5,
    });
  });
});
