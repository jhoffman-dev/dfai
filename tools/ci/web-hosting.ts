import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { minimatch } from 'minimatch';

/*
 * What the web build's hosting config may say (#662), so a deploy can only
 * ever reach its own site. The Firebase project dailyflowai-app has a default
 * site, dailyflowai-app, serving something else; the web build goes to the
 * site dailyflowai-web through the hosting target `web`, and nowhere else.
 * The deploy workflow's own checks are in web-hosting-workflow.ts.
 *
 * Each check returns the problems it found, worded for a failing test.
 */

export const PROJECT = 'dailyflowai-app';
export const TARGET = 'web';
export const SITE = 'dailyflowai-web';

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

/** The `ignore` firebase.json must carry: dotfiles, and everything in a dot-folder. */
export const UPLOAD_IGNORE: readonly string[] = ['**/.*', '**/.*/**'];

/** What firebase-tools' listFiles always leaves out, before the config's own `ignore`. */
const CLI_IGNORES = ['**/firebase-debug.log', '**/firebase-debug.*.log', '.firebase/*'];

/**
 * The list is held to UPLOAD_IGNORE exactly rather than interpreted: glob
 * drops a `!` pattern from an ignore list where minimatch would negate it,
 * and a list nobody has checked against firebase-tools is a guess.
 */
export function ignoreProblems(ignore: readonly string[]): string[] {
  const problems = ignore
    .filter((pattern) => pattern.startsWith('!'))
    .map((pattern) => `ignore pattern "${pattern}" is dropped by firebase-tools (no negations)`);
  if (JSON.stringify(ignore) !== JSON.stringify(UPLOAD_IGNORE))
    problems.push(`ignore is ${JSON.stringify(ignore)}, not ${JSON.stringify(UPLOAD_IGNORE)}`);
  return problems;
}

/** One ignore pattern as glob's ignore list reads it: `x/**` covers `x` too. */
const ignoredBy = (pattern: string) => (path: string) =>
  minimatch(path, pattern, { dot: true }) ||
  (pattern.endsWith('/**') && minimatch(path, pattern.slice(0, -3), { dot: true }));

/**
 * The files a deploy uploads, of `paths` (relative to `public`, `/`-separated),
 * matched as firebase-tools' listFiles does on Linux: glob with `dot: true`,
 * case-sensitive, negations dropped. A pattern skips a file, not a folder's
 * contents, unless it reaches inside the folder: `**\/.*` alone uploads `.vite/x.json`.
 */
export function uploadedFiles(paths: readonly string[], ignore: readonly string[]): string[] {
  const patterns = [...CLI_IGNORES, ...ignore.filter((pattern) => !pattern.startsWith('!'))];
  return paths.filter((path) => !patterns.some((pattern) => ignoredBy(pattern)(path)));
}

/** A file under a dot-folder, or a dotfile: never served. */
export const isDotPath = (path: string) => path.split('/').some((part) => part.startsWith('.'));

/** Every entry under `root`, links not followed: its files and its symlinks, `/`-separated. */
export function walkPublic(root: string): { files: string[]; symlinks: string[] } {
  const files: string[] = [];
  const symlinks: string[] = [];
  const visit = (dir: string, prefix: string) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = `${prefix}${entry.name}`;
      if (entry.isSymbolicLink()) symlinks.push(path);
      else if (entry.isDirectory()) visit(join(dir, entry.name), `${path}/`);
      else files.push(path);
    }
  };
  visit('', '');
  return { files, symlinks };
}

/**
 * What is wrong with uploading `root` under `ignore`. firebase-tools follows
 * symlinks, so a link can ship a dot-folder under a plain name or a file from
 * outside the build: any symlink at all is refused.
 */
export function publicDirProblems(root: string, ignore: readonly string[]): string[] {
  const { files, symlinks } = walkPublic(root);
  return [
    ...ignoreProblems(ignore),
    ...symlinks.map((path) => `"${path}" is a symlink, which firebase-tools would follow`),
    ...uploadedFiles(files, ignore)
      .filter(isDotPath)
      .map((path) => `"${path}" would be uploaded`),
  ];
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
