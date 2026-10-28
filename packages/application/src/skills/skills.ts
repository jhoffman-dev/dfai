import {
  createVaultPath,
  joinVaultPath,
  parentVaultPath,
  skillReadingOf,
  SKILL_FILE,
  skillFolderNamed,
  SKILLS_DIRECTORY,
  splitFrontmatter,
  type SkillReading,
  type VaultEntry,
  type VaultPath,
  vaultPathName,
} from '@dfai/domain';
import type { MarkdownPort } from '../notes/ports.ts';
import { VaultAccessError, type VaultFsPort } from '../vault/ports.ts';

/*
 * Reading the vault's skills (ADR-0050): every folder in `.atlas/skills`,
 * each read through its SKILL.md and held to the domain's rules. Only
 * SKILL.md is read; whatever else a folder holds is never opened.
 */

/** A skill as the list shows it: what it is, where it is, and what is wrong with it. */
export interface SkillSummary extends SkillReading {
  /** Its folder, as the disk spells it. */
  readonly folder: VaultPath;
  /** Its SKILL.md. */
  readonly path: VaultPath;
}

/** A skill read whole, with what a write needs to refuse a file changed since. */
export interface SkillFile extends SkillSummary {
  /** SKILL.md's whole text as read; '' when the folder has none. */
  readonly text: string;
  /** SKILL.md's modification time as read; null when the folder has none. */
  readonly modified: number | null;
  /** Why its frontmatter cannot be read, or null: such a skill is not saved over. */
  readonly frontmatterProblem: string | null;
  /** Why SKILL.md, though there, could not be read at all, or null: such a skill is not saved over or deleted. */
  readonly readFailure: string | null;
}

/** What reading a SKILL.md found: its text, nothing there, or a file that cannot be read. */
export type SkillFileRead =
  | { readonly kind: 'read'; readonly text: string; readonly modified: number }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unreadable'; readonly reason: string };

type SkillPorts = {
  fs: Pick<VaultFsPort, 'listDirectory' | 'readTextFile'>;
  markdown: Pick<MarkdownPort, 'frontmatterProperties' | 'frontmatterProblem'>;
};

/** By name as written, code unit by code unit: the same order on every Mac, whatever its locale. */
function byName(left: VaultEntry, right: VaultEntry): number {
  if (left.name === right.name) return 0;
  return left.name < right.name ? -1 : 1;
}

/** The folders in `.atlas/skills`, dotted ones aside; none when the vault has no such folder. */
export async function listSkillFolders(
  fs: Pick<VaultFsPort, 'listDirectory'>,
): Promise<VaultEntry[]> {
  let entries: readonly VaultEntry[];
  try {
    entries = await fs.listDirectory(createVaultPath(SKILLS_DIRECTORY));
  } catch (error) {
    // A vault with no skills folder simply has no skills.
    if (error instanceof VaultAccessError) return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.kind === 'directory' && !entry.name.startsWith('.'))
    .sort(byName);
}

/** Every skill in the vault, by folder name, each read through its SKILL.md. */
export async function listSkills(ports: SkillPorts): Promise<SkillSummary[]> {
  const folders = await listSkillFolders(ports.fs);
  return Promise.all(folders.map((folder) => readSkillIn(ports, folder)));
}

/**
 * The skill `name` means — its folder exactly, else in any case — read whole.
 * Null when no folder is called that. The name is only ever compared with
 * the folders listed, never made into a path, so it cannot reach outside them.
 */
export async function readSkill({
  name,
  ...ports
}: SkillPorts & { name: string }): Promise<SkillFile | null> {
  const folders = await listSkillFolders(ports.fs);
  const found = skillFolderNamed(
    name,
    folders.map((folder) => folder.name),
  );
  const folder = folders.find((each) => each.name === found);
  return folder === undefined ? null : readSkillIn(ports, folder);
}

/** One folder's skill, read through its SKILL.md. */
export async function readSkillIn(ports: SkillPorts, folder: VaultEntry): Promise<SkillFile> {
  const path = joinVaultPath(folder.path, SKILL_FILE);
  const read = await readSkillFileAt(ports.fs, path);
  return skillFileOf({ markdown: ports.markdown, folder, path, read });
}

/** A skill from what reading its SKILL.md found. */
export function skillFileOf({
  markdown,
  folder,
  path,
  read,
}: {
  markdown: SkillPorts['markdown'];
  folder: Pick<VaultEntry, 'name' | 'path'>;
  path: VaultPath;
  read: SkillFileRead;
}): SkillFile {
  const place = { folder: folder.path, path };
  if (read.kind !== 'read') {
    const unreadable = read.kind === 'unreadable';
    return {
      ...skillReadingOf({
        folder: folder.name,
        file: unreadable ? { unreadable: read.reason } : null,
      }),
      ...place,
      text: '',
      modified: null,
      frontmatterProblem: null,
      readFailure: unreadable ? read.reason : null,
    };
  }
  const { frontmatter, body } = splitFrontmatter(read.text);
  const frontmatterProblem = markdown.frontmatterProblem(frontmatter);
  const properties = markdown.frontmatterProperties(frontmatter);
  return {
    ...skillReadingOf({ folder: folder.name, file: { properties, body, frontmatterProblem } }),
    ...place,
    text: read.text,
    modified: read.modified,
    frontmatterProblem,
    readFailure: null,
  };
}

/**
 * Reads a SKILL.md. The host refuses a file it cannot read — gone, too
 * large, not text — with one error, so a refusal is told apart by whether
 * the folder still lists the file: only a file not listed is missing.
 */
export async function readSkillFileAt(
  fs: Pick<VaultFsPort, 'listDirectory' | 'readTextFile'>,
  path: VaultPath,
): Promise<SkillFileRead> {
  try {
    const { text, modified } = await fs.readTextFile(path);
    return { kind: 'read', text, modified };
  } catch (error) {
    if (!(error instanceof VaultAccessError)) throw error;
    return (await isListed(fs, path))
      ? { kind: 'unreadable', reason: error.message }
      : { kind: 'missing' };
  }
}

/** Whether `path`'s folder lists it as a file, in any case as the Mac's disk reads a name. */
async function isListed(fs: Pick<VaultFsPort, 'listDirectory'>, path: VaultPath): Promise<boolean> {
  let entries: readonly VaultEntry[];
  try {
    entries = await fs.listDirectory(parentVaultPath(path));
  } catch (error) {
    // A folder that has gone holds no SKILL.md.
    if (error instanceof VaultAccessError) return false;
    throw error;
  }
  const name = vaultPathName(path).toLowerCase();
  return entries.some((entry) => entry.kind === 'file' && entry.name.toLowerCase() === name);
}
