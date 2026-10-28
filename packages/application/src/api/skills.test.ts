/**
 * Issue #169 through the local API: the skills, read-only (ADR-0050). Each
 * is listed by its folder's name with what is wrong with it, as the Skills
 * page will say, and one is read by name. A name is only ever compared with
 * the folders there are, so none reaches outside `.atlas/skills`.
 */

import { describe, expect, it } from 'vitest';
import { apiFixture, bodyOf, codeOf, encoded } from '../testing/api-fixture.ts';

const REVIEW =
  '---\nname: weekly-review\ndescription: Walks Mara Quill through the Friday review.\n---\n\n' +
  'List each project with no next action.\n';
const DAILY = '---\nname: morning\ndescription: Plans the day.\n---\n\nRead the calendar.\n';

function vault(files: Record<string, string> = {}) {
  return apiFixture({
    files: {
      '.atlas/settings.md': '---\napiToken: secret\n---\n',
      '.atlas/skills/weekly-review/SKILL.md': REVIEW,
      '.atlas/skills/weekly-review/scripts/run.md': 'never read',
      '.atlas/skills/daily/SKILL.md': DAILY,
      '.atlas/templates/Meeting.md': '# Agenda\n',
      'Notes/Plain.md': 'A note.\n',
      ...files,
    },
  });
}

type Api = ReturnType<typeof vault>;
const list = (api: Api) => api.send({ method: 'GET', path: '/v1/skills' });
const readRaw = (api: Api, segment: string) =>
  api.send({ method: 'GET', path: `/v1/skills/${segment}` });
const read = (api: Api, name: string) => readRaw(api, encoded(name));

describe('GET /v1/skills', () => {
  it('lists every skill folder by name, with its description and problems', async () => {
    const response = await list(vault());

    expect(response.status).toBe(200);
    expect(bodyOf(response)).toEqual({
      skills: [
        {
          name: 'daily',
          path: '.atlas/skills/daily/SKILL.md',
          description: 'Plans the day.',
          problems: [
            { field: 'name', message: 'SKILL.md names it “morning”, but its folder is “daily”.' },
          ],
        },
        {
          name: 'weekly-review',
          path: '.atlas/skills/weekly-review/SKILL.md',
          description: 'Walks Mara Quill through the Friday review.',
          problems: [],
        },
      ],
    });
  });

  it('answers none for a vault with no skills folder', async () => {
    const api = apiFixture({ files: { 'Notes/Plain.md': 'x' } });

    expect(bodyOf(await list(api))).toEqual({ skills: [] });
  });

  it('writes nothing', async () => {
    const api = vault();

    await list(api);
    await read(api, 'weekly-review');

    expect(api.writes).toEqual([]);
  });
});

describe('GET /v1/skills/{name}', () => {
  it('reads one skill with its instructions as written', async () => {
    const response = await read(vault(), 'weekly-review');

    expect(response.status).toBe(200);
    expect(bodyOf(response)).toEqual({
      skill: {
        name: 'weekly-review',
        path: '.atlas/skills/weekly-review/SKILL.md',
        description: 'Walks Mara Quill through the Friday review.',
        problems: [],
        instructions: 'List each project with no next action.\n',
      },
    });
  });

  it('reads it by its folder name in any case', async () => {
    const response = await read(vault(), 'Weekly-Review');

    expect(bodyOf(response)['skill']).toMatchObject({ name: 'weekly-review' });
  });

  it('is not_found for a name no folder has, even one SKILL.md declares', async () => {
    const api = vault();

    expect(codeOf(await read(api, 'nope'))).toBe('not_found');
    expect(codeOf(await read(api, 'morning'))).toBe('not_found');
  });

  it('reads a folder with no SKILL.md as a skill with that problem', async () => {
    const api = vault({ '.atlas/skills/empty/notes.md': 'x' });

    const response = await read(api, 'empty');

    expect(bodyOf(response)['skill']).toMatchObject({
      name: 'empty',
      instructions: '',
      problems: [{ field: 'file', message: 'The folder has no SKILL.md.' }],
    });
  });
});

describe('a skill is never one of the vault’s notes', () => {
  it('refuses its SKILL.md by note path, as it refuses all of .atlas', async () => {
    const api = vault();

    const response = await api.send({
      method: 'GET',
      path: `/v1/notes/${encoded('.atlas/skills/weekly-review/SKILL.md')}`,
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(bodyOf(response))).not.toContain('Friday review');
  });
});
