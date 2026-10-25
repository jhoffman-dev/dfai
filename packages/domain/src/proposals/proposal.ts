import { isArchivedPath } from '../archive/archive.ts';
import { readWikiLink } from '../markdown/wikilink-spans.ts';
import { isInMeetingInboxFolder } from '../meetings/meeting-arrival.ts';
import type { MeetingIdentity } from '../meetings/meeting-holding.ts';
import { PERSON_TYPE } from '../people/person.ts';
import { cleanEntryName } from '../vault/new-note.ts';
import { noteTitle } from '../vault/vault-entry.ts';
import { isUserSpaceNote } from '../vault/vault-visibility.ts';
import { createVaultPath, InvalidVaultPathError, type VaultPath } from '../vault/vault-path.ts';

/**
 * A proposal is a note (ADR-0028): what Claude or an automation suggests, kept
 * in `Inbox/Proposals/` until James accepts, edits or rejects it. Being a note
 * it syncs, survives a restart and can be queried; accepting writes what its
 * `payload` says, and nothing else (P29-02).
 */
export const PROPOSAL_TYPE = 'proposal';

/** The built-in type a decision proposal makes. */
export const DECISION_TYPE = 'decision';

/** Where proposals wait. Accepted and rejected ones go to the Archive, so it holds only open ones. */
export const PROPOSALS_FOLDER = 'Inbox/Proposals';

/** The start of every path in the proposals folder, lower-cased: the disk does not tell `Inbox` from `inbox`. */
const PROPOSALS_PREFIX = `${PROPOSALS_FOLDER.toLowerCase()}/`;

export const PROPOSAL_KINDS = [
  'task',
  'decision',
  'follow-up',
  'person',
  'link',
  'term',
  'project',
  'dashboard',
  'view',
] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

/**
 * The kinds that make one of DFAI's own entries in `.atlas` — a dashboard in
 * `.atlas/dashboards`, a view in `.atlas/views` (P32-05). The local API never
 * writes `.atlas` (ADR-0016), so these are accepted only in the app.
 */
export const SPEC_PROPOSAL_KINDS = ['dashboard', 'view'] as const;
export type SpecProposalKind = (typeof SPEC_PROPOSAL_KINDS)[number];

export function isSpecProposalKind(kind: ProposalKind): kind is SpecProposalKind {
  return (SPEC_PROPOSAL_KINDS as readonly string[]).includes(kind);
}

export const PROPOSAL_STATES = ['open', 'accepted', 'rejected'] as const;
export type ProposalState = (typeof PROPOSAL_STATES)[number];

export const PROPOSAL_CONFIDENCES = ['high', 'medium', 'low'] as const;

/**
 * Where a proposal was answered, recorded on it as `answered_via` when it is
 * accepted or rejected: the app's buttons, or the local API (an MCP client
 * James asked). The Archive keeps who said yes.
 */
export const ANSWERED_VIA_KEY = 'answered_via';
export const PROPOSAL_ANSWERERS = ['app', 'api'] as const;
export type ProposalAnswerer = (typeof PROPOSAL_ANSWERERS)[number];
export type ProposalConfidence = (typeof PROPOSAL_CONFIDENCES)[number];

/** A proposal that makes a note in user space: everything but a link, a dashboard or a view. */
export type NoteProposalKind = Exclude<ProposalKind, 'link' | SpecProposalKind>;

/** The type of the note each kind makes. A follow-up is a task to chase someone. */
export const PROPOSAL_NOTE_TYPES: Readonly<Record<NoteProposalKind, string>> = {
  task: 'task',
  'follow-up': 'task',
  decision: DECISION_TYPE,
  person: PERSON_TYPE,
  term: 'term',
  project: 'project',
};

/**
 * A relation of another note the new note is added to once it is made: a
 * person proposed from a meeting's attendees joins that meeting's `people`.
 */
export interface LinkFrom {
  readonly note: VaultPath;
  readonly property: string;
  /**
   * Which meeting `note` was when this was proposed (provider and id), when it
   * is a meeting. A meeting is filed out of the Inbox, so its path is not what
   * it is: accepting finds it by this, and writes to no note that is not it.
   */
  readonly meeting?: MeetingIdentity;
}

/**
 * What accepting a note proposal makes: a note called `title`, in `folder` or
 * at the top of the vault — and, with `linkFrom`, a link to it added to that
 * note's relation.
 */
export interface NotePayload {
  readonly title: string;
  readonly folder: VaultPath | null;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly body: string;
  readonly linkFrom: LinkFrom | null;
}

/**
 * What accepting a link proposal changes: `link` added to the relation
 * `property` of the note at `note`. With a `digest` (`digestOf` its whole
 * text when the proposal was made), the note must still hold exactly that.
 * Without one, only the relation is judged: a link is added to a list, or
 * fills an empty single link, and never replaces one — so a proposal made by
 * a step that other steps follow is not refused for their writes.
 */
export interface LinkPayload {
  readonly note: VaultPath;
  readonly property: string;
  readonly link: string;
  readonly digest: string | null;
  /** Which meeting `note` was, as for {@link LinkFrom}. */
  readonly meeting?: MeetingIdentity;
}

/**
 * What accepting a dashboard or view proposal makes: an entry called `title`
 * in its kind's folder of `.atlas`, as `spec` describes it. The spec is
 * checked again when it is accepted — against the vault's types as they are
 * then — and only what the checker passes is written.
 */
export interface SpecPayload {
  readonly title: string;
  readonly spec: Readonly<Record<string, unknown>>;
}

interface ProposalCommon {
  readonly path: VaultPath;
  readonly state: ProposalState;
  readonly confidence: ProposalConfidence | null;
  /** The block it came from, as a link — `[[2026-10-01 Standup#^t0003]]` — or null when it cites none. */
  readonly source: string | null;
  /** The rule and run that made it, as written. */
  readonly madeBy: string | null;
}

export type ProposalNote =
  | (ProposalCommon & { readonly kind: NoteProposalKind; readonly payload: NotePayload })
  | (ProposalCommon & { readonly kind: 'link'; readonly payload: LinkPayload })
  | (ProposalCommon & { readonly kind: SpecProposalKind; readonly payload: SpecPayload });

export type ProposalPayload = ProposalNote['payload'];

/** A proposal that makes a note in user space. */
export type NoteProposal = Extract<ProposalNote, { readonly kind: NoteProposalKind }>;

/** A proposal that makes a dashboard or a view in `.atlas`. */
export type SpecProposal = Extract<ProposalNote, { readonly kind: SpecProposalKind }>;

/** Whether a proposal makes a dashboard or a view. */
export function isSpecProposal(proposal: ProposalNote): proposal is SpecProposal {
  return isSpecProposalKind(proposal.kind);
}

/** Whether a proposal makes a note in user space: not a link, nor a dashboard or a view. */
export function isNoteProposal(proposal: ProposalNote): proposal is NoteProposal {
  return proposal.kind !== 'link' && !isSpecProposalKind(proposal.kind);
}

export type ProposalReading =
  | { readonly ok: true; readonly proposal: ProposalNote }
  | { readonly ok: false; readonly problem: string };

export type PayloadReading =
  | { readonly ok: true; readonly payload: ProposalPayload }
  | { readonly ok: false; readonly problem: string };

/**
 * Why a proposal may not be accepted by whoever answered it, or null when it
 * may. A dashboard or a view is written into `.atlas`, which nothing outside
 * the app writes (ADR-0016): only the app's own Accept makes one.
 */
export function acceptRefusal(kind: ProposalKind, via: ProposalAnswerer): string | null {
  if (via === 'app' || !isSpecProposalKind(kind)) return null;
  return `A ${kind} proposal is written into .atlas, which the local API never writes: accept it in DFAI’s Inbox.`;
}

/** Whether a note sits in the proposals folder, however `Inbox` is cased. */
export function isProposalPath(path: string): boolean {
  return path.toLowerCase().startsWith(PROPOSALS_PREFIX);
}

/** Whether a note's properties say it is a proposal. */
export function isProposalNote(properties: Readonly<Record<string, unknown>>): boolean {
  const type = properties['type'];
  return typeof type === 'string' && type.trim().toLowerCase() === PROPOSAL_TYPE;
}

/**
 * A proposal note read from its frontmatter, or why it cannot be: a kind
 * DFAI does not know, a state it does not know, or a payload that does not
 * say what to write. A confidence it does not know reads as none, since it
 * changes nothing Accept does.
 */
export function readProposal({
  path,
  properties,
}: {
  path: VaultPath;
  properties: Readonly<Record<string, unknown>>;
}): ProposalReading {
  const kind = oneOf(PROPOSAL_KINDS, properties['kind']);
  if (kind === null) return refused(`It has no kind DFAI knows: ${known(PROPOSAL_KINDS)}.`);
  const state =
    properties['state'] === undefined ? 'open' : oneOf(PROPOSAL_STATES, properties['state']);
  if (state === null) return refused(`Its state is not one of ${known(PROPOSAL_STATES)}.`);
  const payload = readProposalPayload(kind, properties['payload']);
  if (!payload.ok) return payload;
  const common: ProposalCommon = {
    path,
    state,
    confidence: oneOf(PROPOSAL_CONFIDENCES, properties['confidence']),
    source: text(properties['source']),
    madeBy: text(properties['made_by']),
  };
  return { ok: true, proposal: { ...common, kind, payload: payload.payload } as ProposalNote };
}

/**
 * The payload a proposal of `kind` carries, checked: what Accept writes. Also
 * what an edit is read back through, so an edited payload is held to the
 * rules the proposal was.
 */
export function readProposalPayload(kind: ProposalKind, value: unknown): PayloadReading {
  if (!isRecord(value)) return refused('Its payload does not say what to write.');
  if (isSpecProposalKind(kind)) return readSpecPayload(value);
  return kind === 'link' ? readLinkPayload(value) : readNotePayload(value);
}

/** A dashboard or view payload: a title and the spec, read whole; what the spec says is checked on Accept. */
function readSpecPayload(value: Readonly<Record<string, unknown>>): PayloadReading {
  const title = cleanEntryName(text(value['title']) ?? '');
  if (title === '') return refused('Its payload needs a title.');
  const spec = value['spec'];
  if (!isRecord(spec)) return refused('Its payload’s spec must be keys and values.');
  return { ok: true, payload: { title, spec } };
}

function readNotePayload(value: Readonly<Record<string, unknown>>): PayloadReading {
  const title = cleanEntryName(text(value['title']) ?? '');
  if (title === '') return refused('Its payload needs a title.');
  const properties = value['properties'] ?? {};
  if (!isRecord(properties)) return refused('Its payload’s properties must be keys and values.');
  if (Object.keys(properties).some((key) => key.trim() === '')) {
    return refused('A property in its payload has no name.');
  }
  const folder = text(value['folder']);
  // Whether a proposal may write there is Accept's question (applyProposal), asked of the vault as it is.
  const at = folder === null ? null : vaultPath(folder);
  if (at instanceof Error) return refused(at.message);
  const body = value['body'] ?? '';
  if (typeof body !== 'string') return refused('Its payload’s body must be text.');
  const linkFrom = readLinkFrom(value[LINK_FROM_KEY]);
  if (linkFrom instanceof Error) return refused(linkFrom.message);
  return { ok: true, payload: { title, folder: at, properties, body, linkFrom } };
}

/** The payload key naming the relation a new note joins. */
const LINK_FROM_KEY = 'link_from';

function readLinkFrom(value: unknown): LinkFrom | null | Error {
  if (value === undefined || value === null) return null;
  const record = isRecord(value) ? value : {};
  const note = text(record['note']);
  const property = text(record['property']);
  if (note === null || property === null) {
    return new Error('Its payload’s link_from needs the note and the property.');
  }
  const path = notePath(note);
  if (path instanceof Error) return path;
  const meeting = readMeetingIdentity(record['meeting']);
  if (meeting instanceof Error) return meeting;
  return { note: path, property, ...(meeting !== null && { meeting }) };
}

/** The meeting a payload names, as `{ provider, external_id }`; null when it names none. */
function readMeetingIdentity(value: unknown): MeetingIdentity | null | Error {
  if (value === undefined || value === null) return null;
  const provider = isRecord(value) ? text(value['provider']) : null;
  const externalId = isRecord(value) ? text(value[MEETING_ID_KEY] ?? value['externalId']) : null;
  if (provider === null || externalId === null) {
    return new Error('Its payload’s meeting needs the provider and the external_id.');
  }
  return { provider, externalId };
}

/** The key a payload writes a meeting's id under, as the meeting's own frontmatter does. */
const MEETING_ID_KEY = 'external_id';

function meetingRecord({ provider, externalId }: MeetingIdentity) {
  return { provider, [MEETING_ID_KEY]: externalId };
}

function readLinkPayload(value: Readonly<Record<string, unknown>>): PayloadReading {
  const note = text(value['note']);
  const property = text(value['property']);
  const link = text(value['link']);
  if (note === null || property === null || link === null) {
    return refused('A link proposal needs the note, the property and the link.');
  }
  const written = value['digest'] ?? null;
  const digest = written === null ? null : text(written);
  if (written !== null && digest === null)
    return refused('A link proposal’s digest, when it has one, must be text that is not blank.');
  const read = readWikiLink(link);
  if (read === null || read.embed) return refused(`${link} is not a link to a note.`);
  const path = notePath(note);
  if (path instanceof Error) return refused(path.message);
  const meeting = readMeetingIdentity(value['meeting']);
  if (meeting instanceof Error) return refused(meeting.message);
  return {
    ok: true,
    payload: { note: path, property, link, digest, ...(meeting !== null && { meeting }) },
  };
}

/**
 * Why a proposal may not write at `path` — a note, or a folder it would make
 * one in — or null when it may. Only user space: not `.atlas` or a hidden
 * folder, nor one the vault's walk never reads (`node_modules`, in any case,
 * at any depth), where a note would be invisible. Nor the Archive, which is
 * what is done with, nor the proposals folder, where proposals wait, nor
 * `Inbox/Meetings`, where every file that lands is judged as a meeting.
 */
export function proposedWriteRefusal(path: VaultPath): string | null {
  const refusal = proposedChangeRefusal(path);
  if (refusal !== null) return refusal;
  // The meeting import judges every note that lands there as a meeting file (ADR-0027); in
  // `Meetings` it judges only a file that declares its contract, which a proposal never writes (#214).
  if (isInMeetingInboxFolder(`${path}/note.md`)) {
    return `${JSON.stringify(path)} is where meeting files land; a proposal does not write there.`;
  }
  return null;
}

/**
 * Why a proposal may not change the note at `path` that is already there —
 * a link added to one of its relations — or null when it may. As for a new
 * note, except where meeting files land: a meeting waiting there is the very
 * note a proposal from it most often links (P29-04), and changing it makes
 * no new file for the import to judge.
 */
export function proposedChangeRefusal(path: VaultPath): string | null {
  const shown = JSON.stringify(path);
  // A folder is judged as what would be written inside it.
  const within = `${path}/`;
  if (!isUserSpaceNote(createVaultPath(`${within}note.md`))) {
    return `${shown} is hidden configuration, or a folder the vault never shows; a proposal does not write there.`;
  }
  if (isArchivedPath(within)) return `${shown} is in the Archive; a proposal does not write there.`;
  if (isProposalPath(within)) {
    return `${shown} is where proposals wait; a proposal does not write there.`;
  }
  return null;
}

function linkFromRecord({ meeting, ...from }: LinkFrom) {
  return { ...from, ...(meeting !== undefined && { meeting: meetingRecord(meeting) }) };
}

/**
 * A payload as it is written back into its proposal's `payload:` — after an
 * edit, so the Archive keeps what was accepted. Only what it holds is written:
 * no empty folder, properties or body.
 */
export function payloadRecord(payload: ProposalPayload): Readonly<Record<string, unknown>> {
  if ('spec' in payload) return { title: payload.title, spec: payload.spec };
  if ('digest' in payload) {
    const { digest, meeting, ...link } = payload;
    return {
      ...link,
      ...(digest !== null && { digest }),
      ...(meeting !== undefined && { meeting: meetingRecord(meeting) }),
    };
  }
  const { title, folder, properties, body, linkFrom } = payload;
  return {
    title,
    ...(folder !== null && { folder }),
    ...(Object.keys(properties).length > 0 && { properties }),
    ...(body !== '' && { body }),
    ...(linkFrom !== null && { [LINK_FROM_KEY]: linkFromRecord(linkFrom) }),
  };
}

/** One line saying what a proposal would do, as the Inbox lists it. */
export function proposalHeadline(proposal: ProposalNote): string {
  if (proposal.kind !== 'link') return proposal.payload.title;
  const { note, property, link } = proposal.payload;
  return `${noteTitle(note)} · ${property} → ${link}`;
}

function notePath(raw: string): VaultPath | Error {
  const path = vaultPath(raw);
  if (path instanceof Error) return path;
  if (!/\.(md|markdown)$/i.test(path)) return new Error(`${JSON.stringify(raw)} is not a note.`);
  const refusal = proposedChangeRefusal(path);
  return refusal === null ? path : new Error(refusal);
}

function vaultPath(raw: string): VaultPath | Error {
  try {
    return createVaultPath(raw);
  } catch (error) {
    if (error instanceof InvalidVaultPathError) {
      return new Error(`${JSON.stringify(raw)} is not a path inside the vault.`);
    }
    throw error;
  }
}

function oneOf<T extends string>(options: readonly T[], value: unknown): T | null {
  if (typeof value !== 'string') return null;
  const wanted = value.trim().toLowerCase();
  return options.find((option) => option === wanted) ?? null;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function known(options: readonly string[]): string {
  return options.join(', ');
}

function refused(problem: string): { readonly ok: false; readonly problem: string } {
  return { ok: false, problem };
}
