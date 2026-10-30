import { describe, expect, it } from 'vitest';
import type { HttpRequest } from '@dfai/domain';
import {
  apiFixture,
  bodyOf,
  codeOf,
  encoded,
  NOW,
  OTHER_VAULT,
  VAULT,
} from '../testing/api-fixture.ts';

/* P12-06 / A19-01 through the local API: refreshing a source note now. */

const ISSUES = [
  '---',
  'atlas: source',
  'format: json',
  'url: https://api.github.com/repos/me/atlas/issues?token={{secret:github}}',
  'into: Issues',
  'type: issue',
  'key: id',
  'name: title',
  '---',
  '',
].join('\n');

/** A feed anyone may read: it runs from any folder. */
const PUBLIC_FEED = ISSUES.replace('?token={{secret:github}}', '');

const FEED = JSON.stringify([
  { id: '1', title: 'Crash on open' },
  { id: '2', title: 'Slow search' },
]);

type Api = ReturnType<typeof apiFixture>;

/** Where a source that sends a secret has to live to be refreshed (ADR-0017). */
const TRUSTED = '.atlas/sources/Issues.md';

const refresh = (api: Api, path = TRUSTED) =>
  api.send({ method: 'POST', path: `/v1/sources/${encoded(path)}/refresh` });

function vault() {
  const api = apiFixture({ files: { [TRUSTED]: ISSUES, 'Plain.md': '# Plain\n' } });
  api.folders.add('Issues');
  api.feed = async () => FEED;
  return api;
}

describe('POST /v1/sources/{path}/refresh', () => {
  it('refreshes the source into its folder and answers what it did', async () => {
    const api = vault();

    const response = await refresh(api);

    expect(response.status).toBe(200);
    expect(bodyOf(response)).toEqual({
      report: {
        ran: NOW,
        from: 'https://api.github.com/repos/me/atlas/issues?token={{secret:github}}',
        records: 2,
        created: 2,
        replaced: 0,
        updated: 0,
        missing: 0,
        unkeyed: 0,
        truncated: false,
        error: null,
      },
    });
    expect([...api.files.keys()].filter((path) => path.startsWith('Issues/'))).toHaveLength(2);
  });

  it('hands the host the secret by name, for this vault, and never a value', async () => {
    const api = vault();

    await refresh(api);

    expect(api.fetches).toEqual([
      {
        vault: VAULT.absolutePath,
        request: {
          url: [
            { text: 'https://api.github.com/repos/me/atlas/issues?token=' },
            { secret: 'github' },
          ],
          headers: [],
        } satisfies HttpRequest,
      },
    ]);
  });

  it('answers a feed that failed as a report that says why, writing nothing', async () => {
    const api = vault();
    api.feed = async () => {
      throw new Error('api.github.com refused the request: its origin is not bound to github');
    };

    const response = await refresh(api);

    expect(response.status).toBe(200);
    expect(bodyOf(response)['report']).toMatchObject({ created: 0, error: expect.any(String) });
    expect(api.writes).toEqual([]);
  });

  it('refuses a second refresh of the same source while the first is under way', async () => {
    const api = vault();
    let release: (text: string) => void = () => {};
    api.feed = () => new Promise((resolve) => (release = resolve));

    const first = refresh(api);
    await expect.poll(() => api.fetches.length).toBe(1);
    const second = await refresh(api);
    release(FEED);

    expect(codeOf(second)).toBe('conflict');
    expect((await first).status).toBe(200);
    expect(api.fetches).toHaveLength(1);
  });

  it('refreshes again through the API once 30 seconds have passed', async () => {
    const api = vault();
    await refresh(api);
    api.now += 30_000;
    expect((await refresh(api)).status).toBe(200);
    expect(api.fetches).toHaveLength(2);
  });

  it('does not hold a refresh off once the clock is set back, as the window cannot have begun', async () => {
    const api = vault();
    await refresh(api);
    // The Mac's clock is corrected back an hour.
    api.now -= 60 * 60_000;

    expect((await refresh(api)).status).toBe(200);
    expect(api.fetches).toHaveLength(2);
    // The window starts again from the clock as it now is.
    api.now += 20_000;
    expect(bodyOf(await refresh(api))['error']).toMatchObject({ code: 'conflict', retryAfter: 10 });
  });

  it('refuses a refresh sooner than that as a conflict saying how long to wait, fetching nothing', async () => {
    const api = vault();
    await refresh(api);
    api.now += 20_000;

    const response = await refresh(api);

    expect(response.status).toBe(409);
    expect(bodyOf(response)['error']).toMatchObject({ code: 'conflict', retryAfter: 10 });
    expect(api.fetches).toHaveLength(1);
  });

  it('spaces each source on its own', async () => {
    const api = vault();
    api.files.set('Holidays.md', { text: PUBLIC_FEED, modified: 1 });
    await refresh(api);

    expect((await refresh(api, 'Holidays.md')).status).toBe(200);
  });

  it('refreshes a public feed kept in user space', async () => {
    const api = vault();
    api.files.set('Holidays.md', { text: PUBLIC_FEED, modified: 1 });

    const response = await refresh(api, 'Holidays.md');

    expect(response.status).toBe(200);
    expect(bodyOf(response)['report']).toMatchObject({ created: 2, error: null });
  });

  it.each([
    ['sends a secret', ISSUES],
    [
      'reads a SQLite file outside the vault',
      ISSUES.replace(
        'format: json\nurl: https://api.github.com/repos/me/atlas/issues?token={{secret:github}}',
        'format: sqlite\nfile: /Users/j/Library/Messages/chat.db\nquery: SELECT 1',
      ),
    ],
  ])(
    'refuses a source in user space that %s, saying to move it to .atlas/sources',
    async (_why, text) => {
      const api = vault();
      api.files.set('Issues.md', { text, modified: 1 });

      const response = await refresh(api, 'Issues.md');

      expect(codeOf(response)).toBe('forbidden');
      expect(JSON.stringify(bodyOf(response))).toContain('System → sources');
      expect(api.fetches).toEqual([]);
      expect(api.sqliteQueries).toEqual([]);
      expect(api.writes).toEqual([]);
    },
  );

  it.each([
    ['a note that is not a source', 'Plain.md', 'invalid'],
    ['a note that is not there', 'Gone.md', 'not_found'],
    ['a note in a hidden folder', '.atlas/.git/x.md', 'invalid'],
    ['a note outside the vault', '../x.md', 'invalid'],
  ])('refuses %s', async (_why, path, code) => {
    const api = vault();
    expect(codeOf(await refresh(api, path))).toBe(code);
    expect(api.fetches).toEqual([]);
  });

  it('refreshes a source kept in .atlas/sources, where sources live, however it is cased', async () => {
    const api = vault();
    api.files.set('.atlas/sources/Issues.md', { text: ISSUES, modified: 1 });

    const response = await refresh(api, '.atlas/Sources/issues.md');

    expect(response.status).toBe(200);
    expect(api.fetches).toHaveLength(1);
  });

  it.each([
    ['writes into .atlas', 'into: Issues', 'into: .atlas/types'],
    ['writes into a hidden folder', 'into: Issues', 'into: .git'],
    [
      'reads a hidden file',
      'url: https://api.github.com/repos/me/atlas/issues?token={{secret:github}}',
      'file: .git/config',
    ],
    [
      'reads a file in .atlas',
      'url: https://api.github.com/repos/me/atlas/issues?token={{secret:github}}',
      'file: .atlas/settings.md',
    ],
    [
      'reads a file outside the vault by climbing out of it',
      'url: https://api.github.com/repos/me/atlas/issues?token={{secret:github}}',
      'file: ../other/people.csv',
    ],
  ])('refuses a source that %s, reading and writing nothing', async (_why, line, replaced) => {
    const api = vault();
    const text = ISSUES.replace(line, replaced);
    expect(text).not.toBe(ISSUES);
    api.files.set(TRUSTED, { text, modified: 1 });

    expect(codeOf(await refresh(api))).toBe('invalid');
    expect(api.fetches).toEqual([]);
    expect(api.writes).toEqual([]);
  });

  it('leaves a SQLite file outside the vault to the host, which opens only one picked on this Mac, from .atlas/sources', async () => {
    const api = vault();
    const sqlite = [
      '---',
      'atlas: source',
      'format: sqlite',
      'file: /Users/j/Library/Messages/chat.db',
      'query: SELECT 1',
      'into: Issues',
      'type: issue',
      '---',
      '',
    ].join('\n');
    api.files.set(TRUSTED, { text: sqlite, modified: 1 });

    const response = await refresh(api);

    expect(response.status).toBe(200);
    expect(bodyOf(response)['report']).toMatchObject({ created: 0, error: expect.any(String) });
    expect(api.writes).toEqual([]);
  });

  it('answers no_vault, not a report, when another vault is opened while it runs', async () => {
    const api = vault();
    api.feed = async () => {
      api.open = OTHER_VAULT;
      return FEED;
    };

    expect(codeOf(await refresh(api))).toBe('no_vault');
    expect(api.writes).toEqual([]);
  });
});
