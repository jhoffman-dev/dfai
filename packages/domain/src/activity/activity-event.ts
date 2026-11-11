/**
 * The Activity log's one line (U-28): something a person would care about —
 * an automation ran, a source failed, Claude's edit was accepted — said once,
 * in words that may be read anywhere.
 *
 * A line never carries a note's contents, a machine's absolute paths, a
 * secret's value or a chat note's name, which is the question that started
 * it. Every line is made through {@link activityEvent}, which strips them, so
 * that rule holds for whatever words a caller hands over.
 */

import { CHAT_NOTE_LABEL, isInChats } from '../chat/chat-note.ts';
import { messageWithoutPaths, PATH_PLACEHOLDER } from '../errors/message-without-paths.ts';
import {
  BYTE_ORDER_MARK,
  DIRECTION_MARKS,
  DRAWN_AS_NOTHING,
  LONE_SURROGATE,
} from '../text/hidden-characters.ts';
import { createVaultPath, VAULT_ROOT, type VaultPath } from '../vault/vault-path.ts';
import { withoutChatPaths, withoutChatTitle } from './without-chat-names.ts';
import { REDACTED, withoutSecrets } from './without-secrets.ts';

export const ACTIVITY_LEVELS = ['info', 'warning', 'error'] as const;
export type ActivityLevel = (typeof ACTIVITY_LEVELS)[number];

/** What part of DFAI a line is about, in the order the page's filters list them. */
export const ACTIVITY_KINDS = [
  'automation',
  'source',
  'meeting',
  'api',
  'chat',
  'index',
  'save',
  'export',
  'sync',
  'app',
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export const ACTIVITY_SUBJECT_KINDS = ['note', 'rule', 'source'] as const;
export type ActivitySubjectKind = (typeof ACTIVITY_SUBJECT_KINDS)[number];

/** What a line is about, for the page to open: a note, an automation's rule file, or a source note. */
export interface ActivitySubject {
  readonly kind: ActivitySubjectKind;
  /** A line never names a place outside the vault. */
  readonly path: VaultPath;
}

/** What a use-case reports: the line, before it is dated. */
export interface ActivityReport {
  readonly level: ActivityLevel;
  readonly kind: ActivityKind;
  readonly message: string;
  readonly subject: ActivitySubject | null;
  /**
   * The notes the line is about besides its subject: the meetings a rule's
   * run heard (#192), so Activity can show the line under each meeting. Left
   * out for none.
   */
  readonly notes?: readonly VaultPath[];
  /**
   * More than the line says, for a reader who opens it (#815): an API
   * refusal's reason, say. Made safe as the message is; left out for none.
   */
  readonly detail?: string;
}

/** The most notes a line keeps beside its subject: a run's are its few triggering notes. */
export const MAX_ACTIVITY_NOTES = 20;

export interface ActivityEvent extends ActivityReport {
  /** When it happened, in milliseconds since the epoch, as the injected clock said. */
  readonly at: number;
}

/** The longest a line's message may be: one line on the page, not a stack trace. */
export const MAX_ACTIVITY_MESSAGE = 300;

/** The longest a line's detail may be: a paragraph to open, not a log file. */
export const MAX_ACTIVITY_DETAIL = 1000;

/**
 * A line, made safe to keep: its message on one line, without absolute paths,
 * chat notes' names or secret values, and no longer than
 * {@link MAX_ACTIVITY_MESSAGE}; its subject dropped when it is not a path
 * inside the vault, or is a chat note.
 */
export function activityEvent(report: ActivityReport & { at: number }): ActivityEvent {
  const chat = report.subject !== null && isInChats(report.subject.path) ? report.subject : null;
  return {
    at: report.at,
    level: report.level,
    kind: report.kind,
    message: cleanMessage(report.message, chat),
    subject: chat === null ? cleanSubject(report.subject) : null,
    ...notesOf(report.notes),
    ...detailOf(report.detail, chat),
  };
}

/** The detail kept: cleaned as the message is, and left out when nothing is left of it. */
function detailOf(detail: string | undefined, chat: ActivitySubject | null): { detail?: string } {
  if (detail === undefined) return {};
  const safe = safeActivityText(detail, { max: MAX_ACTIVITY_DETAIL, chatPath: chat?.path ?? null });
  return safe === '' ? {} : { detail: safe };
}

/** The notes kept beside the subject: inside the vault, no chat note, each once, at most {@link MAX_ACTIVITY_NOTES}. */
function notesOf(notes: readonly string[] | undefined): { notes?: readonly VaultPath[] } {
  const kept = new Set<VaultPath>();
  for (const note of notes ?? []) {
    const path = insideVault(note);
    if (path !== null && !isInChats(path)) kept.add(path);
  }
  return kept.size === 0 ? {} : { notes: [...kept].slice(0, MAX_ACTIVITY_NOTES) };
}

function cleanMessage(raw: string, chat: ActivitySubject | null): string {
  const safe = safeActivityText(raw, { max: MAX_ACTIVITY_MESSAGE, chatPath: chat?.path ?? null });
  return safe === '' ? 'No detail was given.' : safe;
}

/**
 * Words made safe to keep, as a line's message and detail are: one line of
 * plain text, without absolute paths, chat notes' names (the title of
 * `chatPath`, when the words are about one) or secret values, cut to `max`
 * characters with an ellipsis. Cut only once clean, so a cut never leaves
 * part of a secret, a path or a title that the whole would have struck.
 */
export function safeActivityText(
  raw: string,
  { max, chatPath = null }: { max: number; chatPath?: VaultPath | null },
): string {
  // Invisible characters go first: one inside a token or a title would hide it from what strikes it.
  const visible = withoutInvisibles(raw);
  const unnamed = chatPath === null ? visible : withoutChatTitle(visible, chatPath);
  const safe = withoutSecrets(withoutChatPaths(messageWithoutPaths(unnamed)))
    .replace(LINE_BREAKS, ' ')
    .trim();
  return cutToLength(safe, max);
}

/**
 * Terminal escapes (CSI, OSC), then any other control, direction or invisible
 * character, and a lone surrogate. An OSC with no end loses only its `ESC ]`,
 * so the words after it are kept.
 */
// eslint-disable-next-line no-control-regex -- an escape sequence is exactly what is removed
const ESCAPES = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\](?:[^\u0007\u001B]*(?:\u0007|\u001B\\))?)/g;
const INVISIBLES = new RegExp(
  `[\\u0000-\\u0008\\u000E-\\u001B\\u007F-\\u0084\\u0086-\\u009F${DIRECTION_MARKS}${BYTE_ORDER_MARK}${DRAWN_AS_NOTHING}]`,
  'gu',
);

/** Every run of what a reader may break a line on — `\s`, NEL and the C0 separators — as one space. */
// eslint-disable-next-line no-control-regex -- the C0 separators are exactly what becomes a space
const LINE_BREAKS = /[\s\u001C-\u001F\u0085]+/g;

function withoutInvisibles(text: string): string {
  return text.replace(ESCAPES, '').replace(INVISIBLES, '').replace(LONE_SURROGATE, '\uFFFD');
}

/** What the cleaning put in place of what it struck: a cut through one would leave `<se…`. */
const PLACEHOLDERS = [REDACTED, PATH_PLACEHOLDER, CHAT_NOTE_LABEL];

/**
 * The text cut to `max` characters, counted by code point so an emoji is
 * never split in two, and before any placeholder the cut would fall inside.
 */
function cutToLength(text: string, max: number): string {
  const characters = [...text];
  if (characters.length <= max) return text;
  const end = characters.slice(0, max - 1).join('').length;
  return `${text.slice(0, outsidePlaceholders(text, end)).trimEnd()}…`;
}

/** The cut `end`, or the start of the placeholder it falls inside. */
function outsidePlaceholders(text: string, end: number): number {
  for (const placeholder of PLACEHOLDERS) {
    const start = text.lastIndexOf(placeholder, end - 1);
    if (start !== -1 && start + placeholder.length > end) return start;
  }
  return end;
}

function cleanSubject(subject: ActivitySubject | null): ActivitySubject | null {
  if (subject === null) return null;
  const path = insideVault(subject.path);
  return path === null ? null : { kind: subject.kind, path };
}

/** The path, when it names something in the vault; null for the root, or a place outside it. */
export function insideVault(path: string): VaultPath | null {
  try {
    const inside = createVaultPath(path);
    return inside === VAULT_ROOT ? null : inside;
  } catch {
    // Not a vault path — absolute, or climbing out: the line keeps its words and loses its link.
    return null;
  }
}
