import { describe, expect, it } from 'vitest';
import { CAPTURE_QUERY_MARK, readCapture } from '@dfai/domain';
import { slackCapture } from '@dfai/domain/testing';
import { apiFixture } from '../testing/api-fixture.ts';
import { fakeMarkdown } from '../testing/fake-ports.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import type { QueryResult } from '../index/ports.ts';
import { receiveCapture } from './receive-capture.ts';

/*
 * Second attack on PR #615 (#103): one message, captured twice at once under
 * two titles — n8n's from the first line and a pasted link's (#105) — while
 * the index has read neither. ADR-0049: "a message is saved once". All
 * names are made up.
 */

/** `fakeMarkdown`'s `key: value` lines, with a single-quoted value read as YAML reads it. */
function quotedMarkdown(): MarkdownPort {
  const base = fakeMarkdown();
  return {
    ...base,
    frontmatterProperties: (frontmatter) =>
      Object.fromEntries(
        Object.entries(base.frontmatterProperties(frontmatter)).map(([key, value]) => [
          key,
          typeof value === 'string' ? value.replace(/^'(.*)'$/, '$1').replace(/''/g, "'") : value,
        ]),
      ),
  };
}

/** An index that has read nothing yet: it lags the writes. */
const laggingIndex = {
  query: async (sql: string): Promise<QueryResult> => ({
    columns: sql.startsWith(CAPTURE_QUERY_MARK) ? ['path'] : [],
    rows: [],
    truncated: false,
  }),
};

describe('two captures of one message at once (#103, second attack on PR #615)', () => {
  it('saves the message once, whatever title each capture asks for', async () => {
    const api = apiFixture();
    const ports = { fs: api.fs, markdown: quotedMarkdown(), index: laggingIndex };
    const receive = (title: string | null) =>
      receiveCapture({ ports, capture: readCapture(slackCapture({ title })), timeZone: 'UTC' });
    const receipts = await Promise.all([receive(null), receive('Renewal, from Slack')]);
    const captures = [...api.files.keys()].filter((path) => path.startsWith('Inbox/Captures/'));
    expect(captures).toHaveLength(1);
    expect(receipts.map((receipt) => receipt.outcome).sort()).toEqual(['in-vault', 'written']);
  });
});
