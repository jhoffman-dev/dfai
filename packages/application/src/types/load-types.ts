import {
  createVaultPath,
  isBlankFrontmatter,
  noteTitle,
  objectTypeProblems,
  opensUnclosedFrontmatter,
  parseObjectType,
  splitFrontmatter,
  TYPES_DIRECTORY,
  type ObjectType,
  type VaultPath,
} from '@dfai/domain';
import type { NoteFile, VaultFsPort } from '../vault/ports.ts';
import type { MarkdownPort } from '../notes/ports.ts';

/** Where a vault keeps its type definitions. */
export const TYPES_FOLDER = TYPES_DIRECTORY;

/** A type as the vault defines it: the definition, and the file it is written in. */
export interface DefinedType extends ObjectType {
  readonly path: VaultPath;
}

/**
 * A type file that does not read whole, and why: listed where types are
 * managed (#683). It may still have loaded, without what it says is wrong.
 */
export interface BrokenType {
  readonly path: VaultPath;
  /** The file's name without `.md`: the block that would name the type may not read. */
  readonly name: string;
  readonly problem: string;
}

/** The vault's types, and the type files that do not read whole. */
export interface TypeListing {
  readonly types: readonly DefinedType[];
  readonly broken: readonly BrokenType[];
}

/**
 * Reads the type definitions out of the vault.
 *
 * Types are ordinary notes, so they can be edited in any editor and travel with
 * the vault. A definition that cannot be read is skipped rather than failing the
 * others: one malformed file should not cost you every type you have.
 */
export async function loadObjectTypes({
  fs,
  markdown,
}: {
  fs: VaultFsPort;
  markdown: Pick<MarkdownPort, 'frontmatterProperties'>;
}): Promise<DefinedType[]> {
  const types: DefinedType[] = [];
  for (const file of await readTypeFiles(fs)) {
    const frontmatter = propertiesOf(blockOf(file), markdown);
    const type = frontmatter === null ? null : definedType(file, frontmatter);
    if (type !== null) types.push(type);
  }
  return types.sort(byName);
}

/**
 * The types, as `loadObjectTypes` reads them, and beside them every type file
 * that does not read whole, with why: frontmatter that is not YAML or never
 * closes, a type with no name, a property it leaves out. A file with no
 * frontmatter, or frontmatter with none of a type's keys, is neither.
 */
export async function loadTypeListing({
  fs,
  markdown,
}: {
  fs: VaultFsPort;
  markdown: Pick<MarkdownPort, 'frontmatterProperties' | 'frontmatterProblem'>;
}): Promise<TypeListing> {
  const types: DefinedType[] = [];
  const broken: BrokenType[] = [];
  for (const file of await readTypeFiles(fs)) {
    const { type, problem } = readTypeFile(file, markdown);
    if (type !== null) types.push(type);
    if (problem !== null) broken.push(brokenType(file.path, problem));
  }
  return { types: types.sort(byName), broken: broken.sort(byName) };
}

/** One type file: the type it defines, if any, and what keeps it from reading whole. */
function readTypeFile(
  file: NoteFile,
  markdown: Pick<MarkdownPort, 'frontmatterProperties' | 'frontmatterProblem'>,
): { type: DefinedType | null; problem: string | null } {
  // An unclosed or unreadable block, or one that is a list or one value, reads as
  // no properties, so it would be skipped as no type: in the types folder it most
  // likely is one, gone without a word (#683). In the words PR #682 gives a rule
  // file in the same state (its readRuleBlock), so the two read alike.
  if (opensUnclosedFrontmatter(file.text)) {
    return { type: null, problem: 'Its frontmatter has no closing ---.' };
  }
  const block = blockOf(file);
  const unreadable = markdown.frontmatterProblem(block);
  if (unreadable !== null) {
    return { type: null, problem: `Its frontmatter is not valid YAML: ${unreadable}` };
  }
  const frontmatter = propertiesOf(block, markdown);
  if (frontmatter === null) return { type: null, problem: null };
  if (block !== null && !isBlankFrontmatter(block) && Object.keys(frontmatter).length === 0) {
    return { type: null, problem: 'Its frontmatter is not a set of properties.' };
  }
  const problems = objectTypeProblems(frontmatter);
  return {
    type: definedType(file, frontmatter),
    problem: problems.length === 0 ? null : problems.join(' '),
  };
}

async function readTypeFiles(fs: VaultFsPort): Promise<readonly NoteFile[]> {
  let paths: VaultPath[];
  try {
    const entries = await fs.listDirectory(createVaultPath(TYPES_FOLDER));
    paths = entries
      .filter((entry) => entry.kind === 'file' && entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => entry.path);
  } catch {
    // A vault with no .atlas/types folder simply has no types yet.
    return [];
  }
  return paths.length === 0 ? [] : fs.readNotes(paths);
}

function blockOf(file: NoteFile): string | null {
  return splitFrontmatter(file.text).frontmatter;
}

function propertiesOf(
  block: string | null,
  markdown: Pick<MarkdownPort, 'frontmatterProperties'>,
): Record<string, unknown> | null {
  try {
    return markdown.frontmatterProperties(block);
  } catch {
    // Skipped: a block the port cannot read costs that one type, nothing else.
    return null;
  }
}

function definedType(file: NoteFile, frontmatter: Record<string, unknown>): DefinedType | null {
  try {
    return { ...parseObjectType(frontmatter), path: createVaultPath(file.path) };
  } catch {
    // Skipped: a broken definition costs that one type, nothing else.
    return null;
  }
}

function brokenType(path: string, problem: string): BrokenType {
  const vaultPath = createVaultPath(path);
  return { path: vaultPath, name: noteTitle(vaultPath), problem };
}

function byName(left: { readonly name: string }, right: { readonly name: string }): number {
  return left.name.localeCompare(right.name);
}

/** The type a note declares, or null when it declares none. */
export function noteTypeName(frontmatter: Readonly<Record<string, unknown>>): string | null {
  const declared = frontmatter['type'];
  const name = declared === undefined || declared === null ? '' : String(declared).trim();
  return name === '' ? null : name;
}
