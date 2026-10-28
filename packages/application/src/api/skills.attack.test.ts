/**
 * Adversarial edges of the read-only skill routes (#169): what a name can
 * reach. A name is matched against the folders in `.atlas/skills`, never
 * joined into a path, so a path in it, `..`, percent-encoding tricks and
 * the way out to the rest of `.atlas` all find nothing.
 */

import { describe, expect, it } from 'vitest';
import { apiFixture, bodyOf, codeOf, encoded } from '../testing/api-fixture.ts';

const SECRET = 'apiToken: secret-7f3a';

function vault() {
  return apiFixture({
    files: {
      '.atlas/settings.md': `---\n${SECRET}\n---\n`,
      '.atlas/settings/SKILL.md': `---\nname: settings\ndescription: ${SECRET}\n---\n\nx\n`,
      '.atlas/templates/SKILL.md': '---\nname: templates\ndescription: t\n---\n\nx\n',
      '.atlas/skills/weekly-review/SKILL.md':
        '---\nname: weekly-review\ndescription: Reviews.\n---\n\nStep.\n',
      '.atlas/skills/weekly-review/scripts/SKILL.md':
        '---\nname: scripts\ndescription: nested\n---\n\nnested\n',
      'SKILL.md': '---\nname: root\ndescription: root\n---\n\nroot\n',
    },
  });
}

type Api = ReturnType<typeof vault>;
const readRaw = (api: Api, segment: string) =>
  api.send({ method: 'GET', path: `/v1/skills/${segment}` });

describe('a name that is a path', () => {
  it.each([
    ['../settings', encoded('../settings')],
    ['../../.atlas/settings', encoded('../../.atlas/settings')],
    ['..%2Fsettings', '..%2Fsettings'],
    ['%2E%2E%2Fsettings', '%2E%2E%2Fsettings'],
    ['double-encoded ..', '%252E%252E%252Fsettings'],
    ['../templates', encoded('../templates')],
    ['weekly-review/scripts', encoded('weekly-review/scripts')],
    ['weekly-review/SKILL.md', encoded('weekly-review/SKILL.md')],
    ['/SKILL.md', encoded('/')],
    ['.atlas/settings', encoded('.atlas/settings')],
    ['a NUL', encoded('weekly-review\u0000')],
  ])('%s finds no skill and hands out nothing else', async (_label, segment) => {
    const api = vault();

    const response = await readRaw(api, segment);

    expect(codeOf(response)).toBe('not_found');
    expect(JSON.stringify(bodyOf(response))).not.toContain('secret-7f3a');
    expect(JSON.stringify(bodyOf(response))).not.toContain('nested');
  });

  it('is invalid when its percent-encoding is broken', async () => {
    const response = await readRaw(vault(), '%E0%A4%A');

    expect(codeOf(response)).toBe('invalid');
  });

  it('lists only the folders in .atlas/skills, never one nested in a skill', async () => {
    const response = await vault().send({ method: 'GET', path: '/v1/skills' });

    const names = (bodyOf(response)['skills'] as { name: string }[]).map(({ name }) => name);
    expect(names).toEqual(['weekly-review']);
  });
});

describe('no route writes a skill', () => {
  it.each(['PUT', 'POST', 'PATCH', 'DELETE'] as const)(
    '%s /v1/skills/{name} is not a route',
    async (method) => {
      const api = vault();

      const response = await api.send({ method, path: '/v1/skills/weekly-review', body: {} });

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(api.writes).toEqual([]);
    },
  );
});
