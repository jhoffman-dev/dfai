import { codeNodeScript, DEFAULT_TIME_ZONE, moduleScript } from './code-node.ts';

/*
 * The Granola webhook workflow's two Code-node scripts: the signature check,
 * compiled from tools/n8n's plain-JavaScript HMAC, and the mapping, which is
 * the Gemini workflow's compiled mapper with Granola's own last lines.
 */

/** The node that fetches the note; the map node reads its answer's body by this name. */
export const FETCH_NOTE_NODE = 'Fetch Granola note';

/** What the committed verify node holds instead of the secret, which James pastes in n8n only. */
export const SECRET_PLACEHOLDER = 'whsec_PASTE_THE_SECRET_FROM_GRANOLA_HERE';

const WEBHOOK_MODULES = ['./sha256.ts', './standard-webhook.ts', './granola-webhook.ts'] as const;

const WEBHOOK_HEADER = [
  '// DFAI Granola webhook check (Standard Webhooks, HMAC-SHA256 in plain JavaScript).',
  '// Generated from tools/n8n/sha256.ts, standard-webhook.ts and granola-webhook.ts',
  '// in the DFAI repo by `pnpm n8n:build`:',
  '// change those files and rebuild rather than editing here (except SECRET).',
].join('\n');

/** The signature check as one plain-JavaScript script, followed by `run`, the node's own lines. */
export function webhookCodeNodeScript(run: string): string {
  return `${WEBHOOK_HEADER}\n\n${WEBHOOK_MODULES.map(moduleScript).join('\n')}\n// --- n8n ---\n${run}\n`;
}

/**
 * The "Verify Granola signature" node, run once for all items (one webhook
 * is one item). The Webhook node's Raw Body option puts the bytes as sent in
 * its `data` binary, which is what was signed.
 */
export function verifyGranolaScript(secret: string = SECRET_PLACEHOLDER): string {
  return webhookCodeNodeScript(
    [
      '// SECRET: Granola → Settings → Connectors → Webhooks → your endpoint’s signing secret.',
      '// Paste it here in n8n only. Never commit it, and never export this workflow with it in.',
      `const SECRET = ${JSON.stringify(secret)};`,
      'const body = new Uint8Array(await this.helpers.getBinaryDataBuffer(0, "data"));',
      'const delivery = { headers: $input.first().json.headers, body };',
      'return [{ json: verifyGranolaWebhook(delivery, { secret: SECRET, now: Date.now() }) }];',
    ].join('\n'),
  );
}

/** The mapping inputs that are not the note; the vault's settings hold the app's copy (ADR-0034). */
export interface GranolaNodeOptions {
  readonly timeZone: string;
  readonly selfEmails: readonly string[];
  readonly groupAddresses: readonly string[];
}

export const DEFAULT_GRANOLA_OPTIONS: GranolaNodeOptions = {
  timeZone: DEFAULT_TIME_ZONE,
  selfEmails: [],
  groupAddresses: [],
};

/** The Granola "Map meeting to DFAI file" node: the fetched note as the app's pull writes it. */
export function mapGranolaScript(options: GranolaNodeOptions = DEFAULT_GRANOLA_OPTIONS): string {
  return codeNodeScript(
    [
      '// OPTIONS must equal the vault’s settings, byte for byte, or the app and n8n write the',
      '// same meeting differently (a sync conflict copy): timeZone is granola_time_zone,',
      '// selfEmails is selfEmails (your own addresses), groupAddresses is granola_group_addresses.',
      `const OPTIONS = ${JSON.stringify(options)};`,
      `return { json: mapGranolaNote($('${FETCH_NOTE_NODE}').item.json.body, OPTIONS) };`,
    ].join('\n'),
  );
}
