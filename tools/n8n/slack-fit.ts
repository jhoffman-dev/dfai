import {
  EMAIL,
  MAX_ATTACHMENTS,
  MAX_MESSAGE_LENGTH,
  MAX_NAME_LENGTH,
  MAX_REPLIES,
  MAX_TOTAL_LENGTH,
  MAX_URL_LENGTH,
  WEB_ADDRESS,
} from '../../packages/domain/src/capture/mapping/capture-payload.ts';
import { cleanText, oneLineText } from '../../packages/domain/src/capture/mapping/capture-text.ts';

/*
 * What Slack sends, fitted to capture/v1 before the contract reads it (PR
 * #623 attack): one odd detail — an address the contract will not hold, a
 * name of nothing but direction marks, a 101st file, a thread of a million
 * characters — must never lose the message. The rules and limits are the
 * contract's own, imported, so the two cannot drift.
 */

/** A name as the contract holds it: one clean line, at most its length, cut between code points. */
function fittedLine(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const line = oneLineText(value);
  return line === '' ? null : [...line].slice(0, MAX_NAME_LENGTH).join('').trimEnd();
}

/** The first of `candidates` that is a name once cleaned, else `fallback`. */
export function fittedName(candidates: readonly unknown[], fallback: string): string {
  for (const candidate of candidates) {
    const name = fittedLine(candidate);
    if (name !== null) return name;
  }
  return fittedLine(fallback) ?? fallback;
}

/** An address the contract holds, or none: the person is kept, by name and id. */
export function fittedEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = oneLineText(value);
  return EMAIL.test(email) ? email : null;
}

export interface Attachment {
  readonly name: string;
  readonly url: string;
}

/** A file link the contract holds: an https address with nothing a link could be broken by. */
export const holdsLink = (url: string) => url.length <= MAX_URL_LENGTH && WEB_ADDRESS.test(url);

/** At most the contract's number of files; the first ones shared are kept. */
export const fittedAttachments = (attachments: readonly Attachment[]) =>
  attachments.slice(0, MAX_ATTACHMENTS);

export interface Reply {
  readonly ts: string;
  readonly text: string;
}

/** How far a reply is from the saved message, in Slack's seconds. */
const distance = (reply: Reply, savedTs: string) => Math.abs(Number(reply.ts) - Number(savedTs));

/**
 * The replies the contract can hold beside the saved message, which is kept
 * whole: at most its number, none over Slack's own length, and all the text
 * within its total, the replies farthest from the saved message (the oldest
 * first, on a tie) left out first. In ts order, as they came.
 */
export function fittedThread<T extends Reply>(replies: readonly T[], saved: Reply): T[] {
  let room = MAX_TOTAL_LENGTH - cleanText(saved.text).length;
  const nearest = replies
    .filter((reply) => reply.text.length <= MAX_MESSAGE_LENGTH)
    .sort((a, b) => distance(a, saved.ts) - distance(b, saved.ts) || b.ts.localeCompare(a.ts));
  const kept = new Set<T>();
  for (const reply of nearest) {
    const size = cleanText(reply.text).length;
    if (kept.size === MAX_REPLIES || size > room) continue;
    kept.add(reply);
    room -= size;
  }
  return replies.filter((reply) => kept.has(reply));
}
