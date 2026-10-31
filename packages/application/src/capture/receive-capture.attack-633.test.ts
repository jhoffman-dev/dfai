import { describe, expect, it } from 'vitest';
import { CAPTURE_QUERY_MARK, readCapture } from '@dfai/domain';
import { slackCapture } from '@dfai/domain/testing';
import { apiFixture } from '../testing/api-fixture.ts';
import { fakeMarkdown } from '../testing/fake-ports.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import type { QueryResult } from '../index/ports.ts';
import { receiveCapture } from './receive-capture.ts';

/*
 * Attack on PR #633 (#106): `atlas_capture` lets the model choose the kind
 * and the title, so one message can arrive as a note, then a task, under
 * three titles, at once, while the index has read none of them. ADR-0049:
 * "a message is saved once". All names are made up.
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

const ASKS = [
  { kind: 'note', title: null },
  { kind: 'task', title: 'Renewal, from Slack' },
  { kind: 'note', title: 'Keep this Larkspur thread' },
] as const;

describe('one message asked for as a note and a task under three titles (attack on PR #633)', () => {
  const setUp = () => {
    const api = apiFixture();
    const ports = { fs: api.fs, markdown: quotedMarkdown(), index: laggingIndex };
    const receive = (ask: (typeof ASKS)[number]) =>
      receiveCapture({ ports, capture: readCapture(slackCapture(ask)), timeZone: 'UTC' });
    const captures = () =>
      [...api.files.keys()].filter((path) => path.startsWith('Inbox/Captures/'));
    return { receive, captures };
  };

  it('saves it once when the asks come one after another', async () => {
    const { receive, captures } = setUp();
    const receipts = [];
    for (const ask of ASKS) receipts.push(await receive(ask));

    expect(captures()).toHaveLength(1);
    expect(receipts.map((receipt) => receipt.outcome)).toEqual(['written', 'in-vault', 'in-vault']);
    expect(new Set(receipts.map((receipt) => receipt.path)).size).toBe(1);
  });

  it('saves it once when the asks come at the same moment', async () => {
    const { receive, captures } = setUp();
    const receipts = await Promise.all(ASKS.map(receive));

    expect(captures()).toHaveLength(1);
    expect(receipts.filter((receipt) => receipt.outcome === 'written')).toHaveLength(1);
    expect(new Set(receipts.map((receipt) => receipt.path)).size).toBe(1);
  });
});
