import {
  bodyWithInstructions,
  createVaultPath,
  isSkillNameTaken,
  joinFrontmatter,
  joinVaultPath,
  newSkillBody,
  SKILL_FILE,
  SKILL_FILE_UNREADABLE,
  skillDraftProblems,
  skillFrontmatterChanges,
  SKILLS_DIRECTORY,
  splitFrontmatter,
  type SkillDraft,
  type SkillFolderContents,
  type VaultPath,
} from '@dfai/domain';
import { NoteChangedError } from '../notes/note-changed-error.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import { ensureFolder } from '../vault/create-folder.ts';
import { filesAndLinksUnder } from '../vault/delete-entry.ts';
import { isListedAsLink } from '../vault/listed-links.ts';
import { VaultAccessError, type VaultFsPort } from '../vault/ports.ts';
import { listSkillFolders, readSkillFileAt, skillFileOf, type SkillFile } from './skills.ts';

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

/** The refusal of a name some folder or file in `.atlas/skills` already has. */
const taken = (name: string) => new SkillRefusedError(`There is already a skill called “${name}”.`);

/** Writes `draft` as a new SKILL.md in `folder`, in the one canonical form; never over one there. */
async function writeSkillFile({
  fs,
  markdown,
  folder,
  draft,
}: {
  fs: Pick<VaultFsPort, 'createNote'>;
  markdown: SkillMarkdown;
  folder: { readonly name: string; readonly path: VaultPath };
  draft: SkillDraft;
}): Promise<SkillFile> {
  const path = joinVaultPath(folder.path, SKILL_FILE);
  const frontmatter = markdown.updateFrontmatter(null, {
    name: draft.name,
    description: draft.description,
  });
  const text = joinFrontmatter(frontmatter, newSkillBody(draft.instructions));
  const modified = await fs.createNote({ path, contents: text });
  return skillFileOf({ markdown, folder, path, read: { kind: 'read', text, modified } });
}

/**
 * Makes the folder for a new skill called `name`. A clash the listing could
 * not see — a file of that name, or a folder made since — is refused as a
 * name already taken; any other failure is passed on.
 */
async function makeSkillFolder(fs: VaultFsPort, name: string): Promise<VaultPath> {
  const parent = await ensureFolder({ fs, folder: createVaultPath(SKILLS_DIRECTORY) });
  const folder = joinVaultPath(parent, name);
  try {
    await fs.createFolder({ path: folder });
  } catch (error) {
    if (!(error instanceof VaultAccessError)) throw error;
    const there = (await fs.listDirectory(parent)).map((entry) => entry.name);
    if (isSkillNameTaken(name, there)) throw taken(name);
    throw error;
  }
  return folder;
}

/**
 * Writes a new skill: its folder in `.atlas/skills`, and in it a SKILL.md in
 * the one canonical form — `name` and `description`, then the instructions.
 * A folder of exactly that name with no SKILL.md yet is the skill's: its
 * SKILL.md is written into it. Refused when the draft breaks a rule, or
 * another folder has the name in any case or form. When the folder is made
 * but its SKILL.md cannot be, the folder is taken away again while it is
 * still empty.
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
  const folders = await listSkillFolders(fs);
  const names = folders.map((folder) => folder.name);
  const own = folders.find((folder) => folder.name === draft.name);
  if (own !== undefined) {
    const there = await readSkillFileAt(fs, joinVaultPath(own.path, SKILL_FILE));
    if (there.kind !== 'missing') throw taken(draft.name);
    return writeOrExplain({ fs, markdown, folder: own, draft, made: false });
  }
  if (isSkillNameTaken(draft.name, names)) throw taken(draft.name);
  const path = await makeSkillFolder(fs, draft.name);
  return writeOrExplain({ fs, markdown, folder: { name: draft.name, path }, draft, made: true });
}

/**
 * Writes the new SKILL.md, and when that fails, looks at the folder again
 * before deciding what the failure was. A SKILL.md there now is another
 * program's, made since the folder was read: a name already taken, and
 * nothing is trashed. A folder this create `made` that is still empty is
 * taken away, so it does not hold the name; one that holds anything at all is
 * left as it is.
 */
async function writeOrExplain({
  fs,
  markdown,
  folder,
  draft,
  made,
}: {
  fs: VaultFsPort;
  markdown: SkillMarkdown;
  folder: { readonly name: string; readonly path: VaultPath };
  draft: SkillDraft;
  made: boolean;
}): Promise<SkillFile> {
  try {
    return await writeSkillFile({ fs, markdown, folder, draft });
  } catch (cause) {
    // A folder that cannot be listed is left alone, and the write's own failure passed on.
    const held = await fs.listDirectory(folder.path).catch(() => null);
    const skillFile = SKILL_FILE.toLowerCase();
    if (held?.some((entry) => entry.name.toLowerCase() === skillFile)) throw taken(draft.name);
    if (made && held?.length === 0) {
      // Safe to ignore: a folder left behind is empty, and a retry writes into it.
      await fs.trashEntry({ path: folder.path }).catch(() => undefined);
    }
    throw cause;
  }
}

/**
 * Refuses a skill whose SKILL.md is no longer what `skill` read: changed,
 * gone, there now when it was not, or now unreadable.
 */
async function refuseUnlessUnchanged(
  fs: Pick<VaultFsPort, 'listDirectory' | 'readTextFile'>,
  skill: SkillFile,
): Promise<void> {
  const now = await readSkillFileAt(fs, skill.path);
  const same =
    now.kind === 'read'
      ? now.modified === skill.modified && now.text === skill.text
      : now.kind === 'missing' && skill.modified === null && !skill.unreadable;
  if (!same) throw new NoteChangedError(skill.path);
}

/** Refuses a skill whose SKILL.md is there but could not be read: nothing is done to it here. */
function refuseUnreadable(skill: SkillFile, doing: string): void {
  if (skill.unreadable) {
    const why = skill.problems.find((problem) => problem.field === 'file')?.message;
    throw new SkillRefusedError(`${why ?? SKILL_FILE_UNREADABLE} It is not ${doing} here.`);
  }
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
  return joinFrontmatter(written, bodyWithInstructions(body, draft.instructions, skill.text));
}

/**
 * Saves `draft` over `skill`, as it was read. A skill keeps its folder's
 * name — renaming one is not offered yet — so a draft naming another is
 * refused; one naming the folder puts a `name:` that differed right. A
 * folder with no SKILL.md gets one, written canonically and never over one
 * made since. Nothing is written when nothing changed. Refused, with nothing
 * written, when SKILL.md changed since it was read, or it or its frontmatter
 * cannot be read. Answers the skill as saved.
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
  refuseUnreadable(skill, 'saved');
  if (skill.frontmatterProblem !== null) {
    throw new SkillRefusedError(`${SKILL_FILE} cannot be read: ${skill.frontmatterProblem}`);
  }
  await refuseUnlessUnchanged(fs, skill);
  const folder = { name: skill.name, path: skill.folder };
  if (skill.modified === null) return writeSkillFile({ fs, markdown, folder, draft });
  const text = editedText(markdown, skill, draft);
  if (text === skill.text) return skill;
  const modified = await fs.writeTextFile({
    path: skill.path,
    contents: text,
    expectedModified: skill.modified,
    expectedText: skill.text,
  });
  return skillFileOf({
    markdown,
    folder,
    path: skill.path,
    read: { kind: 'read', text, modified },
  });
}

/** Whether a file below a skill's folder is a dotfile, or in a dotted folder: `.DS_Store`. */
const isDotted = (folder: VaultPath, path: VaultPath) =>
  path
    .slice(folder.length + 1)
    .split('/')
    .some((segment) => segment.startsWith('.'));

/**
 * What deleting a skill takes: the files its folder holds besides SKILL.md,
 * as deep as a folder is walked, with dotfiles such as `.DS_Store` unnamed;
 * and the links in it, which go as links. A folder that is itself a link is
 * not looked in at all: only the link goes (#169). `skillDeletionWarning`
 * says that deeper files go as well.
 */
export async function skillFolderContents({
  fs,
  skill,
}: {
  fs: Pick<VaultFsPort, 'listDirectory'>;
  skill: Pick<SkillFile, 'folder' | 'path'>;
}): Promise<SkillFolderContents> {
  if (await isListedAsLink(fs, skill.folder)) return { link: true, otherFiles: [], links: [] };
  const { files, links } = await filesAndLinksUnder({ fs, folder: skill.folder });
  const named = (path: VaultPath) => !isDotted(skill.folder, path);
  return {
    link: false,
    otherFiles: files.filter(
      (path) => path.toLowerCase() !== skill.path.toLowerCase() && named(path),
    ),
    links: links.filter(named),
  };
}

/**
 * Puts a skill's whole folder in the system Trash, where it can be got back,
 * only while its SKILL.md is unchanged since `skill` read it — checked after
 * the folder is walked, right before the Trash. Refused for a SKILL.md that
 * is there but cannot be read. A folder that is a link, or one whose SKILL.md
 * is, is trashed whatever the link points at, readable or not: the link goes
 * as a link and nothing it points at goes, so there is nothing to hold still
 * (#169). Answers what went with it, so the person can be told.
 */
export async function deleteSkill({
  fs,
  skill,
}: {
  fs: VaultFsPort;
  skill: SkillFile;
}): Promise<{ readonly folder: VaultPath } & SkillFolderContents> {
  const contents = await skillFolderContents({ fs, skill });
  const skillFileLinked = contents.links.some(
    (path) => path.toLowerCase() === skill.path.toLowerCase(),
  );
  if (!contents.link && !skillFileLinked) {
    refuseUnreadable(skill, 'deleted');
    await refuseUnlessUnchanged(fs, skill);
  }
  await fs.trashEntry({ path: skill.folder });
  return { folder: skill.folder, ...contents };
}
