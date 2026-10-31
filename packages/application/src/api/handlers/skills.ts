import type { SKILL_ROUTES } from '../contract/skills.ts';
import { skillRoute, skillsRoute } from '../skills.ts';
import { type HandlerTable, vaultRoute } from './route-handler.ts';

/** What answers each route for skills. */
export const SKILL_HANDLERS: HandlerTable<typeof SKILL_ROUTES> = {
  'GET /v1/skills': vaultRoute(skillsRoute),
  'GET /v1/skills/{name}': vaultRoute(skillRoute),
};
