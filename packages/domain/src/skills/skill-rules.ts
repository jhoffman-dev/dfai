/**
 * Skills: instructions for Claude the person writes once and reuses (ADR-0050).
 *
 * A skill is an Agent Skills folder, `.atlas/skills/<name>/SKILL.md`: the
 * folder's name is the skill's identity, the file's frontmatter holds its
 * `name` and `description`, and its body is the instructions. These are the
 * rules a skill is held to, how one is read from its file, and what an edit
 * changes in it. Nothing here reads or writes a file.
 */

import { MAX_PROMPT_CHARACTERS } from '../chat/index.ts';
import { createVaultPath, type VaultPath } from '../vault/vault-path.ts';
import { SKILLS_DIRECTORY } from '../vault/vault-visibility.ts';

/** The one file of a skill's folder DFAI reads; anything else in it is left alone. */
export const SKILL_FILE = 'SKILL.md';

/** The longest a skill's name may be, as Agent Skills allow. */
export const MAX_SKILL_NAME_LENGTH = 64;

/** The longest a skill's description may be, as Agent Skills allow. */
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024;

/** The longest a skill's instructions may be: a prompt note's limit, since either is a prompt. */
export const MAX_SKILL_INSTRUCTIONS_LENGTH = MAX_PROMPT_CHARACTERS;

/** Words a skill's name may not hold, as Agent Skills refuse them (James to confirm, ADR-0050). */
export const RESERVED_SKILL_WORDS: readonly string[] = ['claude', 'anthropic'];

/** Lowercase letters and digits in runs, joined by single hyphens. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * XML markup, as Agent Skills refuse it in a description: an opening, closing
 * or empty tag whose name starts with any letter, `_` or `:`, as XML 1.0
 * names do (`<example>`, `</b>`, `<br/>`, `<résumé>`, `<名前>`); and, so the
 * description stays plain text wherever it is taken, a comment, a CDATA
 * section or a processing instruction (ADR-0050).
 */
const XML_MARKUP = [
  /<\/?[\p{L}_:][\p{L}\p{N}\p{M}_.:\-·]*(?:\s[^<>]*)?\/?>/u,
  /<!--[\s\S]*?-->/,
  /<!\[CDATA\[[\s\S]*?\]\]>/,
  /<\?[\p{L}_:][\s\S]*?\?>/u,
];

/**
 * A text's length in characters (Unicode code points), as the Agent Skills
 * validator counts: an emoji is one, not the two UTF-16 units `.length` says.
 */
export function characterCount(text: string): number {
  return Array.from(text).length;
}

/** Which part of a skill a problem is with: `file` is SKILL.md itself. */
export type SkillField = 'name' | 'description' | 'instructions' | 'file';

/** Something wrong with a skill, in words for the person. */
export interface SkillProblem {
  readonly field: SkillField;
  readonly message: string;
}

/** What the person writes for a skill: the three things it is. */
export interface SkillDraft {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
}

/** A skill as its folder and SKILL.md read, with everything wrong with them. */
export interface SkillReading {
  /** The folder's name: the skill's identity, whatever the file says. */
  readonly name: string;
  /** What SKILL.md's `name:` says, or null when it says nothing or not text. */
  readonly declaredName: string | null;
  readonly description: string;
  readonly instructions: string;
  readonly problems: readonly SkillProblem[];
}

/** What SKILL.md held, as the markdown port read it; null when the folder has none. */
export interface SkillFileContents {
  readonly properties: Readonly<Record<string, unknown>>;
  readonly body: string;
  /** Why its frontmatter cannot be read, or null. */
  readonly frontmatterProblem: string | null;
}

/** Why `name` cannot be a skill's name, or null. */
export function skillNameProblem(name: string): string | null {
  if (name === '') return 'Name the skill.';
  if (characterCount(name) > MAX_SKILL_NAME_LENGTH) {
    return `A skill’s name may be at most ${MAX_SKILL_NAME_LENGTH} characters.`;
  }
  if (!SKILL_NAME.test(name)) {
    return 'A skill’s name is lowercase letters, digits and single hyphens, starting and ending with a letter or digit.';
  }
  const reserved = RESERVED_SKILL_WORDS.find((word) => name.includes(word));
  return reserved === undefined ? null : `A skill’s name cannot hold “${reserved}”.`;
}

/** Why `description` cannot be a skill's description, or null. */
export function skillDescriptionProblem(description: string): string | null {
  if (description.trim() === '') return 'Say what the skill does and when to use it.';
  if (characterCount(description) > MAX_SKILL_DESCRIPTION_LENGTH) {
    return `A skill’s description may be at most ${MAX_SKILL_DESCRIPTION_LENGTH} characters.`;
  }
  return XML_MARKUP.some((markup) => markup.test(description))
    ? 'A skill’s description cannot hold XML tags.'
    : null;
}

/** Why `instructions` cannot be a skill's instructions, or null. */
export function skillInstructionsProblem(instructions: string): string | null {
  if (instructions.trim() === '') return 'Write the skill’s instructions.';
  return characterCount(instructions) > MAX_SKILL_INSTRUCTIONS_LENGTH
    ? `A skill’s instructions may be at most ${MAX_SKILL_INSTRUCTIONS_LENGTH} characters.`
    : null;
}

/**
 * A skill name as two names are compared for being the same: in any case and
 * any Unicode form, compatibility forms included, so no two folders can be
 * told apart only by how a name was typed.
 */
export function skillNameKey(name: string): string {
  return name.normalize('NFKC').toLowerCase();
}

/** Whether `name` is already one of `taken`, the skill folders there are. */
export function isSkillNameTaken(name: string, taken: readonly string[]): boolean {
  const wanted = skillNameKey(name);
  return taken.some((folder) => skillNameKey(folder) === wanted);
}

/**
 * Of the folders there are, the one `asked` means: its exact name, else the
 * first the same in any case and form. Null when none is.
 */
export function skillFolderNamed(asked: string, folders: readonly string[]): string | null {
  if (folders.includes(asked)) return asked;
  const wanted = skillNameKey(asked);
  return folders.find((folder) => skillNameKey(folder) === wanted) ?? null;
}

/** Everything wrong with a draft, each field's first problem; empty when it can be saved. */
export function skillDraftProblems(draft: SkillDraft): SkillProblem[] {
  const checks: readonly [SkillField, string | null][] = [
    ['name', skillNameProblem(draft.name)],
    ['description', skillDescriptionProblem(draft.description)],
    ['instructions', skillInstructionsProblem(draft.instructions)],
  ];
  return checks.flatMap(([field, message]) => (message === null ? [] : [{ field, message }]));
}

/** A skill's folder. */
export function skillFolderPath(name: string): VaultPath {
  return createVaultPath(`${SKILLS_DIRECTORY}/${name}`);
}

/** A skill's SKILL.md. */
export function skillFilePath(name: string): VaultPath {
  return createVaultPath(`${SKILLS_DIRECTORY}/${name}/${SKILL_FILE}`);
}

/** The line break a body starts with to stand apart from the frontmatter, or none. */
function leadingBreak(body: string): string {
  return /^\r?\n/.exec(body)?.[0] ?? '';
}

/**
 * A skill's instructions: its body, less the blank line that parts it from
 * the frontmatter and the one line ending the writer puts after the last
 * line — so instructions saved at N characters read back as N.
 */
export function instructionsOf(body: string): string {
  const rest = body.slice(leadingBreak(body).length);
  return rest.slice(0, rest.length - (/\r?\n$/.exec(rest)?.[0].length ?? 0));
}

/** Whether most of a file's lines end in CRLF: the file was written that way, whatever its body holds. */
export function isWrittenWithCrlf(text: string): boolean {
  const crlf = text.split('\r\n').length - 1;
  const lf = text.split('\n').length - 1 - crlf;
  return crlf > lf;
}

/**
 * The body that holds `instructions` in place of `body`: `body` itself when
 * they are what it already holds, so an untouched skill is written back byte
 * for byte, and otherwise the instructions after the blank line it had, then
 * one line ending, which {@link instructionsOf} does not count. Line ends are
 * CRLF when the file (`fileText`, the body's own by default) is written with
 * them and the instructions came with bare ones, as an editor's form sends them.
 */
export function bodyWithInstructions(
  body: string,
  instructions: string,
  fileText: string = body,
): string {
  if (instructionsOf(body) === instructions) return body;
  const crlf = isWrittenWithCrlf(fileText) && !instructions.includes('\r');
  const written = crlf ? instructions.replace(/\n/g, '\r\n') : instructions;
  const ending = crlf || instructions.includes('\r\n') ? '\r\n' : '\n';
  return leadingBreak(body) + written + ending;
}

/**
 * The body a new skill is written with, in its one canonical form: a blank
 * line after the frontmatter, then the instructions, then one line ending.
 */
export function newSkillBody(instructions: string): string {
  return `\n${instructions}\n`;
}

/**
 * The frontmatter keys an edit changes: `name` and `description` each only
 * when it differs from what the file says, so every other byte stays.
 */
export function skillFrontmatterChanges(
  before: Pick<SkillReading, 'declaredName' | 'description'>,
  after: Pick<SkillDraft, 'name' | 'description'>,
): Record<string, string> {
  return {
    ...(after.name !== before.declaredName && { name: after.name }),
    ...(after.description !== before.description && { description: after.description }),
  };
}

const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** What is wrong with the file's own `name:`, measured against its folder. */
function declaredNameProblem(folder: string, declared: string | null): SkillProblem[] {
  if (declared === null) {
    return [{ field: 'name', message: `SKILL.md has no name; it should be “${folder}”.` }];
  }
  if (declared === folder) return [];
  return [
    {
      field: 'name',
      message: `SKILL.md names it “${declared}”, but its folder is “${folder}”.`,
    },
  ];
}

/** What SKILL.md was when its folder was read: its contents, unreadable, or not there. */
export type SkillFileState = SkillFileContents | { readonly unreadable: true } | null;

/**
 * What is said of a SKILL.md that is there but cannot be read: DFAI's own
 * words, never the host's, which can name the Mac's folders (ADR-0017).
 */
export const SKILL_FILE_UNREADABLE = `${SKILL_FILE} is there but cannot be read: it may be too large, not text, or not allowed.`;

/** What is wrong with a folder's own name, which is the skill's. */
function folderNameProblems(folder: string): SkillProblem[] {
  const problem = skillNameProblem(folder);
  return problem === null ? [] : [{ field: 'name', message: `Its folder: ${problem}` }];
}

/** What is wrong with a read SKILL.md's description and instructions. */
function contentProblems(description: string, instructions: string): SkillProblem[] {
  const checks = [
    ['description', skillDescriptionProblem(description)],
    ['instructions', skillInstructionsProblem(instructions)],
  ] as const;
  return checks.flatMap(([field, message]) => (message === null ? [] : [{ field, message }]));
}

/** A skill whose SKILL.md gave nothing to read, for `problem`. */
function emptyReading(folder: string, problem: string): SkillReading {
  return {
    name: folder,
    declaredName: null,
    description: '',
    instructions: '',
    problems: [...folderNameProblems(folder), { field: 'file', message: problem }],
  };
}

/**
 * A skill as its folder `folder` and its SKILL.md read. The folder's name is
 * the skill's; a `name:` that differs is a problem to show, never put right
 * here. A folder with no SKILL.md is a skill with nothing in it yet; one
 * whose SKILL.md is there but cannot be read says so.
 */
export function skillReadingOf({
  folder,
  file,
}: {
  folder: string;
  file: SkillFileState;
}): SkillReading {
  if (file === null) return emptyReading(folder, `The folder has no ${SKILL_FILE}.`);
  if ('unreadable' in file) {
    return emptyReading(folder, SKILL_FILE_UNREADABLE);
  }
  const declaredName = textOrNull(file.properties['name']);
  const description = textOrNull(file.properties['description']) ?? '';
  const instructions = instructionsOf(file.body);
  const frontmatter: SkillProblem[] =
    file.frontmatterProblem === null ? [] : [{ field: 'file', message: file.frontmatterProblem }];
  return {
    name: folder,
    declaredName,
    description,
    instructions,
    problems: [
      ...frontmatter,
      ...folderNameProblems(folder),
      ...declaredNameProblem(folder, declaredName),
      ...contentProblems(description, instructions),
    ],
  };
}

/** A file's path below its skill's folder: `scripts/run.sh`. */
function withinFolder(path: string): string {
  const at = path.indexOf('/', SKILLS_DIRECTORY.length + 1);
  return at === -1 ? path : path.slice(at + 1);
}

/**
 * What the person is asked before a skill is deleted: the whole folder goes,
 * with each other file it holds named, and — since a folder is listed only so
 * deep — everything in its subfolders, however deep, goes too.
 */
export function skillDeletionWarning(name: string, otherFiles: readonly string[]): string {
  const trash = 'goes to the Trash, where it can be got back';
  if (otherFiles.length === 0)
    return `Delete “${name}”? Its folder, holding only ${SKILL_FILE}, ${trash}.`;
  const count = otherFiles.length === 1 ? '1 other file' : `${otherFiles.length} other files`;
  const named = otherFiles.map(withinFolder).join(', ');
  return (
    `Delete “${name}”? Its whole folder ${trash}, with ${count}: ${named} — ` +
    'and everything in its subfolders, however deep.'
  );
}
