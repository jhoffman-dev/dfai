/**
 * Claude's answer to Inbox assist (#899), read and checked. The answer is
 * closed: one entry for each item it was asked about, and nothing else, each
 * saying what the item is, where it might go, a due date, who it waits on,
 * how sure Claude is and why. It never names an action: what is done with an
 * item is decided by `assist-plan.ts`.
 *
 * The items' words are anyone's (a Slack message, a web page), so an answer
 * is read as hostile until it checks out. Anything that does not — a key not
 * in the shape, an item it was not asked about, one asked about twice or
 * left out, a value of the wrong kind or too long — refuses the whole
 * answer: a half-read answer is never used.
 */

import { answerJson, isRecord, refused, type Reading } from '../automations/proposal-schema.ts';
import { PROPOSAL_CONFIDENCES, type ProposalConfidence } from '../proposals/proposal.ts';
import type { VaultPath } from '../vault/vault-path.ts';

/** What Claude may say an item is. */
export const ASSIST_KINDS = ['task', 'note', 'reference', 'person', 'meeting', 'junk'] as const;
export type AssistKind = (typeof ASSIST_KINDS)[number];

/** The most projects or areas an entry may suggest: more is no suggestion. */
export const ASSIST_MAX_PROJECTS = 3;

/** The longest a name, a path or a reason in an answer may be, in characters. */
export const ASSIST_TEXT_MAX = 300;

/** The longest an answer may be, in characters: ten items' worth, with room to spare. */
export const ASSIST_ANSWER_MAX = 20_000;

/** One item's entry, as checked: still Claude's say-so, not yet a plan. */
export interface AssistItemAnswer {
  /** The item's path, exactly as it was asked about. */
  readonly item: VaultPath;
  readonly kind: AssistKind;
  /** The projects or areas it might go under, as Claude named them: not checked against the vault yet. */
  readonly projects: readonly string[];
  /** `YYYY-MM-DD`, a real day, or null. */
  readonly due: string | null;
  /** The person it waits on, as Claude named them, or null. */
  readonly waitingOn: string | null;
  readonly confidence: ProposalConfidence;
  /**
   * One sentence: why. Null when it held characters that are not shown as
   * text (a zero-width joiner, say): the plan is shown without it.
   */
  readonly why: string | null;
  /**
   * True when the why held control, bidi or separator characters: text
   * written not to read as it shows. The item becomes a question, and
   * nothing of Claude's answer for it is shown.
   */
  readonly unshowable?: boolean;
}

const ENTRY_KEYS = ['item', 'kind', 'projects', 'due', 'waitingOn', 'confidence', 'why'] as const;

/** What the answer must look like, as Claude is told it. */
export const ASSIST_ANSWER_SHAPE = [
  'Answer with JSON only, exactly this shape, and nothing else:',
  '{ "items": [ { "item": the note\'s path exactly as given; "kind": one of',
  `${ASSIST_KINDS.join(', ')}; "projects": a list of at most ${ASSIST_MAX_PROJECTS} paths of projects or`,
  'areas from the list given, [] when none fits; "due": "YYYY-MM-DD" or null; "waitingOn": the',
  'path of a person from the list given, or null; "confidence": high, medium or low; "why": one',
  'short sentence } ] }',
  'Give exactly one entry for each note, and no other keys.',
].join('\n');

/**
 * The entries of `answer`, one for each of `asked` in its order, or why the
 * answer is refused whole.
 */
export function readAssistAnswer(
  answer: string,
  asked: readonly VaultPath[],
): Reading<readonly AssistItemAnswer[]> {
  if (answer.length > ASSIST_ANSWER_MAX) return refused('It is longer than an answer can be.');
  const json = answerJson(answer);
  if (!json.ok) return json;
  const { value } = json;
  if (!isRecord(value) || !onlyKeys(value, ['items']) || !Array.isArray(value['items'])) {
    return refused('It is not { "items": [...] }.');
  }
  const entries: AssistItemAnswer[] = [];
  for (const raw of value['items'] as readonly unknown[]) {
    const entry = readEntry(raw, asked);
    if (!entry.ok) return entry;
    if (entries.some((seen) => seen.item === entry.value.item)) {
      return refused(`It answers for ${JSON.stringify(entry.value.item)} twice.`);
    }
    entries.push(entry.value);
  }
  const missing = asked.find((path) => !entries.some((entry) => entry.item === path));
  if (missing !== undefined) return refused(`It leaves out ${JSON.stringify(missing)}.`);
  return { ok: true, value: asked.map((path) => entries.find((entry) => entry.item === path)!) };
}

function readEntry(raw: unknown, asked: readonly VaultPath[]): Reading<AssistItemAnswer> {
  if (!isRecord(raw)) return refused('An entry is not an object.');
  if (!onlyKeys(raw, ENTRY_KEYS)) return refused('An entry has a key the shape does not.');
  const item = asked.find((path) => path === raw['item']);
  if (item === undefined) return refused('An entry is for a note it was not asked about.');
  const kind = ASSIST_KINDS.find((known) => known === raw['kind']);
  const confidence = PROPOSAL_CONFIDENCES.find((known) => known === raw['confidence']);
  const projects = textList(raw['projects']);
  const due = raw['due'] === null ? null : day(raw['due']);
  const waitingOn = raw['waitingOn'] === null ? null : shortText(raw['waitingOn']);
  const why = shortText(raw['why']);
  const said = why === undefined ? undefined : whyShown(why);
  if (kind === undefined)
    return refused(`An entry's kind is not one of ${ASSIST_KINDS.join(', ')}.`);
  if (confidence === undefined) return refused("An entry's confidence is not high, medium or low.");
  if (projects === undefined) return refused("An entry's projects are not a short list of names.");
  if (due === undefined) return refused("An entry's due is not a day (YYYY-MM-DD) or null.");
  if (waitingOn === undefined) return refused("An entry's waitingOn is not a short name or null.");
  if (said === undefined) return refused("An entry's why is not one short sentence.");
  return { ok: true, value: { item, kind, projects, due, waitingOn, confidence, ...said } };
}

function onlyKeys(record: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const present = Object.keys(record);
  return present.length === keys.length && present.every((key) => keys.includes(key));
}

/**
 * What text that reads as it shows never holds: control characters (line
 * breaks, NUL, the vertical tab, U+0085), format characters (bidi overrides
 * and isolates, zero-width ones) and the line and paragraph separators.
 */
const UNSHOWN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * The ones that make text read other than it is: controls, separators and
 * bidi marks, overrides and isolates. A zero-width joiner in an emoji, or a
 * zero-width non-joiner in a Persian word, is not one of them.
 */
const MISLEADING = /[\p{Cc}\p{Zl}\p{Zp}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

/**
 * Whether a name or reason holds characters that are not shown as text. A
 * name holding one is trusted only when it names a vault note exactly, and
 * is then shown by the vault's own title, never as Claude wrote it (#903).
 */
export function hasUnshownCharacters(text: string): boolean {
  return UNSHOWN.test(text);
}

/** How a why is shown: as written, without itself, or not at all with the item asked about. */
function whyShown(why: string): { why: string | null; unshowable: boolean } {
  if (MISLEADING.test(why)) return { why: null, unshowable: true };
  return { why: UNSHOWN.test(why) ? null : why, unshowable: false };
}

/** One line of text, not blank, no longer than {@link ASSIST_TEXT_MAX}; undefined for anything else. */
function shortText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text === '' || text.length > ASSIST_TEXT_MAX) return undefined;
  return text;
}

function textList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > ASSIST_MAX_PROJECTS) return undefined;
  const texts = value.map(shortText);
  return texts.every((text) => text !== undefined) ? (texts as string[]) : undefined;
}

/** A real calendar day as `YYYY-MM-DD`; undefined for anything else, 2026-02-30 included. */
function day(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [year, month, date] = value.split('-').map(Number) as [number, number, number];
  const at = new Date(Date.UTC(year, month - 1, date));
  return at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === date
    ? value
    : undefined;
}
