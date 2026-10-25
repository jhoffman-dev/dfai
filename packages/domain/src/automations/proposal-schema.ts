/**
 * What a Claude step's answer may propose (P29-03, ADR-0028), and the one
 * place every kind of answer is checked.
 *
 * A rule's `output:` names a proposal schema. Each schema says what JSON the
 * model is to answer with, how one item of it is read, and what proposal an
 * item makes. Every proposal any schema makes is then held to the same rules
 * here: a payload Accept could write, a confidence, and a source citing a
 * block of a note the run was about. No schema can skip them, so a new one —
 * a meeting's action items (P29-05) — adds its own reading and nothing less.
 *
 * A proposal makes a new note and edits none, with one exception a schema
 * has to ask for by name: the note it makes may join a relation of the
 * meeting it cites ({@link ProposalSchema.meetingRelations}), so a task taken
 * from a meeting is linked from that meeting once accepted. Which meeting is
 * never the model's to say: it is the note the draft cites, and only when the
 * run itself read it as a meeting the import let in.
 *
 * An answer that does not read is refused whole: one bad item and nothing is
 * written. A schema may name the one kind of item it drops instead
 * ({@link ProposalSchema.dropped}); what it drops is reported, never silent.
 */

import { blockIdAtEnd, standaloneBlockAnchor } from '../markdown/block-anchor.ts';
import { readWikiLink } from '../markdown/wikilink-spans.ts';
import type { DirectoryPerson } from '../meeting-links/attendee-matching.ts';
import {
  PROPOSAL_CONFIDENCES,
  proposedChangeRefusal,
  readProposalPayload,
  type LinkFrom,
  type NotePayload,
  type NoteProposalKind,
  type ProposalConfidence,
} from '../proposals/proposal.ts';
import type { MeetingIdentity } from '../meetings/meeting-holding.ts';
import type { SuggestionVocabulary } from '../terms/term-suggestion.ts';
import { noteTitle } from '../vault/vault-entry.ts';
import type { VaultPath } from '../vault/vault-path.ts';
import { shownNotes, type AnsweredNote } from './answered-note.ts';
import {
  lengthProblem,
  MAX_WHY_CHARACTERS,
  noteTextProblem,
  propertiesProblem,
  truncated,
  unknownKeyProblem,
} from './answer-limits.ts';
import { claudeWriteRefusal } from './claude-write-folder.ts';
import type { MeetingDecisionClaim, MeetingItemClaim } from './meeting-item-apply.ts';
import {
  PROJECT_CHOICE_INSTRUCTIONS,
  PROJECT_CHOICE_KEY,
  readProjectChoice,
  type ProjectChoice,
  type ProjectOption,
} from './meeting-project-choice.ts';
import { setKeyProblem } from './property-key.ts';
import { remoteResourceProblem } from './remote-resources.ts';

export type { AnsweredNote };

/** The most proposals one answer may make: more is a model run away, not a meeting. */
export const MAX_PROPOSALS_PER_ANSWER = 25;

/**
 * What a run knows of the vault beyond the notes it is about, for a schema
 * that asks for it ({@link ProposalSchema.readsVault}): read by the run from
 * the index and the profile, never from the model's answer.
 */
export interface AnswerVault {
  /** The vault owner's name, from their profile; null when it holds none. */
  readonly selfName: string | null;
  /** The vault owner's own addresses, the vault's `selfEmails`; none when it holds none. */
  readonly selfEmails: readonly string[];
  /** The vault's people, as attendees are matched against them. */
  readonly people: readonly DirectoryPerson[];
  /** Every note in the vault: what a link to one of them is spelt against. */
  readonly notePaths: readonly VaultPath[];
  /** The right spellings the Terms page keeps. */
  readonly terms: readonly string[];
  /**
   * Every spelling the vault's terms, people and companies hold, right and
   * misheard: what a suggested term is held to (#19). None when left out.
   */
  readonly vocabulary?: SuggestionVocabulary;
  /**
   * The suggested terms waiting in the Inbox, open (#19): a suggestion for one
   * of them, or for what one was heard as, is not proposed again.
   */
  readonly pendingTerms?: readonly PendingTerm[];
  /**
   * The open projects and areas a meeting with none may be filed under, for
   * a schema that chooses one ({@link ProposalSchema.choosesProject}); read
   * only for the step that acts on the choice (#227).
   */
  readonly projects?: readonly ProjectOption[];
}

/** A term proposal waiting in the Inbox: its right spelling and what it was heard as. */
export interface PendingTerm {
  readonly title: string;
  readonly variants: readonly string[];
}

/** What an answer is checked against. */
export interface AnswerContext {
  readonly notes: readonly AnsweredNote[];
  /** Set for a schema that reads the vault; a schema that needs it and finds none reads as an empty vault. */
  readonly vault?: AnswerVault;
}

/** Something DFAI tells the model beside the notes: data, fenced as the notes are. */
export interface PromptData {
  /** What it is, in DFAI's own words: the fence's label. */
  readonly about: string;
  /** The vault's text: neutralised before it is shown. */
  readonly text: string;
}

/** An item of an answer left out while the rest was kept, and why: what the run's log says. */
export interface DroppedItem {
  /** What the item called itself. */
  readonly title: string;
  readonly reason: string;
}

/** What an answer says of its note besides its list (`meeting-digest`, #184). */
export interface AnsweredSummary {
  /** What the note was for and what came of it: a paragraph. */
  readonly summary: string;
  readonly keyPoints: readonly string[];
  readonly openQuestions: readonly string[];
}

/**
 * An answer's summary, read: kept, dropped with why — the answer's list is
 * kept either way — or absent, an answer given before its schema summarised.
 */
export type SummaryReading =
  | { readonly kind: 'read'; readonly value: AnsweredSummary }
  | { readonly kind: 'dropped'; readonly problem: string }
  | { readonly kind: 'absent' };

/**
 * What a schema's answer says besides its list: the keys, what each is, and
 * how they are read. A summary that does not read is dropped, never the
 * answer: its list is what the run acts on.
 */
export interface AnswerSummarySchema {
  /** The answer's keys besides the list's. */
  readonly keys: readonly string[];
  /** What they are, told to the model before the list, as `"key": what, …`. */
  readonly shape: string;
  /** The summary the answer's keys hold, or why it is dropped. */
  readonly read: (answer: Readonly<Record<string, unknown>>) => SummaryReading;
}

/** What a schema's item proposes, before the shared rules have checked it. */
export interface ProposalDraft {
  readonly kind: NoteProposalKind;
  /** What Accept would write, as a proposal's `payload:` holds it. */
  readonly payload: Readonly<Record<string, unknown>>;
  /** The block it came from, as a link: `[[2026-10-01 Standup#^t0003]]`. */
  readonly source: string;
  readonly confidence: string;
  /** Why it is proposed, in a sentence: the proposal note's body. */
  readonly why: string;
  /**
   * The relation of the meeting it cites that the note it makes joins once
   * accepted: one of its schema's {@link ProposalSchema.meetingRelations},
   * written by the schema's own code. The meeting is the note `source` cites.
   */
  readonly joinsMeeting?: string;
  /**
   * What tells this draft from another of the same kind, title and block:
   * who it concerns, normalised. Part of what the proposal is known by, so
   * two people taking on "Send the notes" in one turn are two proposals.
   */
  readonly distinguishedBy?: string;
  /**
   * Whose the meeting action item behind it is, and what caps it, as the
   * domain read it: what decides whether it is made the owner's task without
   * a click (ADR-0036, `decideMeetingItems`). Only an action item has one.
   */
  readonly meetingItem?: MeetingItemClaim;
  /**
   * What decides whether a meeting's decision reaches the owner at all
   * (#226): whether they took part in the exchange it cites. Only a
   * decision has one.
   */
  readonly meetingDecision?: MeetingDecisionClaim;
  /**
   * What only one draft of an answer may hold: a suggested term's heard
   * spelling, which two terms cannot both correct, and the term itself (#19).
   * A later draft holding a key an earlier one claimed is left out, saying
   * that claim's `why`.
   */
  readonly claims?: readonly { readonly key: string; readonly why: string }[];
}

/**
 * The block a proposal cites, as the run resolved the model's link: the note
 * among those it read, the meeting that note is when the import vouches for
 * it, and the block's id. A title or a path, `.md` or not, any case — however
 * the link was written, one block resolves to one citation.
 */
export interface ProposalCitation {
  readonly note: VaultPath;
  readonly meeting: MeetingIdentity | null;
  readonly block: string;
}

/** A proposal that has passed every rule, ready to be written as a note. */
export interface CheckedProposal {
  readonly kind: NoteProposalKind;
  readonly payload: NotePayload;
  /** The citation as the model wrote it: what the proposal's note shows. */
  readonly source: string;
  /** What the citation names, resolved by the run: what the proposal is known by. */
  readonly cites: ProposalCitation;
  readonly confidence: ProposalConfidence;
  readonly why: string;
  /** See {@link ProposalDraft.distinguishedBy}; empty when nothing does. */
  readonly distinguishedBy: string;
  /** See {@link ProposalDraft.meetingItem}. */
  readonly meetingItem?: MeetingItemClaim;
  /** See {@link ProposalDraft.meetingDecision}. */
  readonly meetingDecision?: MeetingDecisionClaim;
  /**
   * Whether the proposal is known by what it is and where it came from alone,
   * so that two rules reading one meeting propose it once between them
   * ({@link ProposalSchema.sharedAcrossRules}).
   */
  readonly sharedAcrossRules: boolean;
}

export type Reading<Value> =
  { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly problem: string };

/**
 * One item of an answer, read: the item (with a note of anything about it
 * that was put right, for the log), or why it is not one — refused, which
 * fails the whole answer, or dropped (`drop`), which leaves out just it.
 */
export type ItemReading<Item> =
  | { readonly ok: true; readonly value: Item; readonly adjusted?: string }
  | { readonly ok: false; readonly problem: string; readonly drop?: boolean };

/**
 * A kind of answer a Claude step can give: the extension point for new
 * proposal kinds. `Item` is the schema's own shape; nothing outside sees it.
 */
export interface ProposalSchema<Item> {
  /** What a rule's `output:` calls it. */
  readonly name: string;
  /** The key of the answer's list: `{ "<key>": [ … ] }`. */
  readonly key: string;
  /** What each item is, told to the model after the list's key. */
  readonly itemShape: string;
  /**
   * The keys an item may have. An item with any other is refused, not read
   * with the extra key ignored: it is a guess at what the model meant.
   */
  readonly itemKeys: readonly string[];
  /**
   * How the model is told to cite a block, when the schema cites differently
   * from the default (an item whose `source_block` is its own citation, say).
   * It must still end in a link the shared check can read: `[[Note#^id]]`.
   */
  readonly citation?: string;
  /**
   * The relations of a meeting that this schema's drafts may join
   * (`joinsMeeting`): `[]`, or left out, and none of its proposals touches a
   * note. They are the schema's own words, fixed when it is registered — a
   * draft naming any other is refused, so no answer can pick a property — and
   * each must be a relation the meeting type has, or Accept refuses the link.
   */
  readonly meetingRelations?: readonly string[];
  /**
   * One item of the list, or why it is not one. A schema may drop an item
   * that does not read (the rest are kept) and keep one with a fault put
   * right; both are in the run's record. By default one that does not read
   * refuses the whole answer.
   */
  readonly readItem: (value: unknown, context: AnswerContext) => ItemReading<Item>;
  /**
   * Whether the proposals are known by what they are and where they came
   * from, not by the rule that made them: two rules proposing the same
   * commitment from the same meeting make it once. Default: per rule.
   */
  readonly sharedAcrossRules?: boolean;
  /** Whether an item that is no object is dropped, as one {@link ItemReading} drops, instead of refusing the answer. */
  readonly dropsUnreadable?: boolean;
  /**
   * The key by which a note counts as already answered, besides its whole-file
   * digest: for a schema whose answer depends on only part of a note. Two
   * versions with one key are one to the rule, so a change to the rest — the
   * frontmatter Accept writes — asks nothing again. Keys match across paths, so
   * one must be unique to the thing answered, never a bare digest; null when
   * the note has nothing to be known by. Default: only the whole file.
   */
  readonly handledKeyOf?: (note: Pick<AnsweredNote, 'text' | 'meeting'>) => string | null;
  /**
   * Where in its note the block a proposal cites falls, to take an answer's
   * proposals in the order of the note whatever order the model listed them.
   */
  readonly positionOf?: (cites: ProposalCitation, context: AnswerContext) => number;
  /**
   * The proposals an item makes, given the notes the run was about: none, one,
   * or several (a meeting's one action item may be a task and a follow-up).
   * Each is held to the shared rules; the answer's total is capped.
   */
  readonly draftsOf: (item: Item, context: AnswerContext) => readonly ProposalDraft[];
  /**
   * Why an item is left out while the rest of the answer is kept, or null
   * when it is not: the one exception to "one bad item refuses the answer",
   * for a schema whose every item must cite a line and whose model will, now
   * and then, cite one that is not there (P29-05). The run's log names each.
   */
  readonly dropped?: (item: Item, context: AnswerContext) => DroppedItem | null;
  /** Whether its drafts read the vault's owner, people and terms ({@link AnswerVault}). */
  readonly readsVault?: boolean;
  /**
   * Whether a run asks about each note alone, a long meeting in parts
   * (`claudeAsks`): for a schema that reads a transcript turn by turn.
   */
  readonly readsInParts?: boolean;
  /** What the model is told beside the notes of one ask, as data. */
  readonly dataFor?: (context: AnswerContext) => readonly PromptData[];
  /**
   * What the answer says of its note besides the list, for a schema whose
   * answer also summarises it (`meeting-digest`, #184). Left out, the answer
   * is the list alone.
   */
  readonly summary?: AnswerSummarySchema;
  /**
   * Whether the answer may choose, beside its list, the project a meeting
   * with none is filed under (#227): read against the projects the ask
   * showed, and a choice that does not read is left out and said, never the
   * cause of refusing the answer.
   */
  readonly choosesProject?: boolean;
}

/** Told to the model so a refusal is rare; the checks hold either way. */
const PLAIN_TEXT = 'Write plain markdown: no images, embeds or HTML. Links are fine.';

const DEFAULT_CITATION =
  'Cite a block of a note you were given, as [[Note title#^blockid]], using an id that note already has. ' +
  'If two of the notes share a title, cite by the path instead, as [[Folder/Note title#^blockid]].';

/** A schema with its item type closed over: what the registry holds. */
export interface RegisteredProposalSchema {
  readonly name: string;
  /** What the model is told its answer must be. */
  readonly instructions: string;
  readonly read: (answer: string, context: AnswerContext) => AnswerReading;
  readonly readsVault: boolean;
  readonly readsInParts: boolean;
  readonly handledKeyOf: ((note: Pick<AnsweredNote, 'text' | 'meeting'>) => string | null) | null;
  /** The relations of a meeting its proposals join on Accept. */
  readonly meetingRelations: readonly string[];
  readonly dataFor: (context: AnswerContext) => readonly PromptData[];
  /** Whether its answer also summarises its note: every reading then says what of. */
  readonly summarises: boolean;
}

/** An answer read: its proposals, and the items left out of it. */
export type AnswerReading =
  | {
      readonly ok: true;
      readonly value: CheckedProposal[];
      readonly dropped: readonly DroppedItem[];
      /** Items kept with a fault put right, and what was put right. */
      readonly adjusted: readonly DroppedItem[];
      /** For a schema that summarises: its summary, read. */
      readonly summary?: SummaryReading;
      /** The project it chose for the meeting, for a schema that chooses one; null when it chose none. */
      readonly project?: ProjectChoice | null;
    }
  | { readonly ok: false; readonly problem: string };

/** Closes a schema over its item type, adding the checks every schema's proposals pass. */
export function registerProposalSchema<Item>(
  schema: ProposalSchema<Item>,
): RegisteredProposalSchema {
  for (const relation of schema.meetingRelations ?? []) {
    const problem = setKeyProblem(relation);
    // A schema is code: one that names a key DFAI keeps is a bug, found when the app starts.
    if (problem !== null) throw new Error(`The ${schema.name} output cannot link: ${problem}`);
  }
  return {
    name: schema.name,
    instructions: answerInstructions(schema),
    read: (answer, context) => readAnswer({ schema, answer, context }),
    readsVault: schema.readsVault === true,
    readsInParts: schema.readsInParts === true,
    handledKeyOf: schema.handledKeyOf ?? null,
    meetingRelations: schema.meetingRelations ?? [],
    dataFor: (context) => schema.dataFor?.(context) ?? [],
    summarises: schema.summary !== undefined,
  };
}

/** What the model is told its answer must be: the list, and before it any summary the schema asks for. */
function answerInstructions<Item>(schema: ProposalSchema<Item>): string {
  const { summary } = schema;
  const besides =
    summary === undefined ? '' : `${summary.keys.map((key) => `"${key}": …`).join(', ')}, `;
  const empty =
    summary === undefined ? `{ "${schema.key}": [] }` : `the rest with "${schema.key}": []`;
  return [
    `Answer with JSON only, and nothing around it: { ${besides}"${schema.key}": [ … ] }, at most ${MAX_PROPOSALS_PER_ANSWER} items.`,
    ...(summary === undefined ? [] : [summary.shape]),
    `Each item is ${schema.itemShape}`,
    ...(schema.choosesProject === true ? [PROJECT_CHOICE_INSTRUCTIONS] : []),
    schema.citation ?? DEFAULT_CITATION,
    PLAIN_TEXT,
    `If there is nothing to propose, answer ${empty}.`,
  ].join('\n');
}

function readAnswer<Item>({
  schema,
  answer,
  context,
}: {
  schema: ProposalSchema<Item>;
  answer: string;
  context: AnswerContext;
}): AnswerReading {
  const parsed = answerJson(answer);
  if (!parsed.ok) return parsed;
  const list = isRecord(parsed.value) ? parsed.value[schema.key] : undefined;
  if (!isRecord(parsed.value) || !Array.isArray(list)) {
    return refused(`It is not { "${schema.key}": [ … ] }.`);
  }
  const keys = [
    schema.key,
    ...(schema.summary?.keys ?? []),
    ...(schema.choosesProject === true ? [PROJECT_CHOICE_KEY] : []),
  ];
  const extra = unknownKeyProblem(parsed.value, keys, 'The answer');
  if (extra !== null) return refused(extra);
  if (list.length > MAX_PROPOSALS_PER_ANSWER) {
    return refused(
      `It made ${list.length} proposals; one run makes at most ${MAX_PROPOSALS_PER_ANSWER}.`,
    );
  }
  const checked: CheckedProposal[] = [];
  const dropped: DroppedItem[] = [];
  const adjusted: DroppedItem[] = [];
  const claimed = new Set<string>();
  for (const [at, value] of list.entries()) {
    const item = itemDrafts({ schema, value, context });
    if (!item.ok) return refused(`Item ${at + 1}: ${item.problem}`);
    if ('dropped' in item) {
      dropped.push(item.dropped);
      continue;
    }
    if (item.adjusted !== undefined) adjusted.push(item.adjusted);
    for (const draft of item.drafts) {
      const taken = draft.claims?.find(({ key }) => claimed.has(key));
      if (taken !== undefined) {
        dropped.push({ title: titleOf(value), reason: taken.why });
        continue;
      }
      for (const { key } of draft.claims ?? []) claimed.add(key);
      const proposal = checkDraft(draft, context, schema.meetingRelations);
      if (!proposal.ok) return refused(`Item ${at + 1}: ${proposal.problem}`);
      checked.push({ ...proposal.value, sharedAcrossRules: schema.sharedAcrossRules === true });
    }
    if (checked.length > MAX_PROPOSALS_PER_ANSWER) {
      return refused(`It made more than ${MAX_PROPOSALS_PER_ANSWER} proposals in one run.`);
    }
  }
  const summary = schema.summary?.read(parsed.value);
  const project = schema.choosesProject === true ? projectOf(parsed.value, context, dropped) : {};
  return {
    ok: true,
    value: inNoteOrder(schema, checked, context),
    dropped,
    adjusted,
    ...(summary !== undefined && { summary }),
    ...project,
  };
}

/** The answer's choice of project; one that does not read is added to `dropped`, and no choice. */
function projectOf(
  answer: Readonly<Record<string, unknown>>,
  context: AnswerContext,
  dropped: DroppedItem[],
): { project: ProjectChoice | null } {
  const reading = readProjectChoice({
    value: answer[PROJECT_CHOICE_KEY],
    notes: context.notes,
    options: context.vault?.projects ?? [],
  });
  if (reading.ok) return { project: reading.value };
  dropped.push({ title: 'its project', reason: reading.problem });
  return { project: null };
}

/** The proposals in the order of the note they cite, when the schema can say where each falls; else as listed. */
function inNoteOrder<Item>(
  schema: ProposalSchema<Item>,
  proposals: CheckedProposal[],
  context: AnswerContext,
): CheckedProposal[] {
  const { positionOf } = schema;
  if (positionOf === undefined) return proposals;
  // Array.prototype.sort is stable: proposals at one place keep the order they were listed in.
  return proposals
    .map((proposal) => ({ proposal, at: positionOf(proposal.cites, context) }))
    .sort((a, b) => a.at - b.at)
    .map(({ proposal }) => proposal);
}

/** An item's drafts, or the item as dropped; refused when it does not read. */
function itemDrafts<Item>({
  schema,
  value,
  context,
}: {
  schema: ProposalSchema<Item>;
  value: unknown;
  context: AnswerContext;
}):
  | {
      readonly ok: true;
      readonly drafts: readonly ProposalDraft[];
      readonly adjusted?: DroppedItem;
    }
  | { readonly ok: true; readonly dropped: DroppedItem }
  | { readonly ok: false; readonly problem: string } {
  if (!isRecord(value)) return droppedOrRefused(schema, 'It is not an object.', value);
  const extra = unknownKeyProblem(value, schema.itemKeys, 'It');
  if (extra !== null) return refused(extra);
  const item = schema.readItem(value, context);
  if (!item.ok) {
    return item.drop === true
      ? { ok: true, dropped: { title: titleOf(value), reason: item.problem } }
      : refused(item.problem);
  }
  const dropped = schema.dropped?.(item.value, context) ?? null;
  if (dropped !== null) return { ok: true, dropped };
  const drafts = schema.draftsOf(item.value, context);
  return {
    ok: true,
    drafts,
    ...(item.adjusted !== undefined && {
      adjusted: { title: titleOf(value), reason: item.adjusted },
    }),
  };
}

/** What an item called itself, for the record; a stand-in when it did not. */
function titleOf(value: unknown): string {
  const title = isRecord(value) ? value['title'] : undefined;
  return typeof title === 'string' && title.trim() !== '' ? title.trim() : 'an item';
}

/** An item that is no object: dropped by a schema that drops what does not read, else the answer is refused. */
function droppedOrRefused<Item>(
  schema: ProposalSchema<Item>,
  problem: string,
  value: unknown,
):
  | { readonly ok: true; readonly dropped: DroppedItem }
  | { readonly ok: false; readonly problem: string } {
  return schema.dropsUnreadable === true
    ? { ok: true, dropped: { title: titleOf(value), reason: problem } }
    : refused(problem);
}

/** What a payload may hold: a note, and nothing that would edit one. */
const PAYLOAD_KEYS = ['title', 'folder', 'properties', 'body'];

/**
 * The rules every proposal passes, whichever schema made it: new notes only
 * (never a link, which edits a note), a payload Accept could write — with no
 * `link_from` of its own, which would name a note to edit — held to the
 * sizes and properties a note answer is, loading nothing remote, and citing a
 * block the model was shown. A draft that joins the meeting it cites does so
 * through one of `meetingRelations`, its schema's, and no other.
 */
export function checkDraft(
  draft: ProposalDraft,
  context: AnswerContext,
  meetingRelations: readonly string[] = [],
): Reading<CheckedProposal> {
  // Stated, not left to the payload's shape: "new notes only" is the line between propose and edit.
  if ((draft.kind as string) === 'link') return refused('A Claude step proposes new notes only.');
  const extra = unknownKeyProblem(draft.payload, PAYLOAD_KEYS, 'Its payload');
  if (extra !== null) return refused(extra);
  const payload = readProposalPayload(draft.kind, draft.payload);
  if (!payload.ok) return payload;
  if (!('linkFrom' in payload.payload)) return refused('A Claude step proposes new notes only.');
  const note = payload.payload;
  const where = note.folder === null ? null : claudeWriteRefusal(note.folder);
  const content =
    where ??
    noteTextProblem({ title: note.title, body: note.body }) ??
    propertiesProblem(note.properties) ??
    lengthProblem('Its “why”', draft.why, MAX_WHY_CHARACTERS) ??
    remoteResourceProblem(draft.why);
  if (content !== null) return refused(content);
  const confidence = PROPOSAL_CONFIDENCES.find((known) => known === draft.confidence);
  if (confidence === undefined) {
    return refused(`Its confidence is not one of ${PROPOSAL_CONFIDENCES.join(', ')}.`);
  }
  const cited = citedBlock(draft.source, context.notes);
  if (!cited.ok) return cited;
  const linkFrom = sourceMeetingLink({ draft, cited: cited.value, meetingRelations });
  if (!linkFrom.ok) return linkFrom;
  return {
    ok: true,
    value: {
      kind: draft.kind,
      payload: { ...note, linkFrom: linkFrom.value },
      source: draft.source.trim(),
      cites: {
        note: cited.value.note.path,
        meeting: cited.value.note.meeting?.identity ?? null,
        block: cited.value.block,
      },
      confidence,
      why: draft.why.trim(),
      distinguishedBy: draft.distinguishedBy ?? '',
      sharedAcrossRules: false,
      ...(draft.meetingItem === undefined ? {} : { meetingItem: draft.meetingItem }),
      ...(draft.meetingDecision === undefined ? {} : { meetingDecision: draft.meetingDecision }),
    },
  };
}

/**
 * The relation of its source meeting a draft's note joins, as Accept reads it
 * (`link_from`, P29-04) — null when the draft joins none. The meeting is the
 * note the draft cites, named by the identity the run read from its file, so
 * Accept finds it wherever it has been filed since and writes to no other.
 * Refused: a relation its schema does not list, and a cited note the run did
 * not read as a meeting the import let in.
 */
function sourceMeetingLink({
  draft,
  cited,
  meetingRelations,
}: {
  draft: ProposalDraft;
  cited: CitedBlock;
  meetingRelations: readonly string[];
}): Reading<LinkFrom | null> {
  const property = draft.joinsMeeting;
  if (property === undefined) return { ok: true, value: null };
  if (!meetingRelations.includes(property)) {
    return refused(
      `It would join “${truncated(property, 40)}” of a meeting, which this output does not link through.`,
    );
  }
  const meeting = cited.note.meeting?.identity ?? null;
  if (meeting === null) {
    return refused('It links back to the meeting it cites, and the note it cites is not one.');
  }
  const refusal = proposedChangeRefusal(cited.note.path);
  if (refusal !== null) return refused(refusal);
  return { ok: true, value: { note: cited.note.path, property, meeting } };
}

/** A block the run found: the note, as it was read, and the id. */
interface CitedBlock {
  readonly note: AnsweredNote;
  readonly block: string;
}

/**
 * Why `source` does not cite a block of one of `notes`, or null when it
 * does: see {@link citedBlock}.
 */
export function citedBlockProblem(source: string, notes: readonly AnsweredNote[]): string | null {
  const cited = citedBlock(source, notes);
  return cited.ok ? null : cited.problem;
}

/**
 * The block `source` cites: a link `[[Note#^id]]` to one note the run read,
 * naming an id that note holds in the text the model was shown, outside a
 * code fence. A proposal that cites nothing real cannot be checked against
 * what was said, so it is refused — as is a link by a title more than one of
 * the notes has: which note it means would hang on the order they were read
 * in, so the model is told to cite by path.
 */
function citedBlock(source: string, notes: readonly AnsweredNote[]): Reading<CitedBlock> {
  const link = readWikiLink(source.trim());
  // The reader keeps the `#` that starts a link's heading: a block's is `#^id`.
  const id = link?.heading?.startsWith('#^') ? link.heading.slice(2) : null;
  if (link === null || link.embed || id === null || id === '') {
    return refused(
      `Its source ${JSON.stringify(truncated(source, 200))} is not a link to a block, like [[Note#^id]].`,
    );
  }
  const named = notesNamed(link.target, notes);
  if (named.length > 1) {
    return refused(
      `Its source cites ${JSON.stringify(truncated(link.target, 200))}, a title ${named.length} of the notes this run read share. Cite the note by its path, like [[Folder/Note#^id]].`,
    );
  }
  const [note] = named;
  if (note === undefined) {
    return refused(
      `Its source cites ${JSON.stringify(truncated(link.target, 200))}, which is not a note this run read.`,
    );
  }
  // Only what the model was shown: a block past where the note was cut is a guess.
  const shown = shownNotes(notes).find((each) => each.path === note.path);
  return shown !== undefined && holdsBlock(shown.text, id)
    ? { ok: true, value: { note, block: id } }
    : refused(`${noteTitle(note.path)} has no block ^${truncated(id, 100)}.`);
}

/** Whether a link target names the note at `path`: by its path, or by its title alone. */
export function namesNote(target: string, path: VaultPath): boolean {
  return notesNamed(target, [{ path, text: '' }]).length > 0;
}

/**
 * The notes a link's target names, among those the run read: the one at that
 * path when there is one, else every note of that title — more than one when
 * the title is shared.
 */
function notesNamed(target: string, notes: readonly AnsweredNote[]): AnsweredNote[] {
  const wanted = target.trim().replace(/\.md$/i, '').toLowerCase();
  const stem = (path: VaultPath) => path.replace(/\.md$/i, '').toLowerCase();
  const atPath = notes.filter((each) => stem(each.path) === wanted);
  if (atPath.length > 0) return atPath.slice(0, 1);
  return notes.filter((each) => noteTitle(each.path).toLowerCase() === wanted);
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** Whether a line of `text` outside any code fence ends in, or is, the block id `id`. */
function holdsBlock(text: string, id: string): boolean {
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const marker = FENCE.exec(line);
    if (fence !== null) {
      // A fence closes on the same mark, at least as long, with nothing after it.
      if (
        marker !== null &&
        marker[1]![0] === fence[0] &&
        marker[1]!.length >= fence.length &&
        marker[2]!.trim() === ''
      ) {
        fence = null;
      }
      continue;
    }
    if (marker !== null) {
      fence = marker[1]!;
      continue;
    }
    if (blockIdAtEnd(line)?.id === id || standaloneBlockAnchor(line.trim()) === id) return true;
  }
  return false;
}

/**
 * The JSON an answer holds: the whole answer, or one fenced block that is
 * all of it — models fence JSON whatever they are told.
 */
export function answerJson(answer: string): Reading<unknown> {
  const text = answer.trim();
  const fenced = /^```(?:json)?[ \t]*\n([\s\S]*?)\n```$/i.exec(text);
  try {
    return { ok: true, value: JSON.parse(fenced === null ? text : fenced[1]!) as unknown };
  } catch {
    // Not JSON is the answer's problem, said as one; the parser's words add nothing.
    return refused('It is not JSON.');
  }
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function refused(problem: string): { readonly ok: false; readonly problem: string } {
  return { ok: false, problem };
}
