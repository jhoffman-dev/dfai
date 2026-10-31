// `node tools/perf/combine-budgets.ts <folder>` — in CI's `perf` job, after
// the work budgets were done in parts on machines of their own: reads each
// part's `budgets.<part>.json` under <folder>, and fails if any budgeted
// action was not counted on each of the PERF_BUDGETS_RUNS runs, or not timed,
// by exactly one part, or if a run counted on a machine apart from run 1
// counted differently from it (RUN_TOLERANCE, as within one machine). Prints
// the one report of the whole run, into the job summary too. The part that
// counted run 1 has already held it to the budgets.
import { appendFile, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BUDGETED_ACTIONS, RUN_TOLERANCE } from './budgeted-actions.ts';
import {
  combineParts,
  measurementsOf,
  reportTable,
  type BudgetsFile,
  type PartResult,
} from './work-budgets.ts';

const BUDGETS_FILE = new URL('./budgets.json', import.meta.url);

async function partsUnder(folder: string): Promise<PartResult[]> {
  const files = (await readdir(folder, { recursive: true })).filter((file) =>
    /(^|\/)budgets\.[^/]+\.json$/.test(file),
  );
  return Promise.all(
    files.map(async (file) => JSON.parse(await readFile(join(folder, file), 'utf8')) as PartResult),
  );
}

async function main(): Promise<void> {
  const folder = process.argv[2];
  if (folder === undefined) {
    console.error('usage: node tools/perf/combine-budgets.ts <folder of the parts>');
    process.exit(2);
  }
  const parts = await partsUnder(folder);
  const budgets = JSON.parse(await readFile(BUDGETS_FILE, 'utf8')) as BudgetsFile;
  const runs = Number(process.env.PERF_BUDGETS_RUNS ?? 1);
  if (!Number.isInteger(runs) || runs < 1) {
    console.error(`PERF_BUDGETS_RUNS must be a whole number of runs, 1 or more`);
    process.exit(2);
  }
  const { result, problems } = combineParts(parts, BUDGETED_ACTIONS, {
    runs,
    tolerance: RUN_TOLERANCE,
  });
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
