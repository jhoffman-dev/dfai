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

interface HostingEntry {
  readonly target?: unknown;
  readonly site?: unknown;
  readonly public?: unknown;
  readonly headers?: readonly { source?: unknown; headers?: { key: string; value: string }[] }[];
}

const asList = (hosting: unknown): readonly HostingEntry[] =>
  Array.isArray(hosting) ? hosting : [hosting as HostingEntry];

/** firebase.json: hosting only, and every entry deploys through the `web` target. */
export function firebaseJsonProblems(config: Record<string, unknown>): string[] {
  const problems = Object.keys(config)
    .filter((key) => key !== 'hosting')
    .map((key) => `firebase.json configures "${key}"; only hosting is deployed from here`);
  if (config.hosting === undefined) return [...problems, 'firebase.json has no hosting entry'];
  for (const entry of asList(config.hosting)) {
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

/**
 * The workflow: no `firebase deploy` that is not `--only hosting:web`, and
 * every use of the deploy action names the project and the `web` target.
 */
export function workflowProblems(workflow: string): string[] {
  const code = withoutComments(workflow);
  const problems: string[] = [];
  for (const match of code.matchAll(/firebase\s+deploy\b[^\n]*/g)) {
    if (!new RegExp(`--only[ =]hosting:${TARGET}(?![\\w:,-])`).test(match[0]))
      problems.push(`"${match[0].trim()}" is not --only hosting:${TARGET}`);
  }
  const steps = code.split(/\n\s*- /).filter((step) => step.includes('action-hosting-deploy'));
  if (steps.length === 0) problems.push('the workflow never uses action-hosting-deploy');
  for (const step of steps) {
    if (!new RegExp(`\\btarget:\\s*${TARGET}\\s*$`, 'm').test(step))
      problems.push('a deploy step does not name target: ' + TARGET);
    if (!new RegExp(`\\bprojectId:\\s*${PROJECT}\\s*$`, 'm').test(step))
      problems.push('a deploy step does not name projectId: ' + PROJECT);
  }
  return problems;
}
