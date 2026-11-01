import { minimatch } from 'minimatch';

/*
 * What the web build's hosting config may say (#662), so a deploy can only
 * ever reach its own site. The Firebase project dailyflowai-app has a default
 * site, dailyflowai-app, serving something else; the web build goes to the
 * site dailyflowai-web through the hosting target `web`, and nowhere else.
 *
 * Each check returns the problems it found, worded for a failing test.
 */

export const PROJECT = 'dailyflowai-app';
export const TARGET = 'web';
export const SITE = 'dailyflowai-web';
export const LIVE_ENVIRONMENT = 'web-live';

/** The command each deploy job runs before it deploys. */
export const HOSTING_CHECK = 'pnpm exec vitest run tools/ci/web-hosting.test.ts';

interface HostingEntry {
  readonly target?: unknown;
  readonly site?: unknown;
}

const asList = (hosting: unknown): readonly HostingEntry[] =>
  Array.isArray(hosting) ? hosting : [hosting as HostingEntry];

/** firebase.json: hosting only, and every entry deploys through the `web` target. */
export function firebaseJsonProblems(config: Record<string, unknown>): string[] {
  const problems = Object.keys(config)
    .filter((key) => key !== 'hosting')
    .map((key) => `firebase.json configures "${key}"; only hosting is deployed from here`);
  if (config.hosting === undefined) return [...problems, 'firebase.json has no hosting entry'];
  const entries = asList(config.hosting);
  if (entries.length === 0) problems.push('firebase.json has an empty hosting list');
  for (const entry of entries) {
    if (entry.site !== undefined)
      problems.push(`a hosting entry names site "${String(entry.site)}"; use the target`);
    if (entry.target !== TARGET)
      problems.push(`a hosting entry has target "${String(entry.target)}", not "${TARGET}"`);
  }
  return problems;
}

/** .firebaserc: the one project, and the `web` target mapped to the web site alone. */
export function firebasercProblems(rc: {
  projects?: Record<string, string>;
  targets?: Record<string, Record<string, Record<string, string[]>>>;
}): string[] {
  const problems: string[] = [];
  const projects = Object.values(rc.projects ?? {});
  if (projects.length !== 1 || projects[0] !== PROJECT)
    problems.push(`.firebaserc projects are ${JSON.stringify(projects)}, not ["${PROJECT}"]`);
  const targets = rc.targets ?? {};
  for (const project of Object.keys(targets)) {
    if (project !== PROJECT) problems.push(`.firebaserc has targets in project "${project}"`);
  }
  const hosting = targets[PROJECT]?.hosting ?? {};
  for (const [target, sites] of Object.entries(hosting)) {
    if (target !== TARGET) problems.push(`.firebaserc has hosting target "${target}"`);
    if (sites.length !== 1 || sites[0] !== SITE)
      problems.push(`target "${target}" maps to ${JSON.stringify(sites)}, not ["${SITE}"]`);
  }
  if (!(TARGET in hosting)) problems.push(`.firebaserc does not map target "${TARGET}"`);
  return problems;
}

/** What firebase-tools' listFiles always leaves out, before the config's own `ignore`. */
const CLI_IGNORES = ['**/firebase-debug.log', '**/firebase-debug.*.log', '.firebase/*'];

/**
 * The files a deploy uploads, of `paths` (relative to `public`, `/`-separated),
 * matched as firebase-tools does: glob's ignore list, which is minimatch with
 * `dot: true`. A pattern skips a file, not a folder's contents, unless it
 * reaches inside the folder — `**\/.*` alone uploads `.vite/x.json`.
 */
export function uploadedFiles(paths: readonly string[], ignore: readonly string[]): string[] {
  const patterns = [...CLI_IGNORES, ...ignore];
  return paths.filter(
    (path) => !patterns.some((pattern) => minimatch(path, pattern, { dot: true })),
  );
}

/** A file under a dot-folder, or a dotfile: never served. */
export const isDotPath = (path: string) => path.split('/').some((part) => part.startsWith('.'));

const directives = (policy: string) =>
  policy
    .split(';')
    .map((part) => part.trim().replace(/\s+/g, ' '))
    .filter(Boolean);

/** The page's own policy, from index.html's meta tag. */
export function metaCsp(html: string): string | undefined {
  return /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(html)?.[1];
}

/**
 * The served policy must say what the page's meta tag says, so neither loosens
 * the other unnoticed, plus `frame-ancestors 'none'`, which only a header can carry.
 */
export function cspHeaderProblems(header: string, meta: string): string[] {
  const served = new Set(directives(header));
  const problems = directives(meta)
    .filter((directive) => !served.has(directive))
    .map((directive) => `the CSP header lacks the page's "${directive}"`);
  const expected = new Set([...directives(meta), "frame-ancestors 'none'"]);
  for (const directive of served) {
    if (!expected.has(directive))
      problems.push(`the CSP header adds "${directive}", which the page does not have`);
  }
  if (!served.has("frame-ancestors 'none'"))
    problems.push("the CSP header lacks frame-ancestors 'none'");
  return problems;
}

const withoutComments = (text: string) =>
  text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

/** `firebase deploy`, `firebase-tools deploy`, `firebase hosting:channel:deploy`. */
const DEPLOY_COMMAND =
  /\bfirebase(?:-tools)?(?:@\S+)?\s+(deploy|hosting:channel:deploy)\b[^\n;&|]*/g;

function commandProblems(code: string): string[] {
  const problems: string[] = [];
  for (const [command, verb] of code.matchAll(DEPLOY_COMMAND)) {
    // `deploy` scopes by service (`hosting:web`); a channel deploy by target name alone.
    const only = verb === 'deploy' ? `hosting:${TARGET}` : TARGET;
    if (!new RegExp(`--only[ =]${only}(?![\\w:,-])`).test(command))
      problems.push(`"${command.trim()}" is not --only ${only}`);
  }
  for (const [flag, project] of code.matchAll(/(?:--project|\s-P)[ =](\S+)/g)) {
    if (project !== PROJECT)
      problems.push(`"${flag.trim()}" names a project other than ${PROJECT}`);
  }
  return problems;
}

/** Each job under `jobs:`, by name, as its text. */
function jobsOf(code: string): Map<string, string> {
  const body = code.split(/^jobs:\s*$/m)[1] ?? '';
  const jobs = new Map<string, string>();
  for (const part of body.split(/^(?= {2}[\w-]+:\s*$)/m)) {
    const name = /^ {2}([\w-]+):/.exec(part)?.[1];
    if (name) jobs.set(name, part);
  }
  return jobs;
}

function deployJobProblems(name: string, job: string): string[] {
  const problems: string[] = [];
  const deployAt = job.indexOf('action-hosting-deploy');
  const checkAt = job.indexOf(HOSTING_CHECK);
  if (checkAt < 0 || checkAt > deployAt)
    problems.push(`job "${name}" deploys without first running ${HOSTING_CHECK}`);
  if (
    /^\s*channelId:\s*live\s*$/m.test(job) &&
    !new RegExp(`^ {4}environment:\\s*${LIVE_ENVIRONMENT}\\s*$`, 'm').test(job)
  )
    problems.push(`job "${name}" deploys live outside the ${LIVE_ENVIRONMENT} environment`);
  for (const step of job.split(/\n\s*- /).filter((s) => s.includes('action-hosting-deploy'))) {
    if (!new RegExp(`\\btarget:\\s*${TARGET}\\s*$`, 'm').test(step))
      problems.push(`a deploy step in "${name}" does not name target: ${TARGET}`);
    if (!new RegExp(`\\bprojectId:\\s*${PROJECT}\\s*$`, 'm').test(step))
      problems.push(`a deploy step in "${name}" does not name projectId: ${PROJECT}`);
  }
  return problems;
}

/** Where a secret may appear: handed to the deploy action, or asked whether it is set. */
const SECRET_USES = [
  /^\s*firebaseServiceAccount:\s*\$\{\{\s*secrets\.\w+\s*\}\}\s*$/,
  /^\s*repoToken:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}\s*$/,
  /^\s*\w+:\s*\$\{\{\s*secrets\.\w+\s*!=\s*''\s*\}\}\s*$/,
];

/**
 * A secret anywhere else (a job's env, a step's env, a `run`) reaches code
 * other than the deploy action: `pnpm install` and the build run third-party code.
 */
function secretUseProblems(code: string): string[] {
  return code
    .split('\n')
    .filter((line) => line.includes('secrets.') && !SECRET_USES.some((use) => use.test(line)))
    .map((line) => `"${line.trim()}" hands a secret to more than the deploy action`);
}

/**
 * The workflow: every deploy command limited to the `web` target and the one
 * project; every job that deploys runs the hosting checks first, names the
 * project and target, and deploys live only from the live environment; and a
 * secret reaches the deploy action alone.
 */
export function workflowProblems(workflow: string): string[] {
  const code = withoutComments(workflow);
  const deployJobs = [...jobsOf(code)].filter(([, job]) => job.includes('action-hosting-deploy'));
  return [
    ...commandProblems(code),
    ...(deployJobs.length === 0 ? ['the workflow never uses action-hosting-deploy'] : []),
    ...deployJobs.flatMap(([name, job]) => deployJobProblems(name, job)),
    ...secretUseProblems(code),
  ];
}
