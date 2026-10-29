/**
 * Attack on PR #629 (#169): `/v1/automations` and a dry run name a step's
 * skill, and never hand out what its SKILL.md holds; a broken rule is listed
 * as it was before skills, even one whose `skill:` reads.
 */
import { describe, expect, it } from 'vitest';
import { digestOf } from '@dfai/domain';
import { apiFixture, bodyOf, encoded } from '../testing/api-fixture.ts';
import { jsonMarkdown, jsonNote } from '../testing/json-markdown.ts';
import { atlasQueryIndex } from '../testing/query-index.ts';

const rule = (fields: Record<string, unknown>) =>
  jsonNote({ atlas: 'automation', enabled: true, ...fields });
const SECRET_DESCRIPTION = 'Larkspur-only description of the skill.';
const SECRET_STEPS = 'Larkspur-only instructions: ask Mara Quill first.';

const FILES: Record<string, string> = {
  '.atlas/types/task.md': jsonNote({
    name: 'task',
    label: 'Task',
    properties: { status: { kind: 'select', options: ['todo', 'done'] } },
  }),
  '.atlas/skills/task-notes/SKILL.md': `---\n${JSON.stringify({
    name: 'task-notes',
    description: SECRET_DESCRIPTION,
  })}\n---\n\n${SECRET_STEPS}\n`,
  '.atlas/automations/Skilled.md': rule({
    id: 'skilled',
    name: 'Skilled',
    when: 'manually',
    which: 'FROM task',
    do: 'claude',
    skill: 'task-notes',
    output: 'proposals',
  }),
  '.atlas/automations/Broken skilled.md': rule({
    name: 'Broken skilled',
    when: 'manually',
    which: 'FROM task',
    do: 'claude',
    skill: 'task-notes',
    tools: ['atlas_write_note'],
    output: 'proposals',
  }),
  'tasks/A.md': jsonNote({ type: 'task', status: 'done' }),
};

function api() {
  const markdown = jsonMarkdown();
  return apiFixture({
    files: FILES,
    markdown,
    index: {
      query: atlasQueryIndex({ files: FILES, markdown }),
      manifest: async () =>
        Object.entries(FILES).map(([path, text]) => ({
          path,
          modified: 0,
          size: text.length,
          type: null,
          digest: digestOf(text),
        })),
    },
  });
}

describe('a step with a skill, through the API (#629 attack)', () => {
  it('lists its skill and never what the SKILL.md holds', async () => {
    const response = await api().send({ method: 'GET', path: '/v1/automations' });
    const text = JSON.stringify(bodyOf(response));
    expect(text).toContain('"skill":"task-notes"');
    expect(text).not.toContain(SECRET_DESCRIPTION);
    expect(text).not.toContain(SECRET_STEPS);
  });

  it('dry-runs it with its skill and never what the SKILL.md holds', async () => {
    const response = await api().send({
      method: 'POST',
      path: `/v1/automations/${encoded('skilled')}/dry-run`,
    });
    expect(response.status).toBe(200);
    const text = JSON.stringify(bodyOf(response));
    expect(text).toContain('"skill":"task-notes"');
    expect(text).not.toContain(SECRET_DESCRIPTION);
    expect(text).not.toContain(SECRET_STEPS);
  });

  it('lists a broken rule that names a skill with only its path, name and problem', async () => {
    const { broken } = bodyOf(await api().send({ method: 'GET', path: '/v1/automations' })) as {
      broken: Record<string, unknown>[];
    };
    expect(broken).toHaveLength(1);
    expect(Object.keys(broken[0] ?? {}).sort()).toEqual(['name', 'path', 'problem']);
  });
});
