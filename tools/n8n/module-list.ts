import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleForm, type ModuleForm } from './module-form.ts';
import { namesFromOutside } from './run-names.ts';

/*
 * A Code node's modules are a hand-kept list (#825): the order is the bytes of
 * the built workflow, so it is checked rather than derived. Anything that would
 * make the built node throw in n8n — a module missing, listed twice, or written
 * in a form the build cannot inline, a name defined twice or never — is a
 * problem, and so is a listed module nothing uses.
 */

/** Where list entries resolve from: tools/n8n, as `moduleScript` reads them. */
const BASE = new URL('./', import.meta.url);

interface Listed extends ModuleForm {
  readonly name: string;
  readonly url: string;
}

/** A module's place, as a list here would name it: from tools/n8n. */
const shown = (url: string) => relative(fileURLToPath(BASE), fileURLToPath(url));

const repeats = (values: readonly string[]) => [
  ...new Set(values.filter((each, at) => values.indexOf(each) !== at)),
];

function formProblems(listed: readonly Listed[]): string[] {
  const twice = repeats(listed.map(({ url }) => url)).map(
    (url) => `${shown(url)} is listed more than once: its names would be declared twice`,
  );
  const forms = listed.flatMap(({ name, problems }) => problems.map((each) => `${name}: ${each}`));
  const once = listed.filter((each, at) => listed.findIndex(({ url }) => url === each.url) === at);
  const names = repeats(once.flatMap(({ exports }) => exports));
  const clashes = names.map((each) => `${each} is exported by more than one listed module`);
  return [...twice, ...forms, ...clashes];
}

function missingImports(listed: readonly Listed[]): string[] {
  return listed.flatMap(({ name, imports }, at) =>
    imports
      .filter((dep) => !listed.slice(0, at).some((each) => each.url === dep))
      .map((dep) => `${name} imports ${shown(dep)}, which is not listed before it`),
  );
}

/** Names a node's lines may use that no module defines: n8n's `$…` and JavaScript's own. */
const fromHost = (name: string) => name.startsWith('$') || name in globalThis;

function undefinedNames(listed: readonly Listed[], used: ReadonlySet<string>): string[] {
  const exported = new Set(listed.flatMap(({ exports }) => exports));
  return [...used]
    .filter((name) => !exported.has(name) && !fromHost(name))
    .map((name) => `the node uses ${name}, which no listed module exports`);
}

function unusedModules(listed: readonly Listed[], used: ReadonlySet<string>): string[] {
  const imported = new Set(listed.flatMap(({ imports }) => imports));
  return listed
    .filter(({ url, exports }) => !imported.has(url) && !exports.some((each) => used.has(each)))
    .map(({ name }) => `${name} is listed, but no listed module imports it and no node uses it`);
}

/**
 * What is wrong with one Code-node module list, given the `run` lines of
 * every node built from it and the names something other than a listed module
 * defines in the node (`provided`, such as a bundle's global). An empty answer
 * means the list is right.
 */
export function moduleListProblems(
  modules: readonly string[],
  runs: readonly string[],
  provided: readonly string[] = [],
): string[] {
  const listed = modules.map((name) => {
    const url = new URL(name, BASE);
    return { name, url: url.href, ...moduleForm(url) };
  });
  const used = new Set(runs.flatMap((run) => [...namesFromOutside(run)]));
  for (const name of provided) used.delete(name);
  return [
    ...formProblems(listed),
    ...missingImports(listed),
    ...undefinedNames(listed, used),
    ...unusedModules(listed, used),
  ];
}
