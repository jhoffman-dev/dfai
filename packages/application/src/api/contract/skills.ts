/**
 * The local API's contract for skills.
 *
 * One area of `../contract.ts`, which composes every area's routes and
 * answers. Everything here is data. No behaviour belongs in this file.
 */

/** Something wrong with a skill, as the Skills page shows it (ADR-0050). */
export interface ApiSkillProblem {
  /** Which part: its `name`, `description` or `instructions`, or `file` for SKILL.md itself. */
  readonly field: 'name' | 'description' | 'instructions' | 'file';
  readonly message: string;
}

/** A skill in `.atlas/skills`: a folder holding a SKILL.md. */
export interface ApiSkill {
  /** Its folder's name: the skill's identity, whatever SKILL.md's `name:` says. */
  readonly name: string;
  /** Its SKILL.md. Read-only: the API never writes `.atlas`. */
  readonly path: string;
  readonly description: string;
  /** What is wrong with it; empty for a skill that follows every rule. */
  readonly problems: readonly ApiSkillProblem[];
}

/** A skill and its instructions: SKILL.md's body, as written. */
export interface ApiSkillContent extends ApiSkill {
  readonly instructions: string;
}

/** What the routes for skills answer with. */
export type ApiSkillSuccessBody =
  { readonly skills: readonly ApiSkill[] } | { readonly skill: ApiSkillContent };

/** The routes for skills. */
export const SKILL_ROUTES = [
  {
    method: 'GET',
    path: '/v1/skills',
    summary: 'Every skill, with its description and what is wrong with it. Read-only.',
  },
  {
    method: 'GET',
    path: '/v1/skills/{name}',
    summary: "One skill's description and instructions, by name. Read-only.",
  },
] as const;
