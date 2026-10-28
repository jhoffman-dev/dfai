import {
  createVaultPath,
  joinVaultPath,
  skillReadingOf,
  SKILL_FILE,
  skillFolderNamed,
  SKILLS_DIRECTORY,
  splitFrontmatter,
  type SkillReading,
  type VaultEntry,
  type VaultPath,
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
}

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
  const read = await readIfThere(ports.fs, path);
  return skillFileOf({ markdown: ports.markdown, folder, path, read });
}

/** A skill from SKILL.md's text as read, or from its absence. */
export function skillFileOf({
  markdown,
  folder,
  path,
  read,
}: {
  markdown: SkillPorts['markdown'];
  folder: Pick<VaultEntry, 'name' | 'path'>;
  path: VaultPath;
  read: { text: string; modified: number } | null;
}): SkillFile {
  const place = { folder: folder.path, path };
  if (read === null) {
    return {
      ...skillReadingOf({ folder: folder.name, file: null }),
      ...place,
      text: '',
      modified: null,
      frontmatterProblem: null,
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
  };
}

/** A file's text and time, or null when it is not there. */
async function readIfThere(
  fs: Pick<VaultFsPort, 'readTextFile'>,
  path: VaultPath,
): Promise<{ text: string; modified: number } | null> {
  try {
    return await fs.readTextFile(path);
  } catch (error) {
    // A folder without SKILL.md is a skill with nothing in it yet, shown as a problem.
    if (error instanceof VaultAccessError) return null;
    throw error;
  }
}
