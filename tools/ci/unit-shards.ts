/*
 * How the unit tests are split over the `unit` machines in CI
 * (.github/workflows/gate.yml), by how long each file takes rather than by how
 * many files there are.
 *
 * Vitest's own `--shard` deals files out by a hash of their path, so one
 * machine could draw the five-minute property tests and finish minutes after
 * the others (#648). Here each file costs what it took on CI
 * (`unit-durations.json`) plus what starting any file costs, and the files are
 * dealt longest first to whichever machine has the least so far.
 *
 * Every machine works the same split out from the same list and the same
 * durations, so each file runs on exactly one of them. A file with no recorded
 * duration, a new one, costs only the start: a stale record skews the balance,
 * never what runs.
 */

/** Seconds every file costs before its first test: a worker, its environment, its imports. */
export const FILE_START_S = 1.2;

/** Seconds each file's tests took on CI, by path from the repository's root. */
export type Durations = Readonly<Record<string, number>>;

/** What a file is expected to take on a CI machine, its start included. */
export function costOf(file: string, durations: Durations): number {
  return FILE_START_S + (durations[file] ?? 0);
}

/** `files`, the slowest first; equal ones by path, so every machine orders them alike. */
export function longestFirst(files: readonly string[], durations: Durations): string[] {
  return [...files].sort(
    (a, b) => costOf(b, durations) - costOf(a, durations) || (a < b ? -1 : a > b ? 1 : 0),
  );
}

/**
 * `files` split into `count` shards of about equal cost: each file, slowest
 * first, goes to the shard with the least so far (the first such on a tie).
 */
export function partition(
  files: readonly string[],
  durations: Durations,
  count: number,
): string[][] {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`a shard count is a whole number, 1 or more; it is ${count}`);
  }
  const shards = Array.from({ length: count }, () => ({ files: [] as string[], cost: 0 }));
  for (const file of longestFirst([...new Set(files)], durations)) {
    const least = shards.reduce((best, shard) => (shard.cost < best.cost ? shard : best));
    least.files.push(file);
    least.cost += costOf(file, durations);
  }
  return shards.map((shard) => shard.files);
}

/** The files shard `index` (from 1, as `--shard=index/count` gives it) runs. */
export function filesOfShard(
  files: readonly string[],
  durations: Durations,
  { index, count }: { readonly index: number; readonly count: number },
): string[] {
  if (!Number.isInteger(index) || index < 1 || index > count) {
    throw new Error(`shard ${index} is not one of 1 to ${count}`);
  }
  return partition(files, durations, count)[index - 1] ?? [];
}

/** The minimum a file is recorded at: shorter ones cost about the start alone. */
export const RECORDED_FROM_S = 1;

/** One file's result in Vitest's JSON report: its absolute path and when its tests ran, in ms. */
export interface ReportedFile {
  readonly name: string;
  readonly startTime: number;
  readonly endTime: number;
}

/**
 * The durations to record from a run's JSON report: each file that took at
 * least `RECORDED_FROM_S`, by path from `root`, in seconds to a tenth.
 */
export function durationsFromReport(files: readonly ReportedFile[], root: string): Durations {
  const prefix = root.endsWith('/') ? root : `${root}/`;
  const recorded: Record<string, number> = {};
  const rows = files
    .map((file) => ({
      path: file.name.startsWith(prefix) ? file.name.slice(prefix.length) : file.name,
      seconds: Math.round((file.endTime - file.startTime) / 100) / 10,
    }))
    .filter((row) => row.seconds >= RECORDED_FROM_S)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const { path, seconds } of rows) recorded[path] = seconds;
  return recorded;
}

/** One test file's result in the merged report, and its tests' outcomes. */
export interface FileResult {
  readonly name: string;
  readonly assertionResults: readonly { readonly status: string }[];
}

/**
 * The listed test files the merged report shows did not run: no result, fewer
 * results than the projects it is listed under, or no test that passed or
 * failed, every one skipped, unless `maySkip` names it. Empty when the shards
 * between them ran the whole suite.
 */
export function filesNotRun(
  listed: readonly string[],
  reported: readonly FileResult[],
  maySkip: readonly string[] = [],
): string[] {
  const ran = new Map<string, number>();
  for (const { name, assertionResults } of reported) {
    const ranATest = assertionResults.some(
      ({ status }) => status === 'passed' || status === 'failed',
    );
    if (ranATest || maySkip.some((file) => name.endsWith(`/${file}`))) {
      ran.set(name, (ran.get(name) ?? 0) + 1);
    }
  }
  const wanted = new Map<string, number>();
  for (const file of listed) wanted.set(file, (wanted.get(file) ?? 0) + 1);
  return [...wanted]
    .filter(([file, times]) => (ran.get(file) ?? 0) < times)
    .map(([file]) => file)
    .sort();
}
