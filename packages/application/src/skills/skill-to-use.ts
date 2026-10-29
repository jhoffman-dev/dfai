import { skillRunProblem } from '@dfai/domain';
import type { MarkdownPort } from '../notes/ports.ts';
import { VaultAccessError, type VaultFsPort } from '../vault/ports.ts';
import { readSkill } from './skills.ts';

/**
 * A skill as a run or a chat turn is about to hand it over (#169): its
 * instructions, trimmed as a prompt note's body is, or why it cannot be.
 */
export type SkillToUse =
  | { readonly kind: 'usable'; readonly name: string; readonly instructions: string }
  /** The host refused it: its words can name the Mac's folders, so the caller says what DFAI knows. */
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'missing' }
  /** It breaks a skill's rules, or is too long to hand over (`skillRunProblem`). */
  | { readonly kind: 'unusable'; readonly message: string };

/**
 * The skill `name`, found as the Skills page finds it, and whether it can be
 * asked with. Read at the moment of use, so an edit since applies.
 */
export async function readSkillToUse({
  fs,
  markdown,
  name,
}: {
  fs: Pick<VaultFsPort, 'listDirectory' | 'readTextFile'>;
  markdown: Pick<MarkdownPort, 'frontmatterProperties' | 'frontmatterProblem'>;
  name: string;
}): Promise<SkillToUse> {
  let skill: Awaited<ReturnType<typeof readSkill>>;
  try {
    skill = await readSkill({ fs, markdown, name });
  } catch (error) {
    if (!(error instanceof VaultAccessError)) throw error;
    return { kind: 'unreadable' };
  }
  if (skill === null) return { kind: 'missing' };
  const unusable = skillRunProblem(skill);
  // Trimmed as a prompt note's body is, and as skillRunProblem measures it: instructionsOf takes
  // off only one blank line and one line end, so spaces and further blank lines would remain.
  return unusable === null
    ? { kind: 'usable', name: skill.name, instructions: skill.instructions.trim() }
    : { kind: 'unusable', message: unusable.message };
}
