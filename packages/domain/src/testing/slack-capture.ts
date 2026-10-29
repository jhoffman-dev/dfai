/*
 * A capture/v1 payload as n8n would assemble it from a Slack message and its
 * thread (#103, #104), for tests in every layer. All names, ids and links are
 * made up: Larkspur Payroll, Mara Quill and Tobias Fenn are fictional.
 */

/** 2026-10-27T21:20:00Z, as a Slack ts. */
export const SLACK_TS = '1793136000.000100';
export const SLACK_CHANNEL = 'C0LARK5PUR';
export const SLACK_PERMALINK = `https://larkspur.slack.com/archives/${SLACK_CHANNEL}/p1793136000000100`;
/** Five minutes later, in the thread. */
export const SLACK_REPLY_TS = '1793136300.000200';

/** A payload, with any top-level field replaced. */
export function slackCapture(
  fields: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    contract: 'capture/v1',
    kind: 'task',
    source: {
      provider: 'slack',
      channel: { id: SLACK_CHANNEL, name: 'larkspur-payroll' },
      ts: SLACK_TS,
      url: SLACK_PERMALINK,
      author: { id: 'U0MARAQ111', name: 'Mara Quill', email: 'mara.quill@example.com' },
    },
    text: 'Can you send the *Larkspur* renewal by Friday? cc <@U0TOBIAS22>',
    thread: [
      {
        ts: SLACK_REPLY_TS,
        author: { id: 'U0TOBIAS22', name: 'Tobias Fenn', email: 'tobias.fenn@example.com' },
        text: 'On it.',
        url: `https://larkspur.slack.com/archives/${SLACK_CHANNEL}/p1793136300000200?thread_ts=${SLACK_TS}`,
      },
    ],
    attachments: [
      { name: 'renewal.pdf', url: 'https://files.slack.com/files-pri/T0LARK/renewal.pdf' },
    ],
    users: { U0TOBIAS22: 'Tobias Fenn' },
    ...fields,
  };
}

/** The payload's `source`, with any field replaced. */
export function slackSource(
  fields: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return { ...(slackCapture().source as Record<string, unknown>), ...fields };
}

/**
 * A capture's tree written as its JSON: what a domain test maps with, since
 * the markdown serializer is the adapters' (`writeCaptureMarkdown`). Enough
 * to tell which tree a mapping wrote; never what the note's bytes are.
 */
export const treeAsJson = (root: unknown): string => JSON.stringify(root);
