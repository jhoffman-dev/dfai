import {
  characterCount,
  MAX_SKILL_DESCRIPTION_LENGTH,
  SKILL_FILE,
  SKILL_FILE_UNREADABLE,
  skillDraftProblems,
  type SkillDraft,
} from '@dfai/domain';
import type { SkillFile } from '@dfai/application';
import type { SkillEditorState, SkillFocus } from '@dfai/ui';

/*
 * What the Skills page's editor holds and how it follows the file (#169):
 * the draft over the skill as read, what a change on disk does to it, and
 * what the page is told of it. Plain functions; `use-skills-page.ts` holds
 * the state.
 */

/** Which skill the editor holds: a new one, or one by name. */
export type Selection =
  { readonly kind: 'new' } | { readonly kind: 'skill'; readonly name: string };

/** What the editor started from and what has been typed over it. */
export interface Editing {
  /** SKILL.md as read, which a save or a delete is held to; null for a new skill, or while it is read. */
  readonly base: SkillFile | null;
  readonly draft: SkillDraft;
  /** Whether SKILL.md changed on disk under typing not yet saved. */
  readonly changedOnDisk: boolean;
  /** Whether the skill was made a moment ago, so its editor takes the focus as it opens. */
  readonly justCreated: boolean;
}

export const EMPTY_DRAFT: SkillDraft = { name: '', description: '', instructions: '' };

/** The editor waiting for a skill to be read, or holding a new one not yet typed in. */
export const EMPTY_EDITING: Editing = {
  base: null,
  draft: EMPTY_DRAFT,
  changedOnDisk: false,
  justCreated: false,
};

const draftOf = (skill: SkillFile): SkillDraft => ({
  name: skill.name,
  description: skill.description,
  instructions: skill.instructions,
});

const sameDraft = (left: SkillDraft, right: SkillDraft) =>
  left.name === right.name &&
  left.description === right.description &&
  left.instructions === right.instructions;

/** Whether two reads of SKILL.md found the same file. */
const sameFile = (left: SkillFile, right: SkillFile) =>
  left.text === right.text &&
  left.modified === right.modified &&
  left.unreadable === right.unreadable;

/** The editor over `skill` as read, nothing typed over it. */
export const fresh = (skill: SkillFile, justCreated = false): Editing => ({
  base: skill,
  draft: draftOf(skill),
  changedOnDisk: false,
  justCreated,
});

/** Whether the editor holds typing that leaving it would throw away. */
export function isDirty(editing: Editing | null): boolean {
  if (editing === null) return false;
  return !sameDraft(editing.draft, editing.base === null ? EMPTY_DRAFT : draftOf(editing.base));
}

/**
 * The editor after a read of its skill found `opened`: the first read fills
 * it, a change on disk is taken in while nothing is typed over it and is
 * said otherwise, and a skill gone with nothing typed closes it (null).
 */
export function followed(was: Editing, opened: SkillFile | null): Editing | null {
  if (was.base === null) return opened === null ? null : fresh(opened);
  if (opened !== null && sameFile(was.base, opened)) return was;
  if (isDirty(was)) return { ...was, changedOnDisk: true };
  return opened === null ? null : fresh(opened);
}

/**
 * Why no save can write the skill as it was read, in the words the save's
 * refusal uses (`saveSkill`): SKILL.md or its frontmatter cannot be read, so
 * it is not saved over. Null when a save can.
 */
function saveRefusalOf(base: SkillFile | null): string | null {
  if (base === null) return null;
  if (base.unreadable) return `${SKILL_FILE_UNREADABLE} It is not saved here.`;
  if (base.frontmatterProblem !== null) {
    return `${SKILL_FILE} cannot be read, so it is not saved over: ${base.frontmatterProblem}`;
  }
  return null;
}

/** The editor's state as the page draws it: the draft, and the domain's words on it. */
export function editorStateOf({
  editing,
  mode,
  saving,
  deleting,
}: {
  editing: Editing;
  mode: 'new' | 'edit';
  saving: boolean;
  /** Whether a delete is under way, from its walk of the folder to the Trash's answer. */
  deleting: boolean;
}): SkillEditorState {
  const problems = skillDraftProblems(editing.draft);
  const saveRefusal = saveRefusalOf(editing.base);
  return {
    mode,
    draft: editing.draft,
    problems,
    // A description or instructions problem is said of the draft as it is typed.
    fileProblems: (editing.base?.problems ?? [])
      .filter(({ field }) => field === 'file' || field === 'name')
      .map(({ message }) => message),
    descriptionLength: characterCount(editing.draft.description),
    descriptionLimit: MAX_SKILL_DESCRIPTION_LENGTH,
    changedOnDisk: editing.changedOnDisk,
    saving,
    // A save over a file changed on disk, or one that cannot be read, is refused: it waits.
    canSave: problems.length === 0 && !saving && !editing.changedOnDisk && saveRefusal === null,
    saveRefusal,
    deleting,
    justCreated: editing.justCreated,
  };
}

/** Where the focus goes once `deleted` is gone from `names`: the next skill, else the one before, else the list. */
export function focusAfterDelete(names: readonly string[], deleted: string): SkillFocus {
  const at = names.indexOf(deleted);
  const next = names[at + 1] ?? (at > 0 ? names[at - 1] : undefined);
  return next === undefined ? { kind: 'list' } : { kind: 'row', name: next };
}
