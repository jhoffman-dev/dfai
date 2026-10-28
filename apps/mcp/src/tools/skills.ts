/** Tools for the vault's skills: `/v1/skills`. Read-only — skills are made and edited in the app. */

import { z } from 'zod';
import { defineTool } from './define.ts';
import { noInput } from './inputs.ts';

const READ_ONLY = { readOnlyHint: true } as const;

export const listSkills = defineTool({
  name: 'atlas_list_skills',
  title: 'List skills',
  description:
    'Every skill in the vault — an Agent Skills folder in .atlas/skills holding a SKILL.md — ' +
    'sorted by name: { skills: [{ name, path, description, problems }] }. "name" is the ' +
    "folder's name, the skill's identity; each problem is { field, message }, field one of " +
    '"name", "description", "instructions" or "file", for what breaks the rules (a name: ' +
    'that differs from its folder, a missing description, no SKILL.md). Pass a "name" to ' +
    'atlas_read_skill for its instructions. Read-only: making, editing and deleting skills ' +
    'stay in the app.',
  inputSchema: noInput,
  annotations: READ_ONLY,
  call: (client) => client.skills(),
});

export const readSkill = defineTool({
  name: 'atlas_read_skill',
  title: 'Read a skill',
  description:
    'Read one skill by its folder name, as atlas_list_skills gives it, in any case: ' +
    '{ skill: { name, path, description, ' +
    'problems, instructions } }. "instructions" is the body of its SKILL.md as written. Fails ' +
    'with "not_found" when no skill folder has the name. Read-only.',
  inputSchema: z.object({
    name: z
      .string()
      .min(1)
      .describe('A skill\'s name, as atlas_list_skills gives it, e.g. "weekly-review".'),
  }),
  annotations: READ_ONLY,
  call: (client, { name }) => client.skill(name),
});

export const skillTools = [listSkills, readSkill];
