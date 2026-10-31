import { describe, expect, it } from 'vitest';
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
} from '../../testing/index.ts';
import {
  MAX_MESSAGE_LENGTH,
  MAX_REPLIES,
  MAX_TOTAL_LENGTH,
  readCapture,
} from '../mapping/capture-payload.ts';
import {
  MAX_LOOKUPS,
  SlackApiError,
  SlackMessageMissingError,
  slackCapturePayload,
  usersToLookUp,
} from './slack-answers.ts';
import { fittedThread } from './slack-fit.ts';

/*
 * Slack's answers as a capture/v1 payload, shared by n8n (#104) and a pasted
 * link (#105): what both senders hand the contract for one message.
 */

const message = { channel: SLACK_CHANNEL, ts: SLACK_TS, kind: 'task' as const };
const answers = (replies: unknown = slackRepliesAnswer()) => ({
  message,
  permalink: slackPermalinkAnswer(),
  replies,
  users: [slackUserAnswer(MARA_ID), slackUserAnswer(TOBIAS_ID)],
});

describe('the people to look up', () => {
  it('are the author, then every other author and everyone mentioned, once each', () => {
    expect(usersToLookUp({ ts: SLACK_TS, replies: slackRepliesAnswer() })).toEqual([
      MARA_ID,
      TOBIAS_ID,
    ]);
  });

  it('start with whoever asked, when a sender names one, and stop at the cap', () => {
    expect(
      usersToLookUp({ ts: SLACK_TS, replies: slackRepliesAnswer(), first: 'U0ASKER999' }),
    ).toEqual(['U0ASKER999', MARA_ID, TOBIAS_ID]);
    const many = Array.from({ length: 150 }, (_, at) => ({
      ts: `${1793136000 + at}.000100`,
      user: `U0PEOPLE${String(at).padStart(3, '0')}`,
      text: '',
    }));
    const ids = usersToLookUp({ ts: '1793136149.000100', replies: { ok: true, messages: many } });
    expect(ids).toHaveLength(MAX_LOOKUPS);
    // The saved message's author is never the one the cap leaves out.
    expect(ids[0]).toBe('U0PEOPLE149');
  });
});

describe('the capture/v1 payload', () => {
  it('is one the contract reads: the message, its thread, its people and files', () => {
    const capture = readCapture(slackCapturePayload(answers()));
    expect(capture.externalId).toBe(`${SLACK_CHANNEL}/${SLACK_TS}`);
    expect(capture.kind).toBe('task');
    expect(capture.message.url).toBe(SLACK_PERMALINK);
    expect(capture.message.author).toEqual({
      id: MARA_ID,
      name: 'Mara Quill',
      email: 'mara.quill@example.com',
    });
    expect(capture.thread.map((reply) => [reply.ts, reply.author.name])).toEqual([
      [SLACK_REPLY_TS, 'Tobias Fenn'],
    ]);
    expect(capture.users[TOBIAS_ID]).toBe('Tobias Fenn');
    expect(capture.attachments).toEqual([
      { name: 'renewal.pdf', url: 'https://files.slack.com/files-pri/T0LARK/renewal.pdf' },
    ]);
  });

  it('for a reply saved by itself, holds the parent and the other replies as its thread', () => {
    const payload = slackCapturePayload({
      ...answers(),
      message: { ...message, ts: SLACK_REPLY_TS },
      permalink: slackPermalinkAnswer(
        `https://larkspur.slack.com/archives/${SLACK_CHANNEL}/p1793136300000200?thread_ts=${SLACK_TS}`,
      ),
    });
    const capture = readCapture(payload);
    expect(capture.message.text).toBe('On it.');
    expect(capture.thread.map((reply) => reply.ts)).toEqual([SLACK_TS]);
  });

  it('names a bot by its name, with its bot id', () => {
    const replies = {
      ok: true,
      messages: [
        { ts: SLACK_TS, bot_id: 'B0RENEWAL1', bot_profile: { name: 'Renewal bot' }, text: 'Due.' },
      ],
    };
    const capture = readCapture(slackCapturePayload({ ...answers(replies), users: [] }));
    expect(capture.message.author).toEqual({ id: 'B0RENEWAL1', name: 'Renewal bot', email: null });
  });

  it('names someone Slack would not look up by their id', () => {
    const payload = slackCapturePayload({ ...answers(), users: [slackUserAnswer('U0NOBODY00')] });
    expect(readCapture(payload).message.author.name).toBe(MARA_ID);
  });

  it('is refused when Slack did not answer ok, and says what Slack said', () => {
    expect(() => slackCapturePayload(answers({ ok: false, error: 'not_in_channel' }))).toThrow(
      new SlackApiError("Slack's conversations.replies said not_in_channel"),
    );
    expect(() =>
      slackCapturePayload({ ...answers(), permalink: { ok: false, error: 'invalid_auth' } }),
    ).toThrow(SlackApiError);
  });

  it('is refused as missing when the message is not among what Slack sent', () => {
    const replies = { ok: true, messages: [{ ts: SLACK_REPLY_TS, user: TOBIAS_ID, text: 'x' }] };
    expect(() => slackCapturePayload(answers(replies))).toThrow(SlackMessageMissingError);
  });
});

describe('a thread too long for a capture', () => {
  const SAVED_SECONDS = 1793136000;
  const reply = (offsetSeconds: number, length: number) => ({
    ts: `${SAVED_SECONDS + offsetSeconds}.000100`,
    text: 'x'.repeat(length),
  });
  const saved = { ts: `${SAVED_SECONDS}.000100`, text: 'Can you send the renewal?' };
  const SIZE = 39_000;
  const fits = Math.floor((MAX_TOTAL_LENGTH - saved.text.length) / SIZE);

  it('keeps the replies nearest the saved message, leaving out the farthest, in ts order', () => {
    const offsets = Array.from({ length: fits + 6 }, (_, at) => (at - 10) * 60);
    const kept = fittedThread(
      offsets.map((offset) => reply(offset, SIZE)),
      saved,
    );
    expect(kept).toHaveLength(fits);
    const keptOffsets = kept.map((each) => Number(each.ts.split('.')[0]) - SAVED_SECONDS);
    const farthestKept = Math.max(...keptOffsets.map(Math.abs));
    const left = offsets.filter((offset) => !keptOffsets.includes(offset));
    expect(left.every((offset) => Math.abs(offset) >= farthestKept)).toBe(true);
    expect(keptOffsets).toEqual([...keptOffsets].sort((a, b) => a - b));
  });

  // Moved with the fitting from tools/n8n/slack-fit.test.ts (PR #623).
  it('leaves out the older of two replies equally far, on a tie', () => {
    const before = reply(-60, SIZE);
    const after = reply(60, SIZE);
    const filler = Array.from({ length: fits - 1 }, (_, at) => reply(1 + at, SIZE));
    const kept = fittedThread([before, ...filler, after], saved);
    expect(kept).toContain(after);
    expect(kept).not.toContain(before);
  });

  it('keeps every reply of a thread within the limits, as it came', () => {
    const replies = [reply(60, 10), reply(120, 10)];
    expect(fittedThread(replies, saved)).toEqual(replies);
  });

  it('holds at most the contract’s number of replies, and none over Slack’s length', () => {
    const many = Array.from({ length: MAX_REPLIES + 5 }, (_, at) => reply(at + 1, 1));
    expect(fittedThread(many, saved)).toHaveLength(MAX_REPLIES);
    const long = reply(1, MAX_MESSAGE_LENGTH + 1);
    expect(fittedThread([long, reply(2, 5)], saved)).toEqual([reply(2, 5)]);
  });
});
