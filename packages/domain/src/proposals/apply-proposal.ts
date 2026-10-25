import { linkTargets } from '../index/relation-rows.ts';
import { resolveWikiLinkTarget, wikiLinkTargetFor } from '../markdown/resolve-wikilink.ts';
import { holdsOnlyText, withLink, linkedNotes } from '../types/relation-links.ts';
import { fitFileNameStem } from '../vault/file-name-bytes.ts';
import { TASK_KEYS } from '../gtd/gtd-status.ts';
import { linkableEntryName, nextAvailableNotePath } from '../vault/new-note.ts';
import { TITLE_KEY } from '../page/page-title.ts';
import { noteTitle } from '../vault/vault-entry.ts';
import { joinVaultPath, VAULT_ROOT, type VaultPath } from '../vault/vault-path.ts';
import { foldedVaultPath } from '../vault/vault-spelling.ts';
import type { ObjectType } from '../types/property-def.ts';
import { applySpecProposal } from './spec-proposal.ts';
import {
  PROPOSAL_NOTE_TYPES,
  isSpecProposal,
  proposedWriteRefusal,
  type LinkFrom,
  type LinkPayload,
  type NotePayload,
  type NoteProposalKind,
  type ProposalNote,
} from './proposal.ts';
import type { ProposalApplication, ProposalWrite } from './proposal-application.ts';

export type { ProposalApplication, ProposalWrite } from './proposal-application.ts';

/** The note a link proposal changes, as it is now. */
export interface LinkTarget {
  /** `digestOf` its whole text. */
  readonly digest: string;
  /** The relation's value now; undefined when the note has none. */
  readonly value: unknown;
  /** The relation by its type: whether it holds several notes. Null when the type has no such relation. */
  readonly relation: { readonly many: boolean } | null;
}

/** What accepting a proposal is checked against. */
export interface ProposalVault {
  /** Every note in the vault now: a new note never takes a path one of them has. */
  readonly notePaths: readonly VaultPath[];
  /**
   * The note a link proposal changes — or a note proposal's `linkFrom` note —
   * as it is now; null when it is not there, or the proposal names none.
   */
  readonly target: LinkTarget | null;
  /**
   * The `type` of the note already at the path a new note would take, as it
   * is written, when there is one: a proposal that joins a relation links
   * that note instead of making it, but only if it is the kind of note
   * proposed.
   */
  readonly heldTypes?: readonly string[] | undefined;
  /**
   * The home folder of the note's type, for its day (#214): where a record
   * of its own — a task, a follow-up, a decision — goes when its payload
   * names no folder. Null, or left out, for the root.
   */
  readonly homeFolder?: VaultPath | null | undefined;
  /** The vault's types: what a dashboard or view proposal is checked against again. None, left out. */
  readonly types?: readonly ObjectType[] | undefined;
  /**
   * The entries in the folder a dashboard or view proposal writes into, as
   * they are now: its entry is numbered past them. None, left out.
   */
  readonly specPaths?: readonly VaultPath[] | undefined;
}

/** The kinds whose note records the line it came from, in its `source`. */
const CITING_KINDS: ReadonlySet<NoteProposalKind> = new Set(['task', 'follow-up', 'decision']);

/**
 * What accepting a proposal writes, or why it may not be accepted.
 *
 * A task, a follow-up or a decision makes a note of its type citing the block
 * the proposal came from; a person, a term or a project makes a note of its
 * type, and with `linkFrom` is added to that note's relation too. A link adds
 * one link to a relation of an existing note. A dashboard or a view makes an
 * entry in its folder of `.atlas`, its spec checked again first. Nothing is written over: a note
 * already at the path a new one would take is a refusal (it may be the very
 * note this proposes), and a note changed since a proposal with a digest was
 * made is too — the proposal was made against what it held then.
 */
export function applyProposal(proposal: ProposalNote, vault: ProposalVault): ProposalApplication {
  if (proposal.state !== 'open') return refused(`It was already ${proposal.state}.`);
  if (isSpecProposal(proposal)) {
    return applySpecProposal(proposal, {
      types: vault.types ?? [],
      takenPaths: vault.specPaths ?? [],
    });
  }
  return proposal.kind === 'link'
    ? applyLink(proposal.payload, vault)
    : applyNoteProposal(proposal, vault);
}

/** A note to make, as a note proposal has it: what it is, what it holds, and the block it cites. */
export type ProposedNote = Pick<
  ProposalNote & { readonly kind: NoteProposalKind },
  'kind' | 'payload' | 'source'
>;

/**
 * The kinds whose note is a record of this proposal's own — a task, a
 * follow-up, a decision: another note of the same name is some other record
 * (last year's finished task), never this one, so a clash is numbered past.
 * A person, a term or a project is a note about a thing in the world, and one
 * already there may be the very one proposed.
 */
const OWN_RECORDS: ReadonlySet<NoteProposalKind> = new Set(['task', 'follow-up', 'decision']);

/**
 * What making a proposed note writes, or why it may not be made: the note of
 * its kind, and its `linkFrom` joined. Accepting a note proposal is this; so
 * is making a task from a meeting's action item without one (#177).
 */
export function applyNoteProposal(
  proposal: ProposedNote,
  { notePaths, target, heldTypes, homeFolder = null }: ProposalVault,
): ProposalApplication {
  const { kind, source } = proposal;
  const refusal =
    proposal.payload.folder === null ? null : proposedWriteRefusal(proposal.payload.folder);
  if (refusal !== null) return refused(refusal);
  const gone = waitingOnGone(proposal, notePaths);
  if (gone !== null) return refused(gone);
  // A record of its own is never one already there, so it can go to its home; a person or a
  // project is looked for where the payload says, and a home would miss the one there.
  const payload =
    proposal.payload.folder === null && OWN_RECORDS.has(kind)
      ? { ...proposal.payload, folder: homeFolder }
      : proposal.payload;
  const wanted = newNotePath(payload);
  const folded = foldedVaultPath(wanted);
  const found = notePaths.find((note) => foldedVaultPath(note) === folded);
  // Its own record is made where the name is free: "Send the notes 2", never last year's "Send the notes".
  const path =
    found !== undefined && OWN_RECORDS.has(kind)
      ? nextAvailableNotePath({
          folder: payload.folder ?? VAULT_ROOT,
          name: noteTitle(wanted),
          taken: new Set(notePaths),
        })
      : wanted;
  const held = path === wanted ? found : undefined;
  if (held !== undefined && !(kind === 'person' && payload.linkFrom !== null)) {
    return refused(
      `There is already a note at ${path}, which may be this one. Edit the title to make another.`,
    );
  }
  if (held !== undefined && !isKindOfNote(kind, heldTypes)) {
    return refused(
      `There is already a note at ${held} that is not a ${PROPOSAL_NOTE_TYPES[kind]}, so this was left as it is. Edit the title to make another.`,
    );
  }
  const cites = CITING_KINDS.has(kind) && source !== null;
  const properties = {
    type: PROPOSAL_NOTE_TYPES[kind],
    ...titleUnsaidBy(wanted, payload.title),
    ...withoutType(payload.properties),
    ...(cites && { source }),
  };
  // A person already there is the one proposed — made since by another proposal for them,
  // from another meeting: they are linked, not made again.
  const creates: ProposalWrite[] =
    held === undefined ? [{ kind: 'create', path, properties, body: payload.body }] : [];
  if (payload.linkFrom === null) return { ok: true, writes: creates };
  const joined = joinedRelation({
    linkFrom: payload.linkFrom,
    note: held ?? path,
    notePaths: held === undefined ? [...notePaths, path] : notePaths,
    target,
  });
  return joined.ok ? { ok: true, writes: [...creates, ...joined.writes] } : joined;
}

/**
 * Why a task cannot be accepted because the person it waits on has gone: its
 * `waiting_on` links a note the vault no longer has (renamed or deleted on
 * another Mac since the proposal was made). Refused, with nothing written —
 * a link to nothing would show as waiting on nobody — and the card's Edit can
 * point it at the right person, or at their name as text.
 */
function waitingOnGone({ payload }: ProposedNote, notePaths: readonly VaultPath[]): string | null {
  const value = payload.properties[TASK_KEYS.waitingOn];
  if (typeof value !== 'string') return null;
  const missing = linkTargets(value).find(
    (written) => resolveWikiLinkTarget(written, notePaths) === null,
  );
  return missing === undefined
    ? null
    : `It waits on [[${missing}]], which is not a note any more (renamed or deleted since). Edit waiting_on to the right person, or to their name as text; nothing was written.`;
}

/** Whether a note of these types is what a proposal of `kind` makes. */
function isKindOfNote(kind: NoteProposalKind, types: readonly string[] | undefined): boolean {
  return (types ?? []).some((type) => type.trim().toLowerCase() === PROPOSAL_NOTE_TYPES[kind]);
}

/**
 * The write adding the new note to its `linkFrom` relation — none when the
 * relation already links it, however the link is spelt, or when that note is
 * gone: the note is still made, since what it records is still true.
 */
function joinedRelation({
  linkFrom,
  note,
  notePaths,
  target,
}: {
  linkFrom: LinkFrom;
  note: VaultPath;
  notePaths: readonly VaultPath[];
  target: LinkTarget | null;
}): ProposalApplication {
  if (target === null) return { ok: true, writes: [] };
  if (relationLinks(target.value, notePaths).has(note)) return { ok: true, writes: [] };
  const link = `[[${wikiLinkTargetFor(note, notePaths)}]]`;
  return applyLink({ ...linkFrom, link, digest: null }, { notePaths, target });
}

/** The notes a relation's value links, each resolved as the vault resolves a link. */
function relationLinks(value: unknown, notePaths: readonly VaultPath[]): Set<VaultPath> {
  const resolved = linkedNotes(value)
    .flatMap((item) => linkTargets(item))
    .flatMap((written) => resolveWikiLinkTarget(written, notePaths) ?? []);
  return new Set(resolved);
}

function applyLink(
  payload: LinkPayload,
  { notePaths, target }: Pick<ProposalVault, 'notePaths' | 'target'>,
): ProposalApplication {
  const title = noteTitle(payload.note);
  if (target === null) return refused(`${title} is not there any more.`);
  if (payload.digest !== null && target.digest !== payload.digest) {
    return refused(`${title} changed since this was proposed, so it was left as it is.`);
  }
  if (target.relation === null) {
    return refused(`${title} has no relation called ${payload.property} to link through.`);
  }
  if (!holdsOnlyText(target.value)) {
    return refused(
      `${title}’s ${payload.property} holds something other than links, which adding one would write over; nothing was written.`,
    );
  }
  const held = linkedNotes(target.value);
  if (held.includes(payload.link) || linksSameNote(payload.link, target.value, notePaths)) {
    return refused(`${title} already links ${payload.link} in ${payload.property}.`);
  }
  // Without a digest the note may have moved on since; a link set since is a choice, kept.
  if (payload.digest === null && !target.relation.many && held.length > 0) {
    return refused(
      `${title} already links ${held[0]} in ${payload.property}; this would replace it.`,
    );
  }
  const value = withLink({ value: target.value, link: payload.link, many: target.relation.many });
  return {
    ok: true,
    writes: [{ kind: 'set', path: payload.note, changes: { [payload.property]: value } }],
  };
}

/** Whether a relation already links the note `link` means, however either is spelt. */
function linksSameNote(link: string, value: unknown, notePaths: readonly VaultPath[]): boolean {
  const [written] = linkTargets(link);
  const wanted = written === undefined ? null : resolveWikiLinkTarget(written, notePaths);
  return wanted !== null && relationLinks(value, notePaths).has(wanted);
}

/**
 * Where a note proposal's note goes: its title as a file name a wiki link can
 * reach, cut to what the disk takes, in its folder or at the top.
 */
export function newNotePath(payload: NotePayload): VaultPath {
  const stem = fitFileNameStem(linkableEntryName(payload.title), NOTE_EXTENSION);
  return joinVaultPath(payload.folder ?? VAULT_ROOT, `${stem}${NOTE_EXTENSION}`);
}

const NOTE_EXTENSION = '.md';

/**
 * The `title` a new note needs when its file name cannot say its title — a
 * `#` or a bracket made a space so a link reaches it, or a long title cut —
 * so the page still heads it exactly as proposed. None when the name says it.
 */
function titleUnsaidBy(path: VaultPath, title: string): Record<string, string> {
  const wanted = title.trim();
  return noteTitle(path) === wanted ? {} : { [TITLE_KEY]: wanted };
}

/** The payload's properties without a `type`: the kind decides what the note is. */
function withoutType(properties: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(properties).filter(([key]) => key.trim().toLowerCase() !== 'type'),
  );
}

function refused(problem: string): ProposalApplication {
  return { ok: false, problem };
}
