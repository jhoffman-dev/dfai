// Converts a DFAI vault into a DFAI Lite vault, leaving the source untouched:
// `node tools/migrate-from-dfai.ts <dfai vault dir> <new empty output dir>`.
// Plain Node, no dependencies, erasable TypeScript only.
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAVORITES_PATH, serializeFavorites } from '../src/domain/favorites/index.ts';
import { moveResolvers, retargetLinks } from '../src/domain/links/index.ts';
import { foldedPath } from '../src/domain/vault/index.ts';
import { buildIndex, runSummary, type IndexRun } from './build-index.ts';
import { convertNote, uniquePath, type ConversionRule } from './dfai-convert.ts';
import { listFiles } from './vault-files.ts';

/** DFAI's caches and state, and what is never part of a vault. */
const SKIPPED = new Set(['.atlas', '.atlas-cache', '.git', 'node_modules', '_index']);
const TEMPLATE = fileURLToPath(new URL('../vault-template/', import.meta.url));
/** What a new vault needs from the template, when the source has none of its own. */
const TEMPLATE_FILES = ['CLAUDE.md', '.github/workflows/index.yml'];

export interface MigrationReport {
  readonly counts: Readonly<
    Record<ConversionRule | 'copied' | 'favorite' | 'linksRewritten', number>
  >;
  /** Every note that lost a property, and which. */
  readonly dropped: readonly { readonly path: string; readonly keys: readonly string[] }[];
  /** `from → to` for every note whose new path was already taken. */
  readonly collisions: readonly string[];
  readonly templateFiles: readonly string[];
  readonly index: IndexRun;
}

interface PlannedNote {
  readonly from: string;
  readonly to: string;
  readonly text: string;
}

export async function migrate(source: string, output: string): Promise<MigrationReport> {
  await assertSafeOutput(resolve(source), resolve(output));
  await mkdir(output, { recursive: true });
  const files = await listFiles(source, SKIPPED);
  const counts = {
    plain: 0,
    frontmatter: 0,
    meeting: 0,
    person: 0,
    copied: 0,
    favorite: 0,
    linksRewritten: 0,
  };
  const dropped: { path: string; keys: readonly string[] }[] = [];
  const collisions: string[] = [];
  const taken = new Set<string>();
  const notes: PlannedNote[] = [];
  const favorites: string[] = [];
  for (const file of files.filter(({ path }) => !isMarkdown(path))) {
    taken.add(foldedPath(file.path));
    await copyInto(output, file.path, file.absolute);
    counts.copied += 1;
  }
  const converted = await Promise.all(
    files
      .filter(({ path }) => isMarkdown(path))
      .map(async (file) => ({
        file,
        converted: convertNote({ path: file.path, text: await readFile(file.absolute, 'utf8') }),
      })),
  );
  // Notes that stay put claim their paths first, so a note moving in is the one renamed.
  const stayersFirst = [
    ...converted.filter((entry) => entry.converted.path === entry.file.path),
    ...converted.filter((entry) => entry.converted.path !== entry.file.path),
  ];
  for (const { file, converted } of stayersFirst) {
    const to = uniquePath(converted.path, taken);
    if (to !== converted.path) collisions.push(`${file.path} → ${to}`);
    taken.add(foldedPath(to));
    counts[converted.rule] += 1;
    if (converted.favorite) favorites.push(to);
    if (converted.dropped.length > 0) dropped.push({ path: file.path, keys: converted.dropped });
    notes.push({ from: file.path, to, text: converted.text });
  }
  counts.linksRewritten = await writeNotes(output, notes);
  counts.favorite = favorites.length;
  if (favorites.length > 0) await writeInto(output, FAVORITES_PATH, serializeFavorites(favorites));
  const templateFiles = await copyTemplate(output, taken);
  const index = await buildIndex(output);
  return { counts, dropped, collisions, templateFiles, index };
}

/** Writes the notes at their new paths, re-pointing links a move or rename broke. Returns links rewritten. */
async function writeNotes(output: string, notes: readonly PlannedNote[]): Promise<number> {
  const resolvers = moveResolvers({
    before: notes.map(({ from }) => from),
    after: notes.map(({ to }) => to),
    moved: new Map(notes.filter(({ from, to }) => from !== to).map(({ from, to }) => [from, to])),
  });
  let rewritten = 0;
  for (const note of notes) {
    const { text, count } = retargetLinks(note.text, resolvers);
    rewritten += count;
    await writeInto(output, note.to, text);
  }
  return rewritten;
}

async function copyTemplate(output: string, taken: ReadonlySet<string>): Promise<string[]> {
  const copied: string[] = [];
  for (const path of TEMPLATE_FILES) {
    if (taken.has(foldedPath(path))) continue;
    await copyInto(output, path, join(TEMPLATE, ...path.split('/')));
    copied.push(path);
  }
  return copied;
}

/** Refuses an output folder that holds anything, or sits inside the source. */
async function assertSafeOutput(source: string, output: string): Promise<void> {
  const sourceFolder = await stat(source).catch(() => null);
  if (sourceFolder === null || !sourceFolder.isDirectory()) {
    throw new MigrationRefused(`The DFAI vault is not a folder: ${source}`);
  }
  if (output === source || output.startsWith(`${source}${sep}`)) {
    throw new MigrationRefused('The output folder is inside the DFAI vault: pick one outside it.');
  }
  const entries = await readdir(output).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  if (entries.length > 0) {
    throw new MigrationRefused(`The output folder is not empty: ${output}`);
  }
}

export class MigrationRefused extends Error {
  override readonly name = 'MigrationRefused';
}

const isMarkdown = (path: string): boolean => path.toLowerCase().endsWith('.md');

async function copyInto(root: string, path: string, from: string): Promise<void> {
  const to = join(root, ...path.split('/'));
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
}

async function writeInto(root: string, path: string, text: string): Promise<void> {
  const to = join(root, ...path.split('/'));
  await mkdir(dirname(to), { recursive: true });
  await writeFile(to, text, 'utf8');
}

/** What the tool prints: counts by rule, then every dropped property and name clash. */
export function reportLines(report: MigrationReport, output: string): string[] {
  const { counts } = report;
  return [
    `Migrated into ${output}:`,
    `  ${counts.meeting} meetings → Meetings/<YYYY>/<MM>/, ${counts.person} people → People/, ${counts.frontmatter} other notes had frontmatter converted, ${counts.plain} notes copied as they were.`,
    `  ${counts.copied} other files copied, ${counts.favorite} favourites, ${counts.linksRewritten} links re-pointed after moves.`,
    `  From the template: ${report.templateFiles.length === 0 ? 'nothing (the vault had its own)' : report.templateFiles.join(', ')}.`,
    `  ${runSummary(report.index)}`,
    `Properties dropped, by key: ${droppedByKey(report.dropped)}. By note (${report.dropped.length}):`,
    ...report.dropped.map(({ path, keys }) => `  ${path}: ${keys.join(', ')}`),
    `Name collisions (${report.collisions.length}):`,
    ...report.collisions.map((line) => `  ${line}`),
  ];
}

function droppedByKey(dropped: MigrationReport['dropped']): string {
  const counts = new Map<string, number>();
  for (const { keys } of dropped)
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  if (counts.size === 0) return 'none';
  return [...counts]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([key, count]) => `${key} ${count}`)
    .join(', ');
}

async function main(args: readonly string[]): Promise<number> {
  const [source, output] = args;
  if (source === undefined || output === undefined || args.length !== 2) {
    console.error('Usage: node tools/migrate-from-dfai.ts <dfai vault dir> <new empty output dir>');
    return 2;
  }
  try {
    const report = await migrate(source, output);
    console.log(reportLines(report, output).join('\n'));
    return 0;
  } catch (error) {
    if (!(error instanceof MigrationRefused)) throw error;
    console.error(error.message);
    return 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
