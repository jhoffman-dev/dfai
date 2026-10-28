/**
 * Skills: instructions for Claude the person writes once and reuses (ADR-0050).
 *
 * A skill is an Agent Skills folder, `.atlas/skills/<name>/SKILL.md`: the
 * folder's name is the skill's identity, the file's frontmatter holds its
 * `name` and `description`, and its body is the instructions. These are the
 * rules a skill is held to, how one is read from its file, and what an edit
 * changes in it. Nothing here reads or writes a file.
 */

import { MAX_PROMPT_CHARACTERS } from '../automations/claude-step.ts';
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

/** An opening, closing or empty XML tag: `<example>`, `</b>`, `<br/>`. */
const XML_TAG = /<\/?[A-Za-z_][\w.:-]*(?:\s[^<>]*)?\/?>/;

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
  if (name.length > MAX_SKILL_NAME_LENGTH) {
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
  if (description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
    return `A skill’s description may be at most ${MAX_SKILL_DESCRIPTION_LENGTH} characters.`;
  }
  return XML_TAG.test(description) ? 'A skill’s description cannot hold XML tags.' : null;
}

/** Why `instructions` cannot be a skill's instructions, or null. */
export function skillInstructionsProblem(instructions: string): string | null {
  if (instructions.trim() === '') return 'Write the skill’s instructions.';
  return instructions.length > MAX_SKILL_INSTRUCTIONS_LENGTH
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

/** A skill's instructions: its body, less the blank line that parts it from the frontmatter. */
export function instructionsOf(body: string): string {
  return body.slice(leadingBreak(body).length);
}

/**
 * The body that holds `instructions` in place of `body`: `body` itself when
 * they are what it already holds, so an untouched skill is written back byte
 * for byte, and otherwise the instructions after the blank line it had.
 */
export function bodyWithInstructions(body: string, instructions: string): string {
  return instructionsOf(body) === instructions ? body : leadingBreak(body) + instructions;
}

/**
 * The body a new skill is written with, in its one canonical form: a blank
 * line after the frontmatter, then the instructions, ending their last line.
 */
export function newSkillBody(instructions: string): string {
  return `\n${instructions.endsWith('\n') ? instructions : `${instructions}\n`}`;
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

/**
 * A skill as its folder `folder` and its SKILL.md read. The folder's name is
 * the skill's; a `name:` that differs is a problem to show, never put right
 * here. A folder with no SKILL.md is a skill with nothing in it yet.
 */
export function skillReadingOf({
  folder,
  file,
}: {
  folder: string;
  file: SkillFileContents | null;
}): SkillReading {
  const folderProblem = skillNameProblem(folder);
  const ownName: SkillProblem[] =
    folderProblem === null ? [] : [{ field: 'name', message: `Its folder: ${folderProblem}` }];
  if (file === null) {
    const missing = { field: 'file' as const, message: `The folder has no ${SKILL_FILE}.` };
    return {
      name: folder,
      declaredName: null,
      description: '',
      instructions: '',
      problems: [...ownName, missing],
    };
  }
  const declaredName = textOrNull(file.properties['name']);
  const description = textOrNull(file.properties['description']) ?? '';
  const instructions = instructionsOf(file.body);
  const unreadable: SkillProblem[] =
    file.frontmatterProblem === null ? [] : [{ field: 'file', message: file.frontmatterProblem }];
  const fieldProblems = (
    [
      ['description', skillDescriptionProblem(description)],
      ['instructions', skillInstructionsProblem(instructions)],
    ] as const
  ).flatMap(([field, message]) => (message === null ? [] : [{ field, message }]));
  return {
    name: folder,
    declaredName,
    description,
    instructions,
    problems: [
      ...unreadable,
      ...ownName,
      ...declaredNameProblem(folder, declaredName),
      ...fieldProblems,
    ],
  };
}
