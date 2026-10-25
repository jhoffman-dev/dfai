import {
  ANSWERED_VIA_KEY,
  acceptRefusal,
  applyProposal,
  foldedVaultPath,
  isNoteProposal,
  isSpecProposal,
  linkedTaskOwner,
  madeTaskFor,
  MEETING_TASKS_KEY,
  messageOf,
  newNotePath,
  payloadRecord,
  proposalHeadline,
  readProposalPayload,
  splitFrontmatter,
  vaultSpellingOf,
  type ProposalAnswerer,
  type ProposalNote,
  type VaultPath,
} from '@dfai/domain';
import { ProposalRefused, type AppliedProposal } from '../chat/proposals.ts';
import { unarchiveNotes } from '../archive/index.ts';
import {
  makeTaskFromMeeting,
  type MeetingItemTask,
  type TaskMeeting,
} from '../meetings/make-task-from-meeting.ts';
import { readMadeItems } from '../meetings/made-items.ts';
import { listVaultNotes } from '../vault/read-vault.ts';
import { refuseOutdatedTerm } from './accept-term.ts';
import { pointedAtItsMeeting, relationChanged } from './proposal-meeting.ts';
import { specVault } from './spec-vault.ts';
import {
  archiveProposal,
  readOpenProposal,
  refuseUnsaved,
  stampProposal,
  type ProposalArchived,
  type ProposalPorts,
} from './proposal-file.ts';
import {
  carryOut,
  heldToTaskRules,
  proposalHomeFolder,
  readLinkNote,
  takeBackAll,
  takenBack,
} from './proposal-writes.ts';

/**
 * A proposal only the app may accept — a dashboard or a view, written into
 * `.atlas` — answered from elsewhere. Nothing was written.
 */
export class AcceptedOnlyInAppError extends ProposalRefused {}

/** What accepting a proposal did, kept so it can be undone in one step. */
export interface AcceptedProposal extends ProposalArchived {
  /** Where the proposal was while it waited. */
  readonly proposal: VaultPath;
  /** What it proposed, in one line. */
  readonly headline: string;
  /** What Accept wrote, each with what undoing it needs. */
  readonly wrote: readonly AppliedProposal[];
}

/** The types of the note already at the path a joining note proposal would make; none when nothing is there. */
async function typesHeldAtNewNote(
  ports: ProposalPorts,
  { proposal, notePaths }: { proposal: ProposalNote; notePaths: readonly VaultPath[] },
): Promise<readonly string[] | undefined> {
  // Only a person is linked when already there: any other note of that name is not this one.
  if (proposal.kind !== 'person' || proposal.payload.linkFrom === null) return undefined;
  const folded = foldedVaultPath(newNotePath(proposal.payload));
  const held = notePaths.find((note) => foldedVaultPath(note) === folded);
  if (held === undefined) return undefined;
  const { text } = await ports.fs.readTextFile(held);
  const type = ports.markdown.frontmatterProperties(splitFrontmatter(text).frontmatter)['type'];
  return (Array.isArray(type) ? type : [type]).filter((item) => typeof item === 'string');
}

/**
 * Accepts the proposal at `path`: writes what its payload says — or `payload`,
 * when it was edited first — marks it `state: accepted` and files it in the
 * Archive (P29-02).
 *
 * Nothing is written over. A note made since at the path a new one would
 * take, or a note a link proposal changes that has changed since the proposal
 * was made, refuses the whole accept with the reason; so does unsaved typing
 * in the proposal or the note it changes. Two accepts of one proposal at once
 * make one write: the second finds the note the first made, or the proposal
 * already accepted.
 *
 * What it writes is held to the task rules (ADR-0029) as every write that
 * makes or changes a task is: a task Waiting with nobody to wait on is
 * written as proposed (#202), and one made already finished is dated — or,
 * when it repeats, rolled on to its next date as ticking it done would.
 */
export async function acceptProposalNote({
  ports,
  path,
  today,
  via,
  payload,
}: {
  ports: ProposalPorts;
  path: VaultPath;
  today: string;
  /**
   * Who answered — the app's buttons or the local API — recorded on the
   * proposal as `answered_via`. Always said: a dashboard or view proposal is
   * accepted only by the app's.
   */
  via: ProposalAnswerer;
  /** The payload as edited, in place of the proposal's own. */
  payload?: unknown;
}): Promise<AcceptedProposal> {
  const file = await readOpenProposal(ports, path);
  const notHere = acceptRefusal(file.proposal.kind, via);
  if (notHere !== null) throw new AcceptedOnlyInAppError(notHere);
  refuseUnsaved(ports.editors, path);
  const notePaths = await listVaultNotes({ fs: ports.fs });
  const asked = payload === undefined ? file.proposal : edited(file.proposal, payload);
  const meeting = await pointedAtItsMeeting({ ports, proposal: asked, notePaths });
  const proposal = spelledAsVault(meeting, notePaths);
  await refuseAlreadyMade(ports, { file: { ...file, path }, proposal, notePaths, today, via });
  await refuseOutdatedTerm(ports, { proposal, notePaths });
  const headline = proposalHeadline(proposal);
  const wrote = await writeAccepted(ports, { proposal, notePaths, today, headline });
  await stampProposal(
    ports,
    { ...file, path },
    {
      state: 'accepted',
      [ANSWERED_VIA_KEY]: via,
      ...(payload !== undefined && { payload: payloadRecord(proposal.payload) }),
    },
  ).catch(async (cause: unknown) => {
    throw await takenBack(ports, { wrote, headline, cause });
  });
  const archived = await archiveProposal({ ports, path, today });
  return { proposal: path, headline, wrote, ...archived };
}

/**
 * Undoes an accept: takes back what it wrote — if nothing has changed it
 * since — and puts the proposal back in the Inbox, open again. Answers where
 * the proposal is now.
 */
export async function undoAcceptedProposal({
  ports,
  accepted,
}: {
  ports: ProposalPorts;
  accepted: AcceptedProposal;
}): Promise<VaultPath> {
  await takeBackAll(ports, accepted.wrote);
  const back = await backFromArchive(ports, accepted);
  await reopen(ports, back).catch((cause: unknown) => {
    throw new ProposalRefused(
      `What it made was taken back and the proposal is at ${back}, but it could not be marked open again: ${messageOf(cause)}`,
    );
  });
  return back;
}

/**
 * What accepting writes, each write made once nothing can refuse it. A task
 * from a meeting's action item, while that meeting is there to join, is made
 * the one way such a task is made (#177); anything else as its payload says.
 */
async function writeAccepted(
  ports: ProposalPorts,
  {
    proposal,
    notePaths,
    today,
    headline,
  }: { proposal: ProposalNote; notePaths: readonly VaultPath[]; today: string; headline: string },
): Promise<readonly AppliedProposal[]> {
  const fromMeeting = meetingItemOf(proposal, notePaths);
  if (fromMeeting !== null) {
    return (await makeTaskFromMeeting({ ports, ...fromMeeting, notePaths, today })).wrote;
  }
  const joins = relationChanged(proposal);
  const link = joins === null ? null : await readLinkNote(ports, joins);
  const heldTypes = await typesHeldAtNewNote(ports, { proposal, notePaths });
  const homeFolder = isNoteProposal(proposal)
    ? await proposalHomeFolder(ports, { kind: proposal.kind, payload: proposal.payload, today })
    : null;
  const applied = applyProposal(proposal, {
    notePaths,
    target: link?.target ?? null,
    heldTypes,
    homeFolder,
    ...(isSpecProposal(proposal) && (await specVault(ports, proposal.kind))),
  });
  if (!applied.ok) throw new ProposalRefused(applied.problem);

  const ruled = applied.writes.map((write) => heldToTaskRules(ports, { write, link, today }));
  return carryOut(ports, { writes: ruled, link, headline });
}

/**
 * A task or follow-up proposed from a meeting's action item, as the task
 * made from it — when it joins the meeting's `tasks` and that meeting is in
 * the vault. A meeting gone altogether is left to the proposal's own rules:
 * the task is still made. Accept writes no `atlas_item`: a proposal keeps
 * whose item it was only inside its id.
 */
function meetingItemOf(
  proposal: ProposalNote,
  notePaths: readonly VaultPath[],
): { meeting: TaskMeeting; item: MeetingItemTask } | null {
  if (proposal.kind !== 'task' && proposal.kind !== 'follow-up') return null;
  const { payload, source } = proposal;
  const joins = payload.linkFrom;
  if (source === null || joins?.meeting === undefined) return null;
  if (joins.property !== MEETING_TASKS_KEY || !notePaths.includes(joins.note)) return null;
  return {
    meeting: { path: joins.note, identity: joins.meeting },
    item: {
      kind: proposal.kind,
      title: payload.title,
      folder: payload.folder,
      properties: payload.properties,
      body: payload.body,
      source,
      atlasItem: null,
    },
  };
}

/**
 * Refuses a leftover proposal for a meeting item whose task the declared
 * step has made already (ADR-0036, "Two sources of truth"): the same item and
 * title. The proposal is answered — marked rejected, saying who answered —
 * and archived, and no second task is made.
 */
async function refuseAlreadyMade(
  ports: ProposalPorts,
  {
    file,
    proposal,
    notePaths,
    today,
    via,
  }: {
    file: Parameters<typeof stampProposal>[1];
    proposal: ProposalNote;
    notePaths: readonly VaultPath[];
    today: string;
    via: ProposalAnswerer;
  },
): Promise<void> {
  const fromMeeting = meetingItemOf(proposal, notePaths);
  if (fromMeeting === null) return;
  const { meeting, item } = fromMeeting;
  const made = madeTaskFor({
    meeting: meeting.identity,
    source: item.source,
    owner: linkedTaskOwner(item.properties),
    title: item.title,
    madeItems: await readMadeItems(ports),
  });
  if (made === null) return;
  await stampProposal(ports, file, { state: 'rejected', [ANSWERED_VIA_KEY]: via });
  await archiveProposal({ ports, path: file.path, today });
  throw new ProposalRefused(
    `“${item.title}” is already a task, made from the same item of the meeting; the proposal was archived and nothing else was written.`,
  );
}

/** Marks the proposal open again, with no record of the answer undone. */
export async function reopen(ports: ProposalPorts, path: VaultPath): Promise<void> {
  const { text, modified } = await ports.fs.readTextFile(path);
  await stampProposal(
    ports,
    { path, document: splitFrontmatter(text), modified },
    { state: 'open', [ANSWERED_VIA_KEY]: null },
  );
}

/** The proposal with an edited payload, held to the rules its own was. */
function edited(proposal: ProposalNote, payload: unknown): ProposalNote {
  const reading = readProposalPayload(proposal.kind, payload);
  if (!reading.ok) throw new ProposalRefused(reading.problem);
  return { ...proposal, payload: reading.payload } as ProposalNote;
}

/**
 * A link proposal — or a note proposal's `linkFrom` — names its note as its
 * maker spelled it; the disk a Mac vault lives on ignores case, but the panes
 * know each note by one spelling. The note is named as the vault spells it,
 * so its pane is the one asked about typing and the one reloaded.
 */
function spelledAsVault(proposal: ProposalNote, notePaths: readonly VaultPath[]): ProposalNote {
  const spelled = (note: VaultPath) => vaultSpellingOf(note, notePaths);
  if (proposal.kind === 'link') {
    const note = spelled(proposal.payload.note) ?? proposal.payload.note;
    return { ...proposal, payload: { ...proposal.payload, note } };
  }
  if (!isNoteProposal(proposal)) return proposal;
  const { linkFrom } = proposal.payload;
  if (linkFrom === null) return proposal;
  const joined = { ...linkFrom, note: spelled(linkFrom.note) ?? linkFrom.note };
  return { ...proposal, payload: { ...proposal.payload, linkFrom: joined } };
}

/** Where the proposal is once it is out of the Archive — or where it stayed, when it never went. */
export async function backFromArchive(
  ports: ProposalPorts,
  accepted: ProposalArchived & { readonly proposal: VaultPath },
  lead = 'What it made was taken back, but the proposal stays in the Archive',
): Promise<VaultPath> {
  if (accepted.archivedAt === null) return accepted.proposal;
  const outcome = await unarchiveNotes({
    ports,
    paths: [accepted.archivedAt],
    notePaths: await listVaultNotes({ fs: ports.fs }),
    unsavedTyping: 'leave',
  });
  const back = outcome.moves[0]?.move.to;
  if (back === undefined) {
    const why = outcome.failed[0]?.reason ?? 'it could not be moved';
    throw new ProposalRefused(`${lead}: ${why}`);
  }
  return back;
}
