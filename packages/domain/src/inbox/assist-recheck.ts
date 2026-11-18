/**
 * Whether a row Inbox assist planned may still be applied (#909), decided
 * again for that one item alone, from the notes as they are now and the
 * vault as it is now, with no model.
 *
 * One item's text can steer the answer Claude gave for another in the same
 * ask (#899, rule 4), so nothing is applied on the strength of the batch's
 * answer as it stands. Each change applied is one this check justifies from
 * the item's own words and the vault: Claude's answer is trusted for no more
 * than its choice among options the domain computed (what the item is, which
 * of the vault's projects, which task of those the title rule listed).
 *
 * It asks, and nothing is written, when:
 *
 * - the item is gone, or it or the kept task has typing not saved, or
 *   changed in the last {@link ASSIST_QUIET_MS};
 * - a read was cut short, or a frontmatter block cannot be read;
 * - a field the row would fill is written now;
 * - for a duplicate: the kept task is no longer open, it was made after this
 *   copy, the two differ now, or this copy holds anything the kept task lacks;
 * - for a person: someone in People (the Archive included) is them or may be
 *   now, a note has their name, or the item's text no longer names them;
 * - a person, or the due date, is found only in quoted or forwarded text;
 * - the due date is not written in the item's own words;
 * - the plan made again, for this item alone, is not the plan shown;
 * - the item or the kept task says anything other than at the preview.
 */

import { NEW_TASK_STATUS, TASK_KEYS } from '../gtd/gtd-status.ts';
import type { TaskCandidate } from '../gtd/task-similarity.ts';
import { splitFrontmatter } from '../markdown/markdown-document.ts';
import {
  addressesIn,
  foldedPersonName,
  hasMailbox,
  mailboxKey,
  mentionsName,
  nameWordCount,
  namesOf,
  personMatch,
  type PersonCandidate,
} from '../people/person-match.ts';
import { digestOf } from '../sources/merge.ts';
import type { VaultPath } from '../vault/vault-path.ts';
import type { AssistItemAnswer } from './assist-answer.ts';
import { assistApplyStep, assistStepKeys, type AssistApplyStep } from './assist-apply.ts';
import type { HeldField } from './assist-held.ts';
import { assistItemFacts } from './assist-item-facts.ts';
import { assistOwnWords } from './assist-own-words.ts';
import { ASSIST_QUIET_MS, assistPlan, type AssistFacts, type AssistRow } from './assist-plan.ts';
import { isInInbox, type InboxItem } from './inbox.ts';

/** What the preview saw of one item it planned, kept until the row is applied. */
export interface AssistEvidence {
  /** The item as the Inbox listed it. */
  readonly item: InboxItem;
  /** Claude's checked answer for it. */
  readonly answer: AssistItemAnswer;
  /** {@link digestOf} its whole text, as the preview read it. */
  readonly digest: string;
  /** A planned duplicate's kept task, as the preview read it; null for any other row. */
  readonly kept: { readonly path: VaultPath; readonly digest: string } | null;
}

/** A note's frontmatter as read now; null when its block cannot be read. */
export type AssistReadProperties = {
  /** Every property written, by lower-case key. */
  readonly written: ReadonlyMap<string, readonly string[]>;
  /** What it lists under `people`; null when nothing. */
  readonly listedPeople: HeldField | null;
} | null;

/** A note as read at the press of Apply. */
export interface AssistNoteNow {
  readonly text: string;
  readonly modified: number;
  /** Whether a pane holds typing in it not saved yet. */
  readonly unsaved: boolean;
  readonly properties: AssistReadProperties;
}

export interface AssistRecheckInput {
  readonly row: AssistRow;
  readonly evidence: AssistEvidence;
  /** The item now; null when it is no longer there. */
  readonly item: AssistNoteNow | null;
  /** A duplicate's kept task now, and as the open tasks list it (null: not open); null for none read. */
  readonly kept: (AssistNoteNow & { readonly task: TaskCandidate | null }) | null;
  /** The vault now: what the plan is made again against. */
  readonly vault: Omit<AssistFacts, 'items'>;
  /** The open tasks now, for the duplicates the item may copy. */
  readonly tasks: readonly TaskCandidate[];
  /** True when any read behind these facts was cut short. */
  readonly cut: boolean;
  /** The clock's instant, in milliseconds. */
  readonly now: number;
}

/** Why a row asks at apply time, by the rule that stopped it. */
export type AssistApplyAsk =
  | 'not-appliable'
  | 'gone'
  | 'unsaved'
  | 'recent'
  | 'read-cut'
  | 'unreadable'
  | 'field-written'
  | 'kept-not-open'
  | 'not-in-inbox'
  | 'kept-newer'
  | 'kept-differs'
  | 'newer-holds'
  | 'person-exists'
  | 'title-taken'
  | 'evidence-gone'
  | 'quoted-only'
  | 'due-unconfirmed'
  | 'plan-changed'
  | 'item-changed'
  | 'kept-changed';

export type AssistRecheck =
  | { readonly kind: 'apply'; readonly step: AssistApplyStep }
  | { readonly kind: 'ask'; readonly ask: AssistApplyAsk; readonly words: string };

type Asked = Extract<AssistRecheck, { kind: 'ask' }>;
const ask = (code: AssistApplyAsk, words: string): Asked => ({ kind: 'ask', ask: code, words });

/** Whether `input.row` may be applied now, and how; or the first reason it asks. */
export function assistRecheck(input: AssistRecheckInput): AssistRecheck {
  const step = assistApplyStep(input.row);
  if (step === null) return ask('not-appliable', 'This row is not one that is applied.');
  const asked =
    notesSettled(input, step) ??
    fieldsEmpty(input, step) ??
    keptStillOlder(input, step) ??
    peopleConfirmed(input, step) ??
    dueConfirmed(input, step) ??
    samePlan(input, step) ??
    unchanged(input, step);
  return asked ?? { kind: 'apply', step };
}

/** The notes as they are: there, saved, left alone a while, read whole. */
function notesSettled({ item, kept, cut, now }: AssistRecheckInput, step: AssistApplyStep) {
  if (item === null) return ask('gone', 'It is no longer there.');
  const notes = step.duplicateOf === null ? [item] : [item, kept];
  for (const note of notes) {
    if (note === null) return ask('kept-not-open', keptGone(step));
    if (note.unsaved) return ask('unsaved', 'It has typing not saved yet.');
    // A time ahead of the clock is a note still settling too.
    if (now - note.modified < ASSIST_QUIET_MS)
      return ask('recent', 'Changed in the last 10 minutes.');
    if (note.properties === null) return ask('unreadable', 'Its frontmatter could not be read.');
  }
  return cut ? ask('read-cut', 'The vault could not be read whole just now.') : null;
}

const keptGone = (step: AssistApplyStep) =>
  `${step.duplicateOf?.title ?? 'The kept task'} is no longer an open task.`;

/** Every field the row fills still empty: nothing written is written over. */
function fieldsEmpty({ item }: AssistRecheckInput, step: AssistApplyStep): Asked | null {
  const { written, listedPeople } = item!.properties!;
  for (const key of assistStepKeys(step)) {
    if (written.has(key) || (key === 'people' && listedPeople !== null)) {
      return ask('field-written', `Its “${key}” is set now, so nothing was written over it.`);
    }
  }
  return null;
}

/**
 * The kept task is older than the copy archived, as far as either says when
 * it was made: one made after it asks. Neither's file time ever decides; an
 * item that says nothing is the copy because it is the one in the Inbox.
 */
function keptStillOlder(input: AssistRecheckInput, step: AssistApplyStep) {
  const { item, kept } = input;
  if (step.duplicateOf === null) return null;
  if (kept!.task === null) return ask('kept-not-open', keptGone(step));
  const status = item!.properties!.written.get(TASK_KEYS.status)?.[0] ?? null;
  if (!isInInbox(input.row.path) && status !== NEW_TASK_STATUS) {
    return ask(
      'not-in-inbox',
      'It is no longer an item in the Inbox, so it is not archived as a copy.',
    );
  }
  const mine = createdOf(item!.properties!.written);
  const theirs = createdOf(kept!.properties!.written);
  if (
    mine === 'unread' ||
    theirs === 'unread' ||
    (mine !== null && theirs !== null && theirs > mine)
  ) {
    return ask('kept-newer', `${step.duplicateOf.title} may be the newer copy. Which one is kept?`);
  }
  return null;
}

const CREATED = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$/u;

/** When a note says it was made, comparable as text; null for nothing written, `unread` for something that is no time. */
function createdOf(written: ReadonlyMap<string, readonly string[]>): string | null | 'unread' {
  const values = written.get('created');
  if (values === undefined) return null;
  const [value] = values;
  if (values.length !== 1 || value === undefined || !CREATED.test(value.trim())) return 'unread';
  // A day alone is its midnight, so a day and a time on it compare.
  const time = value.trim().replace(' ', 'T');
  return time.length === 10 ? `${time}T00:00:00` : time.padEnd(19, ':00').slice(0, 19);
}

/** What the item's text holds, whole and in its own words alone. */
interface Texts {
  readonly whole: { readonly text: string; readonly addresses: readonly string[] };
  readonly own: { readonly text: string; readonly addresses: readonly string[] };
}

function textsOf(input: AssistRecheckInput): Texts {
  const { body } = splitFrontmatter(input.item!.text);
  const own = assistOwnWords(body);
  const title = input.evidence.item.title;
  return {
    whole: { text: `${title}\n${body}`, addresses: addressesIn(body) },
    own: { text: `${title}\n${own}`, addresses: addressesIn(own) },
  };
}

/** Each person still confirmed by the vault and the item's own words. */
function peopleConfirmed(input: AssistRecheckInput, step: AssistApplyStep): Asked | null {
  const { directory, takenTitles } = input.vault;
  for (const person of step.adds) {
    const match = personMatch({ name: person.name, email: person.email, people: directory });
    if (match.kind !== 'none')
      return ask('person-exists', `${person.name} may be in People now. Is this them?`);
    if (takenTitles.has(foldedPersonName(person.name))) {
      return ask('title-taken', `A note is called ${person.name} already. Is this them?`);
    }
  }
  const texts = textsOf(input);
  const named = (where: Texts['whole']) => (person: Named) => namedIn(where, person, directory);
  const people: Named[] = [
    ...step.links.map((target) => ({
      kind: 'link' as const,
      path: target.path,
      name: target.title,
    })),
    ...step.adds.map((added) => ({ kind: 'add' as const, ...added })),
  ];
  const missing = people.find((person) => !named(texts.whole)(person));
  if (missing !== undefined)
    return ask('evidence-gone', `The item no longer names ${missing.name}.`);
  const quoted = people.find((person) => !named(texts.own)(person));
  if (quoted !== undefined) {
    return ask('quoted-only', `Only quoted or forwarded text names ${quoted.name}. Is this them?`);
  }
  return null;
}

type Named =
  | { readonly kind: 'link'; readonly path: VaultPath; readonly name: string }
  | { readonly kind: 'add'; readonly name: string; readonly email: string };

/**
 * Whether the text names a person as linking or adding them needs: someone in
 * People by an address of theirs it holds, or their full name (two words or
 * more); someone new by their full name and the very address they are added with.
 */
function namedIn(
  where: Texts['whole'],
  person: Named,
  directory: readonly PersonCandidate[],
): boolean {
  if (person.kind === 'add') {
    const mailbox = mailboxKey(person.email);
    return (
      mentionsName(where.text, person.name) &&
      where.addresses.some((address) => mailboxKey(address) === mailbox)
    );
  }
  const known = directory.find((each) => each.path === person.path);
  const candidate = known ?? { path: person.path, name: person.name, emails: [], aliases: [] };
  if (where.addresses.some((address) => hasMailbox(candidate, address))) return true;
  return namesOf(candidate).some(
    (name) => nameWordCount(name) >= 2 && mentionsName(where.text, name),
  );
}

/**
 * The due date is written, `YYYY-MM-DD`, in the item's own words: a date read
 * from prose ("before December") is Claude's, and DFAI has no reader of its
 * own for one, so it is not applied.
 */
function dueConfirmed(input: AssistRecheckInput, step: AssistApplyStep): Asked | null {
  const due = step.fill?.due ?? null;
  if (due === null) return null;
  if (!isRealDay(due) || due < input.vault.today) {
    return ask('due-unconfirmed', `${due} is no day still ahead. Set the date by hand?`);
  }
  const texts = textsOf(input);
  if (!saysDay(texts.whole.text, due)) {
    return ask('due-unconfirmed', `The item does not say ${due} itself. Set the date by hand?`);
  }
  if (!saysDay(texts.own.text, due)) {
    return ask('quoted-only', `Only quoted or forwarded text says ${due}. Set the date by hand?`);
  }
  return null;
}

/** Whether `day`, written `YYYY-MM-DD`, is a day of the calendar: 2026-02-30 is not. */
function isRealDay(day: string): boolean {
  const at = Date.UTC(
    Number(day.slice(0, 4)),
    Number(day.slice(5, 7)) - 1,
    Number(day.slice(8, 10)),
  );
  return /^\d{4}-\d{2}-\d{2}$/u.test(day) && new Date(at).toISOString().slice(0, 10) === day;
}

/** Brackets and quotes a day may stand inside in prose, and the punctuation that may follow it. */
const OPENING = /^[("'“‘]+/u;
const CLOSING = /[)"'”’.,;:!?]+$/u;

/**
 * Whether the text says `day` as a word of its own (#911): not inside a URL, a
 * path, a link or a longer run of digits, letters, slashes or dashes. Only
 * brackets, quotes and the punctuation ending a clause may stand around it.
 */
function saysDay(text: string, day: string): boolean {
  return text.split(/\s+/u).some((word) => word.replace(OPENING, '').replace(CLOSING, '') === day);
}

/**
 * The plan made again for this item alone, from the vault now, is the plan
 * shown — once from the item's whole text, once from its own words alone. A
 * duplicate made again must also find this copy holding nothing the kept task
 * lacks.
 */
function samePlan(input: AssistRecheckInput, step: AssistApplyStep): Asked | null {
  const whole = planAgain(input, input.item!.text);
  if (step.duplicateOf !== null) {
    if (whole.step.kind !== 'duplicate' || whole.step.of.path !== step.duplicateOf.path) {
      const why = whole.step.kind === 'ask' ? ` ${whole.step.question}` : '';
      return ask('kept-differs', `It and ${step.duplicateOf.title} differ now.${why}`);
    }
    if (whole.step.newerHolds.length > 0) {
      const holds = whole.step.newerHolds.join(', ');
      return ask(
        'newer-holds',
        `This copy holds what ${step.duplicateOf.title} lacks (${holds}). Archive it anyway?`,
      );
    }
  }
  if (!samePlanned(whole, input.row)) return ask('plan-changed', changedWords(whole));
  const { frontmatter, body } = splitFrontmatter(input.item!.text);
  const own = planAgain(input, `${frontmatter ?? ''}${assistOwnWords(body)}`);
  if (!samePlanned(own, input.row) && step.duplicateOf === null) {
    return ask(
      'quoted-only',
      'What it would do rests on quoted or forwarded text. Check it by hand.',
    );
  }
  return null;
}

/** The plan for the item alone, from `text` as its file's, against the vault now. */
function planAgain(input: AssistRecheckInput, text: string): AssistRow {
  const { item, evidence } = input;
  const asked = {
    item: evidence.item,
    text,
    modified: item!.modified,
    listedPeople: item!.properties!.listedPeople,
    written: item!.properties!.written,
  };
  const items = assistItemFacts({ asked: [asked], tasks: input.tasks });
  return assistPlan(evidence.item, evidence.answer, { ...input.vault, items });
}

/** Whether two rows plan the same: the same step and the same people, a duplicate's holdings aside. */
function samePlanned(left: AssistRow, right: AssistRow): boolean {
  const shape = (row: AssistRow) =>
    JSON.stringify({
      step: row.step.kind === 'duplicate' ? { kind: 'duplicate', of: row.step.of.path } : row.step,
      people: row.people,
    });
  return shape(left) === shape(right);
}

function changedWords(row: AssistRow): string {
  if (row.step.kind === 'ask') return `It would be a question now: ${row.step.question}`;
  if (row.step.kind === 'leave') return `It would be left now: ${row.step.because}`;
  return 'What it would do has changed since the preview. Suggest again to see it.';
}

/** The item, and the kept task, say exactly what they said at the preview. */
function unchanged({ item, kept, evidence }: AssistRecheckInput, step: AssistApplyStep) {
  if (digestOf(item!.text) !== evidence.digest) {
    return ask('item-changed', 'It changed since the preview. Suggest again to see it.');
  }
  if (step.duplicateOf === null) return null;
  if (
    evidence.kept === null ||
    evidence.kept.path !== step.duplicateOf.path ||
    digestOf(kept!.text) !== evidence.kept.digest
  ) {
    return ask('kept-changed', `${step.duplicateOf.title} changed since the preview.`);
  }
  return null;
}
