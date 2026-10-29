/**
 * An automation, as a note (P25-01): when it runs, which notes it takes — an
 * DFAI query — and what it does to them. The rule is the file's frontmatter
 * and the file's body is the person's own notes about it, so a vault's
 * automations can be read, diffed and edited anywhere.
 *
 * ```yaml
 * atlas: automation
 * name: Archive done tasks after 30 days
 * enabled: true
 * when: daily at 03:00
 * which: FROM task WHERE status = done
 * olderThanDays: 30
 * do: archive
 * ```
 *
 * What a rule may do is a short list: archive, set properties to fixed
 * values, or ask Claude for proposals or one new note (P29-03). Anything else
 * is refused rather than guessed at.
 */

import { isRecord } from '../query/frontmatter-query.ts';
import { createVaultPath, type VaultPath } from '../vault/vault-path.ts';
import { AUTOMATIONS_DIRECTORY } from '../vault/vault-visibility.ts';
import {
  claudeActionFields,
  describeClaudeAction,
  namedSkill,
  readClaudeAction,
  readsData,
  type ClaudeAction,
} from './claude-step.ts';
import { noteTriggerQueryProblem } from './note-trigger.ts';
import { setKeyProblem } from './property-key.ts';
import { parseSchedule, printSchedule, type Schedule } from './schedule.ts';

export const AUTOMATION_MARKER = 'atlas';
export const AUTOMATION_MARKER_VALUE = 'automation';

/** The longest age filter a rule may ask for: ten years. */
export const MAX_OLDER_THAN_DAYS = 3650;

/** A value a rule may set: plain, so undo can put back exactly what was there. */
export type SetValue = string | number | boolean;

export type AutomationAction =
  | { readonly kind: 'archive' }
  | { readonly kind: 'set'; readonly values: Readonly<Record<string, SetValue>> }
  | ClaudeAction;

/** What the person writes, or the editor holds: a rule without a home yet. */
export interface AutomationDraft {
  readonly name: string;
  readonly enabled: boolean;
  readonly when: Schedule;
  /** The DFAI query naming the notes. */
  readonly which: string;
  /** Only notes not modified in this many days; null for any. */
  readonly olderThanDays: number | null;
  readonly action: AutomationAction;
}

export interface AutomationRule extends AutomationDraft {
  /**
   * What the rule's log is named after: written into its file when it is
   * made, so renaming the file keeps its history and a new rule under an old
   * one's name starts its own.
   */
  readonly id: string;
  readonly path: VaultPath;
}

/** A rule file that could not be read, listed with why so it can be fixed; it never runs. */
export interface BrokenAutomation {
  readonly path: VaultPath;
  readonly name: string;
  readonly problem: string;
  /** The skill its Claude step names, when `skill:` reads as one: it still uses it (#169). */
  readonly skill?: string;
}

/** The longest id a rule may have: it names a file. */
const MAX_ID_LENGTH = 120;

const UNUSABLE_IN_NAME = /[/\\:*?"<>|]|\p{Cc}/u;

export { setKeyProblem };

export function isAutomationNote(frontmatter: Readonly<Record<string, unknown>>): boolean {
  return String(frontmatter[AUTOMATION_MARKER] ?? '').trim() === AUTOMATION_MARKER_VALUE;
}

/** Why this cannot be a rule's id — it names the rule's log file — or null when it can. */
export function automationIdProblem(id: string): string | null {
  const plain =
    id.trim() !== '' &&
    id.trim() === id &&
    id.length <= MAX_ID_LENGTH &&
    !UNUSABLE_IN_NAME.test(id) &&
    !id.startsWith('.');
  return plain ? null : 'Write id: as a plain name, without / \\ : * ? " < > | or a leading dot.';
}

/**
 * What an id is compared by. An id names its log's file, and the disks DFAI
 * runs on may treat names differing only in case, or in Unicode form (`é` as
 * one character or as `e` and an accent), as the same file.
 */
export function automationIdKey(id: string): string {
  return id.normalize('NFC').toLowerCase();
}

/**
 * The id a new rule is given: its name, numbered past any id a log is already
 * kept under — a deleted rule's log is not the new rule's history. Taken in
 * another case or Unicode form counts, as it does on the disk.
 */
export function automationIdFor(name: string, taken: readonly string[]): string {
  const folded = new Set(taken.map(automationIdKey));
  const base = name.trim();
  let id = base;
  for (let count = 2; folded.has(automationIdKey(id)); count += 1) id = `${base} ${count}`;
  return id;
}

/** Where a rule of this name lives. */
export function automationPathFor(name: string): VaultPath {
  return createVaultPath(`${AUTOMATIONS_DIRECTORY}/${name.trim()}.md`);
}

/** Whether a path is a rule's file: a note directly in the automations folder. */
export function isAutomationPath(path: string): boolean {
  const prefix = `${AUTOMATIONS_DIRECTORY}/`;
  return (
    path.startsWith(prefix) && !path.slice(prefix.length).includes('/') && path.endsWith('.md')
  );
}

/**
 * Reads a rule out of its file's frontmatter. A rule that does not say enough,
 * or asks for something it may not do, is broken — listed, never run.
 */
export function parseAutomationRule(
  path: VaultPath,
  frontmatter: Readonly<Record<string, unknown>>,
): { rule: AutomationRule; idWritten: boolean } | { broken: BrokenAutomation } {
  const stem = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '');
  const name = String(frontmatter['name'] ?? '').trim() || stem;
  const written = frontmatter['id'];
  const idWritten = written !== undefined && written !== null;
  // A rule from before ids kept its log under its file's name: that is its id until one is written.
  const id = !idWritten
    ? stem
    : typeof written === 'string' || typeof written === 'number'
      ? String(written)
      : '';
  const skill = namedSkill(frontmatter);
  const broken = (problem: string) => ({
    broken: { path, name, problem, ...(skill !== null && { skill }) },
  });
  const idProblem = automationIdProblem(id);
  if (idProblem !== null) return broken(idProblem);
  const read = readDraft({ ...frontmatter, name });
  return 'draft' in read ? { rule: { ...read.draft, id, path }, idWritten } : broken(read.problem);
}

function readDraft(
  frontmatter: Readonly<Record<string, unknown>>,
): { draft: AutomationDraft } | { problem: string } {
  const when = parseSchedule(frontmatter['when']);
  if (when === null) {
    return {
      problem:
        'Say when it runs: daily at 03:00, fridays at 15:00, every 6 hours, on app open, manually, ' +
        'or when a note appears, like a meeting is created or changed.',
    };
  }
  const which = String(frontmatter['which'] ?? '').trim();
  const action = readAction(frontmatter);
  // A step handed its data reads that alone when it names no notes (#40).
  const needsQuery = typeof action === 'string' || !readsData(action);
  if (which === '' && needsQuery) {
    return { problem: 'Say which notes it takes, as a query: FROM task WHERE …' };
  }
  const whereProblem = when.kind === 'note' ? noteTriggerQueryProblem(when, which) : null;
  if (whereProblem !== null) return { problem: whereProblem };
  const olderThanDays = readAge(frontmatter['olderThanDays']);
  if (olderThanDays === undefined) {
    return { problem: `olderThanDays is a number of days, from 1 to ${MAX_OLDER_THAN_DAYS}.` };
  }
  // The note that set it off has just changed: an age filter would leave out every one.
  if (when.kind === 'note' && olderThanDays !== null) {
    return {
      problem:
        'A rule a note sets off acts on that note as it has just become: take olderThanDays out.',
    };
  }
  if (typeof action === 'string') return { problem: action };
  const enabled = frontmatter['enabled'] ?? false;
  // Anything but a checkbox's own value would be a guess at on or off, and a wrong "off" is silent.
  if (typeof enabled !== 'boolean') return { problem: 'Write enabled: true or false.' };
  const draft: AutomationDraft = {
    name: String(frontmatter['name']),
    enabled,
    when,
    which,
    olderThanDays,
    action,
  };
  return { draft };
}

/** Null when there is no age filter; undefined when the one written is no number of days. */
function readAge(value: unknown): number | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  const days = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isInteger(days) && days >= 1 && days <= MAX_OLDER_THAN_DAYS ? days : undefined;
}

/** The action, or why it cannot be one. */
function readAction(frontmatter: Readonly<Record<string, unknown>>): AutomationAction | string {
  const word = String(frontmatter['do'] ?? '')
    .trim()
    .toLowerCase();
  if (word === 'archive') return { kind: 'archive' };
  if (word === 'claude') return readClaudeAction(frontmatter);
  if (word !== 'set') {
    return 'Say what it does: do: archive, do: set with the values under set:, or do: claude.';
  }
  const values = frontmatter['set'];
  if (!isRecord(values) || Object.keys(values).length === 0) {
    return 'A rule that sets properties names them under set:, like set: {status: done}.';
  }
  for (const [key, value] of Object.entries(values)) {
    const problem = setKeyProblem(key) ?? setValueProblem(key, value);
    if (problem !== null) return problem;
  }
  return { kind: 'set', values: { ...(values as Record<string, SetValue>) } };
}

function setValueProblem(key: string, value: unknown): string | null {
  const plain =
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && value.trim() !== '');
  return plain ? null : `A rule sets “${key}” to text, a number, or true or false.`;
}

/** Why the editor's rule cannot be saved under this name, or null. */
export function automationNameProblem(name: string, takenPaths: readonly string[]): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return 'Name the automation.';
  if (UNUSABLE_IN_NAME.test(trimmed)) {
    return 'An automation’s name cannot hold / \\ : * ? " < > or |.';
  }
  if (trimmed.startsWith('.')) return 'An automation’s name cannot start with a dot.';
  const path = automationPathFor(trimmed).toLowerCase();
  if (takenPaths.some((taken) => taken.toLowerCase() === path)) {
    return `There is already an automation called “${trimmed}”.`;
  }
  return null;
}

/** Why the editor's rule is not one yet, or null: the same rules a file is read by. */
export function draftProblem(draft: AutomationDraft): string | null {
  const read = readDraft(automationFrontmatter(draft));
  return 'problem' in read ? read.problem : null;
}

/**
 * A rule as its file's frontmatter, every key written so the file reads as
 * the rule; `set`, and a Claude step's keys, are null for a rule without
 * them, which takes them out.
 */
export function automationFrontmatter(draft: AutomationDraft): Record<string, unknown> {
  return {
    [AUTOMATION_MARKER]: AUTOMATION_MARKER_VALUE,
    name: draft.name.trim(),
    enabled: draft.enabled,
    when: printSchedule(draft.when),
    which: draft.which.trim(),
    olderThanDays: draft.olderThanDays,
    do: draft.action.kind,
    set: draft.action.kind === 'set' ? { ...draft.action.values } : null,
    ...claudeActionFields(draft.action.kind === 'claude' ? draft.action : null),
  };
}

/**
 * Whether carrying the action out would change a note holding these
 * properties — always, for an action that does not set them. A note a set rule has already done is left out before the cap
 * is counted, so it cannot take the place of one still to do. Which notes an
 * archive rule cannot take is the plan's to say, and it says why.
 */
export function wouldChange(
  action: AutomationAction,
  properties: Readonly<Record<string, unknown>>,
): boolean {
  if (action.kind !== 'set') return true;
  return Object.entries(action.values).some(
    ([key, value]) =>
      !Object.hasOwn(properties, key) || JSON.stringify(properties[key]) !== JSON.stringify(value),
  );
}

/** The action in a few words, for the list: "Archive", "Set status to done". */
export function describeAction(action: AutomationAction): string {
  if (action.kind === 'archive') return 'Archive';
  if (action.kind === 'claude') return describeClaudeAction(action);
  const parts = Object.entries(action.values).map(([key, value]) => `${key} to ${String(value)}`);
  return `Set ${parts.join(', ')}`;
}

/**
 * A value typed into the editor, as the rule keeps it: `true` and `false` as
 * a checkbox's, a plain number as a number, anything else as text.
 */
export function setValueFromInput(typed: string): SetValue {
  const text = typed.trim();
  if (text === 'true' || text === 'false') return text === 'true';
  const number = Number(text);
  // `007` and `02134` are codes, not numbers: read as numbers they would lose their zeros.
  return /^-?(0|[1-9]\d*)(\.\d+)?$/.test(text) && Number.isFinite(number) ? number : text;
}
