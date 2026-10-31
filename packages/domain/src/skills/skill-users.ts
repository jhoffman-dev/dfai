/**
 * Which automations ask with a skill (#169): what the Skills page shows as
 * "Used by", and what its delete question warns of. A rule uses a skill when
 * its Claude step names it (`skill:`) and its run would read that skill's
 * folder: the one of that exact name, else the first the same in any case
 * and form (`skillFolderNamed`, as `readSkill` finds it), so of two folders
 * told apart only by case, one claims the rule.
 */

import { skillFolderNamed } from './skill-rules.ts';

/** A rule as far as using a skill goes: its name, and what it does. */
export interface SkillUser {
  readonly name: string;
  readonly action: { readonly kind: string; readonly skill?: string };
}

/**
 * Whether a rule's action asks with the skill whose folder is `folder`, of
 * the skill folders there are (`folders`; that one alone when left out).
 */
export function usesSkill(
  action: SkillUser['action'],
  folder: string,
  folders: readonly string[] = [folder],
): boolean {
  return (
    action.kind === 'claude' &&
    action.skill !== undefined &&
    skillFolderNamed(action.skill, folders) === folder
  );
}

/** The names of the rules that ask with the skill in `folder`, each once, by name. */
export function skillUsers(
  rules: readonly SkillUser[],
  folder: string,
  folders: readonly string[] = [folder],
): string[] {
  const names = rules
    .filter((rule) => usesSkill(rule.action, folder, folders))
    .map((rule) => rule.name);
  return [...new Set(names)].sort((left, right) => left.localeCompare(right, 'en'));
}

/** What the delete question adds when automations use the skill; null when none does. */
export function skillInUseWarning(users: readonly string[]): string | null {
  if (users.length === 0) return null;
  const named = users.map((name) => `“${name}”`).join(', ');
  return users.length === 1
    ? `The automation ${named} uses it, and will fail until it names another skill or a prompt.`
    : `${users.length} automations use it — ${named} — and will fail until each names another skill or a prompt.`;
}
