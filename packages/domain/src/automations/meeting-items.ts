/**
 * What Claude pulls out of a meeting (P29-05, ADR-0028): the `meeting-items`
 * output. Each item is something somebody took on, something decided, or
 * something to chase, citing the one transcript turn it came from.
 *
 * The model says what and who in words; everything a proposal then does is
 * decided here. An item the vault's owner took on is a task in the Inbox; one
 * somebody else took on is a task Waiting on them; a decision is a Decision
 * note; a follow-up is an Inbox task tagged `follow-up`. Each joins the
 * meeting it cites (`tasks`, `decisions`) once accepted.
 *
 * An item whose `source_block` is not a turn of a meeting the model was shown
 * is left out and reported, and the rest are kept: a model cites a line that
 * is not there now and then, and one such item should not lose a meeting's
 * worth of the others. Anything else wrong with an item still refuses the
 * whole answer, as for every output.
 */

import { splitFrontmatter } from '../markdown/markdown-document.ts';
import { digestOf } from '../sources/merge.ts';
import { NEW_TASK_STATUS, TASK_KEYS, WAITING_STATUS } from '../gtd/gtd-status.ts';
import { wikiLinkTargetFor } from '../markdown/resolve-wikilink.ts';
import { readWikiLink } from '../markdown/wikilink-spans.ts';
import {
  MEETING_DECISIONS_KEY,
  MEETING_TASKS_KEY,
} from '../meetings/meeting-extraction-properties.ts';
import {
  meetingTranscriptOf,
  meetingTurnsOf,
  providerNextStepsOf,
} from '../meetings/meeting-turns.ts';
import type { TranscriptTurn } from '../meetings/transcript.ts';
import { PROPOSAL_CONFIDENCES, type ProposalConfidence } from '../proposals/proposal.ts';
import { TAGS_KEY } from '../tags/note-tags.ts';
import { noteTitle } from '../vault/vault-entry.ts';
import { truncated } from './answer-limits.ts';
import { ownerNotAGroup, sameName } from '../meeting-links/vault-owner.ts';
import { shownNotes, type AnsweredNote } from './answered-note.ts';
import { itemOwner, type ItemOwner, type OwnerDirectory } from './meeting-item-owner.ts';
import { projectChoiceData } from './meeting-project-choice.ts';
import { termDraft, termItemRefusal } from './meeting-term-items.ts';
import type {
  MeetingDecisionClaim,
  MeetingItemCap,
  MeetingItemClaim,
} from './meeting-item-apply.ts';
import {
  citedBlockProblem,
  isRecord,
  namesNote,
  type AnswerContext,
  type DroppedItem,
  type ItemReading,
  type PromptData,
  type ProposalCitation,
  type ProposalDraft,
  type ProposalSchema,
} from './proposal-schema.ts';

/** What a rule's `output:` calls it. */
export const MEETING_ITEMS_OUTPUT = 'meeting-items';

/** The tag a follow-up's task carries, so follow-ups can be listed apart from tasks. */
export const FOLLOW_UP_TAG = 'follow-up';

const ITEM_KINDS = ['task', 'waiting', 'decision', 'follow-up', 'term'] as const;
type ItemKind = (typeof ITEM_KINDS)[number];

/** An owner is a name, not a sentence. */
const MAX_OWNER_CHARACTERS = 120;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** A due date this far from the meeting is a slip of the model's, not a plan. */
const MAX_DUE_YEARS_FROM_MEETING = 5;
const DAY_MS = 86_400_000;

/**
 * How many turns before an item's cited turn count as the exchange it was
 * settled in (#226): an agreement answers a proposal a few turns up, and a
 * provider that splits one sentence into several turns spreads a request
 * over more than one. The owner taking part is a turn of theirs among these
 * or the cited turn itself.
 */
export const EXCHANGE_TURNS = 6;

interface MeetingItem {
  readonly kind: ItemKind;
  readonly title: string;
  /** Who took it on, as the answer wrote them; blank when it named nobody. */
  readonly owner: string;
  /** `YYYY-MM-DD`, when a date was said and it was a real one near the meeting. */
  readonly due: string | null;
  readonly sourceBlock: string;
  readonly confidence: ProposalConfidence;
  /** The model says the owner asked for it: what keeps a waiting-for of someone else's. */
  readonly askedByOwner: boolean;
  /** A term's words as the transcript has them (#19); blank for any other kind. */
  readonly heard: string;
}

const dropped = (problem: string): { ok: false; problem: string; drop: true } => ({
  ok: false,
  problem,
  drop: true,
});

/**
 * One item of the answer. What is wrong with an item alone leaves out that
 * item and is reported: the rest of a meeting's worth are not lost to one
 * bad owner. A due date that is no date is left off the item, which is kept
 * at one step less confidence, and says so.
 */
function readMeetingItem(value: unknown, context: AnswerContext): ItemReading<MeetingItem> {
  if (!isRecord(value)) return dropped('It is not an object.');
  const kind = ITEM_KINDS.find((known) => known === value['kind']);
  if (kind === undefined) return dropped(`Its kind is not one of ${ITEM_KINDS.join(', ')}.`);
  const { title, owner = '', due = null, source_block: sourceBlock } = value;
  const { asked_by_owner: askedByOwner = false, heard = '' } = value;
  if (typeof title !== 'string' || title.trim() === '') return dropped('It has no "title".');
  if (typeof heard !== 'string') return dropped('Its "heard" is not text.');
  if (kind === 'term' && heard.trim() === '') return dropped('It is a term with no "heard".');
  if (typeof askedByOwner !== 'boolean')
    return dropped('Its "asked_by_owner" is not true or false.');
  if (owner !== null && typeof owner !== 'string') return dropped('Its "owner" is not text.');
  if ((owner ?? '').length > MAX_OWNER_CHARACTERS) {
    return dropped(`Its "owner" is longer than a name: at most ${MAX_OWNER_CHARACTERS}.`);
  }
  if (typeof sourceBlock !== 'string') return dropped('It has no "source_block".');
  const confidence = PROPOSAL_CONFIDENCES.find((known) => known === value['confidence']);
  if (confidence === undefined) {
    return dropped(`Its confidence is not one of ${PROPOSAL_CONFIDENCES.join(', ')}.`);
  }
  const day = readDue(due, meetingDateOf(context));
  const item = { kind, title: title.trim(), owner: owner ?? '', sourceBlock, askedByOwner, heard };
  if (day.ok) return { ok: true, value: { ...item, due: day.value, confidence } };
  return {
    ok: true,
    value: { ...item, due: null, confidence: lowered(confidence) },
    adjusted: `${day.problem} so it has no due date, and one step less confidence.`,
  };
}

/** One step less sure. */
function lowered(confidence: ProposalConfidence): ProposalConfidence {
  const at = PROPOSAL_CONFIDENCES.indexOf(confidence);
  return PROPOSAL_CONFIDENCES[Math.min(PROPOSAL_CONFIDENCES.length - 1, at + 1)]!;
}

/** The date the meeting the run is about was held, when its note says. */
function meetingDateOf({ notes }: AnswerContext): string | null {
  const [only, ...others] = notes;
  return others.length === 0 ? (only?.meeting?.date ?? null) : null;
}

/** A due date as written: none, a real day near the meeting, or why it cannot be one. */
function readDue(
  value: unknown,
  meetingDate: string | null,
): { ok: true; value: string | null } | { ok: false; problem: string } {
  if (value === null || value === '') return { ok: true, value: null };
  const written = typeof value === 'string' ? value.trim() : '';
  const match = DATE.exec(written);
  const unreadable = (why: string) => ({ ok: false as const, problem: `Its "due" ${why}` });
  if (match === null) {
    return unreadable(
      `${quoted(typeof value === 'string' ? value : String(value))} is not a date written YYYY-MM-DD,`,
    );
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC reads year 0-99 as 19xx: a real day only when the same year comes back.
  const real =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  if (!real) return unreadable(`${quoted(written)} is not a day that exists,`);
  const near = nearMeeting(date.getTime(), meetingDate, year);
  return near
    ? { ok: true, value: match[0] }
    : unreadable(`${quoted(written)} is too far from the meeting,`);
}

function nearMeeting(due: number, meetingDate: string | null, year: number): boolean {
  const held = meetingDate === null ? null : DATE.exec(meetingDate);
  if (held === null) return year >= 2000 && year <= 2100;
  const meeting = Date.UTC(Number(held[1]), Number(held[2]) - 1, Number(held[3]));
  return Math.abs(due - meeting) <= MAX_DUE_YEARS_FROM_MEETING * 365.25 * DAY_MS;
}

/** The turn an item cites, in a meeting the model was shown — or why it cites none. */
type CitedTurn =
  | {
      readonly ok: true;
      readonly meeting: AnsweredNote;
      readonly turn: TranscriptTurn;
      /** The citation as a link the shared check reads: `[[Meeting#^t0004]]`. */
      readonly source: string;
    }
  | { readonly ok: false; readonly reason: string };

const BARE_ID = /^\^?([A-Za-z0-9-]+)$/;

/** What a `source_block` names: a turn's id, and the meeting when it was written as a link. */
function writtenCitation(sourceBlock: string): { id: string; target: string | null } | null {
  const written = sourceBlock.trim();
  const bare = BARE_ID.exec(written);
  if (bare !== null) return { id: bare[1]!, target: null };
  const link = readWikiLink(written);
  if (link === null || link.embed || !link.heading?.startsWith('#^')) return null;
  const id = link.heading.slice(2);
  return id === '' ? null : { id, target: link.target };
}

/**
 * The transcript turn an item's `source_block` is: an id (`t0004`) of a turn
 * of the one meeting this answer is about. Only a turn of the Transcript
 * counts: a block of the summary or of the provider's next steps is not what
 * was said.
 *
 * One meeting, never several: which meeting an accepted task is linked back
 * to follows from the turn it cites, so an answer about two meetings could
 * file one's task under the other — and two notes of one title could not be
 * told apart at all. A run asks about each meeting alone (`readsInParts`); an
 * answer checked against more than one note has every item left out.
 */
function citedTurn(item: MeetingItem, context: AnswerContext): CitedTurn {
  const cited = writtenCitation(item.sourceBlock);
  if (cited === null) {
    return unfound(`Its source_block ${quoted(item.sourceBlock)} is not the id of a turn.`);
  }
  const [meeting, ...others] = shownNotes(context.notes);
  if (others.length > 0) return unfound('This output reads one meeting at a time.');
  if (meeting?.meeting === undefined) return unfound('This run read no meeting to cite a turn of.');
  const from = noteTitle(meeting.path);
  if (cited.target !== null && !namesNote(cited.target, meeting.path)) {
    return unfound(`It cites ${quoted(cited.target)}, which is not the meeting it was taken from.`);
  }
  const turn = meetingTurnsOf(meeting.text).find((each) => each.blockId === cited.id);
  if (turn === undefined) {
    return unfound(
      `${from} has no transcript turn ^${truncated(cited.id, 40)} that Claude was shown.`,
    );
  }
  const source = `[[${linkTarget(meeting, context)}#^${cited.id}]]`;
  // The shared check reads it again, its own way (outside a code fence): what it would refuse is left out here.
  const problem = citedBlockProblem(source, context.notes);
  return problem === null ? { ok: true, meeting, turn, source } : unfound(problem);
}

const unfound = (reason: string): CitedTurn => ({ ok: false, reason });
const quoted = (text: string): string => JSON.stringify(truncated(text, 80));

/** What a link to the meeting is written as: spelt against the vault's notes when the run knows them. */
function linkTarget(meeting: AnsweredNote, { vault }: AnswerContext): string {
  return vault === undefined
    ? noteTitle(meeting.path)
    : wikiLinkTargetFor(meeting.path, vault.notePaths);
}

function droppedItem(item: MeetingItem, context: AnswerContext): DroppedItem | null {
  const cited = citedTurn(item, context);
  if (!cited.ok) return { title: item.title, reason: cited.reason };
  const refusal = item.kind === 'term' ? termItemRefusal(item, cited.turn, context) : null;
  return refusal === null ? null : { title: item.title, reason: refusal };
}

type FoundTurn = Extract<CitedTurn, { ok: true }>;

/** What an item concerns, as a proposal's identity holds it: lower-cased, one owner. */
function ownerKey(owner: ItemOwner): string {
  switch (owner.kind) {
    case 'self':
      return 'self';
    case 'person':
    case 'named':
      return owner.name.replace(/\s+/g, ' ').trim().toLowerCase();
    case 'ambiguous':
      return `?${owner.name.replace(/\s+/g, ' ').trim().toLowerCase()}`;
    case 'unknown':
      return '';
  }
}

function draftsOfItem(item: MeetingItem, context: AnswerContext): ProposalDraft[] {
  const cited = citedTurn(item, context);
  // An item that cites no turn was left out before this is asked.
  if (!cited.ok) return [];
  const from = noteTitle(cited.meeting.path);
  if (item.kind === 'term') return [termDraft({ item, source: cited.source, from })];
  const unnamed = cited.turn.speaker.kind === 'unknown';
  const join = meetingJoin(cited.meeting);
  const directory = directoryOf(cited, context);
  if (item.kind === 'decision') {
    const meetingDecision: MeetingDecisionClaim = {
      ownerTookPart: ownerTookPart(cited, directory),
    };
    return [
      {
        kind: 'decision',
        payload: {
          title: item.title,
          properties: { meeting: `[[${linkTarget(cited.meeting, context)}]]` },
        },
        source: cited.source,
        confidence: unnamed ? 'low' : item.confidence,
        why: `Decided in ${from}.${unnamed ? UNNAMED_SPEAKER_WHY : ''}${join.why}`,
        ...join.joins(MEETING_DECISIONS_KEY),
        meetingDecision,
      },
    ];
  }
  const due = item.due === null ? {} : { [TASK_KEYS.due]: item.due };
  const owned = ownedItem({ item, cited, context, directory });
  const meetingItem = claimOf(owned, item.askedByOwner && ownerTookPart(cited, directory));
  if (item.kind === 'follow-up') {
    return [
      {
        kind: 'follow-up',
        payload: {
          title: item.title,
          properties: { [TASK_KEYS.status]: NEW_TASK_STATUS, [TAGS_KEY]: [FOLLOW_UP_TAG], ...due },
        },
        source: cited.source,
        confidence: unnamed ? 'low' : item.confidence,
        why: `A follow-up from ${from}: yours to chase.${unnamed ? UNNAMED_SPEAKER_WHY : ''}${join.why}`,
        ...join.joins(MEETING_TASKS_KEY),
        meetingItem,
      },
    ];
  }
  const { owner } = owned;
  const task = taskOf({ ...owned, cited, directory });
  return [
    {
      kind: 'task',
      payload: { title: item.title, properties: { ...task.properties, ...due } },
      source: cited.source,
      confidence: lowestOf(item.confidence, task.ceiling),
      why: `${task.why}${join.why}`,
      distinguishedBy: ownerKey(owner),
      ...join.joins(MEETING_TASKS_KEY),
      meetingItem,
    },
  ];
}

/**
 * What decides whether an action item is made the owner's task: whose it is,
 * what caps it, and — for someone else's — whether the owner asked for it:
 * the model says so, and the owner spoke in the exchange it cites.
 */
function claimOf({ owner, caps }: OwnedItem, askedByOwner: boolean): MeetingItemClaim {
  const whose =
    owner.kind === 'self'
      ? 'self'
      : owner.kind === 'person' || owner.kind === 'named'
        ? 'other'
        : 'undecided';
  return { owner: whose, ownerKey: ownerKey(owner), caps, askedByOwner };
}

/** Who an item's owner, and a turn's speaker, may be found among: the meeting's attendees and speakers, and the vault's people and owner. */
function directoryOf(cited: FoundTurn, context: AnswerContext): OwnerDirectory {
  return {
    attendees: cited.meeting.meeting?.attendees ?? [],
    people: context.vault?.people ?? [],
    selfName: context.vault?.selfName ?? null,
    selfEmails: context.vault?.selfEmails ?? [],
    speakers: meetingTurnsOf(cited.meeting.text).map((turn) => turn.writtenSpeaker),
  };
}

/**
 * Whether the vault's owner spoke in the exchange an item cites: the cited
 * turn or one of the {@link EXCHANGE_TURNS} before it, by a speaker who is
 * them (one the provider did not name never is). A decision the owner took no part in, or a waiting-for they
 * never asked for, is not theirs to hear of (#226).
 */
function ownerTookPart(cited: FoundTurn, directory: OwnerDirectory): boolean {
  const turns = meetingTurnsOf(cited.meeting.text);
  const at = turns.findIndex((turn) => turn.blockId === cited.turn.blockId);
  return turns
    .slice(Math.max(0, at - EXCHANGE_TURNS), at + 1)
    .some((turn) => itemOwner(turn.writtenSpeaker, directory).kind === 'self');
}

const UNNAMED_SPEAKER_WHY = ' The turn it cites has no named speaker, so check it.';

/**
 * Whether what a proposal makes can join its meeting once accepted: only a
 * meeting the import let in can be found again by Accept. One written by hand
 * is still read, and its proposals are made without the link, and say so.
 */
function meetingJoin(meeting: AnsweredNote): {
  readonly why: string;
  readonly joins: (relation: string) => { readonly joinsMeeting?: string };
} {
  const imported = meeting.meeting?.identity !== null;
  return {
    why: imported
      ? ''
      : ' This meeting was not imported, so Accept makes the note without adding it to the meeting’s list.',
    joins: (relation) => (imported ? { joinsMeeting: relation } : {}),
  };
}

/** The least sure of two confidences. */
function lowestOf(left: ProposalConfidence, right: ProposalConfidence): ProposalConfidence {
  const order = PROPOSAL_CONFIDENCES;
  // The list runs from most sure to least.
  return order.indexOf(left) >= order.indexOf(right) ? left : right;
}

/** Whose an action item is, and what caps it. */
interface OwnedItem {
  readonly owner: ItemOwner;
  readonly caps: readonly MeetingItemCap[];
  readonly context: AnswerContext;
}

/** Whose an item is, from the owner its answer wrote and the turn it cites. */
function ownedItem({
  item,
  cited,
  context,
  directory,
}: {
  item: MeetingItem;
  cited: FoundTurn;
  context: AnswerContext;
  directory: OwnerDirectory;
}): OwnedItem {
  const owner = itemOwner(item.owner, directory);
  return { owner, caps: capsOf({ owner, item, turn: cited.turn, directory }), context };
}

/**
 * What makes whose an item is a reading rather than a fact (ADR-0036): the
 * cited turn has no named speaker, or was spoken by someone it does not
 * concern ({@link spokenByAnother}); the owner is "we" or named with others;
 * the owner's own item was called a waiting-for. Whose it is cannot be
 * doubted further when nobody, or several people, could be named.
 */
function capsOf({
  owner,
  item,
  turn,
  directory,
}: {
  owner: ItemOwner;
  item: MeetingItem;
  turn: TranscriptTurn;
  directory: OwnerDirectory;
}): MeetingItemCap[] {
  if (owner.kind === 'unknown' || owner.kind === 'ambiguous') return [];
  const unnamed = turn.speaker.kind === 'unknown';
  const self = owner.kind === 'self' ? owner : null;
  const caps: (MeetingItemCap | false | undefined)[] = [
    unnamed && 'unnamed-speaker',
    !unnamed && spokenByAnother({ owner, turn, directory }) && 'spoken-by-another',
    self?.shared,
    self !== null && item.kind === 'waiting' && 'mixed-kind',
  ];
  return caps.filter((cap): cap is MeetingItemCap => typeof cap === 'string');
}

/** A task as its owner makes it: where it starts, who it waits on, and what the card says of both. */
interface OwnedTask {
  readonly properties: Readonly<Record<string, unknown>>;
  readonly why: string;
  /** The most sure the card may be: low when whose it is rests on a guess, whatever the answer said. */
  readonly ceiling: ProposalConfidence;
}

const SURE: ProposalConfidence = 'high';
const GUESS: ProposalConfidence = 'low';
/** The most sure the owner's item they share may be: enough to reach the review, never a task. */
const SHARED: ProposalConfidence = 'medium';

/**
 * The task an action item makes, by who took it on (the mine / waiting-for
 * split). The owner's own is an Inbox task. Anyone else's is Waiting on them:
 * linked when the vault has their Person note, and otherwise their name as
 * text, said so. With nobody named, or a name that could be several people or
 * is a group, it is an Inbox task with an empty "waiting_on" to fill in, at
 * low confidence. A name nobody in the meeting or the vault has, and a cited
 * turn with no named speaker, make whose it is a guess: low confidence too. A
 * cited turn spoken by a third person makes it medium at most (see
 * {@link spokenByAnother}), and so does the owner's item they share — named
 * with others, called a waiting-for, or "we" in an exchange the owner spoke
 * in — so it reaches the meeting's review (ADR-0036 amendment, #226). "We"
 * where the owner said nothing is a guess.
 */
function taskOf({
  owner,
  caps,
  cited,
  context,
  directory,
}: OwnedItem & { cited: FoundTurn; directory: OwnerDirectory }): OwnedTask {
  const from = noteTitle(cited.meeting.path);
  if (owner.kind === 'unknown' || owner.kind === 'ambiguous') {
    return {
      properties: { [TASK_KEYS.status]: NEW_TASK_STATUS, [TASK_KEYS.waitingOn]: '' },
      why: `${undecidedOwner(owner)} Edit it to say who it waits on — set status to ${WAITING_STATUS} and waiting_on to their name — or accept it as yours.`,
      ceiling: GUESS,
    };
  }
  const guessed = caps.includes('unnamed-speaker');
  const another = caps.includes('spoken-by-another');
  const spoken = guessed
    ? ' The turn it cites has no named speaker, so whose it is is a guess.'
    : another
      ? ` ${cited.turn.writtenSpeaker} spoke the turn it cites, so check it is meant for ${owner.kind === 'self' ? 'you' : owner.name}.`
      : '';
  const ceiling = guessed ? GUESS : another ? 'medium' : SURE;
  if (owner.kind === 'self') {
    const mixed = caps.includes('mixed-kind');
    const doubt = mixed
      ? ' Claude called it a waiting-for but named you, so check whose it is.'
      : '';
    const shared = mixed || owner.doubt !== undefined;
    const weWithoutTheOwner = owner.shared === 'we' && !ownerTookPart(cited, directory);
    return {
      properties: { [TASK_KEYS.status]: NEW_TASK_STATUS },
      why: `Yours, from ${from}.${doubt}${owner.doubt === undefined ? '' : ` ${owner.doubt}`}${spoken}`,
      ceiling: !shared ? ceiling : lowestOf(ceiling, weWithoutTheOwner ? GUESS : SHARED),
    };
  }
  const strange = owner.kind === 'named' && !owner.inMeeting;
  return {
    properties: {
      [TASK_KEYS.status]: WAITING_STATUS,
      [TASK_KEYS.waitingOn]: waitingOn(owner, context),
    },
    why: `${owner.name} took this on in ${from}, so it waits on them.${unlinked(owner)}${spoken}`,
    ceiling: strange ? GUESS : ceiling,
  };
}

/** What the card says when whose it is cannot be told. */
function undecidedOwner(owner: Extract<ItemOwner, { kind: 'unknown' | 'ambiguous' }>): string {
  if (owner.kind === 'unknown') return 'Claude could not tell whose this is.';
  const people = owner.candidates.join(' or ');
  return owner.candidates.length > 1 && owner.name !== people && !owner.name.includes(' and ')
    ? `Claude wrote ${JSON.stringify(owner.name)}, which could be ${people}.`
    : `Claude named more than one person (${owner.candidates.join(', ')}), and an item has one owner.`;
}

/**
 * Whether the turn an item cites was spoken by a named person it does not
 * concern: someone other than the task's owner, and not the vault's owner
 * (who may be handing a task out). They may be asking, or speaking of a third
 * person, so the card is medium at most. A turn the vault's owner spoke, or
 * the task's own owner, raises no doubt.
 */
function spokenByAnother({
  owner,
  turn,
  directory,
}: {
  owner: Extract<ItemOwner, { kind: 'self' | 'person' | 'named' }>;
  turn: TranscriptTurn;
  directory: OwnerDirectory;
}): boolean {
  if (turn.speaker.kind !== 'named') return false;
  const speaker = turn.speaker.name;
  const speakerIsSelf = itemOwner(speaker, directory).kind === 'self';
  if (owner.kind === 'self') return !speakerIsSelf;
  if (speakerIsSelf) return false;
  const first = (name: string) => name.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return !(sameName(speaker, owner.name) || first(speaker) === first(owner.name));
}

/** Who a task waits on, as its `waiting_on` holds them: a link to their note, or their name. */
function waitingOn(
  owner: Extract<ItemOwner, { kind: 'person' | 'named' }>,
  context: AnswerContext,
) {
  if (owner.kind === 'named') return owner.name;
  return `[[${wikiLinkTargetFor(owner.person.path, context.vault?.notePaths ?? [])}]]`;
}

/** What the card says when the owner is a name with no Person note to link. */
function unlinked(owner: Extract<ItemOwner, { kind: 'person' | 'named' }>): string {
  if (owner.kind === 'person') return '';
  return owner.inMeeting
    ? ` There is no Person note for ${owner.name} yet, so waiting_on holds the name as text.`
    : ` ${owner.name} is not listed in the meeting and has no Person note, so waiting_on holds the name as text: check it.`;
}

/** The most of the vocabulary a prompt carries: spellings, not a document. */
const MAX_TERMS_SHOWN = 300;

/**
 * What the model is told beside a meeting, as data: who its owner and
 * attendees are, the provider's own next steps — hints, each to be found in a
 * turn or left out — and the spellings the Terms page keeps.
 */
function meetingData(context: AnswerContext): PromptData[] {
  const meetings = context.notes.filter((note) => note.meeting !== undefined);
  if (meetings.length === 0) return [];
  const terms = (context.vault?.terms ?? []).slice(0, MAX_TERMS_SHOWN);
  const hints = meetings.flatMap((note) => hintLines(note));
  return [
    {
      about: 'who was in each meeting',
      text: meetings.map((note) => peopleLines(note, context)).join('\n\n'),
    },
    ...(hints.length > 0
      ? [{ about: 'the provider’s own next steps: hints, never a source', text: hints.join('\n') }]
      : []),
    ...(terms.length > 0
      ? [{ about: 'the right spellings of names and terms', text: terms.join('\n') }]
      : []),
    ...projectChoiceData({
      notes: context.notes,
      options: context.vault?.projects ?? [],
      ...(context.vault?.projectTies !== undefined && { ties: context.vault.projectTies }),
    }),
  ];
}

function peopleLines(note: AnsweredNote, { vault }: AnswerContext): string {
  const self = vault?.selfName ?? null;
  const directory = {
    attendees: [],
    people: vault?.people ?? [],
    selfName: self,
    selfEmails: vault?.selfEmails ?? [],
    speakers: [],
  };
  // An attendee at one of the owner's addresses is them, whatever a group rule made of it.
  const listed = ownerNotAGroup(note.meeting?.attendees ?? [], directory.selfEmails);
  const attendees = listed.map((attendee) => {
    if (attendee.group) return `- ${attendee.name}: a group address, not a person`;
    const owner = itemOwner(attendee.name, { ...directory, attendees: [attendee] });
    return `- ${attendee.name}${owner.kind === 'self' ? ': the vault’s owner' : ''}`;
  });
  return [
    `Meeting: ${noteTitle(note.path)}`,
    `The vault’s owner, written “You” in the transcript: ${self ?? 'not named in their profile'}`,
    attendees.length > 0 ? 'Attendees:' : 'Attendees: none listed',
    ...attendees,
  ].join('\n');
}

function hintLines(note: AnsweredNote): string[] {
  const steps = providerNextStepsOf(note.text);
  if (steps.length === 0) return [];
  return [
    `Meeting: ${noteTitle(note.path)}`,
    ...steps.map(({ owner, text }) => `- ${owner === null ? 'nobody named' : owner}: ${text}`),
  ];
}

export const MEETING_ITEMS: ProposalSchema<MeetingItem> = {
  name: MEETING_ITEMS_OUTPUT,
  key: 'items',
  itemShape:
    `{ "kind": one of ${ITEM_KINDS.join(', ')}; "title": what is to be done, or what was decided, in a few words; ` +
    '"owner": who took it on, named as the attendees are — "You" for the vault’s owner, "" when nobody can be named; ' +
    '"due": optional, a date as YYYY-MM-DD, only when one was said; "source_block": the turn it came from; ' +
    '"confidence": high, medium or low; "asked_by_owner": optional, true only for a waiting item the vault’s owner asked that person for in the meeting; ' +
    '"heard": only for a term, the words exactly as the turn has them }. ' +
    `A "term" item is a name, product or piece of jargon the transcript seems to have misheard: "title" is its right spelling, "heard" the transcript's words, "owner" "". ` +
    'Suggest one only when the turn plainly garbles a name, never for everyday words or a spelling the vocabulary already has.',
  itemKeys: [
    'kind',
    'title',
    'owner',
    'due',
    'source_block',
    'confidence',
    'asked_by_owner',
    'heard',
  ],
  citation:
    '"source_block" is the id at the end of the one transcript turn the item came from, as written there without its ^: "t0004". ' +
    'Only a turn of the Transcript you were shown counts — never the summary, the notes or the provider’s next steps. ' +
    'An item that cites anything else is left out.',
  meetingRelations: [MEETING_TASKS_KEY, MEETING_DECISIONS_KEY],
  readItem: readMeetingItem,
  sharedAcrossRules: true,
  handledKeyOf: wordsKeyOf,
  dropsUnreadable: true,
  positionOf: turnPosition,
  dropped: droppedItem,
  draftsOf: draftsOfItem,
  readsVault: true,
  readsInParts: true,
  dataFor: meetingData,
  choosesProject: true,
};

/** Where in the meeting's transcript a cited turn falls: the order the proposals are taken in. */
function turnPosition(cites: ProposalCitation, { notes }: AnswerContext): number {
  const note = notes.find((each) => each.path === cites.note);
  const at = meetingTurnsOf(note?.text ?? '').findIndex((turn) => turn.blockId === cites.block);
  return at === -1 ? Number.MAX_SAFE_INTEGER : at;
}

/**
 * What a meeting is, to a rule that has answered it: what was said, its
 * transcript (ADR-0036, "The ledger's key changes"). Accepting a proposal
 * writes the meeting's `tasks` or `decisions`, and the person edits its
 * Summary and Notes; none of that is something said in the meeting, so none
 * of it makes the meeting new. A transcript corrected is new words. A meeting
 * with no Transcript section is known by its whole body, as before.
 */
function wordsKeyOf({ text, meeting }: Pick<AnsweredNote, 'text' | 'meeting'>): string | null {
  const identity = meeting?.identity;
  // Keys match across paths: only a meeting the import vouches for is unique enough to name.
  if (identity === null || identity === undefined) return null;
  const named = `meeting:${identity.provider}:${identity.externalId}`;
  const transcript = meetingTranscriptOf(text);
  return transcript === null
    ? `${named}:body:${digestOf(splitFrontmatter(text).body)}`
    : `${named}:transcript:${digestOf(transcript)}`;
}
