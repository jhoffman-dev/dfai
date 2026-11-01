import { isDeepStrictEqual } from 'node:util';
import { parse } from 'yaml';

/*
 * The deploy workflow, held to an allowlist rather than searched for bad
 * patterns (#662, PR #700's attack): .github/workflows/web-hosting.yml is
 * parsed (anchors and aliases resolved) and must be, job for job and step for
 * step, the workflow described here. A change to it changes this file too,
 * so review sees both. Every other workflow may not touch Firebase at all,
 * and every workflow uses only the pinned actions listed here.
 */

export const DEPLOY_ACTION =
  'FirebaseExtended/action-hosting-deploy@500ac625ca2dd40cbd15f7659af953801858032a';

/** Every action any workflow may use, pinned by full commit SHA. */
export const ALLOWED_ACTIONS: ReadonlySet<string> = new Set([
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1',
  'pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413',
  'actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9',
  'actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9',
  'actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9',
  'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9',
  'actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333',
  'dtolnay/rust-toolchain@b725eda525362e7cf34af9a7243cac1e3f01a7ec',
  'Swatinem/rust-cache@d1527c8f67ef9af357290475d4af4b0fab8f12e0',
  './.github/workflows/gate.yml',
  DEPLOY_ACTION,
]);

export const HOSTING_CHECK = 'pnpm exec vitest run tools/ci/web-hosting.test.ts';
export const LIVE_ENVIRONMENT = 'web-live';

const KEY = 'FIREBASE_SERVICE_ACCOUNT_DAILYFLOWAI_APP';
const KEY_SET = "steps.key.outputs.set == 'true'";
const HAS_KEY = `\${{ secrets.${KEY} != '' }}`;
const SERVICE_ACCOUNT = `\${{ secrets.${KEY} }}`;
const REPO_TOKEN = '${{ secrets.GITHUB_TOKEN }}';

type Json = unknown;
type Step = Record<string, Json>;

const keyStep: Step = {
  id: 'key',
  env: { HAS_KEY },
  run:
    'echo "set=$HAS_KEY" >> "$GITHUB_OUTPUT"\n' +
    `[ "$HAS_KEY" = true ] || echo "::notice::${KEY} is not set; skipping the deploy."\n`,
};

const checkStep: Step = { if: KEY_SET, env: { WEB_DIST_REQUIRED: '1' }, run: HOSTING_CHECK };

/** What every deploy job does before it deploys, in this order. */
const buildSteps: Step[] = [
  keyStep,
  {
    if: KEY_SET,
    uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    with: { 'persist-credentials': false },
  },
  {
    if: KEY_SET,
    uses: 'pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413',
    with: { version: 11 },
  },
  {
    if: KEY_SET,
    uses: 'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1',
    with: { 'node-version': 22, cache: 'pnpm' },
  },
  { if: KEY_SET, run: 'pnpm install --frozen-lockfile' },
  { if: KEY_SET, run: 'pnpm --filter @dfai/web build' },
  checkStep,
];

const deployWith = {
  repoToken: REPO_TOKEN,
  firebaseServiceAccount: SERVICE_ACCOUNT,
  projectId: 'dailyflowai-app',
  target: 'web',
  firebaseToolsVersion: '15.28.2',
};

const deployStep = (extra: Record<string, string>): Step => ({
  if: KEY_SET,
  uses: DEPLOY_ACTION,
  with: { ...deployWith, ...extra },
});

/** The two jobs, exactly: a preview of a same-repo pull request, and live from `web-live`. */
export const EXPECTED_JOBS: Readonly<Record<string, Record<string, Json>>> = {
  preview: {
    if: "github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository",
    'runs-on': 'ubuntu-latest',
    'timeout-minutes': 15,
    permissions: { contents: 'read', 'pull-requests': 'write', checks: 'write' },
    steps: [...buildSteps, deployStep({ expires: '7d' })],
  },
  live: {
    if: "github.event_name == 'push'",
    'runs-on': 'ubuntu-latest',
    'timeout-minutes': 15,
    environment: LIVE_ENVIRONMENT,
    permissions: { contents: 'read', checks: 'write' },
    steps: [...buildSteps, deployStep({ channelId: 'live' })],
  },
};

const TOP_LEVEL = new Set(['name', 'on', 'concurrency', 'permissions', 'defaults', 'jobs']);

const show = (value: Json) => JSON.stringify(value);
const isRecord = (value: Json): value is Record<string, Json> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Parsed with anchors, aliases and merge keys resolved, as the runner reads it. */
function parseWorkflow(text: string): Record<string, Json> | string {
  try {
    const parsed: Json = parse(text, { merge: true });
    return isRecord(parsed) ? parsed : 'the workflow is not a mapping';
  } catch (error) {
    return `the workflow does not parse: ${(error as Error).message}`;
  }
}

/** A step without its `name`, which may say anything but an expression. */
function withoutName(step: Json): Json {
  if (!isRecord(step)) return step;
  return Object.fromEntries(Object.entries(step).filter(([key]) => key !== 'name'));
}

function stepProblems(job: string, actual: Json[], expected: Step[]): string[] {
  const problems: string[] = [];
  for (const step of actual) {
    if (isRecord(step) && typeof step.name === 'string' && step.name.includes('${{'))
      problems.push(`job "${job}" has a step name with an expression: ${show(step.name)}`);
  }
  if (actual.length !== expected.length)
    problems.push(`job "${job}" has ${actual.length} steps, not ${expected.length}`);
  const bare = actual.map(withoutName);
  expected.forEach((step, at) => {
    if (!isDeepStrictEqual(bare[at], step))
      problems.push(`job "${job}" step ${at + 1} is ${show(bare[at])}, not ${show(step)}`);
  });
  return problems;
}

/** The two rules worth naming on their own, whatever else differs. */
function deployRuleProblems(job: string, actual: Record<string, Json>): string[] {
  const steps = Array.isArray(actual.steps) ? actual.steps.map(withoutName) : [];
  const deployAt = steps.findIndex((step) => isRecord(step) && step.uses === DEPLOY_ACTION);
  if (deployAt < 0) return [];
  const problems: string[] = [];
  const checkAt = steps.findIndex((step) => isDeepStrictEqual(step, checkStep));
  if (checkAt < 0 || checkAt > deployAt)
    problems.push(`job "${job}" deploys without first running exactly "${HOSTING_CHECK}"`);
  const deploy = steps[deployAt] as Record<string, Json>;
  const channel = isRecord(deploy.with) ? deploy.with.channelId : undefined;
  if (channel === 'live' && actual.environment !== LIVE_ENVIRONMENT)
    problems.push(`job "${job}" deploys live outside the ${LIVE_ENVIRONMENT} environment`);
  return problems;
}

function jobProblems(jobs: Json): string[] {
  if (!isRecord(jobs)) return ['the workflow has no jobs'];
  const problems: string[] = [];
  for (const [name, actual] of Object.entries(jobs)) {
    const expected = EXPECTED_JOBS[name];
    if (!expected || !isRecord(actual)) {
      problems.push(`job "${name}" is not one of the deploy jobs (preview, live)`);
      continue;
    }
    problems.push(...deployRuleProblems(name, actual));
    for (const key of new Set([...Object.keys(actual), ...Object.keys(expected)])) {
      if (key === 'steps') continue;
      if (!isDeepStrictEqual(actual[key], expected[key]))
        problems.push(`job "${name}" ${key} is ${show(actual[key])}, not ${show(expected[key])}`);
    }
    const steps = Array.isArray(actual.steps) ? actual.steps : [];
    problems.push(...stepProblems(name, steps, expected.steps as Step[]));
  }
  for (const name of Object.keys(EXPECTED_JOBS)) {
    if (!(name in jobs)) problems.push(`the workflow has no job "${name}"`);
  }
  return problems;
}

/** Pull requests and pushes to `main` only, over one path list. */
function triggerProblems(on: Json): string[] {
  const ok =
    isRecord(on) &&
    isDeepStrictEqual(Object.keys(on).sort(), ['pull_request', 'push']) &&
    isRecord(on.push) &&
    isRecord(on.pull_request) &&
    isDeepStrictEqual(Object.keys(on.push).sort(), ['branches', 'paths']) &&
    isDeepStrictEqual(on.push.branches, ['main']) &&
    isDeepStrictEqual(Object.keys(on.pull_request), ['paths']) &&
    isDeepStrictEqual(on.push.paths, on.pull_request.paths);
  return ok ? [] : [`the workflow runs on ${show(on)}, not pushes to main and pull requests`];
}

/** Where a secret is allowed: the key check, and the deploy action's own inputs. */
function allowedSecret(path: readonly (string | number)[], value: string, root: Json): boolean {
  const [jobs, job, steps, at, block, key] = path;
  if (path.length !== 6 || jobs !== 'jobs' || steps !== 'steps') return false;
  if (block === 'env') return key === 'HAS_KEY' && value === HAS_KEY;
  if (block !== 'with') return false;
  const step = (root as { jobs: Record<string, { steps: Step[] }> }).jobs[String(job)]?.steps[
    Number(at)
  ];
  if (step?.uses !== DEPLOY_ACTION) return false;
  return (
    (key === 'firebaseServiceAccount' && value === SERVICE_ACCOUNT) ||
    (key === 'repoToken' && value === REPO_TOKEN)
  );
}

function* strings(
  value: Json,
  path: (string | number)[] = [],
): Generator<[(string | number)[], string]> {
  if (typeof value === 'string') yield [path, value];
  else if (Array.isArray(value))
    for (const [i, item] of value.entries()) yield* strings(item, [...path, i]);
  else if (isRecord(value))
    for (const [key, item] of Object.entries(value)) {
      if (/\bsecrets\b/.test(key)) yield [[...path, key], key];
      yield* strings(item, [...path, key]);
    }
}

function secretProblems(root: Json): string[] {
  return [...strings(root)]
    .filter(([path, value]) => /\bsecrets\b/.test(value) && !allowedSecret(path, value, root))
    .map(([path]) => `${path.join('.')} hands a secret to more than the deploy action`);
}

/** Every action a workflow uses, from its steps and its reusable-workflow jobs. */
function usesOf(root: Record<string, Json>): string[] {
  const jobs = isRecord(root.jobs) ? Object.values(root.jobs) : [];
  return jobs.flatMap((job) => {
    if (!isRecord(job)) return [];
    const steps = Array.isArray(job.steps) ? job.steps : [];
    return [job.uses, ...steps.map((step) => (isRecord(step) ? step.uses : undefined))].filter(
      (uses): uses is string => typeof uses === 'string',
    );
  });
}

/** Any workflow: only the pinned actions. */
export function actionProblems(text: string): string[] {
  const root = parseWorkflow(text);
  if (typeof root === 'string') return [root];
  return usesOf(root)
    .filter((uses) => !ALLOWED_ACTIONS.has(uses))
    .map((uses) => `"${uses}" is not an allowed, SHA-pinned action`);
}

/** Any workflow but web-hosting.yml: nothing of Firebase at all. */
export function otherWorkflowProblems(file: string, text: string): string[] {
  const root = parseWorkflow(text);
  if (typeof root === 'string') return [`${file}: ${root}`];
  return [...strings(root)]
    .filter(([, value]) => /firebase|FIREBASE_SERVICE_ACCOUNT|action-hosting-deploy/i.test(value))
    .map(([path]) => `${file} ${path.join('.')} touches Firebase; only web-hosting.yml may`);
}

/** web-hosting.yml: exactly the workflow described above. */
export function workflowProblems(text: string): string[] {
  const root = parseWorkflow(text);
  if (typeof root === 'string') return [root];
  const problems = Object.keys(root)
    .filter((key) => !TOP_LEVEL.has(key))
    .map((key) => `the workflow sets "${key}" at the top level`);
  if (!isDeepStrictEqual(root.permissions, { contents: 'read' }))
    problems.push(
      `the workflow permissions are ${show(root.permissions)}, not {"contents":"read"}`,
    );
  if (!isDeepStrictEqual(root.defaults, { run: { shell: 'bash' } }))
    problems.push(`the workflow defaults are ${show(root.defaults)}`);
  return [
    ...problems,
    ...triggerProblems(root.on),
    ...jobProblems(root.jobs),
    ...secretProblems(root),
    ...actionProblems(text),
  ];
}

/** Package scripts: none may run Firebase, so no `run:` reaches it through one. */
export function scriptProblems(
  file: string,
  packageJson: { scripts?: Record<string, string> },
): string[] {
  return Object.entries(packageJson.scripts ?? {})
    .filter(([, script]) => /firebase/i.test(script))
    .map(([name]) => `${file} script "${name}" runs Firebase`);
}
