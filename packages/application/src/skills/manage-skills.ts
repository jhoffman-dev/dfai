import {
  bodyWithInstructions,
  createVaultPath,
  isSkillNameTaken,
  joinFrontmatter,
  joinVaultPath,
  newSkillBody,
  SKILL_FILE,
  skillDraftProblems,
  skillFrontmatterChanges,
  SKILLS_DIRECTORY,
  splitFrontmatter,
  type SkillDraft,
  type VaultPath,
} from '@dfai/domain';
import { NoteChangedError } from '../notes/note-changed-error.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import { ensureFolder } from '../vault/create-folder.ts';
import { filesUnder } from '../vault/delete-entry.ts';
import { VaultAccessError, type VaultFsPort } from '../vault/ports.ts';
import { listSkillFolders, skillFileOf, type SkillFile } from './skills.ts';

/*
 * Making, saving and deleting skills (ADR-0050). Every write is held to the
 * file as it was read: a SKILL.md changed on disk since is refused, never
 * written over, and an edit changes only what the person changed (ADR-0003).
 */

/** Refused before anything is touched, in the rule's own words for the person. */
export class SkillRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillRefusedError';
  }
}

type SkillMarkdown = Pick<
  MarkdownPort,
  'frontmatterProperties' | 'frontmatterProblem' | 'updateFrontmatter'
>;

/** Throws the draft's problems, all of them, when there are any. */
function refuseUnlessValid(draft: SkillDraft): void {
  const problems = skillDraftProblems(draft);
  if (problems.length > 0) {
    throw new SkillRefusedError(problems.map(({ message }) => message).join(' '));
  }
}

/**
 * Writes a new skill: its folder in `.atlas/skills`, and in it a SKILL.md in
 * the one canonical form — `name` and `description`, then the instructions.
 * Refused when the draft breaks a rule or a folder already has its name in
 * any case or form.
 */
export async function createSkill({
  fs,
  markdown,
  draft,
}: {
  fs: VaultFsPort;
  markdown: SkillMarkdown;
  draft: SkillDraft;
}): Promise<SkillFile> {
  refuseUnlessValid(draft);
  const taken = (await listSkillFolders(fs)).map((folder) => folder.name);
  if (isSkillNameTaken(draft.name, taken)) {
    throw new SkillRefusedError(`There is already a skill called “${draft.name}”.`);
  }
  const parent = await ensureFolder({ fs, folder: createVaultPath(SKILLS_DIRECTORY) });
  const folder = joinVaultPath(parent, draft.name);
  await fs.createFolder({ path: folder });
  const path = joinVaultPath(folder, SKILL_FILE);
  const frontmatter = markdown.updateFrontmatter(null, {
    name: draft.name,
    description: draft.description,
  });
  const text = joinFrontmatter(frontmatter, newSkillBody(draft.instructions));
  const modified = await fs.createNote({ path, contents: text });
  return skillFileOf({
    markdown,
    folder: { name: draft.name, path: folder },
    path,
    read: { text, modified },
  });
}

/**
 * Refuses a skill whose SKILL.md is no longer what `skill` read: changed,
 * gone, or there now when it was not.
 */
async function refuseUnlessUnchanged(
  fs: Pick<VaultFsPort, 'readTextFile'>,
  skill: SkillFile,
): Promise<void> {
  let now: { text: string; modified: number } | null;
  try {
    now = await fs.readTextFile(skill.path);
  } catch (error) {
    if (!(error instanceof VaultAccessError)) throw error;
    now = null;
  }
  const same =
    now === null
      ? skill.modified === null
      : now.modified === skill.modified && now.text === skill.text;
  if (!same) throw new NoteChangedError(skill.path);
}

/**
 * SKILL.md's text after `draft`: only the frontmatter keys that changed are
 * rewritten, through the port that keeps every other byte, and the body only
 * when the instructions changed.
 */
function editedText(markdown: SkillMarkdown, skill: SkillFile, draft: SkillDraft): string {
  const { frontmatter, body } = splitFrontmatter(skill.text);
  const changes = skillFrontmatterChanges(skill, draft);
  const written =
    Object.keys(changes).length === 0
      ? frontmatter
      : markdown.updateFrontmatter(frontmatter, changes);
  return joinFrontmatter(written, bodyWithInstructions(body, draft.instructions));
}

/**
 * Saves `draft` over `skill`, as it was read. A skill keeps its folder's
 * name — renaming one is not offered yet — so a draft naming another is
 * refused; one naming the folder puts a `name:` that differed right. Nothing
 * is written when nothing changed. Refused, with nothing written, when
 * SKILL.md changed since it was read, is missing, or its frontmatter cannot
 * be read. Answers the skill as saved.
 */
export async function saveSkill({
  fs,
  markdown,
  skill,
  draft,
}: {
  fs: VaultFsPort;
  markdown: SkillMarkdown;
  skill: SkillFile;
  draft: SkillDraft;
}): Promise<SkillFile> {
  if (draft.name !== skill.name) {
    throw new SkillRefusedError('A skill cannot be renamed yet: it keeps its folder’s name.');
  }
  refuseUnlessValid(draft);
  if (skill.modified === null) throw new SkillRefusedError(`The folder has no ${SKILL_FILE}.`);
  if (skill.frontmatterProblem !== null) {
    throw new SkillRefusedError(`${SKILL_FILE} cannot be read: ${skill.frontmatterProblem}`);
  }
  await refuseUnlessUnchanged(fs, skill);
  const text = editedText(markdown, skill, draft);
  if (text === skill.text) return skill;
  const modified = await fs.writeTextFile({
    path: skill.path,
    contents: text,
    expectedModified: skill.modified,
    expectedText: skill.text,
  });
  const folder = { name: skill.name, path: skill.folder };
  return skillFileOf({ markdown, folder, path: skill.path, read: { text, modified } });
}

/** The files a skill's folder holds besides SKILL.md, which deleting it takes too. */
export async function skillOtherFiles({
  fs,
  skill,
}: {
  fs: Pick<VaultFsPort, 'listDirectory'>;
  skill: Pick<SkillFile, 'folder' | 'path'>;
}): Promise<VaultPath[]> {
  const files = await filesUnder({ fs, folder: skill.folder });
  return files.filter((path) => path.toLowerCase() !== skill.path.toLowerCase());
}

/**
 * Puts a skill's whole folder in the system Trash, where it can be got back,
 * only while its SKILL.md is unchanged since `skill` read it. Answers the
 * other files that went with it, so the person can be told.
 */
export async function deleteSkill({
  fs,
  skill,
}: {
  fs: VaultFsPort;
  skill: SkillFile;
}): Promise<{ readonly folder: VaultPath; readonly otherFiles: readonly VaultPath[] }> {
  await refuseUnlessUnchanged(fs, skill);
  const otherFiles = await skillOtherFiles({ fs, skill });
  await fs.trashEntry({ path: skill.folder });
  return { folder: skill.folder, otherFiles };
}
