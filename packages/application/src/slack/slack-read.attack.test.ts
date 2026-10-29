import { describe, expect, it } from 'vitest';
import { readSlackPermalink, type SlackFailureKind, type SlackPermalink } from '@dfai/domain';
import {
  MARA_ID,
  SLACK_PERMALINK,
  SLACK_TS,
  TOBIAS_ID,
  slackPermalinkAnswer,
  slackRepliesAnswer,
  slackUserAnswer,
} from '@dfai/domain/testing';
import { SlackError, type SlackMethod, type SlackPort } from './ports.ts';
import { LOOKUPS_AT_ONCE, readSlackMessage } from './read-slack-message.ts';
import { saveSlackMessage } from './save-slack-message.ts';
import { apiFixture } from '../testing/api-fixture.ts';
import { fakeMarkdown } from '../testing/fake-ports.ts';

/*
 * Attack on PR #631 (#105). A users.info lookup that fails the way every
 * other lookup will fail too — Slack unreachable, timing out, or the token
 * lacking users:read — is not a profile hidden from the reader: by
 * ENDS_THE_READ's own rule ("the rest would fail alike") it must end the
 * read, not offer a note whose people are all written as ids.
 */

const LINK = readSlackPermalink(SLACK_PERMALINK) as SlackPermalink;
const people = Array.from({ length: 40 }, (_, at) => `U0PEOPLE${String(at).padStart(3, '0')}`);

/** A Slack that answers the thread and its link, and fails every users.info with `kind`. */
function slackFailingLookups(kind: SlackFailureKind) {
  const calls: SlackMethod[] = [];
  const port: SlackPort = {
    status: async () => ({ hasToken: true }),
    connect: async () => ({ hasToken: true }),
    disconnect: async () => ({ hasToken: false }),
    async call({ method }) {
      calls.push(method);
      if (method === 'auth.test') return { ok: true, user_id: people[0] };
      if (method === 'chat.getPermalink') return slackPermalinkAnswer();
      if (method === 'conversations.replies') {
        return {
          ok: true,
          messages: people.map((user, at) => ({
            ts: at === 0 ? SLACK_TS : `${1793136001 + at}.000100`,
            user,
            text: `Message ${at}`,
          })),
        };
      }
      throw new SlackError({ kind, message: kind });
    },
  };
  return { port, lookups: () => calls.filter((method) => method === 'users.info').length };
}

const read = (slack: SlackPort, link: SlackPermalink = LINK) =>
  readSlackMessage({ slack, vault: '/vaults/larkspur', link, kind: 'note' });

describe('a lookup failing the way every lookup will', () => {
  it.each<SlackFailureKind>(['unreachable', 'timeout', 'missing_scope'])(
    'a %s lookup ends the read rather than saving every person as an id',
    async (kind) => {
      const slack = slackFailingLookups(kind);
      await expect(read(slack.port)).rejects.toMatchObject({ failure: { kind } });
    },
  );

  it.each<SlackFailureKind>(['unreachable', 'timeout'])(
    'a %s lookup stops the asking: no more than one round of lookups goes out',
    async (kind) => {
      const slack = slackFailingLookups(kind);
      await read(slack.port).catch(() => undefined);
      expect(slack.lookups()).toBeLessThanOrEqual(LOOKUPS_AT_ONCE);
    },
  );
});

/*
 * A link to a reply far down a long thread: conversations.replies answers
 * one page (`has_more`, a `next_cursor`), and the reply is on a later one.
 * The message exists and the reader can see it; it must not be called
 * deleted or not theirs.
 */
describe('a reply past the first page of its thread', () => {
  const REPLY_TS = '1793139999.000100';
  const replyLink = readSlackPermalink(
    `${SLACK_PERMALINK.replace(/p\d{16}/, `p${REPLY_TS.replace('.', '')}`)}?thread_ts=${SLACK_TS}&cid=C0LARK5PUR`,
  ) as SlackPermalink;

  function pagedSlack() {
    const port: SlackPort = {
      status: async () => ({ hasToken: true }),
      connect: async () => ({ hasToken: true }),
      disconnect: async () => ({ hasToken: false }),
      async call({ method, query }) {
        if (method === 'auth.test') return { ok: true, user_id: MARA_ID };
        if (method === 'chat.getPermalink') return slackPermalinkAnswer();
        if (method === 'users.info') return slackUserAnswer(query['user'] ?? '');
        const first = slackRepliesAnswer();
        if (query['cursor'] === 'page-2') {
          return {
            ok: true,
            has_more: false,
            messages: [
              {
                type: 'message',
                ts: REPLY_TS,
                thread_ts: SLACK_TS,
                user: TOBIAS_ID,
                text: 'Late reply.',
              },
            ],
          };
        }
        return { ...first, has_more: true, response_metadata: { next_cursor: 'page-2' } };
      },
    };
    return port;
  }

  it('is read, not refused as a message the reader cannot see', async () => {
    expect(replyLink).not.toBeNull();
    const preview = await read(pagedSlack(), replyLink);
    expect(preview.text).toBe('Late reply.');
  });
});

/*
 * Dedupe parity: a pasted link and POST /v1/captures, sent the same payload
 * as JSON (as n8n sends it), write byte-identical files into two empty vaults.
 */
describe('a pasted link and POST /v1/captures', () => {
  function slackAnswering(): SlackPort {
    return {
      status: async () => ({ hasToken: true }),
      connect: async () => ({ hasToken: true }),
      disconnect: async () => ({ hasToken: false }),
      async call({ method, query }) {
        if (method === 'auth.test') return { ok: true, user_id: MARA_ID };
        if (method === 'chat.getPermalink') return slackPermalinkAnswer();
        if (method === 'users.info') return slackUserAnswer(query['user'] ?? '');
        const replies = slackRepliesAnswer();
        const messages = replies['messages'] as Record<string, unknown>[];
        return {
          ...replies,
          messages: [
            { ...messages[0], text: 'Ünïcode — “quotes”, 🦀, a tab\there, `code`, *bold* & <b>' },
            ...messages.slice(1),
            {
              type: 'message',
              ts: '1793136100.000300',
              bot_id: 'B0LARKBOT1',
              username: 'Larkbot',
              text: 'Filed.',
            },
          ],
        };
      },
    };
  }

  it('write the same bytes', async () => {
    const index = { query: async () => ({ columns: [], rows: [], truncated: false }) };
    const pasted = apiFixture({ files: {}, index });
    const posted = apiFixture({ files: {}, index });
    const { payload } = await read(slackAnswering());
    const receipt = await saveSlackMessage({
      ports: { fs: pasted.fs, markdown: fakeMarkdown(), index },
      payload,
      kind: 'note',
      timeZone: 'America/Los_Angeles',
    });
    const response = await posted.send({
      method: 'POST',
      path: '/v1/captures',
      body: JSON.parse(JSON.stringify({ ...payload, kind: 'note' })) as unknown,
    });
    expect(response.status).toBe(201);
    expect(pasted.writes).toHaveLength(1);
    expect(posted.writes).toHaveLength(1);
    expect(posted.writes[0]?.path).toBe(receipt.path);
    expect(posted.writes[0]?.contents).toBe(pasted.writes[0]?.contents);
  });
});
