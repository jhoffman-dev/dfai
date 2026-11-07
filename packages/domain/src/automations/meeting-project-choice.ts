/**
 * The project Claude chooses for a meeting nothing else could file (#227):
 * part of the "After a meeting" step's answer, beside its items. Claude is
 * shown the vault's open projects and areas, and only for a meeting whose
 * `project` holds nothing; it answers with one of them, how sure, and why.
 *
 * Which note it means is never the model's to make up: a path that is not
 * one it was shown is left out and said. What the run does with a choice is
 * decided here — sure, the meeting is filed under it; otherwise one Inbox
 * proposal, known by the same id as linking's own, so a meeting waits on one
 * project proposal however many steps had an opinion.
 */

import { meetingProjectProposalId } from '../meeting-links/meeting-link-plan.ts';
import { MEETING_PROJECT_KEY } from '../meeting-links/meeting-link-keys.ts';
import { isOpenFiling } from '../meeting-links/meeting-series.ts';
import { wikiLinkTargetFor } from '../markdown/resolve-wikilink.ts';
import { PROPOSAL_CONFIDENCES, type ProposalConfidence } from '../proposals/proposal.ts';
import type { NewProposal } from '../proposals/new-proposal.ts';
import type { CompiledQuery } from '../query/view-query.ts';
import { PARA_KEY, PROJECT_TYPE, AREA_TYPE } from '../types/para.ts';
import { paraOf } from '../types/para-value.ts';
import { linkedNotes } from '../types/relation-links.ts';
import { noteTitle } from '../vault/vault-entry.ts';
import { createVaultPath, type VaultPath } from '../vault/vault-path.ts';
import { userSpaceNoteSql } from '../vault/vault-visibility.ts';
import {
  lengthProblem,
  MAX_WHY_CHARACTERS,
  truncated,
  unknownKeyProblem,
} from './answer-limits.ts';
import type { AnsweredNote } from './answered-note.ts';
import { remoteResourceProblem } from './remote-resources.ts';

/** The key of the answer that holds the choice, beside its list. */
export const PROJECT_CHOICE_KEY = 'project';

/**
 * The most projects and areas one ask is shown (#793). Each line is some
 * twenty tokens and every part of a long meeting carries the list again, so
 * forty keeps it near 800 tokens an ask; the ones tied to the meeting's
 * people and companies come first, so the likely ones are never the cut.
 */
export const MAX_PROJECT_CHOICES = 40;

/** Each meeting's open projects tied to its people and companies, likeliest first, by meeting path. */
export type MeetingProjectTies = ReadonlyMap<string, readonly VaultPath[]>;

/** A project or area a meeting may be filed under, as Claude is shown it. */
export interface ProjectOption {
  readonly path: VaultPath;
  readonly title: string;
  readonly para: 'project' | 'area';
}

/** What Claude chose, read and checked: one of the options it was shown. */
export interface ProjectChoice {
  readonly project: VaultPath;
  readonly title: string;
  readonly confidence: ProposalConfidence;
  readonly why: string;
}

/** What the model is told of the choice, after the shape of its list. */
export const PROJECT_CHOICE_INSTRUCTIONS =
  'When you are shown the projects and areas a meeting may be filed under, also answer ' +
  `"${PROJECT_CHOICE_KEY}": { "path": one of those paths, exactly as shown; "confidence": high, medium or low; ` +
  '"why": one sentence } beside the list: high only when the meeting is plainly about it, as its earlier ' +
  `meetings or its people show. Leave "${PROJECT_CHOICE_KEY}" out when none fits, and when you were shown none.`;

const CHOICE_KEYS = ['path', 'confidence', 'why'];

/**
 * Every note of the Project or Area type, with its title, PARA and status:
 * what {@link projectOptionsOf} picks the open ones from. Columns: path,
 * title, type, para, status.
 */
export function compileProjectOptionsQuery(): CompiledQuery {
  const value = (key: string) =>
    `(SELECT p.value_text FROM props AS p WHERE p.path = files.path AND p.key = '${key}' ORDER BY p.idx LIMIT 1)`;
  return {
    sql: `/* meeting links: project options */ SELECT files.path AS "path", files.title AS "title",
  ${value('type')} AS "type", ${value(PARA_KEY)} AS "para", ${value('status')} AS "status"
  FROM files
 WHERE files.path IN (SELECT path FROM props WHERE key = 'type' AND lower(value_text) IN (?, ?))
   AND ${userSpaceNoteSql('files.path')}
 ORDER BY lower(files.title), files.path`,
    parameters: [PROJECT_TYPE, AREA_TYPE],
  };
}

/** The open projects and areas among the rows ({@link isOpenFiling}), in the order they came. */
export function projectOptionsOf(
  rows: readonly {
    readonly path: string;
    readonly title: string;
    readonly type: string | null;
    readonly para: string | null;
    readonly status: string | null;
  }[],
): ProjectOption[] {
  return rows
    .filter((row) => isOpenFiling(row))
    .map((row) => ({
      path: createVaultPath(row.path),
      title: row.title,
      para: paraOf(row) === 'area' ? 'area' : 'project',
    }));
}

/** The one meeting of an ask Claude may choose a project for: shown alone, and filed under none. */
function unfiledMeeting(notes: readonly AnsweredNote[]): AnsweredNote | null {
  const [only, ...others] = notes;
  if (only?.meeting === undefined || others.length > 0) return null;
  return only.meeting.filed === true ? null : only;
}

/** What a meeting's choice is worked out from: the vault's open options, and each meeting's ties to them. */
interface ChoiceInput {
  readonly notes: readonly AnsweredNote[];
  readonly options: readonly ProjectOption[];
  /** Left out, nothing is tied, and the options are shown in their own order. */
  readonly ties?: MeetingProjectTies;
}

/**
 * The options an ask about this meeting shows: those tied to its people and
 * companies first, likeliest first — so the one linking would propose is
 * never cut — then the rest in their own order, at most
 * {@link MAX_PROJECT_CHOICES}. None for an ask that may choose no project.
 */
function shownOptions({ notes, options, ties }: ChoiceInput): readonly ProjectOption[] {
  const meeting = unfiledMeeting(notes);
  if (meeting === null) return [];
  const byPath = new Map(options.map((option) => [String(option.path), option]));
  const tied = (ties?.get(meeting.path) ?? []).flatMap((path) => byPath.get(path) ?? []);
  return [...new Set([...tied, ...options])].slice(0, MAX_PROJECT_CHOICES);
}

/** What the model is told beside a meeting with no project: the projects and areas it may choose from. */
export function projectChoiceData(
  input: ChoiceInput,
): { readonly about: string; readonly text: string }[] {
  const shown = shownOptions(input);
  if (shown.length === 0) return [];
  const lines = shown.map((option) => `- ${option.path} — ${option.title} (${option.para})`);
  const cut =
    shown.length < input.options.length
      ? [
          `(${shown.length} of the ${input.options.length} open projects and areas are shown: those tied to its people and companies first, then by title. The rest are cut.)`,
        ]
      : [];
  return [
    {
      about: 'the projects and areas this meeting may be filed under: choose one, or none',
      text: [...lines, ...cut].join('\n'),
    },
  ];
}

/** A choice read, or why it is left out: a fault in it never costs the answer its items. */
export type ProjectChoiceReading =
  | { readonly ok: true; readonly value: ProjectChoice | null }
  | { readonly ok: false; readonly problem: string };

/**
 * The answer's `project`, read against what the ask showed: absent is no
 * choice; anything else must name one of the options, exactly, with a
 * confidence and a sentence of why that loads nothing.
 */
export function readProjectChoice({
  value,
  ...input
}: ChoiceInput & { value: unknown }): ProjectChoiceReading {
  if (value === undefined || value === null) return { ok: true, value: null };
  const options = shownOptions(input);
  if (options.length === 0) {
    return { ok: false, problem: 'It chose a project, and was shown none to choose from.' };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, problem: 'Its project is not an object.' };
  }
  const record = value as Readonly<Record<string, unknown>>;
  const problem = unknownKeyProblem(record, CHOICE_KEYS, 'Its project') ?? choiceProblem(record);
  if (problem !== null) return { ok: false, problem };
  const option = options.find((each) => each.path === String(record['path']).trim());
  if (option === undefined) {
    return {
      ok: false,
      problem: `Its project ${JSON.stringify(truncated(String(record['path']), 80))} is not one it was shown.`,
    };
  }
  const confidence = PROPOSAL_CONFIDENCES.find((known) => known === record['confidence'])!;
  const why = String(record['why']).trim();
  return { ok: true, value: { project: option.path, title: option.title, confidence, why } };
}

function choiceProblem(record: Readonly<Record<string, unknown>>): string | null {
  const { path, confidence, why } = record;
  if (typeof path !== 'string') return 'Its project has no "path".';
  if (!PROPOSAL_CONFIDENCES.some((known) => known === confidence)) {
    return `Its project's confidence is not one of ${PROPOSAL_CONFIDENCES.join(', ')}.`;
  }
  if (typeof why !== 'string' || why.trim() === '') return 'Its project has no "why".';
  return (
    lengthProblem('Its project’s “why”', why, MAX_WHY_CHARACTERS) ?? remoteResourceProblem(why)
  );
}

/**
 * Of a meeting's choices — one per part it was read in — the surest; the
 * first of those as sure. When its parts chose different projects, Claude is
 * not sure of any: the surest is medium at most, so it is proposed, never filed.
 */
export function surestProjectChoice(
  choices: readonly (ProjectChoice | null)[],
): ProjectChoice | null {
  const made = choices.filter((choice): choice is ProjectChoice => choice !== null);
  const rank = (choice: ProjectChoice) => PROPOSAL_CONFIDENCES.indexOf(choice.confidence);
  const surest = made.reduce<ProjectChoice | null>(
    (best, choice) => (best === null || rank(choice) < rank(best) ? choice : best),
    null,
  );
  if (surest === null) return null;
  const elsewhere = [
    ...new Set(made.filter((choice) => choice.project !== surest.project).map((c) => c.title)),
  ];
  if (elsewhere.length === 0) return surest;
  return {
    ...surest,
    confidence: surest.confidence === 'high' ? 'medium' : surest.confidence,
    why: `${surest.why} Other parts of the meeting chose ${elsewhere.join(', ')}.`,
  };
}

/** A meeting Claude chose a project for, as the run read it from its file. */
export interface ChoosingMeeting {
  readonly path: VaultPath;
  readonly identity: { readonly provider: string; readonly externalId: string } | null;
  /** Its `project` as it is now: a meeting filed since it was asked about is left as it is. */
  readonly project: unknown;
}

/** What becomes of a choice: the meeting filed under it, one proposal, or nothing. */
export type ProjectChoiceOutcome =
  | { readonly kind: 'file'; readonly link: string }
  | { readonly kind: 'propose'; readonly proposal: NewProposal }
  | { readonly kind: 'none' };

/**
 * Whether a `project` holds nothing at all — absent, empty, or an empty list:
 * what a meeting the step files held, as {@link projectChoiceOutcome} files
 * only one that links nothing, so the only `project` its undo puts back.
 */
export function holdsNoProject(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  return Array.isArray(value) && value.every(holdsNoProject);
}

/**
 * What a choice does (#227): nothing to a meeting filed since; files a
 * meeting under a project Claude is sure of; and otherwise proposes it, once,
 * under the id linking's own project proposal has.
 */
export function projectChoiceOutcome({
  meeting,
  choice,
  notePaths,
  madeBy,
}: {
  meeting: ChoosingMeeting;
  choice: ProjectChoice;
  notePaths: readonly VaultPath[];
  /** The rule and run, as the proposal's `made_by` says it. */
  madeBy: string;
}): ProjectChoiceOutcome {
  if (linkedNotes(meeting.project).length > 0) return { kind: 'none' };
  const link = `[[${wikiLinkTargetFor(choice.project, notePaths)}]]`;
  if (choice.confidence === 'high') return { kind: 'file', link };
  const title = noteTitle(meeting.path);
  return {
    kind: 'propose',
    proposal: {
      kind: 'link',
      confidence: choice.confidence,
      source: `[[${wikiLinkTargetFor(meeting.path, notePaths)}]]`,
      madeBy,
      id: meetingProjectProposalId(meeting.path, meeting.identity),
      name: `${choice.title} for ${title}`,
      reason: `Claude’s choice: ${choice.why}`,
      payload: {
        note: meeting.path,
        property: MEETING_PROJECT_KEY,
        link,
        digest: null,
        ...(meeting.identity !== null && { meeting: meeting.identity }),
      },
    },
  };
}
