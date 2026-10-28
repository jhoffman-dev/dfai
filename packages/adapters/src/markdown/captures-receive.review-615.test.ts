/**
 * Regressions from PR #615's review (#103): a sender's text must never make
 * a link, a relation, an embed or a crash out of a capture. Each payload is
 * the review's own, run through the real YAML reader, parser and index.
 * All names are made up.
 */
import { describe, expect, it } from 'vitest';
import { apiFixture, bodyOf, codeOf } from '@dfai/application';
import { atlasQueryIndex } from '@dfai/application/testing/sqlite';
import { relationsOf, splitFrontmatter } from '@dfai/domain';
import { SLACK_PERMALINK, slackCapture, slackSource } from '@dfai/domain/testing';
import { remarkMarkdown } from './markdown-port.ts';

const MARA = '---\ntype: person\nemail: mara.quill@example.com\n---\n\nPayroll lead.\n';

function vault(files: Record<string, string> = { 'People/Mara Quill.md': MARA }) {
  return apiFixture({
    files,
    markdown: remarkMarkdown,
    index: { query: atlasQueryIndex({ files, markdown: remarkMarkdown }) },
  });
}

/** The capture's file once written, or a failure naming what the route answered. */
async function written(body: unknown): Promise<string> {
  const api = vault();
  const response = await api.send({ method: 'POST', path: '/v1/captures', body });
  if (response.status !== 201)
    throw new Error(`answered ${response.status}: ${JSON.stringify(response.body)}`);
  const path = (bodyOf(response)['capture'] as { path: string }).path;
  return api.files.get(path)?.text ?? '';
}

const relationsIn = (text: string) =>
  relationsOf(remarkMarkdown.frontmatterProperties(splitFrontmatter(text).frontmatter), () => null);

const refused = async (body: unknown) =>
  codeOf(await vault().send({ method: 'POST', path: '/v1/captures', body }));

describe('review #615 MAJOR 1: sender text in the frontmatter makes no relation', () => {
  it('writes an author’s and a channel’s brackets so they link nothing', async () => {
    const text = await written(
      slackCapture({
        source: slackSource({
          author: { name: 'Tobias [[Mara Quill]]' },
          channel: { id: 'C0LARK5PUR', name: 'ops [[Payroll]]' },
        }),
        thread: [],
      }),
    );
    expect(relationsIn(text)).toEqual([]);
  });

  it('refuses an address holding brackets', async () => {
    const author = { name: 'Tobias', email: 'a@[[Board]]' };
    expect(await refused(slackCapture({ source: slackSource({ author }) }))).toBe('invalid');
  });

  it('refuses a permalink whose query holds brackets', async () => {
    const url = `${SLACK_PERMALINK}?x=[[Secret]]`;
    expect(await refused(slackCapture({ source: slackSource({ url }), thread: [] }))).toBe(
      'invalid',
    );
  });
});
