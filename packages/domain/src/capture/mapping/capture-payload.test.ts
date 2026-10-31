import { describe, expect, it } from 'vitest';
import {
  SLACK_CHANNEL,
  SLACK_PERMALINK,
  SLACK_REPLY_TS,
  SLACK_TS,
  slackCapture,
  slackSource,
} from '../../testing/slack-capture.ts';
import { MAX_MESSAGE_LENGTH, MAX_REPLIES, readCapture } from './capture-payload.ts';
import { CaptureRefusedError, shownValue } from './capture-refusal.ts';

/** The reasons a payload is refused for, or [] when it is read. */
function reasonsFor(payload: unknown): readonly string[] {
  try {
    readCapture(payload);
    return [];
  } catch (error) {
    if (error instanceof CaptureRefusedError) return error.reasons;
    throw error;
  }
}

const reply = (fields: Record<string, unknown> = {}) => ({
  ts: SLACK_REPLY_TS,
  author: { name: 'Tobias Fenn' },
  text: 'On it.',
  ...fields,
});

describe('readCapture: a capture/v1 payload (#103)', () => {
  it('reads a Slack task with its thread, attachments and mention names', () => {
    const capture = readCapture(slackCapture());
    expect(capture).toEqual({
      kind: 'task',
      title: null,
      provider: 'slack',
      channel: { id: SLACK_CHANNEL, name: 'larkspur-payroll' },
      message: {
        ts: SLACK_TS,
        author: { id: 'U0MARAQ111', name: 'Mara Quill', email: 'mara.quill@example.com' },
        text: 'Can you send the *Larkspur* renewal by Friday? cc <@U0TOBIAS22>',
        url: SLACK_PERMALINK,
      },
      thread: [
        expect.objectContaining({
          ts: SLACK_REPLY_TS,
          text: 'On it.',
          author: expect.objectContaining({ name: 'Tobias Fenn' }),
        }),
      ],
      attachments: [
        { name: 'renewal.pdf', url: 'https://files.slack.com/files-pri/T0LARK/renewal.pdf' },
      ],
      users: { U0TOBIAS22: 'Tobias Fenn' },
      externalId: `${SLACK_CHANNEL}/${SLACK_TS}`,
    });
  });

  it('keys the message by channel and ts, whatever domain or query its permalink carries', () => {
    const grid =
      'https://larkspur.enterprise.slack.com/archives/C0LARK5PUR/p1793136000000100?cid=C0LARK5PUR';
    const first = readCapture(slackCapture());
    const second = readCapture(slackCapture({ source: slackSource({ url: grid }), kind: 'note' }));
    expect(second.externalId).toBe(first.externalId);
    expect(second.message.url).toBe(grid);
  });

  it('takes a null optional field as left out, as n8n sends one', () => {
    const capture = readCapture(
      slackCapture({
        title: null,
        thread: null,
        users: null,
        source: slackSource({ author: { id: null, name: 'Mara Quill', email: null } }),
      }),
    );
    expect(capture.thread).toEqual([]);
    expect(capture.message.author).toEqual({ id: null, name: 'Mara Quill', email: null });
  });

  it('reads a title, one line, and a channel name without its #', () => {
    const capture = readCapture(
      slackCapture({
        title: '  Renewal\n  by Friday ',
        source: slackSource({ channel: { id: SLACK_CHANNEL, name: '#larkspur-payroll' } }),
      }),
    );
    expect(capture.title).toBe('Renewal by Friday');
    expect(capture.channel.name).toBe('larkspur-payroll');
  });

  it('leaves the parent out of the thread, as Slack lists it first, and puts the replies in order', () => {
    const later = reply({ ts: '1793136900.000300' });
    const capture = readCapture(
      slackCapture({ thread: [reply({ ts: SLACK_TS }), later, reply()] }),
    );
    expect(capture.thread.map((each) => each.ts)).toEqual([SLACK_REPLY_TS, '1793136900.000300']);
  });

  it('cleans control characters out of the text before anything reads it', () => {
    expect(readCapture(slackCapture({ text: 'a\u0000b\u202Ec\r\nd' })).message.text).toBe('abc\nd');
  });

  it('saves a message of attachments only', () => {
    expect(reasonsFor(slackCapture({ text: '' }))).toEqual([]);
  });

  it.each([
    ['text', 'text', 'capture: expected an object, got "text"'],
    ['a list', [], 'capture: expected an object, got a list'],
    ['null', null, 'capture: expected an object, got null'],
  ])('refuses a payload that is %s, for that alone', (_, payload, expected) => {
    expect(reasonsFor(payload)).toEqual([expected]);
  });

  it.each([
    ['another contract', { contract: 'capture/v2' }, 'contract: "capture/v2" is not "capture/v1"'],
    ['no contract', { contract: undefined }, 'contract: undefined is not "capture/v1"'],
    ['another kind', { kind: 'event' }, 'kind: "event" is not "note" or "task"'],
    ['a misspelt field', { attachment: [] }, 'capture: "attachment" is not one of its fields'],
    [
      'another provider',
      { source: slackSource({ provider: 'teams' }) },
      'source.provider: "teams" is not "slack", the one v1 reads',
    ],
    [
      'no permalink',
      { source: slackSource({ url: undefined }) },
      'source.url: missing: the message’s permalink',
    ],
    [
      'a link that is not Slack’s',
      { source: slackSource({ url: 'https://example.com/archives/C0LARK5PUR/p1793136000000100' }) },
      'is not a Slack permalink (https://….slack.com/archives/…)',
    ],
    [
      'a link to an http page',
      { source: slackSource({ url: SLACK_PERMALINK.replace('https', 'http') }) },
      'is not a Slack permalink',
    ],
    [
      'a permalink to another message',
      {
        source: slackSource({
          url: SLACK_PERMALINK.replace('p1793136000000100', 'p1793136000000999'),
        }),
      },
      'source.url: is not a link to this message: its channel or ts differ',
    ],
    [
      'a permalink in another channel',
      { source: slackSource({ url: SLACK_PERMALINK.replace('/C0LARK5PUR/', '/C0OTHER999/') }) },
      'source.url: is not a link to this message',
    ],
    [
      'a ts not as Slack writes it',
      { source: slackSource({ ts: '1793136000' }) },
      'source.ts: "1793136000" is not well formed',
    ],
    ['no ts', { source: slackSource({ ts: undefined }) }, 'source.ts: missing'],
    [
      'a channel id not Slack’s',
      { source: slackSource({ channel: { id: 'larkspur' } }) },
      'source.channel.id: "larkspur" is not well formed',
    ],
    [
      'no channel',
      { source: slackSource({ channel: undefined }) },
      'source.channel: expected an object, got undefined',
    ],
    [
      'an author with no name',
      { source: slackSource({ author: { name: '  ' } }) },
      'source.author.name: is blank',
    ],
    [
      'an author with a number for a name',
      { source: slackSource({ author: { name: 7 } }) },
      'source.author.name: expected text, got number',
    ],
    [
      'an author id not Slack’s',
      { source: slackSource({ author: { name: 'Mara', id: 'mara' } }) },
      'source.author.id: "mara" is not well formed',
    ],
    [
      'an author address that is not one',
      { source: slackSource({ author: { name: 'Mara', email: 'mara' } }) },
      'source.author.email: "mara" is not an address',
    ],
    ['text that is not text', { text: { blocks: [] } }, 'text: expected text, got object'],
    [
      'nothing to save',
      { text: '  ', attachments: [] },
      'text: is empty, and there is no attachment to save instead',
    ],
    [
      'a message longer than Slack allows',
      { text: 'x'.repeat(MAX_MESSAGE_LENGTH + 1) },
      `text: is longer than ${MAX_MESSAGE_LENGTH} characters, Slack's own limit`,
    ],
    ['a title too long', { title: 'x'.repeat(501) }, 'title: is longer than 500 characters'],
    ['a thread that is not a list', { thread: 'On it.' }, 'thread: expected a list, got "On it."'],
    [
      'too many replies',
      { thread: Array.from({ length: MAX_REPLIES + 1 }, () => reply()) },
      `thread: holds more than ${MAX_REPLIES}`,
    ],
    ['a reply twice', { thread: [reply(), reply()] }, `thread: holds ${SLACK_REPLY_TS} twice`],
    [
      'a reply with a field it has not',
      { thread: [reply({ files: [] })] },
      'thread[0]: "files" is not one of its fields',
    ],
    [
      'a reply linking another message',
      { thread: [reply({ url: SLACK_PERMALINK })] },
      'thread[0].url: is not a link to this message',
    ],
    [
      'an attachment that is not https',
      { attachments: [{ name: 'a', url: 'file:///etc/passwd' }] },
      'attachments[0].url: "file:///etc/passwd" is not an https:// link',
    ],
    [
      'an attachment with no name',
      { attachments: [{ url: 'https://files.slack.com/a' }] },
      'attachments[0].name: missing',
    ],
    [
      'names by something not a user id',
      { users: { mara: 'Mara' } },
      'users["mara"]: is not a Slack user id',
    ],
    [
      'names that are not an object',
      { users: ['Mara'] },
      'users: expected an object of names by user id, got a list',
    ],
  ])('refuses %s, saying why', (_, fields, reason) => {
    expect(reasonsFor(slackCapture(fields)).some((each) => each.includes(reason))).toBe(true);
  });

  it('refuses a payload holding more text than the API takes', () => {
    const big = Array.from({ length: 30 }, (_, at) =>
      reply({
        ts: `17931363${String(at).padStart(2, '0')}.000200`,
        text: 'x'.repeat(MAX_MESSAGE_LENGTH),
      }),
    );
    expect(reasonsFor(slackCapture({ thread: big }))).toContain(
      'thread: the messages hold more than 1000000 characters',
    );
  });

  it('names every problem at once, not the first', () => {
    const reasons = reasonsFor({
      contract: 'capture/v1',
      kind: 'memo',
      source: { provider: 'slack' },
    });
    expect(reasons).toEqual([
      'kind: "memo" is not "note" or "task"',
      'source.channel: expected an object, got undefined',
      'source.channel.id: missing',
      'source.ts: missing',
      'source.author: expected an object, got undefined',
      'source.author.name: missing',
      'source.url: missing: the message’s permalink',
      'text: is empty, and there is no attachment to save instead',
    ]);
  });

  it('says it was refused, and why, in its message', () => {
    expect(() => readCapture(slackCapture({ kind: 'memo' }))).toThrow(
      /^The capture was refused: kind: "memo" is not "note" or "task"$/,
    );
  });
});

describe('shownValue', () => {
  it('shows text cut short, and anything else by its kind only', () => {
    expect(shownValue('x'.repeat(41))).toBe(`"${'x'.repeat(40)}…"`);
    expect(shownValue(null)).toBe('null');
    expect(shownValue(3)).toBe('number');
    expect(shownValue({ secret: 'payroll' })).toBe('object');
  });
});
