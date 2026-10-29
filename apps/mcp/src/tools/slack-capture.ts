/**
 * Saving a Slack message the model has read (#106, ADR-0049): the same
 * `POST /v1/captures` n8n and a pasted link send, so one message is one note
 * however it arrives, and the contract alone decides what is accepted.
 */

import type { ApiReceiveCaptureBody } from '@dfai/application';
import { z } from 'zod';
import { defineTool } from './define.ts';

/** Said, after the field's name, when the permalink is left out: before any request, so nothing is sent. */
export const MISSING_PERMALINK =
  'required: the permalink of the Slack message you read (its "Copy link"). ' +
  'Do not make one up; if you cannot get it, tell the person instead of saving.';

const author = z.object({
  id: z.string().exactOptional().describe('Slack user id, e.g. "U0MARAQ111".'),
  name: z.string().describe('The display name, as Slack shows it.'),
  email: z
    .string()
    .exactOptional()
    .describe("The author's address, when Slack gives it: it links them to their Person note."),
});

const slackPermalink = z
  .string({ error: MISSING_PERMALINK })
  .min(1, { error: MISSING_PERMALINK })
  .describe('The permalink of this message, e.g. "https://…slack.com/archives/C…/p…".');

const captureInput = z.object({
  kind: z
    .enum(['note', 'task'])
    .describe(
      'From what the person asked: "task" when they want to act on it (make a task, remind me, ' +
        'follow up), "note" when they want to keep it (save, note, keep this thread).',
    ),
  title: z
    .string()
    .exactOptional()
    .describe("The note's name. Leave it out to use the message's first line."),
  source: z.object({
    channel: z.object({
      id: z.string().describe('The channel id, e.g. "C0LARK5PUR".'),
      name: z.string().exactOptional().describe('The channel name without "#".'),
    }),
    ts: z.string().describe('The message\'s ts, e.g. "1793136000.000100".'),
    url: slackPermalink,
    author,
  }),
  text: z.string().describe('The message exactly as Slack returned it, in mrkdwn.'),
  thread: z
    .array(
      z.object({
        ts: z.string(),
        author,
        text: z.string(),
        url: z.string().exactOptional().describe("The reply's own permalink."),
      }),
    )
    .exactOptional()
    .describe('Replies you read, when the person asked for the thread.'),
  attachments: z
    .array(z.object({ name: z.string(), url: z.string().describe('An https:// link.') }))
    .exactOptional(),
  users: z
    .record(z.string(), z.string())
    .exactOptional()
    .describe('Names for the <@U…> mentions in the text, by user id.'),
  timeZone: z.string().exactOptional().describe('IANA zone to show times on. Omit for the Mac’s.'),
});

/** The tool's input as the capture/v1 payload the route reads. */
export function capturePayload(input: z.infer<typeof captureInput>): ApiReceiveCaptureBody {
  const { source, ...rest } = input;
  return { contract: 'capture/v1', ...rest, source: { provider: 'slack', ...source } };
}

export const captureSlackMessage = defineTool({
  name: 'atlas_capture',
  title: 'Save a Slack message',
  description:
    'Save one Slack message — and its thread, if asked — into the Inbox as a task or a note, ' +
    'once: the same message saved again writes nothing and answers "in-vault" with the note ' +
    "that already holds it. Always pass the message's permalink as source.url and its " +
    "channel id and ts: they are how DFAI knows the message. Choose kind from the person's " +
    'words. Pass only what you read from Slack — the text, author and replies as Slack gave ' +
    'them; never invent, summarise or fill in content you did not read. Returns ' +
    '{ capture: { path, outcome: "written" | "in-vault" } }; a refused capture lists every reason.',
  inputSchema: captureInput,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  call: (client, input) => client.receiveCapture(capturePayload(input)),
});

export const slackCaptureTools = [captureSlackMessage];
