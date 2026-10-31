import { SHORTCUT_CALLBACKS } from './slack-request.ts';
import { WEBHOOK_PATH } from './slack-capture.workflow.ts';

/*
 * The Slack app James creates from a manifest (README, "Slack messages into
 * DFAI"): the two message shortcuts, the reaction event, and the fewest
 * scopes the workflow's calls need. Built here so the callback ids and the
 * webhook path cannot drift from the workflow's.
 */

/** Where Slack sends events and shortcuts; James puts his n8n's public host in. */
export const REQUEST_URL = `https://YOUR-N8N-HOST/webhook/${WEBHOOK_PATH}`;

/**
 * James's own (user token) scopes, each for one call: reading a message and
 * its thread wherever he can see it (`conversations.replies`, one history
 * scope per kind of conversation), his reactions (the `reaction_added`
 * event), and people's names and addresses (`users.info`).
 * `chat.getPermalink` needs none.
 */
export const USER_SCOPES = [
  'channels:history',
  'groups:history',
  'im:history',
  'mpim:history',
  'reactions:read',
  'users:read',
  'users:read.email',
] as const;

/** The bot's: the shortcuts (`commands`) and its DM to James (`chat:write`). */
export const BOT_SCOPES = ['commands', 'chat:write'] as const;

const shortcut = (kind: 'note' | 'task') => ({
  name: `Save to DFAI as a ${kind}`,
  type: 'message',
  callback_id: SHORTCUT_CALLBACKS[kind],
  description: `Saves this message, and its thread, to the DFAI Inbox as a ${kind}`,
});

export function slackAppManifest() {
  return {
    display_information: {
      name: 'Save to DFAI',
      description: 'Saves a Slack message, and its thread, into the DFAI Inbox.',
    },
    features: {
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: true,
      },
      bot_user: { display_name: 'DFAI', always_online: false },
      shortcuts: [shortcut('note'), shortcut('task')],
    },
    oauth_config: { scopes: { user: [...USER_SCOPES], bot: [...BOT_SCOPES] } },
    settings: {
      event_subscriptions: { request_url: REQUEST_URL, user_events: ['reaction_added'] },
      interactivity: { is_enabled: true, request_url: REQUEST_URL },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}
