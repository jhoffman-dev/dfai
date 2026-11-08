/*
 * What an end-to-end run says about its unreliable tests (#799): each test
 * that failed on at least one try, how many tries it had, and whether one of
 * them passed. A test that failed and then passed is flaky. The gate's `flaky`
 * job files an issue for each flaky test, and the nightly flake hunt one issue
 * for every test that failed at least once in its repeated runs.
 *
 * A test's repeats (`--repeat-each`) and retries are folded into one record, so
 * a test that failed one try in three is one line, not three.
 */

/** A test as the run left it: what it is, and each try's status and errors. */
export interface RanTest {
  readonly file: string;
  readonly title: string;
  readonly project: string;
  readonly expectedStatus: string;
  readonly results: readonly {
    readonly status: string;
    readonly errors: readonly { readonly message?: string }[];
  }[];
}

/** A test that failed on at least one of its tries. */
export interface FlakeRecord {
  readonly file: string;
  readonly title: string;
  readonly project: string;
  readonly tries: number;
  readonly failures: number;
  /** Whether a try passed: a failure and a pass make the test flaky. */
  readonly passed: boolean;
  /** The first failed try's error, a few lines of it. */
  readonly errorLines: readonly string[];
  /** Where the run's report is, when the shard uploaded one. */
  readonly reportUrl?: string;
}

/** As many lines of an error as an issue shows: the message and where it was thrown. */
export const ERROR_LINES = 12;

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** The first lines of a try's errors, without the terminal's colours. */
export function errorLinesOf(errors: readonly { readonly message?: string }[]): string[] {
  const text = errors.map((error) => error.message ?? '').join('\n');
  return text
    .replace(ANSI, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')
    .slice(0, ERROR_LINES);
}

/** Neither passed nor failed: skipped, or stopped with the run. */
const didNotRun = (status: string) => status === 'skipped' || status === 'interrupted';

const keyOf = (test: { readonly project: string; readonly file: string; readonly title: string }) =>
  `${test.project}\u0000${test.file}\u0000${test.title}`;

/** One record for each test, its repeats folded in, of those that failed a try. */
export function flakeRecordsOf(tests: readonly RanTest[]): FlakeRecord[] {
  const records = new Map<string, FlakeRecord>();
  for (const test of tests) {
    const tried = test.results.filter((result) => !didNotRun(result.status));
    const failed = tried.filter((result) => result.status !== test.expectedStatus);
    const record = records.get(keyOf(test)) ?? {
      file: test.file,
      title: test.title,
      project: test.project,
      tries: 0,
      failures: 0,
      passed: false,
      errorLines: [],
    };
    records.set(keyOf(test), {
      ...record,
      tries: record.tries + tried.length,
      failures: record.failures + failed.length,
      passed: record.passed || tried.length > failed.length,
      errorLines:
        record.errorLines.length > 0 ? record.errorLines : errorLinesOf(failed[0]?.errors ?? []),
    });
  }
  return [...records.values()].filter((record) => record.failures > 0);
}

/**
 * Records from several shards folded into one per test: Playwright deals a
 * test's repeats out to different shards, each of which recorded its own.
 */
export function foldRecords(records: readonly FlakeRecord[]): FlakeRecord[] {
  const folded = new Map<string, FlakeRecord>();
  for (const record of records) {
    const earlier = folded.get(keyOf(record));
    folded.set(
      keyOf(record),
      earlier === undefined
        ? record
        : {
            ...earlier,
            tries: earlier.tries + record.tries,
            failures: earlier.failures + record.failures,
            passed: earlier.passed || record.passed,
          },
    );
  }
  return [...folded.values()];
}

/** Flaky: failed on a try and passed on another. */
export const isFlaky = (record: FlakeRecord) => record.failures > 0 && record.passed;
