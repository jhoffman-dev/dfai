import { mapCaptureScript, moduleScript } from './code-node.ts';
import { DEFAULT_EMOJI, OWNER_PLACEHOLDER, type SlackCaptureSettings } from './slack-request.ts';
import { SIGNING_SECRET_PLACEHOLDER } from './slack-signature.ts';

/*
 * The Slack capture workflow's Code-node scripts (#104): the signature
 * check, the lookups, the capture/v1 payload, the app's own mapper for the
 * fallback commit, and the replies. Each is compiled from tools/n8n's
 * TypeScript by `pnpm n8n:build`, so a test holds them to it.
 */

/** The nodes the scripts read by name; the workflow names its nodes with these. */
export const SCRIPT_NODES = {
  verify: 'Verify Slack signature',
  permalink: 'Fetch the permalink',
  thread: 'Fetch the thread',
  build: 'Build the capture',
  send: 'Send to DFAI',
  map: 'Map capture to DFAI file',
} as const;

const N = SCRIPT_NODES;

const header = (what: string, from: string) =>
  [
    `// DFAI Slack capture: ${what}.`,
    `// Generated from ${from} in the DFAI repo by \`pnpm n8n:build\`:`,
    '// change those files and rebuild rather than editing here.',
  ].join('\n');

/** Modules here as one plain-JavaScript script, followed by `run`, the node's own lines. */
function slackScript(what: string, modules: readonly string[], run: readonly string[]): string {
  const from = `tools/n8n/${modules.map((each) => each.slice(2)).join(', ')}`;
  return `${header(what, from)}\n\n${modules.map(moduleScript).join('\n')}\n// --- n8n ---\n${run.join('\n')}\n`;
}

const VERIFY_MODULES = [
  './sha256.ts',
  './standard-webhook.ts',
  './slack-signature.ts',
  './slack-request.ts',
] as const;

/** What the committed verify node holds: placeholders James replaces in n8n, and the default emoji. */
export interface VerifyNodeSettings {
  readonly signingSecret: string;
  readonly settings: SlackCaptureSettings;
}

export const PLACEHOLDER_SETTINGS: VerifyNodeSettings = {
  signingSecret: SIGNING_SECRET_PLACEHOLDER,
  settings: { ownerUserId: OWNER_PLACEHOLDER, emoji: DEFAULT_EMOJI },
};

/**
 * The "Verify Slack signature" node, run once for all items (one request is
 * one item). The Webhook node's Raw Body option puts the bytes as sent in its
 * `data` binary, which is what Slack signed.
 */
export function verifySlackScript(node: VerifyNodeSettings = PLACEHOLDER_SETTINGS): string {
  const { ownerUserId, emoji } = node.settings;
  return slackScript(
    'the request signature check (HMAC-SHA256 in plain JavaScript)',
    VERIFY_MODULES,
    [
      '// SIGNING_SECRET: Slack app → Basic Information → App Credentials → Signing Secret.',
      '// Paste it here in n8n only. Never commit it, and never export this workflow with it in.',
      `const SIGNING_SECRET = ${JSON.stringify(node.signingSecret)};`,
      '// OWNER: your Slack member id (your profile → ⋮ → Copy member ID). Only your saves count.',
      `const OWNER = ${JSON.stringify(ownerUserId)};`,
      '// EMOJI: the reactions that save a message as a note or a task (names, without colons).',
      `const EMOJI = ${JSON.stringify(emoji)};`,
      '// No raw body (a multipart request with no file part, say) cannot be signed: a silent 401.',
      'let body = null;',
      'try {',
      '  body = new Uint8Array(await this.helpers.getBinaryDataBuffer(0, "data"));',
      '} catch (error) {',
      '  body = null;',
      '}',
      'const delivery = { headers: $input.first()?.json?.headers, body };',
      'const settings = { ownerUserId: OWNER, emoji: EMOJI };',
      '// Until the signature is proven, every outcome is { signed: false } (a silent 401). Only a',
      '// request proven Slack’s that cannot be read throws to the error output: 200 and an email.',
      'return [{ json: verifySlackRequest(delivery, { signingSecret: SIGNING_SECRET, now: Date.now(), settings }) }];',
    ],
  );
}

/** The "Who is in it?" node: one item per person to look up, whoever asked always among them. */
export function usersToLookUpScript(): string {
  return slackScript(
    'who to look up',
    ['./slack-capture.ts'],
    [
      `const action = $('${N.verify}').first().json;`,
      `return usersToLookUp(action, $('${N.thread}').first().json).map((userId) => ({ json: { userId } }));`,
    ],
  );
}

/** The "Build the capture" node: everything Slack sent, as one capture/v1 payload. */
export function buildCaptureScript(): string {
  return slackScript(
    'the capture/v1 payload',
    ['./slack-capture.ts'],
    [
      'const payload = slackCapturePayload({',
      `  action: $('${N.verify}').first().json,`,
      `  permalink: $('${N.permalink}').first().json,`,
      `  replies: $('${N.thread}').first().json,`,
      '  users: $input.all().map((each) => each.json),',
      '});',
      'return [{ json: payload }];',
    ],
  );
}

/** The reply each outcome DMs, as an n8n Code node's lines: `text` is the reply's words. */
export type ReplyOutcome = 'saved' | 'committed' | 'held' | 'failed';

const REPLY_TEXT: Readonly<Record<ReplyOutcome, string>> = {
  saved: 'savedReply($input.first().json)',
  committed: `committedReply($('${N.map}').first().json.path, $('${N.send}').first().json)`,
  held: `heldReply($('${N.map}').first().json.held)`,
  failed: 'failedReply($input.first().json)',
};

/** A "Reply:" node: to James, by DM from the app's bot, in one line. */
export function replyScript(outcome: ReplyOutcome): string {
  return slackScript(
    `the ${outcome} reply`,
    ['./slack-reply.ts'],
    [
      `return [{ json: { channel: $('${N.verify}').first().json.userId, text: ${REPLY_TEXT[outcome]} } }];`,
    ],
  );
}

/** Every script the Slack workflow holds, as `pnpm n8n:build` commits them. */
export function slackScripts() {
  return {
    verify: verifySlackScript(),
    lookUp: usersToLookUpScript(),
    build: buildCaptureScript(),
    map: mapCaptureScript(N.build),
    replies: {
      saved: replyScript('saved'),
      committed: replyScript('committed'),
      held: replyScript('held'),
      failed: replyScript('failed'),
    },
  };
}
