import { SLACK_CHANNEL, SLACK_PERMALINK, SLACK_REPLY_TS, SLACK_TS } from './slack-capture.ts';

/*
 * Slack's Web API answers for one message and its thread (#105), as
 * `conversations.replies`, `chat.getPermalink` and `users.info` send them,
 * for tests in every layer. All names, ids and links are made up.
 */

export const MARA_ID = 'U0MARAQ111';
export const TOBIAS_ID = 'U0TOBIAS22';

/** `conversations.replies` for the message, which starts its thread, and one reply. */
export function slackRepliesAnswer(): Record<string, unknown> {
  return {
    ok: true,
    has_more: false,
    messages: [
      {
        type: 'message',
        ts: SLACK_TS,
        thread_ts: SLACK_TS,
        user: MARA_ID,
        text: `Can you send the *Larkspur* renewal by Friday? cc <@${TOBIAS_ID}>`,
        files: [
          {
            name: 'renewal.pdf',
            permalink: 'https://files.slack.com/files-pri/T0LARK/renewal.pdf',
          },
        ],
      },
      { type: 'message', ts: SLACK_REPLY_TS, thread_ts: SLACK_TS, user: TOBIAS_ID, text: 'On it.' },
    ],
  };
}

export const slackPermalinkAnswer = (permalink = SLACK_PERMALINK) => ({
  ok: true,
  channel: SLACK_CHANNEL,
  permalink,
});

/** `users.info` for one of the two people in the thread. */
export function slackUserAnswer(id: string): Record<string, unknown> {
  const people: Record<string, { name: string; email: string }> = {
    [MARA_ID]: { name: 'Mara Quill', email: 'mara.quill@example.com' },
    [TOBIAS_ID]: { name: 'Tobias Fenn', email: 'tobias.fenn@example.com' },
  };
  const person = people[id];
  if (person === undefined) return { ok: false, error: 'user_not_found' };
  return {
    ok: true,
    user: {
      id,
      name: person.name.toLowerCase(),
      profile: { display_name: person.name, email: person.email },
    },
  };
}
