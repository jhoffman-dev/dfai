import { RECORDED_FROM_S, type Durations } from './unit-shards.ts';

/*
 * The durations the end-to-end shards in CI (.github/workflows/gate.yml, the
 * `e2e` jobs) are dealt by, as the unit shards are: e2e-shard-reporter.ts deals
 * whole spec files with unit-shards.ts's `filesOfShard`, by what each file's
 * tests took on CI (`e2e-durations.json`).
 *
 * Playwright's own `--shard` cuts the suite into runs of equal test count, in
 * file order, so a shard that drew the Tab-through-600-rows attacks and the
 * two-Macs meetings ran six and a half minutes against three and a half (#716).
 */

/** One test's result: the spec file it is in, by path from the root, and how long it ran. */
export interface TestTime {
  readonly file: string;
  readonly ms: number;
}

/**
 * The seconds each file's tests took between them, in tenths, by path; files
 * under `RECORDED_FROM_S` left out, as the unit durations leave them.
 */
export function durationsOf(times: readonly TestTime[]): Durations {
  const ms = new Map<string, number>();
  for (const { file, ms: took } of times) ms.set(file, (ms.get(file) ?? 0) + took);
  return byPath([...ms].map(([file, total]) => [file, Math.round(total / 100) / 10] as const));
}

/**
 * The shards' durations as one record. Each shard ran different files, so
 * they do not overlap; were a file in two, the longer time is kept.
 */
export function mergeDurations(parts: readonly Durations[]): Durations {
  const merged = new Map<string, number>();
  for (const part of parts) {
    for (const [file, seconds] of Object.entries(part)) {
      merged.set(file, Math.max(seconds, merged.get(file) ?? 0));
    }
  }
  return byPath([...merged]);
}

/** The rows of a second or more, sorted by path so a new record changes only the lines that moved. */
function byPath(rows: readonly (readonly [string, number])[]): Durations {
  const recorded: Record<string, number> = {};
  const kept = rows
    .filter(([, seconds]) => seconds >= RECORDED_FROM_S)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [file, seconds] of kept) recorded[file] = seconds;
  return recorded;
}
