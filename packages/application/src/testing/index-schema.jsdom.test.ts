// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { jsonMarkdown } from './json-markdown.ts';
import { atlasQueryIndex } from './query-index.ts';
import { sqliteIndexPort } from './sqlite-index.ts';

/**
 * Component tests run in jsdom, where a module's URL is not a file's, and they
 * load the test indexes too (CI's failure on #653): the schema must load there
 * as it does in Node.
 */
describe('the test indexes in a browser-like environment', () => {
  it('make the host schema and answer a query', async () => {
    const query = atlasQueryIndex({ files: { 'Note.md': '# Note\n' }, markdown: jsonMarkdown() });
    const result = await query('SELECT title FROM files', []);
    expect(result.rows).toEqual([['Note']]);
    const stats = await sqliteIndexPort().stats();
    expect(stats.notes).toBe(0);
  });
});
