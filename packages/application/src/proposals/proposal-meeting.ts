import {
  compileMeetingHoldersQuery,
  createVaultPath,
  isConflictCopyPath,
  linkTargets,
  noteTitle,
  proposedChangeRefusal,
  resolveWikiLinkTarget,
  vaultSpellingOf,
  isNoteProposal,
  type LinkFrom,
  type MeetingIdentity,
  type ProposalNote,
  type VaultPath,
} from '@dfai/domain';
import { holdingAt } from '../meetings/meeting-files.ts';
import { ProposalRefused } from '../chat/proposals.ts';
import type { ProposalPorts } from './proposal-file.ts';

/** The relation a proposal changes on a note it names: a link proposal's own, or a new note's `linkFrom`. */
export function relationChanged(proposal: ProposalNote): LinkFrom | null {
  if (proposal.kind === 'link') return proposal.payload;
  return isNoteProposal(proposal) ? proposal.payload.linkFrom : null;
}

/**
 * The proposal, pointed at the meeting it was made for as that meeting is
 * now — or refused.
 *
 * A proposal made from a meeting names the meeting by its path in the Inbox
 * and by its provider and id. The path stops being true once the meeting is
 * filed, and may then be a different meeting that landed there since; the id
 * is what the meeting is. Everything on the proposal is input a person or a
 * sync may have edited, so the note written is never one it merely points
 * at: it is a note that holds this very meeting (the file itself is read to
 * know) and that the import has let in (stamped `imported`), outside the
 * Archive and the other places a proposal never writes. A file of the same
 * meeting the import has not let in — a second delivery waiting where the
 * first landed — is not the meeting yet, and may be about to be archived as
 * a copy: it is never chosen, whatever the proposal's path says.
 * The card names the meeting by its title, which filing does not change.
 *
 * Refused, in words: a meeting now only in the Archive, one that is more than
 * one note, one held only by a note the import has not let in, and a path
 * that holds some other meeting. A meeting that is gone
 * altogether is left to the proposal's own rules (a link proposal says so; a
 * person is still made). A proposal that names no meeting is left as it is.
 */
export async function pointedAtItsMeeting({
  ports,
  proposal,
  notePaths,
}: {
  ports: ProposalPorts;
  proposal: ProposalNote;
  notePaths: readonly VaultPath[];
}): Promise<ProposalNote> {
  const joins = relationChanged(proposal);
  const meeting = joins?.meeting;
  if (joins === null || meeting === undefined) return proposal;
  const named = vaultSpellingOf(joins.note, notePaths) ?? joins.note;
  const hints = [named, ...pointedAtBySource(proposal.source, notePaths)];
  const holders = await holdersOf(ports, { meeting, hints });
  const live = holders.filter(({ path }) => proposedChangeRefusal(path) === null);
  const letIn = live.filter(({ held }) => held === 'imported').map(({ path }) => path);
  const title = noteTitle(joins.note);
  const chosen = letIn.find((holder) => hints.includes(holder)) ?? letIn[0];
  if (letIn.length > 1 && !hints.some((hint) => letIn.includes(hint))) {
    throw new ProposalRefused(
      `More than one note holds the meeting “${title}”, so it is not clear which this is for; nothing was written.`,
    );
  }
  if (chosen !== undefined) return withNote(proposal, chosen);
  if (holders.some(({ held }) => held === 'imported')) {
    throw new ProposalRefused(
      `The meeting “${title}” has been archived; a proposal does not write there, so nothing was written.`,
    );
  }
  if (holders.length > 0) {
    throw new ProposalRefused(
      `The meeting “${title}” has not been let in by the import yet: the only note holding it is still waiting to be imported, so nothing was written.`,
    );
  }
  if (notePaths.includes(named)) {
    throw new ProposalRefused(
      `${named} is no longer the meeting this was proposed for; nothing was written.`,
    );
  }
  return proposal;
}

/** The note a proposal's `source` link names, resolved: a hint at where a filed meeting went, never trusted. */
function pointedAtBySource(source: string | null, notePaths: readonly VaultPath[]): VaultPath[] {
  const [target] = source === null ? [] : linkTargets(source);
  const resolved =
    target === undefined ? null : resolveWikiLinkTarget(target.replace(/#.*$/, ''), notePaths);
  return resolved === null ? [] : [resolved];
}

/**
 * Every note that holds the meeting now. The index names where it was when it
 * last read the vault, which lags a move; the proposal's own hints are
 * checked too. Each is read: it holds the meeting only if its own keys say so.
 */
async function holdersOf(
  ports: ProposalPorts,
  { meeting, hints }: { meeting: MeetingIdentity; hints: readonly VaultPath[] },
): Promise<Holder[]> {
  const indexed = await indexedHolders(ports, meeting);
  const holders: Holder[] = [];
  for (const candidate of new Set([...hints, ...indexed])) {
    if (isConflictCopyPath(candidate)) continue;
    const held = await holdingAt(ports, { holder: candidate, meeting });
    if (held !== null) holders.push({ path: candidate, held });
  }
  return holders;
}

/** A note that holds the meeting, and whether the import has let it in. */
interface Holder {
  readonly path: VaultPath;
  readonly held: 'imported' | 'unsettled';
}

async function indexedHolders(
  ports: ProposalPorts,
  meeting: MeetingIdentity,
): Promise<VaultPath[]> {
  const { sql, parameters } = compileMeetingHoldersQuery(meeting);
  try {
    const found = await ports.index.query(sql, parameters);
    return found.rows.map((row) => createVaultPath(String(row[0])));
  } catch {
    // The index only says where to look: when it cannot, the places the proposal names are still checked.
    return [];
  }
}

function withNote(proposal: ProposalNote, note: VaultPath): ProposalNote {
  if (proposal.kind === 'link') return { ...proposal, payload: { ...proposal.payload, note } };
  if (!isNoteProposal(proposal)) return proposal;
  const { linkFrom } = proposal.payload;
  if (linkFrom === null) return proposal;
  return { ...proposal, payload: { ...proposal.payload, linkFrom: { ...linkFrom, note } } };
}
