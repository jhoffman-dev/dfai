import { createHmac } from 'node:crypto';

/*
 * Slack as the Slack workflow's tests see it (#104): requests signed as
 * Slack signs them, and the Web API's answers, for a fictional workspace.
 * Shared by the tests of the check, the payload and the workflow.
 */

/** Slack's own example (docs.slack.dev, "Verifying requests from Slack", as slackapi/python-slack-sdk tests it). */
export const SLACK_VECTOR = {
  signingSecret: '8f742231b10e8888abcd99yyyzzz85a5',
  timestamp: '1531420618',
  body: 'token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c',
  signature: 'v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503',
} as const;

export const SECRET = 'f1c7e0a9d3b54e2c8a6f0d1e2b3c4a5d';
export const OWNER = 'U0ROWANH01';
export const CHANNEL = 'C0LARK5PUR';
export const TS = '1793136000.000100';
export const REPLY_TS = '1793136300.000200';
/** The moment the fixtures are signed at, in seconds, and the clock that finds them fresh. */
export const SIGNED_AT = 1793136400;
export const NOW = SIGNED_AT * 1000;

export const SETTINGS = {
  ownerUserId: OWNER,
  emoji: { note: ['inbox_tray'], task: ['ballot_box_with_check'] },
} as const;

/** The headers n8n hands over for a body signed with `secret` at `timestamp`. */
export function signedHeaders(
  body: string | Uint8Array,
  secret = SECRET,
  timestamp = String(SIGNED_AT),
) {
  const hmac = createHmac('sha256', secret).update(`v0:${timestamp}:`);
  const signature = hmac.update(typeof body === 'string' ? body : Buffer.from(body)).digest('hex');
  const json = typeof body !== 'string' || body.startsWith('{');
  return {
    'content-type': json ? 'application/json' : 'application/x-www-form-urlencoded',
    'x-slack-request-timestamp': timestamp,
    'x-slack-signature': `v0=${signature}`,
  };
}

export const utf8 = (text: string) => new TextEncoder().encode(text);

/** A message shortcut's body, form-encoded as Slack sends it. */
export function shortcutBody(fields: Record<string, unknown> = {}): string {
  const payload = {
    type: 'message_action',
    callback_id: 'dfai_save_task',
    team: { id: 'T0LARK', domain: 'larkspur' },
    user: { id: OWNER, name: 'rowan' },
    channel: { id: CHANNEL, name: 'larkspur-payroll' },
    message_ts: TS,
    message: { type: 'message', ts: TS, user: 'U0MARAQ111', text: 'Can you send it?' },
    response_url: 'https://hooks.slack.com/app/T0LARK/1/abc',
    trigger_id: '1.2.3',
    ...fields,
  };
  return `payload=${encodeURIComponent(JSON.stringify(payload)).replace(/%20/g, '+')}`;
}

/** An Events API `reaction_added` body. */
export function reactionBody(event: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'event_callback',
    team_id: 'T0LARK',
    event_id: 'Ev0LARK1',
    event: {
      type: 'reaction_added',
      user: OWNER,
      reaction: 'inbox_tray',
      item_user: 'U0MARAQ111',
      item: { type: 'message', channel: CHANNEL, ts: TS },
      event_ts: '1793136390.000300',
      ...event,
    },
  });
}

export const PERMALINK = `https://larkspur.slack.com/archives/${CHANNEL}/p1793136000000100`;

export const permalinkAnswer = { ok: true, channel: CHANNEL, permalink: PERMALINK };

export function repliesAnswer(messages?: readonly Record<string, unknown>[]) {
  return {
    ok: true,
    has_more: false,
    messages: messages ?? [
      {
        type: 'message',
        ts: TS,
        thread_ts: TS,
        user: 'U0MARAQ111',
        text: 'Can you send the *Larkspur* renewal by Friday? cc <@U0TOBIAS22>',
        files: [
          {
            name: 'renewal.pdf',
            url_private: 'https://files.slack.com/files-pri/T0LARK-F1/renewal.pdf',
            permalink: 'https://larkspur.slack.com/files/U0MARAQ111/F1/renewal.pdf',
          },
        ],
      },
      { type: 'message', ts: REPLY_TS, thread_ts: TS, user: 'U0TOBIAS22', text: 'On it.' },
      {
        type: 'message',
        ts: '1793136360.000300',
        thread_ts: TS,
        bot_id: 'B0LARKBOT1',
        bot_profile: { name: 'Renewal bot' },
        text: 'Reminder set.',
      },
    ],
  };
}

export function userAnswer(id: string, name: string, email: string | null) {
  return {
    ok: true,
    user: {
      id,
      name: name.toLowerCase().replace(/ /g, '.'),
      real_name: name,
      profile: { display_name: '', real_name: name, ...(email === null ? {} : { email }) },
    },
  };
}

export const usersAnswers = [
  userAnswer(OWNER, 'Rowan Hale', 'rowan.hale@example.com'),
  userAnswer('U0MARAQ111', 'Mara Quill', 'mara.quill@example.com'),
  userAnswer('U0TOBIAS22', 'Tobias Fenn', null),
];
