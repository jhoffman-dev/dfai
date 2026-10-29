import { describe, expect, it } from 'vitest';
import { readCapture, readSlackPermalink, type SlackPermalink } from '@dfai/domain';
import {
  MARA_ID,
  SLACK_CHANNEL,
  SLACK_PERMALINK,
  SLACK_REPLY_TS,
  SLACK_TS,
  slackPermalinkAnswer,
  slackRepliesAnswer,
  slackUserAnswer,
  TOBIAS_ID,
} from '@dfai/domain/testing';
import { receiveCapture } from '../capture/index.ts';
import { apiFixture } from '../testing/api-fixture.ts';
import { fakeSlack, type SlackCall } from '../testing/fake-slack.ts';
import { fakeMarkdown } from '../testing/fake-ports.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import { connectSlack } from './connect-slack.ts';
import { SlackError } from './ports.ts';
import { readSlackMessage } from './read-slack-message.ts';
import { saveSlackMessage } from './save-slack-message.ts';

/*
 * #105 over fake ports: a pasted Slack link read through the host, shown,
 * and saved through the use-case POST /v1/captures runs — one dedupe.
 */

const VAULT = '/vaults/larkspur';
const LINK = readSlackPermalink(SLACK_PERMALINK) as SlackPermalink;

/** Slack as the fixtures answer it; `overrides` answers a method otherwise. */
function slackAnswering(overrides: Partial<Record<SlackCall['method'], unknown>> = {}) {
  return fakeSlack((call) => {
    if (call.method in overrides) return overrides[call.method];
    switch (call.method) {
      case 'conversations.replies':
        return slackRepliesAnswer();
      case 'chat.getPermalink':
        return slackPermalinkAnswer(permalinkOf(call.query['message_ts'] ?? ''));
      case 'users.info':
        return slackUserAnswer(call.query['user'] ?? '');
      default:
        return { ok: true, team: 'Larkspur Payroll', user: 'mara' };
    }
  });
}

/** The link Slack writes for a message: a reply's names its thread. */
const permalinkOf = (ts: string) =>
  ts === SLACK_TS
    ? SLACK_PERMALINK
    : `https://larkspur.slack.com/archives/${SLACK_CHANNEL}/p${ts.replace('.', '')}?thread_ts=${SLACK_TS}`;

const read = (slack = slackAnswering(), link = LINK) =>
  readSlackMessage({ slack, vault: VAULT, link, kind: 'task' });

describe('reading a pasted Slack link', () => {
  it('asks for the thread, the permalink and each person, and shows the message', async () => {
    const slack = slackAnswering();
    const preview = await read(slack);
    expect(slack.calls).toEqual([
      {
        method: 'conversations.replies',
        query: { channel: SLACK_CHANNEL, ts: SLACK_TS, limit: '1000' },
      },
      { method: 'chat.getPermalink', query: { channel: SLACK_CHANNEL, message_ts: SLACK_TS } },
      { method: 'users.info', query: { user: MARA_ID } },
      { method: 'users.info', query: { user: TOBIAS_ID } },
    ]);
    expect(preview).toMatchObject({
      author: 'Mara Quill',
      text: 'Can you send the Larkspur renewal by Friday? cc @Tobias Fenn',
      replies: 1,
      attachments: 1,
    });
    expect(readCapture(preview.payload).externalId).toBe(`${SLACK_CHANNEL}/${SLACK_TS}`);
  });

  it('asks for a reply’s thread by its parent', async () => {
    const slack = slackAnswering();
    const reply = readSlackPermalink(
      `https://larkspur.slack.com/archives/${SLACK_CHANNEL}/p1793136300000200?thread_ts=${SLACK_TS}`,
    ) as SlackPermalink;
    const preview = await read(slack, reply);
    expect(slack.calls[0]?.query['ts']).toBe(SLACK_TS);
    expect(preview.author).toBe('Tobias Fenn');
    expect(readCapture(preview.payload).message.ts).toBe(SLACK_REPLY_TS);
  });

  it('without a token, fails as no_token and asks nothing', async () => {
    const slack = fakeSlack(() => ({ ok: true }), { hasToken: false });
    await expect(read(slack)).rejects.toMatchObject({ failure: { kind: 'no_token' } });
    expect(slack.calls).toEqual([]);
  });

  it('for a message the reader cannot see, fails as not_found', async () => {
    const hidden = slackAnswering({
      'conversations.replies': { ok: false, error: 'channel_not_found' },
    });
    await expect(read(hidden)).rejects.toMatchObject({ failure: { kind: 'not_found' } });
    const deleted = slackAnswering({
      'conversations.replies': { ok: true, messages: [{ ts: SLACK_REPLY_TS, text: 'x' }] },
    });
    await expect(read(deleted)).rejects.toMatchObject({ failure: { kind: 'not_found' } });
  });

  it('for a refused token, fails as refused', async () => {
    const slack = slackAnswering({ 'conversations.replies': { ok: false, error: 'invalid_auth' } });
    const failure = await read(slack).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SlackError);
    expect((failure as SlackError).failure.kind).toBe('refused');
  });

  it('writes someone whose profile Slack will not give by their id, but stops when rate limited', async () => {
    const hiddenProfile = slackAnswering({ 'users.info': { ok: false, error: 'user_not_found' } });
    expect((await read(hiddenProfile)).author).toBe(MARA_ID);
    const limited = slackAnswering({ 'users.info': { ok: false, error: 'ratelimited' } });
    await expect(read(limited)).rejects.toMatchObject({ failure: { kind: 'rate_limited' } });
  });
});

/** `fakeMarkdown`'s `key: value` lines, a single-quoted value read as YAML reads it. */
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

describe('saving a pasted Slack link', () => {
  function vault() {
    const api = apiFixture({ files: {} });
    const index = { query: async () => ({ columns: [], rows: [], truncated: false }) };
    return { api, ports: { fs: api.fs, markdown: quotedMarkdown(), index } };
  }

  it('writes the note POST /v1/captures would, once, as the kind chosen', async () => {
    const { api, ports } = vault();
    const { payload } = await read();
    const first = await saveSlackMessage({ ports, payload, kind: 'note', timeZone: 'UTC' });
    expect(first.outcome).toBe('written');
    expect(api.files.get(first.path)?.text).not.toContain('status: inbox');

    const again = await saveSlackMessage({ ports, payload, kind: 'note', timeZone: 'UTC' });
    expect(again).toEqual({ path: first.path, outcome: 'in-vault' });
    // The route's own call finds it too: one code path, one dedupe.
    const posted = await receiveCapture({
      ports,
      capture: readCapture({ ...payload, kind: 'task' }),
      timeZone: 'UTC',
    });
    expect(posted).toEqual({ path: first.path, outcome: 'in-vault' });
    expect(api.writes).toHaveLength(1);
  });

  it('as a task, writes an Inbox task', async () => {
    const { api, ports } = vault();
    const { payload } = await read();
    const saved = await saveSlackMessage({ ports, payload, kind: 'task', timeZone: 'UTC' });
    expect(saved.path.startsWith('Inbox/Captures/')).toBe(true);
    expect(api.files.get(saved.path)?.text).toContain('status: inbox');
  });
});

describe('connecting Slack', () => {
  it('keeps the token, then asks Slack whose it is', async () => {
    const slack = slackAnswering();
    slack.hasToken = false;
    expect(await connectSlack({ slack, vault: VAULT, token: 'xoxp-1-fictional' })).toEqual({
      workspace: 'Larkspur Payroll',
      user: 'mara',
    });
    expect(slack.hasToken).toBe(true);
    expect(slack.calls.map((call) => call.method)).toEqual(['auth.test']);
  });

  it('says no names when Slack’s answer names nobody', async () => {
    const slack = slackAnswering({ 'auth.test': { ok: true, team: '  ', user: 7 } });
    expect(await connectSlack({ slack, vault: VAULT, token: 'xoxp-1-fictional' })).toEqual({
      workspace: null,
      user: null,
    });
  });

  it('says when Slack refuses the token, which stays kept', async () => {
    const slack = slackAnswering({ 'auth.test': { ok: false, error: 'invalid_auth' } });
    await expect(connectSlack({ slack, vault: VAULT, token: 'xoxp-1-old' })).rejects.toMatchObject({
      failure: { kind: 'refused' },
    });
    expect(slack.hasToken).toBe(true);
  });
});
