/**
 * What Claude answers about a meeting for the "After a meeting" rule (#184,
 * ADR-0036): the `meeting-digest` output, `{ summary, key_points,
 * open_questions, items }` — the summary written at the top of the meeting,
 * and the action items `meeting-items` reads, read the same way, by the same
 * owner rules. A long meeting is read in parts, as `meeting-items` is, and
 * the parts' summaries are merged by one more ask, the reduce.
 *
 * A summary that does not read — not text, too long, loading something
 * remote — is dropped and said; the answer's items are kept. The items are
 * what becomes tasks; the summary is a glance.
 */

import { readWikiLink } from '../markdown/wikilink-spans.ts';
import { meetingTranscriptOf } from '../meetings/meeting-turns.ts';
import { SUMMARY_OF_KEY } from '../meetings/meeting-summary-block.ts';
import { digestOf } from '../sources/merge.ts';
import { TASK_KEYS } from '../gtd/gtd-status.ts';
import { MAX_KEY_POINTS, MAX_OPEN_QUESTIONS } from '../meetings/meeting-summary-block.ts';
import type { SummaryActionItem } from '../meetings/meeting-summary-block.ts';
import { remoteResourceProblem } from './remote-resources.ts';
import { MEETING_ITEMS } from './meeting-items.ts';
import {
  answerJson,
  isRecord,
  type AnsweredSummary,
  type AnswerSummarySchema,
  type CheckedProposal,
  registerProposalSchema,
  type ProposalSchema,
  type PromptData,
  type RegisteredProposalSchema,
  type SummaryReading,
} from './proposal-schema.ts';
import { unknownKeyProblem } from './answer-limits.ts';
import type { MeetingItemsDecision } from './meeting-item-apply.ts';

/** What a rule's `output:` calls it. */
export const MEETING_DIGEST_OUTPUT = 'meeting-digest';

const SUMMARY_KEYS = ['summary', 'key_points', 'open_questions'] as const;

/**
 * The most a summary may run before it is a runaway, not a long summary: the
 * block cuts a long one to its own sizes, and drops one past this.
 */
const MAX_SUMMARY_TEXT_CHARACTERS = 5_000;
/** The most lines a list of the summary's may hold before it is dropped, not cut. */
const MAX_SUMMARY_LIST_ITEMS = 25;
/** The longest one of its lines may be before the summary is dropped. */
const MAX_SUMMARY_LINE_CHARACTERS = 1_000;

/** What the model is told the summary must be: what the owner needs at a glance. */
const SUMMARY_SHAPE =
  '"summary" is what the meeting was for and what came of it, in two to four plain sentences and at most 150 words: ' +
  'no greeting, no "In this meeting", no restating the title, nothing that is not in the transcript. ' +
  `"key_points" is at most ${MAX_KEY_POINTS} short lines, the facts the vault's owner needs at a glance, most important first; ` +
  'leave out what is already an item. ' +
  `"open_questions" is at most ${MAX_OPEN_QUESTIONS} questions the meeting raised and left open; [] when none were. ` +
  'Spell names and products as the vocabulary does. Plain text only: no links, checkboxes, headings or tags.';

const DIGEST_SUMMARY: AnswerSummarySchema = {
  keys: SUMMARY_KEYS,
  shape: SUMMARY_SHAPE,
  read: readSummaryOf,
};

/**
 * The summary an answer's keys hold. Absent when the answer has none of them
 * (it was given before the output summarised); dropped, with why, when they
 * do not read.
 */
function readSummaryOf(answer: Readonly<Record<string, unknown>>): SummaryReading {
  if (!SUMMARY_KEYS.some((key) => Object.hasOwn(answer, key))) return { kind: 'absent' };
  const { summary, key_points: keyPoints = [], open_questions: openQuestions = [] } = answer;
  if (typeof summary !== 'string' || summary.trim() === '') {
    return dropped('It has no "summary" in words.');
  }
  if (summary.length > MAX_SUMMARY_TEXT_CHARACTERS) {
    return dropped(
      `Its "summary" is ${summary.length} characters; at most ${MAX_SUMMARY_TEXT_CHARACTERS}.`,
    );
  }
  const points = linesOf('key_points', keyPoints);
  if (!points.ok) return dropped(points.problem);
  const questions = linesOf('open_questions', openQuestions);
  if (!questions.ok) return dropped(questions.problem);
  const remote = [summary, ...points.value, ...questions.value]
    .map(remoteResourceProblem)
    .find((problem) => problem !== null);
  if (remote !== undefined) return dropped(remote);
  return {
    kind: 'read',
    value: { summary: summary.trim(), keyPoints: points.value, openQuestions: questions.value },
  };
}

const dropped = (problem: string): SummaryReading => ({ kind: 'dropped', problem });

function linesOf(
  key: string,
  value: unknown,
): { ok: true; value: string[] } | { ok: false; problem: string } {
  if (!Array.isArray(value) || !value.every((line) => typeof line === 'string')) {
    return { ok: false, problem: `Its "${key}" is not a list of text.` };
  }
  if (value.length > MAX_SUMMARY_LIST_ITEMS) {
    return {
      ok: false,
      problem: `Its "${key}" has ${value.length} lines; at most ${MAX_SUMMARY_LIST_ITEMS}.`,
    };
  }
  const long = (value as string[]).find((line) => line.length > MAX_SUMMARY_LINE_CHARACTERS);
  if (long !== undefined) {
    return {
      ok: false,
      problem: `A line of its "${key}" is ${long.length} characters; at most ${MAX_SUMMARY_LINE_CHARACTERS}.`,
    };
  }
  return { ok: true, value: (value as string[]).map((line) => line.trim()).filter(Boolean) };
}

/** A schema's items, read and owned exactly as it reads them, with a summary beside them. */
function summarising<Item>(schema: ProposalSchema<Item>): ProposalSchema<Item> {
  return { ...schema, name: MEETING_DIGEST_OUTPUT, summary: DIGEST_SUMMARY };
}

/** The output: `meeting-items` with a summary of the meeting beside its items. */
export const MEETING_DIGEST: RegisteredProposalSchema = registerProposalSchema(
  summarising(MEETING_ITEMS),
);

/** What the reduce ask is told: the rule's prompt in its place. */
export const DIGEST_REDUCE_PROMPT = `# One summary of a long meeting

The meeting was too long to read at once, so it was read in parts, and each
part was summarised. Merge those summaries into one summary of the whole
meeting, as if it had been read at once: what it was for and what came of it,
the key points, and the questions it left open. Say each thing once. Leave out
what a later part settled or took back. Use only what the parts say.`;

/** What the reduce's answer must be. */
export const DIGEST_REDUCE_INSTRUCTIONS = [
  `Answer with JSON only, and nothing around it: { "summary": …, "key_points": [ … ], "open_questions": [ … ] }.`,
  SUMMARY_SHAPE,
].join('\n');

/**
 * What the reduce ask is shown beside the meeting, as data: each part's
 * summary, in the meeting's order, and who was there and the vocabulary, as
 * each part was shown them.
 */
export function digestReduceData(
  parts: readonly AnsweredSummary[],
  partData: readonly PromptData[],
): PromptData[] {
  const summaries = parts.map((part, at) =>
    [
      `Part ${at + 1} of ${parts.length}`,
      `Summary: ${part.summary}`,
      ...(part.keyPoints.length > 0 ? ['Key points:', ...part.keyPoints.map((p) => `- ${p}`)] : []),
      ...(part.openQuestions.length > 0
        ? ['Open questions:', ...part.openQuestions.map((q) => `- ${q}`)]
        : []),
    ].join('\n'),
  );
  return [
    { about: 'the summary of each part of the meeting, in order', text: summaries.join('\n\n') },
    ...partData.filter(({ about }) => !about.startsWith('the provider')),
  ];
}

/** The reduce's answer, read as a summary is: dropped, with why, when it does not read. */
export function readDigestReduce(answer: string): SummaryReading {
  const parsed = answerJson(answer);
  if (!parsed.ok) return dropped(parsed.problem);
  if (!isRecord(parsed.value)) return dropped('It is not { "summary": … }.');
  const extra = unknownKeyProblem(parsed.value, SUMMARY_KEYS, 'The answer');
  if (extra !== null) return dropped(extra);
  const reading = readSummaryOf(parsed.value);
  return reading.kind === 'absent' ? dropped('It has no "summary".') : reading;
}

/**
 * One meeting's summary from its parts' readings: the one part's own; for
 * several, the reduce's (`reduced`) — never a part's alone, which speaks for
 * part of the meeting. Dropped, with why, when a part's or the reduce's did
 * not read: a summary of part of a meeting is not one of the meeting.
 */
export function meetingSummaryOf(
  parts: readonly SummaryReading[],
  reduced: SummaryReading | null,
): SummaryReading {
  const unread = parts.find((part) => part.kind !== 'read');
  if (unread !== undefined) {
    return unread.kind === 'dropped' ? unread : dropped('A part’s answer has no "summary".');
  }
  if (parts.length === 1) return parts[0]!;
  if (reduced === null) return dropped('The parts’ summaries were not merged.');
  return reduced;
}

/** The parts' summaries, when every part's read: what the reduce merges. */
export function partSummaries(parts: readonly SummaryReading[]): AnsweredSummary[] | null {
  const read = parts.flatMap((part) => (part.kind === 'read' ? [part.value] : []));
  return read.length === parts.length ? read : null;
}

/**
 * What became of an action item, as the decision left it. `left-out` is an
 * item the owner's review never shows (someone else's unasked item, one not
 * sure enough, a decision they took no part in): the summary lists none.
 */
export type ListedOutcome = 'task' | 'made-before' | 'proposal' | 'left-out';

/**
 * What a meeting's summary lists of its answer, as the domain decided each
 * item (`decideMeetingItems`): its action items, in the transcript's order,
 * each with whether a task stands for it, and its decisions. Only what reaches
 * the owner is listed: their own items (a task or the review) and what they
 * asked others for (a waiting-for in the review). An item the decision left
 * out is listed nowhere, an action item or a decision alike (#226).
 */
export function summaryListing(items: MeetingItemsDecision['items']): {
  readonly actionItems: SummaryActionItem[];
  readonly decisions: string[];
} {
  const outcomeOf = ({
    outcome,
  }: MeetingItemsDecision['items'][number]['decision']): ListedOutcome =>
    outcome === 'task'
      ? 'task'
      : outcome === 'skipped'
        ? 'made-before'
        : outcome === 'left-out'
          ? 'left-out'
          : 'proposal';
  return {
    actionItems: items.flatMap(({ proposal, decision }) => {
      const listed = summaryActionItem(proposal, outcomeOf(decision));
      return listed === null ? [] : [listed];
    }),
    decisions: summaryDecisions(
      items.flatMap(({ proposal, decision }) =>
        decision.outcome === 'left-out' ? [] : [proposal],
      ),
    ),
  };
}

/**
 * One of the meeting's action items as the summary lists it: its title, who
 * took it on — `you` for the owner, else the name its task waits on, as the
 * vault spells it — the turn it came from, and whether a task stands for it.
 * A decision is none: the block lists it under Decisions.
 */
export function summaryActionItem(
  proposal: Pick<CheckedProposal, 'kind' | 'payload' | 'cites' | 'meetingItem'>,
  outcome: ListedOutcome,
): SummaryActionItem | null {
  if (outcome === 'left-out') return null;
  if (proposal.kind !== 'task' && proposal.kind !== 'follow-up') return null;
  return {
    title: proposal.payload.title,
    assignee: assigneeOf(proposal),
    turn: proposal.cites.block,
    taskMade: outcome === 'task' || outcome === 'made-before',
  };
}

function assigneeOf({
  kind,
  payload,
  meetingItem,
}: Pick<CheckedProposal, 'kind' | 'payload' | 'meetingItem'>): string {
  if (kind === 'follow-up' || meetingItem?.owner === 'self') return 'you';
  const waitingOn = payload.properties[TASK_KEYS.waitingOn];
  const written = typeof waitingOn === 'string' ? waitingOn.trim() : '';
  if (written === '') return '';
  const link = readWikiLink(written);
  if (link === null || link.embed) return written;
  const target = link.target.slice(link.target.lastIndexOf('/') + 1).replace(/\.md$/i, '');
  return link.alias ?? target;
}

/** The decisions of a meeting's answer, as the block lists them: their titles. */
export function summaryDecisions(
  proposals: readonly Pick<CheckedProposal, 'kind' | 'payload'>[],
): string[] {
  return proposals.flatMap(({ kind, payload }) => (kind === 'decision' ? [payload.title] : []));
}

/**
 * The digest of the words a meeting's summary is of: its transcript section,
 * as the rule's ledger keys it (`meeting-items`' handled key). Null for a
 * meeting with no transcript.
 */
export function transcriptDigestOf(text: string): string | null {
  const transcript = meetingTranscriptOf(text);
  return transcript === null ? null : digestOf(transcript);
}

/**
 * Whether a meeting's summary is of the words it holds now
 * (`atlas_summary_of` is its transcript's digest): it is skipped without
 * asking. Everything the step does for a meeting is written before its
 * summary, so a summary of these words says the rest was done too.
 */
export function summarisedAlready(
  properties: Readonly<Record<string, unknown>>,
  text: string,
): boolean {
  const of = properties[SUMMARY_OF_KEY];
  const words = transcriptDigestOf(text);
  return typeof of === 'string' && words !== null && of === words;
}

/**
 * What the reduce ask is kept as beside the parts' answers (ADR-0036, "The
 * model's answer is kept and reused"): the parts it merged and their answers,
 * so it is reused only over the very answers it merged — a part asked again
 * on a retry means a new reduce (#793).
 */
export function reducePartMark({
  parts,
  answers,
}: {
  parts: readonly string[];
  answers: readonly string[];
}): string {
  return `reduce:${digestOf(JSON.stringify([parts, answers]))}`;
}
