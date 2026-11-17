import { describe, expect, it } from 'vitest';
import { parseDatasource, type Datasource } from './datasource.ts';
import { sourceTrustRefusal } from './source-trust.ts';

function source(fields: Record<string, unknown>): Datasource {
  const parsed = parseDatasource({ atlas: 'source', into: 'Imported', type: 'row', ...fields });
  if (parsed === null) throw new Error('not a source');
  return parsed;
}

const withSecret = source({
  format: 'json',
  url: 'https://api.github.com/user?token={{secret:github}}',
});
const withSecretHeader = source({
  format: 'json',
  url: 'https://api.github.com/user',
  headers: { Authorization: 'Bearer {{secret:github}}' },
});
const outsideDatabase = source({
  format: 'sqlite',
  file: '/Users/j/Library/Messages/chat.db',
  query: 'select 1',
});
const insideDatabase = source({ format: 'sqlite', file: 'data/app.db', query: 'select 1' });
const publicFeed = source({ format: 'ics', url: 'https://example.com/holidays.ics' });
const vaultFile = source({ format: 'csv', file: 'data/feed.csv' });

describe('sourceTrustRefusal', () => {
  it.each([
    ['a secret in its URL', withSecret],
    ['a secret in a header', withSecretHeader],
    ['a database outside the vault', outsideDatabase],
  ])('refuses a source in user space that uses %s, saying to move it', (_, risky) => {
    const refusal = sourceTrustRefusal({ source: risky, sourcePath: 'Feeds/GitHub.md' });

    expect(refusal).toMatch(/\.atlas\/sources/);
    expect(refusal).toMatch(/System → sources/);
    // System is in Pages, which may be hidden (#902): the refusal says how to show it.
    expect(refusal).toContain("show it from the sidebar's … menu");
  });

  it('names the secret it would have sent', () => {
    expect(sourceTrustRefusal({ source: withSecret, sourcePath: 'GitHub.md' })).toContain(
      '“github”',
    );
  });

  it.each([withSecret, withSecretHeader, outsideDatabase])(
    'runs the same source from .atlas/sources, at any depth',
    (risky) => {
      expect(sourceTrustRefusal({ source: risky, sourcePath: '.atlas/sources/GitHub.md' })).toBe(
        null,
      );
      expect(sourceTrustRefusal({ source: risky, sourcePath: '.atlas/sources/work/A.md' })).toBe(
        null,
      );
    },
  );

  it.each([
    ['.atlas/views/GitHub.md'],
    ['.atlas/sourcesX/GitHub.md'],
    ['Notes/.atlas/sources/GitHub.md'],
    ['.atlas/Sources/GitHub.md'],
  ])('does not trust %s, which only looks like the sources folder', (sourcePath) => {
    expect(sourceTrustRefusal({ source: withSecret, sourcePath })).not.toBe(null);
  });

  it.each([
    ['a public feed', publicFeed],
    ['a file in the vault', vaultFile],
    ['a database in the vault', insideDatabase],
  ])('runs %s from anywhere', (_, plain) => {
    expect(sourceTrustRefusal({ source: plain, sourcePath: 'Feeds/Plain.md' })).toBe(null);
  });
});
