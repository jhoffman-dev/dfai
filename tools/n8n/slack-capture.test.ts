import { describe, expect, it } from 'vitest';
import { readCapture } from '@dfai/domain';
import { heldCapturePath, ListingError } from './capture-github.ts';
import { MAX_LOOKUPS, SlackApiError, slackCapturePayload, usersToLookUp } from './slack-capture.ts';
import { committedReply, failedReply, heldReply, savedReply, slackLine } from './slack-reply.ts';
import type { SlackCaptureAction } from './slack-request.ts';
import {
  CHANNEL,
  OWNER,
  PERMALINK,
  permalinkAnswer,
  REPLY_TS,
  repliesAnswer,
  TS,
  userAnswer,
  usersAnswers,
} from './slack-fixtures.ts';

/*
 * Slack's Web API answers as a capture/v1 payload (#104), the fallback's
 * "is it in pkm-space already?", and the replies James is DMed.
 */

const action: SlackCaptureAction = {
  action: 'capture',
  via: 'reaction',
  kind: 'note',
  channel: CHANNEL,
  ts: TS,
  userId: OWNER,
};
const answers = {
  action,
  permalink: permalinkAnswer,
  replies: repliesAnswer(),
  users: usersAnswers,
};

describe('the people to look up', () => {
  it('are whoever asked, every author and everyone mentioned, once each', () => {
    expect(usersToLookUp(action, repliesAnswer())).toEqual([OWNER, 'U0MARAQ111', 'U0TOBIAS22']);
  });

  it('are at least whoever asked, so the lookup runs, and at most the cap', () => {
    expect(usersToLookUp(action, repliesAnswer([]))).toEqual([OWNER]);
    const many = Array.from({ length: 150 }, (_, at) => ({
      ts: TS,
      user: `U0PEOPLE${String(at).padStart(3, '0')}`,
      text: '',
    }));
    expect(usersToLookUp(action, repliesAnswer(many))).toHaveLength(MAX_LOOKUPS);
  });
});

describe('the capture/v1 payload', () => {
  it('is one the contract reads: the message, the whole thread, its people', () => {
    const payload = slackCapturePayload(answers);
    const capture = readCapture(payload);
    expect(capture.externalId).toBe(`${CHANNEL}/${TS}`);
    expect(capture.kind).toBe('note');
    expect(capture.message.url).toBe(PERMALINK);
    expect(capture.message.author).toEqual({
      id: 'U0MARAQ111',
      name: 'Mara Quill',
      email: 'mara.quill@example.com',
    });
    expect(capture.thread.map((reply) => [reply.ts, reply.author.name])).toEqual([
      [REPLY_TS, 'Tobias Fenn'],
      ['1793136360.000300', 'Renewal bot'],
    ]);
    expect(capture.users['U0TOBIAS22']).toBe('Tobias Fenn');
  });

  it('keeps a file as its permalink, never the file’s own address', () => {
    expect(slackCapturePayload(answers).attachments).toEqual([
      { name: 'renewal.pdf', url: 'https://larkspur.slack.com/files/U0MARAQ111/F1/renewal.pdf' },
    ]);
  });

  it('saves a reply with the rest of its thread, the parent among it', () => {
    const permalink = {
      ok: true,
      permalink: `${PERMALINK.slice(0, -16)}1793136300000200?thread_ts=${TS}`,
    };
    const payload = slackCapturePayload({
      ...answers,
      permalink,
      action: { ...action, ts: REPLY_TS },
    });
    const capture = readCapture(payload);
    expect(capture.message.text).toBe('On it.');
    expect(capture.thread.map((reply) => reply.ts)).toEqual([TS, '1793136360.000300']);
  });

  it('names a person by display name first, and one never looked up by id', () => {
    const display = {
      ok: true,
      user: { id: 'U0MARAQ111', profile: { display_name: 'mara', real_name: 'Mara Quill' } },
    };
    const payload = slackCapturePayload({ ...answers, users: [display] });
    expect(payload.source.author).toEqual({ id: 'U0MARAQ111', name: 'mara', email: null });
    expect(payload.thread[0]?.author.name).toBe('U0TOBIAS22');
  });

  it.each([
    [
      'the permalink',
      { permalink: { ok: false, error: 'message_not_found' } },
      /chat.getPermalink said message_not_found/,
    ],
    [
      'the thread',
      { replies: { ok: false, error: 'missing_scope' } },
      /conversations.replies said missing_scope/,
    ],
    ['the thread, with no answer', { replies: 'nope' }, /conversations.replies said no answer/],
  ])('is refused, naming Slack’s reason, when %s is not ok', (_, override, reason) => {
    expect(() => slackCapturePayload({ ...answers, ...override })).toThrow(SlackApiError);
    expect(() => slackCapturePayload({ ...answers, ...override })).toThrow(reason);
  });

  it('names by id a person whose lookup Slack refused, and still saves the message', () => {
    const users = [usersAnswers[0], { ok: false, error: 'user_not_found' }, usersAnswers[2]];
    const payload = slackCapturePayload({ ...answers, users });
    expect(payload.source.author).toEqual({ id: 'U0MARAQ111', name: 'U0MARAQ111', email: null });
    expect(payload.thread[0]?.author.name).toBe('Tobias Fenn');
    expect(() => readCapture(payload)).not.toThrow();
  });

  it('is refused when the message is not among what Slack sent (deleted, or not visible)', () => {
    expect(() =>
      slackCapturePayload({ ...answers, action: { ...action, ts: '1793139999.000000' } }),
    ).toThrow(/not in the thread Slack sent/);
  });

  it('is refused when a person answered has no id', () => {
    expect(() =>
      slackCapturePayload({ ...answers, users: [{ ok: true, user: { profile: {} } }] }),
    ).toThrow(/said nothing of whose/);
  });

  it('writes a person with no address as having none', () => {
    const payload = slackCapturePayload({
      ...answers,
      users: [userAnswer('U0MARAQ111', 'Mara Quill', null)],
    });
    expect(payload.source.author.email).toBeNull();
  });
});

describe('the fallback: is the message in pkm-space already?', () => {
  const file = { keyEnding: ' (slack 0123456789abcdef).md' };
  const listing = (names: readonly string[]) => ({
    statusCode: 200,
    body: names.map((name) => ({ name, type: 'file' })),
  });

  it('finds a file named for the key under any title, in any case, numbered or not', () => {
    expect(
      heldCapturePath(
        listing(['Other (slack ffff).md', 'Renewal (slack 0123456789abcdef).md']),
        file,
      ),
    ).toBe('Inbox/Captures/Renewal (slack 0123456789abcdef).md');
    expect(heldCapturePath(listing(['X (SLACK 0123456789ABCDEF 2).md']), file)).toBe(
      'Inbox/Captures/X (SLACK 0123456789ABCDEF 2).md',
    );
  });

  it('finds none in a folder of other messages, or no folder yet (404)', () => {
    expect(heldCapturePath(listing(['Renewal (slack 0123456789abcdee).md']), file)).toBeNull();
    expect(heldCapturePath({ statusCode: 404, body: { message: 'Not Found' } }, file)).toBeNull();
  });

  it('never takes another answer for “nothing there”: it would write twice', () => {
    expect(() => heldCapturePath({ statusCode: 401, body: {} }, file)).toThrow(ListingError);
    expect(() => heldCapturePath({ statusCode: 200, body: { name: 'x' } }, file)).toThrow(
      /answered 200/,
    );
  });
});

describe('the replies in Slack', () => {
  it('say where DFAI saved it, or that it had it already', () => {
    const answer = (outcome: string) => ({
      statusCode: outcome === 'written' ? 201 : 200,
      body: { capture: { path: 'Inbox/Captures/Renewal (slack 01).md', outcome } },
    });
    expect(savedReply(answer('written'))).toBe(
      'Saved to DFAI: Inbox/Captures/Renewal (slack 01).md',
    );
    expect(savedReply(answer('in-vault'))).toBe(
      'Already in DFAI: Inbox/Captures/Renewal (slack 01).md',
    );
  });

  it('say a commit was the fallback, and why', () => {
    expect(committedReply('Inbox/Captures/R.md', { statusCode: 503 })).toBe(
      'Saved to pkm-space for DFAI (DFAI answered 503): Inbox/Captures/R.md',
    );
    expect(committedReply('Inbox/Captures/R.md', { error: 'ECONNREFUSED' })).toMatch(
      /DFAI did not answer/,
    );
    expect(heldReply('Inbox/Captures/R.md')).toBe(
      'Already in pkm-space, not saved again: Inbox/Captures/R.md',
    );
  });

  it('say why it was not saved, in one line that mentions and links nobody', () => {
    const reply = failedReply({
      error: 'Slack said <!channel>\n<https://evil.example|click> & more',
    });
    expect(reply).toBe(
      'Not saved to DFAI: Slack said &lt;!channel&gt; &lt;https://evil.example|click&gt; &amp; more. The details are in your email.',
    );
    expect(failedReply({ error: { message: 'timeout' } })).toMatch(/: timeout\./);
    expect(failedReply({ status: 500 })).toMatch(/\{"status":500\}/);
  });

  it('cut a long reason, and take out every control character', () => {
    expect(slackLine(`a\u2028b\u0000c${'x'.repeat(400)}`)).toMatch(/^a b cx{295}…$/);
  });
});
