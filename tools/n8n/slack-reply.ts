/*
 * What the Slack workflow tells James in Slack after a capture (#104): saved
 * by DFAI, committed to pkm-space, already there, or not saved and why. One
 * line each, as the app's bot DMs it; compiled into the "Reply:" Code nodes.
 */

/** The longest a reason runs in a reply, in characters, before it is cut. */
const REASON_LENGTH = 300;

/**
 * Words as one line of Slack text that says only what it says: control
 * characters and line breaks as spaces, and `&`, `<`, `>` escaped as Slack
 * asks, so nothing in a title or an error becomes a mention or a link.
 */
export function slackLine(words: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
  const line = words.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();
  const cut = line.length > REASON_LENGTH ? `${line.slice(0, REASON_LENGTH)}…` : line;
  return cut.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Why a node failed, as its error output carries it. */
export function failureReason(item: unknown): string {
  const error =
    typeof item === 'object' && item !== null ? (item as { error?: unknown }).error : undefined;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return JSON.stringify(error ?? item) ?? 'no reason given';
}

/** The DM for a capture DFAI took: its answer names the note. */
export function savedReply(answer: unknown): string {
  const capture =
    typeof answer === 'object' && answer !== null ? (answer as { body?: unknown }).body : null;
  const receipt = (capture as { capture?: { path?: unknown; outcome?: unknown } } | null)?.capture;
  const path = typeof receipt?.path === 'string' ? receipt.path : 'the Inbox';
  const already = receipt?.outcome === 'in-vault';
  return already ? `Already in DFAI: ${slackLine(path)}` : `Saved to DFAI: ${slackLine(path)}`;
}

/** Why the capture went by commit: what DFAI answered, or that it did not. */
function whyNotSent(sent: unknown): string {
  const status =
    typeof sent === 'object' && sent !== null
      ? (sent as { statusCode?: unknown }).statusCode
      : undefined;
  return typeof status === 'number' ? `DFAI answered ${status}` : 'DFAI did not answer';
}

/** The DM for a capture n8n committed to pkm-space itself; DFAI pulls it within a minute. */
export function committedReply(path: string, sent: unknown): string {
  return `Saved to pkm-space for DFAI (${whyNotSent(sent)}): ${slackLine(path)}`;
}

/** The DM for a message pkm-space already holds: nothing was written. */
export function heldReply(path: string): string {
  return `Already in pkm-space, not saved again: ${slackLine(path)}`;
}

/** The DM for a capture that did not happen. */
export function failedReply(item: unknown): string {
  return `Not saved to DFAI: ${slackLine(failureReason(item))}. The details are in your email.`;
}

const countOf = (value: unknown, name: string) => {
  const list =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[name] : null;
  return Array.isArray(list) ? list.length : 0;
};

/**
 * What the DM adds when the thread was too long to save whole: capture/v1
 * has no place in the note to say so. Empty when every reply was saved.
 */
export function leftOutNote(replies: unknown, payload: unknown): string {
  // Slack lists the saved message itself among the thread's messages.
  const leftOut = countOf(replies, 'messages') - 1 - countOf(payload, 'thread');
  if (leftOut <= 0) return '';
  return ` (${leftOut} ${leftOut === 1 ? 'reply was' : 'replies were'} left out: the thread is longer than a capture holds)`;
}
