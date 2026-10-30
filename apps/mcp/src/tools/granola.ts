/** Pulling Granola's meetings: `/v1/granola/pull`. */

import { defineTool } from './define.ts';
import { noInput } from './inputs.ts';

export const syncGranola = defineTool({
  name: 'atlas_sync_granola',
  title: 'Sync Granola now',
  description:
    "Pull Granola's new meetings into the vault now, as Sync now in Settings → Granola does: DFAI " +
    "lists every note in this Mac's Granola account and writes each one the vault does not hold " +
    'yet as a meeting note. The key stays in DFAI; no tool can read it. Returns { report: { mode, ' +
    'ended, written, held, refused, skipped, failed, problem, keyRefused, watermark } }: "written" ' +
    'are the meeting files, and "ended" with "problem" say why a pull stopped or failed, which is ' +
    'not a tool error. Fails with "conflict" when this Mac holds no Granola key for the vault ' +
    'or holds one Granola refused, while DFAI waits for sync and its index before it pulls, or ' +
    'within 30 seconds of the end of the last pull through the API ("retryAfter" says how long ' +
    'is left). A long first pull may end in "timeout" while it goes on; its outcome is then in DFAI.',
  inputSchema: noInput,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  call: (client) => client.syncGranola(),
});

export const granolaTools = [syncGranola];
