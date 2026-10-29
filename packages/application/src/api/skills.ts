import { listSkills, readSkill, type SkillSummary } from '../skills/skills.ts';
import { ApiError } from './api-error.ts';
import type { ApiSkill } from './contract.ts';
import { decodeSegment } from './paths.ts';
import type { RouteResult, VaultRequest } from './vault-request.ts';

/*
 * The skills, read-only (ADR-0050, ADR-0016 "Skills"). Each is listed and
 * read through the same use-cases the Skills page uses, so a skill's
 * problems here are the page's. Which skill a name means is the folder of
 * that name, compared and never built into a path, so no name reaches
 * outside `.atlas/skills`. Nothing here writes: skills live in `.atlas`,
 * which the API never writes.
 */

/** Every skill, by folder name, with what is wrong with each. */
export async function skillsRoute(request: VaultRequest): Promise<RouteResult> {
  const { fs, markdown } = request;
  const skills = await listSkills({ fs, markdown });
  request.assertStillOpen();
  return { status: 200, body: { skills: skills.map(toApiSkill) } };
}

/** One skill by name, with its instructions as written. */
export async function skillRoute(request: VaultRequest): Promise<RouteResult> {
  const name = decodeSegment(request.nameParam, 'name');
  const { fs, markdown } = request;
  const skill = await readSkill({ fs, markdown, name });
  request.assertStillOpen();
  if (skill === null) throw new ApiError('not_found', `No skill called ${JSON.stringify(name)}`);
  return {
    status: 200,
    body: { skill: { ...toApiSkill(skill), instructions: skill.instructions } },
  };
}

function toApiSkill({ name, path, description, problems }: SkillSummary): ApiSkill {
  return { name, path, description, problems };
}
