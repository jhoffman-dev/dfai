/**
 * What Inbox assist (#899) would do with each item: one planned action or
 * one question, from the item, Claude's checked answer and what the vault
 * holds. The model never picks the action; it says what an item is, and
 * this decides.
 *
 * An item is a question, never an action, when Claude is less than sure
 * (`assist-confidence.ts`), when it calls the item junk, a person or a
 * meeting, when it names two plausible projects, when anything it names is
 * not a real project, area or person in the vault, or when its due date has
 * passed. Only a sure task or a sure note with one real project is planned.
 *
 * Which items are asked about at all is decided here too: never a proposal,
 * a brief or a meeting (their own rules own those), a note with typing not
 * saved yet, or one changed in the last {@link ASSIST_QUIET_MS}; and at most
 * {@link ASSIST_ITEMS_PER_ASK} in one ask.
 */

import { MORNING_BRIEF_FOLDER } from '../automations/morning-brief.ts';
import { namesNote } from '../automations/proposal-schema.ts';
import type { PossibleDuplicateTask } from '../gtd/task-similarity.ts';
import type { PersonCandidate } from '../people/person-match.ts';
import { MEETING_TYPE } from '../meetings/meeting-header.ts';
import { PROPOSAL_TYPE } from '../proposals/proposal.ts';
import type { VaultPath } from '../vault/vault-path.ts';
import { hasUnshownCharacters, type AssistItemAnswer, type AssistKind } from './assist-answer.ts';
import { assistSureness } from './assist-confidence.ts';
import { assistDuplicate, type AssistDuplicate } from './assist-duplicate.ts';
import { assistPeople, clashingAdd, OFF_LIST, type AssistPersonStep } from './assist-people.ts';
import type { InboxItem } from './inbox.ts';
import {
  assistHeld,
  heldWords,
  sameDay,
  samePerson,
  sameProject,
  type AssistHeld,
  type HeldField,
} from './assist-held.ts';

/** The most items one ask is about. */
export const ASSIST_ITEMS_PER_ASK = 10;

/** How long a note must have been left alone before it is asked about: it may still be being written. */
export const ASSIST_QUIET_MS = 10 * 60_000;

const PROPOSALS_FOLDER = 'Inbox/Proposals/';

/** A note in the vault an answer may name: a project or area to file under, or a person. */
export interface AssistTarget {
  readonly path: VaultPath;
  readonly title: string;
}

/** What the vault holds that an answer is checked against, read by the use-case, never by the model. */
export interface AssistFacts {
  /** `YYYY-MM-DD`, from the injected clock. */
  readonly today: string;
  /** The projects and areas an item can be filed under, as clarifying offers them. */
  readonly filingTargets: readonly AssistTarget[];
  /** The people an item can wait on, or name: those Claude is offered. */
  readonly people: readonly AssistTarget[];
  /** Everyone in People, the Archive's included, as matched by name and address (#906). */
  readonly directory: readonly PersonCandidate[];
  /** Names, folded, that a note of any type has as its title already: no new person takes one. */
  readonly takenTitles: ReadonlySet<string>;
  /** What each item asked about holds of its own (#906); an item missing here holds nothing. */
  readonly items: ReadonlyMap<VaultPath, AssistItemFacts>;
}

/** What one item holds that its duplicate and people are checked against, read on the press. */
export interface AssistItemFacts {
  /** The open tasks, not Inbox items, the title rule lists as ones it may copy, surest first. */
  readonly duplicates: readonly PossibleDuplicateTask[];
  /** Another Inbox item's title this one is the newer capture of, or cannot be told from; null for none. */
  readonly inboxTwin: string | null;
  /** Every address its text gives. */
  readonly addresses: readonly string[];
  /** What it lists under `people` already; null when nothing. */
  readonly listedPeople: HeldField | null;
  /** Every property written in its frontmatter, by lower-case key. */
  readonly written: ReadonlyMap<string, readonly string[]>;
  /** Its own words, title and body: what a person it names must be found in. */
  readonly text: string;
  /** Whether it has words beyond its title. */
  readonly hasBody: boolean;
}

const NO_ITEM_FACTS: AssistItemFacts = {
  duplicates: [],
  inboxTwin: null,
  addresses: [],
  listedPeople: null,
  written: new Map(),
  text: '',
  hasBody: false,
};

/** What would be done with one item. */
export type AssistStep =
  | {
      readonly kind: 'task';
      /** True when the item is not a task yet. */
      readonly makeTask: boolean;
      readonly project: AssistTarget | null;
      readonly due: string | null;
      readonly waitingOn: AssistTarget | null;
    }
  | { readonly kind: 'file'; readonly project: AssistTarget }
  /** It copies a task already in the vault, which the vault confirms and Claude agrees (#906). */
  | AssistDuplicate
  | { readonly kind: 'leave'; readonly because: string }
  | { readonly kind: 'ask'; readonly question: string };

/** One item and its step, with Claude's reason when Claude gave one. */
export interface AssistRow {
  readonly path: VaultPath;
  readonly title: string;
  readonly step: AssistStep;
  /** Claude's one sentence; null for an item it was not asked about. */
  readonly why: string | null;
  /** What would be done about the people it names: only beside a task or a note filed (#906). */
  readonly people: readonly AssistPersonStep[];
}

/** Why an item is not asked about as the Inbox lists it, before its file is read; null when it may be. */
export function assistListedSkip(item: InboxItem, unsaved: boolean): string | null {
  const type = item.type?.toLowerCase() ?? null;
  if (type === PROPOSAL_TYPE || item.path.startsWith(PROPOSALS_FOLDER)) {
    return 'A proposal: it is answered, not filed.';
  }
  if (item.path.startsWith(`${MORNING_BRIEF_FOLDER}/`)) return 'A brief: its rule files it.';
  if (type === MEETING_TYPE || item.importOutcome !== null) {
    return 'A meeting: “After a meeting” handles it.';
  }
  return unsaved ? 'It has typing not saved yet.' : null;
}

/** Why an item is not asked about once its file is read: changed too lately; null when it may be. */
export function assistQuietSkip({
  modified,
  now,
}: {
  modified: number;
  now: number;
}): string | null {
  // A time ahead of the clock is a note still settling too.
  return now - modified < ASSIST_QUIET_MS ? 'Changed in the last 10 minutes.' : null;
}

/** The items in view an ask considers, in their order: up to the {@link ASSIST_ITEMS_PER_ASK}th that may be asked about. */
export interface AssistBatch {
  /** Every item considered, with why it is skipped, or null for one to ask about. */
  readonly considered: readonly { readonly item: InboxItem; readonly skip: string | null }[];
  /** How many items after those wait unconsidered. */
  readonly notConsidered: number;
}

export function assistBatch(
  items: readonly InboxItem[],
  unsaved: (path: VaultPath) => boolean,
): AssistBatch {
  const considered: { item: InboxItem; skip: string | null }[] = [];
  let open = 0;
  for (const item of items) {
    if (open === ASSIST_ITEMS_PER_ASK) break;
    const skip = assistListedSkip(item, unsaved(item.path));
    if (skip === null) open += 1;
    considered.push({ item, skip });
  }
  return { considered, notConsidered: items.length - considered.length };
}

/**
 * The one step for `item`, from Claude's checked `answer` and what the vault
 * holds, and what would be done about the people it names. Any question —
 * about filing, a duplicate or a person — makes the whole item a question.
 */
export function assistPlan(
  item: InboxItem,
  answer: AssistItemAnswer,
  facts: AssistFacts,
): AssistRow {
  const row = (step: AssistStep, people: readonly AssistPersonStep[] = []): AssistRow => ({
    path: item.path,
    title: item.title,
    step,
    why: answer.why,
    people,
  });
  const step = filingStep(item, answer, facts);
  if (step.kind === 'ask') return row(step);
  if (answer.offList === true) return row(ask(OFF_LIST));
  const own = facts.items.get(item.path) ?? NO_ITEM_FACTS;
  const duplicate = assistDuplicate({
    answer,
    held: assistHeld(item),
    filing: 'project' in step ? (step.project?.path ?? null) : null,
    candidates: own.duplicates,
    inboxTwin: own.inboxTwin,
    listedPeople: own.listedPeople,
    hasBody: own.hasBody,
    written: own.written,
  });
  if (duplicate !== null || step.kind === 'leave') return row(duplicate ?? step);
  const people = assistPeople(answer.people, {
    offered: facts.people,
    directory: facts.directory,
    text: own.text,
    addresses: own.addresses,
    listed: own.listedPeople,
    takenTitles: facts.takenTitles,
  });
  return 'question' in people ? row(ask(people.question)) : row(step, people.steps);
}

/** What filing the item would be: a task, a note filed, left, or a question. */
function filingStep(item: InboxItem, answer: AssistItemAnswer, facts: AssistFacts): AssistStep {
  if (answer.unshowable === true) return ask(UNSHOWABLE);
  const question = questionOf(answer);
  if (question !== null) return ask(question);
  const projects = targetsNamed(answer.projects, facts.filingTargets);
  if (projects.unshowable) return ask(UNSHOWABLE);
  if (projects.unknown !== null) {
    return ask(`Claude named “${projects.unknown}”, which is not a project or area here.`);
  }
  if (projects.found.length > 1) {
    return ask(`Which one: ${projects.found.map((each) => `“${each.title}”`).join(' or ')}?`);
  }
  const project = projects.found[0] ?? null;
  const held = assistHeld(item);
  if (answer.kind === 'task') return taskStep({ item, answer, facts, project, held });
  // Only a note is filed as one: a task stays one unless the person says otherwise.
  if (item.task !== null) {
    return ask(`You made this a task; Claude thinks it is ${KIND_WORDS[answer.kind]}.`);
  }
  return fileStep(project, held.project, facts);
}

/**
 * The rows of one plan with no new person added twice: a person a row would
 * add whom an earlier row adds already — the same mailbox, or the same name
 * but for case, accents or spacing — makes the later row a question.
 */
export function withoutRepeatedAdds(rows: readonly AssistRow[]): AssistRow[] {
  const adding: { step: AssistPersonStep; title: string }[] = [];
  return rows.map((row) => {
    for (const step of row.people) {
      if (step.kind !== 'add') continue;
      const earlier = clashingAdd(
        step,
        adding.map((each) => each.step),
      );
      if (earlier === undefined) continue;
      const first = adding.find((each) => each.step === earlier)!;
      const question = `${step.name} would be added from ${first.title} already. Is this them?`;
      return { ...row, step: ask(question), people: [] };
    }
    for (const step of row.people) if (step.kind === 'add') adding.push({ step, title: row.title });
    return row;
  });
}

/** What an item Claude's answer cannot be shown for becomes: a question, with nothing of the answer in it. */
const UNSHOWABLE = 'Claude’s answer for this item could not be shown.';

/** Filing a note: under the one project named, unless it is filed already. */
function fileStep(
  project: AssistTarget | null,
  held: HeldField | null,
  facts: AssistFacts,
): AssistStep {
  if (project === null) return leave('Nowhere clear to file it.');
  if (held === null) return { kind: 'file', project };
  if (sameProject(held, project.path)) return leave('Already filed there.');
  return ask(differsWords(held, facts, project.title));
}

const ask = (question: string): AssistStep => ({ kind: 'ask', question });
const leave = (because: string): AssistStep => ({ kind: 'leave', because });

/** The question an answer leaves whatever the vault holds: unsure, junk, a person or a meeting; null for none. */
function questionOf(answer: AssistItemAnswer): string | null {
  if (answer.kind === 'junk') return 'Claude thinks this is junk. Archive it?';
  const sureness = assistSureness(answer.confidence);
  if (sureness === 'ask-blind') return 'Claude could not tell what this is.';
  if (sureness === 'ask-with-guess')
    return `Claude thinks this is ${KIND_WORDS[answer.kind]}, but is not sure.`;
  if (answer.kind === 'person') return 'Claude thinks this is about a person. Add them to People?';
  if (answer.kind === 'meeting')
    return 'Claude thinks this is a meeting. File it with your meetings?';
  return null;
}

const KIND_WORDS: Readonly<Record<AssistKind, string>> = {
  task: 'a task',
  note: 'a note',
  reference: 'reference',
  person: 'about a person',
  meeting: 'a meeting',
  junk: 'junk',
};

function taskStep({
  item,
  answer,
  facts,
  project,
  held,
}: {
  item: InboxItem;
  answer: AssistItemAnswer;
  facts: AssistFacts;
  project: AssistTarget | null;
  held: AssistHeld;
}): AssistStep {
  const type = item.type?.trim().toLowerCase() ?? null;
  if (item.task === null && type !== null && type !== PLAIN_NOTE_TYPE) {
    return ask(`This is a ${type} note; Claude thinks it is a task.`);
  }
  const dueProblem = dueQuestion(answer.due, facts.today);
  if (dueProblem !== null) return ask(dueProblem);
  const people = targetsNamed(answer.waitingOn === null ? [] : [answer.waitingOn], facts.people);
  if (people.unshowable) return ask(UNSHOWABLE);
  if (people.unknown !== null) {
    return ask(`Claude says it waits on “${people.unknown}”, who is not in People.`);
  }
  if (people.found.length > 1) return ask('Which person does it wait on?');
  const suggested = { project, due: answer.due, waitingOn: people.found[0] ?? null };
  const filled = filledIn(held, suggested, facts);
  if ('question' in filled) return ask(filled.question);
  const makeTask = item.task === null;
  if (!makeTask && filled.project === null && filled.due === null && filled.waitingOn === null) {
    return leave('Already a task, with nothing clear to add.');
  }
  return { kind: 'task', makeTask, ...filled };
}

/** A note's type when it says only that it is a note: the one type a task may be made from besides none. */
const PLAIN_NOTE_TYPE = 'note';

/**
 * The most a due date may lie ahead, in years, and still be planned: a date
 * further out is more likely a misreading than a deadline.
 */
export const ASSIST_DUE_HORIZON_YEARS = 2;

/** Why a due date is a question rather than a plan: passed, or past the horizon; null when it is neither. */
function dueQuestion(due: string | null, today: string): string | null {
  if (due === null) return null;
  if (due < today) return `Claude gave a due date that has passed (${due}).`;
  const horizon = `${Number(today.slice(0, 4)) + ASSIST_DUE_HORIZON_YEARS}${today.slice(4)}`;
  return due > horizon ? `Claude gave a due date more than two years away (${due}).` : null;
}

interface TaskFields {
  readonly project: AssistTarget | null;
  readonly due: string | null;
  readonly waitingOn: AssistTarget | null;
}

/**
 * What a suggestion adds to what the item already holds: only what is
 * empty. A field with anything written in it is never overwritten: a
 * suggestion that agrees adds nothing, one that differs is a question
 * showing both.
 */
function filledIn(
  held: AssistHeld,
  suggested: TaskFields,
  facts: AssistFacts,
): TaskFields | { question: string } {
  const { project, due, waitingOn } = suggested;
  if (project !== null && held.project !== null && !sameProject(held.project, project.path)) {
    return { question: differsWords(held.project, facts, project.title) };
  }
  if (due !== null && held.due !== null && !sameDay(held.due, due)) {
    return { question: `You set it due ${heldWords(held.due)}; Claude suggests ${due}.` };
  }
  if (waitingOn !== null && held.waitingOn !== null && !samePerson(held.waitingOn, waitingOn)) {
    return {
      question: `It waits on ${heldWords(held.waitingOn)}; Claude suggests ${waitingOn.title}.`,
    };
  }
  return {
    project: held.project === null ? project : null,
    due: held.due === null ? due : null,
    waitingOn: held.waitingOn === null ? waitingOn : null,
  };
}

/** The question when a set project differs from the one suggested: the vault's own names for both. */
function differsWords(held: HeldField, facts: AssistFacts, suggested: string): string {
  return `You filed this under ${heldWords(held, facts.filingTargets)}; Claude suggests ${suggested}.`;
}

/**
 * The vault notes `names` name, each found by its path or its title as a
 * link would be, and the first name that names none: null when all are real.
 * A name holding characters that cannot be shown must name a note exactly —
 * its path, or its title as the vault spells it — or the answer cannot be
 * shown at all (`unshowable`).
 */
function targetsNamed(
  names: readonly string[],
  targets: readonly AssistTarget[],
): { found: readonly AssistTarget[]; unknown: string | null; unshowable: boolean } {
  const found: AssistTarget[] = [];
  for (const name of names) {
    const exact = hasUnshownCharacters(name);
    const named = targets.filter((target) =>
      exact ? namesExactly(name, target) : namesNote(name, target.path),
    );
    if (named.length === 0) return { found, unknown: name, unshowable: exact };
    for (const target of named) if (!found.includes(target)) found.push(target);
  }
  return { found, unknown: null, unshowable: false };
}

function namesExactly(name: string, target: AssistTarget): boolean {
  return name === target.path || name === target.path.replace(/\.md$/, '') || name === target.title;
}
