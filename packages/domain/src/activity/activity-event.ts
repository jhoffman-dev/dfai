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

import { isInChats } from '../chat/chat-note.ts';
import { messageWithoutPaths } from '../errors/message-without-paths.ts';
import { createVaultPath, VAULT_ROOT, type VaultPath } from '../vault/vault-path.ts';
import { withoutChatPaths, withoutChatTitle } from './without-chat-names.ts';
import { withoutSecrets } from './without-secrets.ts';

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
}

/** The most notes a line keeps beside its subject: a run's are its few triggering notes. */
export const MAX_ACTIVITY_NOTES = 20;

export interface ActivityEvent extends ActivityReport {
  /** When it happened, in milliseconds since the epoch, as the injected clock said. */
  readonly at: number;
}

/** The longest a line's message may be: one line on the page, not a stack trace. */
export const MAX_ACTIVITY_MESSAGE = 300;

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
    message: cleanMessage(
      chat === null ? report.message : withoutChatTitle(report.message, chat.path),
    ),
    subject: chat === null ? cleanSubject(report.subject) : null,
    ...notesOf(report.notes),
  };
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

function cleanMessage(raw: string): string {
  const safe = withoutSecrets(withoutChatPaths(messageWithoutPaths(raw)))
    .replace(/\s+/g, ' ')
    .trim();
  if (safe === '') return 'No detail was given.';
  if (safe.length <= MAX_ACTIVITY_MESSAGE) return safe;
  return `${safe.slice(0, MAX_ACTIVITY_MESSAGE - 1).trimEnd()}…`;
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
