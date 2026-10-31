// `node tools/perf/combine-budgets.ts <folder>` — in CI's `perf` job, after
// the work budgets were done in parts on machines of their own: reads each
// part's `budgets.<part>.json` under <folder>, and fails if any budgeted
// action was not counted on each of the `COUNTED_RUNS` runs, or not timed,
// by exactly one part, or if a run counted on a machine apart from run 1
// counted differently from it (RUN_TOLERANCE, as within one machine); and if
// no part ran the response-time budgets (`latency.json`, ui-latency.spec.ts).
// Prints the one report of the whole run, into the job summary too. The part
// that counted run 1 has already held it to the budgets.
import { appendFile, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BUDGETED_ACTIONS, RUN_TOLERANCE } from './budgeted-actions.ts';
import { budgetPartFiles, latencyFiles } from './part-files.ts';
import {
  combineParts,
  measurementsOf,
  reportTable,
  type BudgetsFile,
  type PartResult,
} from './work-budgets.ts';

const BUDGETS_FILE = new URL('./budgets.json', import.meta.url);
/**
 * How many times CI counts every action: twice, so a count that differs
 * between two runs, on two machines, fails. In code, not read from the job,
 * so a job that forgot to say cannot leave run 2 unchecked.
 */
const COUNTED_RUNS = 2;

async function partsUnder(folder: string): Promise<PartResult[]> {
  const files = budgetPartFiles(await readdir(folder, { recursive: true }));
  return Promise.all(
    files.map(async (file) => JSON.parse(await readFile(join(folder, file), 'utf8')) as PartResult),
  );
}

/** What is wrong with the response-time budgets' results under `folder`: none, two, or an empty one. */
async function latencyProblems(folder: string): Promise<string[]> {
  const files = latencyFiles(await readdir(folder, { recursive: true }));
  if (files.length !== 1) {
    return [`the response-time budgets ran in ${files.length} parts, not one (latency.json)`];
  }
  const measured = JSON.parse(await readFile(join(folder, files[0]!), 'utf8')) as unknown[];
  return measured.length > 0 ? [] : ['the response-time budgets measured nothing (latency.json)'];
}

async function main(): Promise<void> {
  const folder = process.argv[2];
  if (folder === undefined) {
    console.error('usage: node tools/perf/combine-budgets.ts <folder of the parts>');
    process.exit(2);
  }
  const parts = await partsUnder(folder);
  const budgets = JSON.parse(await readFile(BUDGETS_FILE, 'utf8')) as BudgetsFile;
  const { result, problems } = combineParts(parts, BUDGETED_ACTIONS, {
    runs: COUNTED_RUNS,
    tolerance: RUN_TOLERANCE,
  });
  problems.push(...(await latencyProblems(folder)));
  const table = reportTable(measurementsOf(BUDGETED_ACTIONS, result, budgets));
  console.log(`Work budgets, ${parts.length} parts together:\n\n${table}\n`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary !== undefined && summary !== '') {
    await appendFile(
      summary,
      `## Work budgets\n\nCounts are held to \`tools/perf/budgets.json\`; times are reported only. ` +
        `Done in ${parts.length} parts.\n\n${table}\n`,
    );
  }
  if (problems.length > 0) {
    console.error(`The parts do not make the whole run:\n${problems.join('\n')}`);
    process.exit(1);
  }
}

await main();
