import {
  createVaultPath,
  noteTitle,
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

/** A type file whose frontmatter cannot be read, and why: listed where types are managed (#683). */
export interface BrokenType {
  readonly path: VaultPath;
  /** The file's name without `.md`: the block that would name the type cannot be read. */
  readonly name: string;
  readonly problem: string;
}

/** The vault's types, and the type files that cannot be read. */
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
    const type = definedType(file, blockOf(file), markdown);
    if (type !== null) types.push(type);
  }
  return types.sort(byName);
}

/**
 * The types, as `loadObjectTypes` reads them, and beside them every type file
 * whose frontmatter is not readable at all, with the parser's reason. A file
 * with no frontmatter, or readable frontmatter that is no type, is neither.
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
    const block = blockOf(file);
    // An unreadable block reads as no properties, so it would be skipped as no
    // type: in the types folder it most likely is one, gone without a word (#683).
    const problem = markdown.frontmatterProblem(block);
    if (problem !== null) {
      broken.push(unreadableType(file.path, problem));
      continue;
    }
    const type = definedType(file, block, markdown);
    if (type !== null) types.push(type);
  }
  return { types: types.sort(byName), broken: broken.sort(byName) };
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

function definedType(
  file: NoteFile,
  block: string | null,
  markdown: Pick<MarkdownPort, 'frontmatterProperties'>,
): DefinedType | null {
  try {
    const type = parseObjectType(markdown.frontmatterProperties(block));
    return { ...type, path: createVaultPath(file.path) };
  } catch {
    // Skipped: a broken definition costs that one type, nothing else.
    return null;
  }
}

function unreadableType(path: string, problem: string): BrokenType {
  const vaultPath = createVaultPath(path);
  return {
    path: vaultPath,
    name: noteTitle(vaultPath),
    problem: `Its frontmatter is not valid YAML: ${problem}`,
  };
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
