import { describe, expect, it } from 'vitest';
import {
  readCapture,
  readSlackPermalink,
  slackAnswerFailure,
  type SlackPermalink,
} from '@dfai/domain';
import {
  SLACK_CHANNEL,
  SLACK_PERMALINK,
  SLACK_TS,
  slackPermalinkAnswer,
} from '@dfai/domain/testing';
import { connectSlack } from './connect-slack.ts';
import { SlackError, type SlackMethod, type SlackPort } from './ports.ts';
import { LOOKUPS_AT_ONCE, readSlackMessage } from './read-slack-message.ts';

/*
 * Review of PR #631: the people in a busy thread are looked up a few at a
 * time, a 429 partway names the rest by id rather than losing the message,
 * whoever reads is looked up first as n8n looks up whoever asked, and a token
 * that is not a user token never reaches the host.
 */

const LINK = readSlackPermalink(SLACK_PERMALINK) as SlackPermalink;
const READER = 'U0READER01';
const people = Array.from({ length: 30 }, (_, at) => `U0PEOPLE${String(at).padStart(3, '0')}`);

/** A thread of 30 people, the first the saved message's author. */
const replies = {
  ok: true,
  messages: people.map((user, at) => ({
    ts: at === 0 ? SLACK_TS : `${1793136001 + at}.000100`,
    user,
    text: `Message ${at}`,
  })),
};

/** A Slack whose answers each wait a turn, counting how many calls are out at once. */
function busySlack({ limitedAfter = Infinity }: { limitedAfter?: number } = {}) {
  let out = 0;
  let mostOut = 0;
  let lookups = 0;
  const calls: { method: SlackMethod; query: Readonly<Record<string, string>> }[] = [];
  const answer = (method: SlackMethod, query: Readonly<Record<string, string>>): unknown => {
    if (method === 'auth.test') return { ok: true, user_id: READER, user: 'reader' };
    if (method === 'conversations.replies') return replies;
    if (method === 'chat.getPermalink') return slackPermalinkAnswer();
    lookups += 1;
    if (lookups > limitedAfter) return { ok: false, error: 'ratelimited' };
    const id = query['user'] ?? '';
    return { ok: true, user: { id, profile: { display_name: `Person ${id}` } } };
  };
  const port: SlackPort = {
    status: async () => ({ hasToken: true }),
    connect: async () => ({ hasToken: true }),
    disconnect: async () => ({ hasToken: false }),
    async call({ method, query }) {
      calls.push({ method, query });
      out += 1;
      mostOut = Math.max(mostOut, out);
      for (let turn = 0; turn < 3; turn += 1) await Promise.resolve();
      out -= 1;
      const body = answer(method, query);
      const failure = slackAnswerFailure({ status: 200, body, retryAfter: null });
      if (failure !== null) throw new SlackError(failure);
      return body;
    },
  };
  return { port, calls, mostOut: () => mostOut };
}

const read = (slack: SlackPort) =>
  readSlackMessage({ slack, vault: '/vaults/larkspur', link: LINK, kind: 'task' });

describe('looking up the people in a thread', () => {
  it('asks a few at a time, never all at once', async () => {
    const slack = busySlack();
    await read(slack.port);
    const lookups = slack.calls.filter((call) => call.method === 'users.info');
    expect(lookups).toHaveLength(31);
    expect(LOOKUPS_AT_ONCE).toBeGreaterThanOrEqual(4);
    expect(LOOKUPS_AT_ONCE).toBeLessThanOrEqual(8);
    expect(slack.mostOut()).toBe(LOOKUPS_AT_ONCE);
  });

  it('looks up whoever reads first, as n8n looks up whoever asked', async () => {
    const slack = busySlack();
    await read(slack.port);
    expect(slack.calls[0]?.method).toBe('auth.test');
    const lookups = slack.calls.filter((call) => call.method === 'users.info');
    expect(lookups.slice(0, 2).map((call) => call.query['user'])).toEqual([READER, people[0]]);
  });

  it('when Slack asks it to slow down partway, saves the message and names the rest by id', async () => {
    const slack = busySlack({ limitedAfter: 5 });
    const preview = await read(slack.port);
    const capture = readCapture(preview.payload);
    expect(capture.message.author.name).toBe(`Person ${people[0]}`);
    const last = capture.thread.at(-1);
    expect(last?.author.name).toBe(people.at(-1));
    // Once slowed down, it asks no more.
    const lookups = slack.calls.filter((call) => call.method === 'users.info');
    expect(lookups.length).toBeLessThan(5 + LOOKUPS_AT_ONCE + 1);
  });
});

describe('connecting with a token that is not a user token', () => {
  it('is refused with its own words, and the host is never handed it', async () => {
    const slack = busySlack();
    let connected = false;
    const port: SlackPort = {
      ...slack.port,
      connect: async () => {
        connected = true;
        return { hasToken: true };
      },
    };
    await expect(
      connectSlack({ slack: port, vault: '/vaults/larkspur', token: 'xoxb-1111-bot' }),
    ).rejects.toMatchObject({ failure: { kind: 'not_a_user_token' } });
    expect(connected).toBe(false);
    expect(slack.calls).toEqual([]);
  });
});

it('the fixture names the channel the link names', () => {
  expect(LINK.channel).toBe(SLACK_CHANNEL);
});

describe('a reply past the first THREAD_LIMIT messages of its thread', () => {
  it('fails as past_thread_limit, naming the limit, after reading pages up to it', async () => {
    const reply = readSlackPermalink(
      `${SLACK_PERMALINK.replace(/p\d{16}/, 'p1793139999000100')}?thread_ts=${SLACK_TS}`,
    ) as SlackPermalink;
    const pages: (string | undefined)[] = [];
    const port: SlackPort = {
      status: async () => ({ hasToken: true }),
      connect: async () => ({ hasToken: true }),
      disconnect: async () => ({ hasToken: false }),
      async call({ method, query }) {
        if (method === 'auth.test') return { ok: true, user_id: READER };
        if (method !== 'conversations.replies') return { ok: true };
        pages.push(query['cursor']);
        const page = pages.length;
        const messages = Array.from({ length: Number(query['limit']) }, (_, at) => ({
          ts: `${1793100000 + page * 1000 + at}.000100`,
          user: READER,
          text: 'x',
        }));
        return {
          ok: true,
          has_more: true,
          messages,
          response_metadata: { next_cursor: `p${page + 1}` },
        };
      },
    };
    await expect(
      readSlackMessage({ slack: port, vault: '/vaults/larkspur', link: reply, kind: 'note' }),
    ).rejects.toMatchObject({ failure: { kind: 'past_thread_limit', message: '1000' } });
    expect(pages[0]).toBeUndefined();
    expect(pages.slice(1)).toEqual(pages.slice(1).map((_, at) => `p${at + 2}`));
  });
});

describe('a lookup that ends the read while others are still out', () => {
  it('stops the others asking for more', async () => {
    let lookups = 0;
    const port: SlackPort = {
      status: async () => ({ hasToken: true }),
      connect: async () => ({ hasToken: true }),
      disconnect: async () => ({ hasToken: false }),
      async call({ method, query }) {
        if (method === 'auth.test') return { ok: true, user_id: READER };
        if (method === 'conversations.replies') return replies;
        if (method === 'chat.getPermalink') return slackPermalinkAnswer();
        lookups += 1;
        const first = lookups === 1;
        // The others answer a while after the first has failed.
        for (let turn = 0; turn < (first ? 1 : 10); turn += 1) await Promise.resolve();
        if (first) throw new SlackError({ kind: 'unreachable', message: 'offline' });
        return { ok: true, user: { id: query['user'], profile: { display_name: 'x' } } };
      },
    };
    await expect(read(port)).rejects.toMatchObject({ failure: { kind: 'unreachable' } });
    for (let turn = 0; turn < 200; turn += 1) await Promise.resolve();
    expect(lookups).toBe(LOOKUPS_AT_ONCE);
  });
});
