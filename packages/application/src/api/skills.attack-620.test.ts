/**
 * Adversarial tests for the read-only skill routes (PR #620, #169): names
 * spelled to slip past the folder match, and a SKILL.md the host lists but
 * will not read. The API answers any local process, so it hands out the
 * skill's own words and never the host's (ADR-0016, ADR-0017).
 */

import { describe, expect, it } from 'vitest';
import { apiFixture, bodyOf, codeOf } from '../testing/api-fixture.ts';
import { VaultAccessError } from '../vault/ports.ts';

const REVIEW = '---\nname: weekly-review\ndescription: Reviews.\n---\n\nStep.\n';
const SECRET = 'apiToken: secret-7f3a';

function vault() {
  return apiFixture({
    files: {
      '.atlas/settings.md': `---\n${SECRET}\n---\n\nSETTINGS BODY\n`,
      '.atlas/skills/weekly-review/SKILL.md': REVIEW,
      '.atlas/skills/weekly-review/scripts/run.md': 'NEVER READ',
    },
  });
}

type Api = ReturnType<typeof vault>;
const readRaw = (api: Api, segment: string) =>
  api.send({ method: 'GET', path: `/v1/skills/${segment}` });

describe('a name spelled to slip past the folder match', () => {
  it.each([
    ['overlong UTF-8 for "."', 'weekly-review%C0%AE'],
    ['overlong UTF-8 for "/"', 'weekly-review%C0%AFscripts'],
    ['an encoded NUL', 'weekly-review%00'],
    ['a trailing dot', 'weekly-review.'],
    ['a trailing space', 'weekly-review%20'],
    ['a trailing tab', 'weekly-review%09'],
    ['a leading space', '%20weekly-review'],
    ['a zero-width space', 'weekly%E2%80%8B-review'],
    ['a non-breaking hyphen', 'weekly%E2%80%91review'],
    ['a fullwidth slash', 'weekly-review%EF%BC%8Fscripts'],
  ])('%s finds no skill and hands out nothing', async (_label, segment) => {
    const api = vault();

    const response = await readRaw(api, segment);

    expect(['not_found', 'invalid']).toContain(codeOf(response));
    const body = JSON.stringify(bodyOf(response));
    expect(body).not.toContain('Step.');
    expect(body).not.toContain('NEVER READ');
    expect(body).not.toContain('secret-7f3a');
  });

  it.each([
    ['mixed case', 'Weekly-Review'],
    ['fullwidth letters', '%EF%BD%97eekly-review'],
  ])('%s means the folder it folds to, as APFS or NFKC reads it', async (_label, segment) => {
    const response = await readRaw(vault(), segment);

    expect(response.status).toBe(200);
    expect((bodyOf(response)['skill'] as { name: string }).name).toBe('weekly-review');
  });
});

describe('a SKILL.md the host lists but will not read', () => {
  const HOST_TEXT = 'cannot read: Permission denied (os error 13) at /Users/mara/Vault/.atlas';

  function deniedVault() {
    const api = vault();
    const read = api.deps.fs.readTextFile.bind(api.deps.fs);
    Object.assign(api.deps.fs, {
      readTextFile: async (path: string) => {
        if (path.endsWith('SKILL.md')) throw new VaultAccessError(HOST_TEXT);
        return read(path as Parameters<typeof read>[0]);
      },
    });
    return api;
  }

  it('is listed with a file problem that carries none of the host’s words', async () => {
    const response = await deniedVault().send({ method: 'GET', path: '/v1/skills' });

    expect(response.status).toBe(200);
    const [skill] = bodyOf(response)['skills'] as {
      problems: { field: string; message: string }[];
    }[];
    expect(skill?.problems.map(({ field }) => field)).toContain('file');
    const said = JSON.stringify(skill?.problems);
    expect(said).not.toContain('os error');
    expect(said).not.toContain('/Users/');
  });

  it('is read with a file problem that carries none of the host’s words', async () => {
    const response = await readRaw(deniedVault(), 'weekly-review');

    expect(response.status).toBe(200);
    const said = JSON.stringify(bodyOf(response));
    expect(said).toContain('"file"');
    expect(said).not.toContain('os error');
    expect(said).not.toContain('/Users/');
  });
});
