/*
 * Which files under the `perf` job's downloaded artifacts are the parts'
 * results (`combine-budgets.ts`): each part's artifact unpacks into a folder
 * of its own, as `perf-<n>/perf/budgets.<part>.json` and, from the part that
 * ran the response-time budgets, `perf-<n>/perf/latency.json`.
 */

/** The work budgets' part results among `paths`, relative to the download folder. */
export const budgetPartFiles = (paths: readonly string[]): string[] =>
  paths.filter((path) => /(^|\/)budgets\.[^/]+\.json$/.test(path)).sort();

/** The response-time budgets' results among `paths`. */
export const latencyFiles = (paths: readonly string[]): string[] =>
  paths.filter((path) => /(^|\/)latency\.json$/.test(path)).sort();
