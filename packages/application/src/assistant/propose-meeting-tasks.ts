import {
  compileProposalsStampedQuery,
  isMeetingType,
  isProposalNote,
  MEETING_DIGEST_KEY,
  meetingDraftDigest,
  meetingIdentityOf,
  sameMeetingIdentity,
  MEETING_EXTRACTION_PROMPT,
  splitFrontmatter,
  type ClaudeAction,
  type MeetingIdentity,
  type DroppedItem,
  type NoteSkipped,
  type VaultPath,
} from '@dfai/domain';
import {
  ClaudeStepFailed,
  runClaudeStep,
  type ClaudeStepPorts,
} from '../automations/claude-step.ts';
import type { NoteWritePorts } from '../proposals/proposal-writes.ts';
import type { ProposalWritePorts } from '../proposals/write-proposals.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import { readProposalsFolder } from '../proposals/proposals-folder.ts';
import { listVaultNotes } from '../vault/read-vault.ts';
import { VaultAccessError } from '../vault/ports.ts';
import { AssistantEntityError } from './read-entity.ts';

/**
 * What its proposals are for, so asking again proposes nothing twice. The
 * meeting-items schema leaves the rule out of a proposal's id (it is shared
 * across rules), so an item the meeting extraction rule proposed already is
 * not proposed again here either.
 */
export const PROPOSE_TASKS_RULE = 'assistant-propose-tasks';

/**
 * The P29-05 extraction, as one meeting's Claude step: the built-in prompt,
 * no tools, every item a proposal. Never `apply: mine` — on demand, nothing
 * is made without an Accept.
 */
const MEETING_TASKS: ClaudeAction = {
  kind: 'claude',
  prompt: MEETING_EXTRACTION_PROMPT,
  tools: [],
  output: { kind: 'proposals', schema: 'meeting-items' },
};

/** What drafting one meeting's tasks came to. */
export interface ProposedTasks {
  readonly meeting: VaultPath;
  /** The proposals written into `Inbox/Proposals/`. */
  readonly proposed: readonly VaultPath[];
  /** How many the answer held that were proposed before — open or answered — and so were not again. */
  readonly alreadyProposed: number;
  /**
   * True when Claude was not asked at all: the meeting's words are those it
   * was drafted from before, and `alreadyProposed` counts what that made.
   */
  readonly unchanged: boolean;
  /** Items left out of the answer, each with why: one citing no turn of this meeting, say. */
  readonly dropped: readonly DroppedItem[];
  /** Why the meeting was not asked about at all — a meeting with no transcript to cite. */
  readonly left: readonly NoteSkipped[];
  readonly warnings: readonly string[];
}

/** Whether two reads of a path are one meeting, by provider and id; two without ids are taken as one. */
function sameIdentity(a: MeetingIdentity | null, b: MeetingIdentity | null): boolean {
  if (a === null || b === null) return a === b;
  return sameMeetingIdentity(a, b);
}

/** The meeting went while Claude drafted it: nothing it proposed was written. */
export class MeetingGoneError extends Error {
  constructor(meeting: VaultPath, why: 'gone' | 'replaced' = 'gone') {
    super(
      why === 'gone'
        ? `${meeting} is not there any more, so nothing it proposed was written.`
        : `${meeting} is another meeting now, so nothing it proposed was written.`,
    );
    this.name = 'MeetingGoneError';
  }
}

type DraftPorts = ProposalWritePorts & Pick<NoteWritePorts, 'editors'> & { markdown: MarkdownPort };

/**
 * Drafts the tasks, waiting-fors, decisions and follow-ups of one meeting as
 * proposals (P32-05): the meeting extraction (P29-05) run on demand, its
 * answer checked against the meeting's own turns. Only proposals are
 * written; each waits in the Inbox for Accept, and keeps the digest of the
 * meeting's words it was drafted from (`meeting_digest`). Asked again about
 * words unchanged, Claude is not asked: what was made then is counted.
 *
 * Refuses, writing nothing, a note that is not there or not a meeting
 * (`AssistantEntityError`), and fails as the step fails (`ClaudeStepFailed`):
 * no provider ready, an answer that does not read. Right before it writes it
 * asks `beforeWrite` (the caller's own check: is its vault still open?) and
 * whether the meeting is still there (`MeetingGoneError`); either refusing
 * stops it with nothing written.
 */
export async function proposeMeetingTasks({
  ports,
  claude,
  meeting,
  madeBy,
  beforeWrite,
}: {
  ports: DraftPorts;
  claude: ClaudeStepPorts;
  meeting: VaultPath;
  /** Who asked, as each proposal's `made_by` says it. */
  madeBy: string;
  /** Rejects to stop the draft before its first write; left out, only the meeting is checked. */
  beforeWrite?: () => Promise<void>;
}): Promise<ProposedTasks> {
  const read = await meetingRead(ports, meeting);
  const digest = meetingDraftDigest({
    meeting: read.identity ?? { path: meeting },
    words: read.words,
  });
  const before = await draftedFrom(ports, digest);
  if (before > 0) return { ...NOTHING_NEW, meeting, alreadyProposed: before, unchanged: true };
  // What stopped it before its first write, raised as it is: the step reports it as its own failure.
  let stopped: unknown = undefined;
  const gate = async () => {
    try {
      await beforeWrite?.();
      const now = await meetingRead(ports, meeting).catch((error: unknown) => {
        throw error instanceof AssistantEntityError ? new MeetingGoneError(meeting) : error;
      });
      // Another meeting at the path — the first deleted, a new one written there — is not the one drafted.
      if (!sameIdentity(now.identity, read.identity))
        throw new MeetingGoneError(meeting, 'replaced');
    } catch (error) {
      stopped = error;
      throw error;
    }
  };
  const outcome = await runClaudeStep({
    ...ports,
    ports: claude,
    action: MEETING_TASKS,
    paths: [meeting],
    notePaths: await listVaultNotes({ fs: ports.fs }),
    rule: PROPOSE_TASKS_RULE,
    madeBy,
    stamp: { [MEETING_DIGEST_KEY]: digest },
    beforeWrite: gate,
  }).catch((error: unknown) => {
    throw error instanceof ClaudeStepFailed &&
      stopped !== undefined &&
      error.interruption === stopped
      ? stopped
      : error;
  });
  return {
    meeting,
    proposed: outcome.done.flatMap((done) => (done.kind === 'proposed' ? [done.path] : [])),
    alreadyProposed: outcome.claude.alreadyMade ?? 0,
    unchanged: false,
    dropped: outcome.claude.dropped ?? [],
    left: outcome.left,
    warnings: outcome.claude.warnings ?? [],
  };
}

const NOTHING_NEW = { proposed: [], dropped: [], left: [], warnings: [] } as const;

/**
 * How many proposals, open or answered, were drafted from these words: the
 * index for those in the Archive, and the proposals folder's own files, since
 * the index lags a write made a moment ago. Counted once each.
 */
async function draftedFrom(ports: DraftPorts, digest: string): Promise<number> {
  const { sql, parameters } = compileProposalsStampedQuery(MEETING_DIGEST_KEY, digest);
  const indexed = await ports.index.query(sql, parameters);
  const found = new Set(indexed.rows.map((row) => String(row[0])));
  // The folder as the disk spells it, read once; a vault with none reads as empty.
  const { notes } = await readProposalsFolder(ports);
  for (const note of notes) {
    const properties = ports.markdown.frontmatterProperties(
      splitFrontmatter(note.text).frontmatter,
    );
    if (isProposalNote(properties) && properties[MEETING_DIGEST_KEY] === digest) {
      found.add(note.path);
    }
  }
  return found.size;
}

/**
 * The meeting as a draft is keyed by: its words — its body, without the
 * frontmatter Accept writes its tasks into — and which meeting it is, by
 * provider and id when it has them. Refused when it is not there or not a
 * meeting.
 */
async function meetingRead(
  { fs, markdown }: DraftPorts,
  path: VaultPath,
): Promise<{ words: string; identity: MeetingIdentity | null }> {
  const text = await fs.readTextFile(path).then(
    (read) => read.text,
    (error: unknown) => {
      if (error instanceof VaultAccessError) {
        throw new AssistantEntityError('not_found', `No note at ${path}`);
      }
      throw error;
    },
  );
  const { frontmatter, body } = splitFrontmatter(text);
  const properties = markdown.frontmatterProperties(frontmatter);
  if (!isMeetingType(properties['type'])) {
    throw new AssistantEntityError('not_a_page', `${path} is not a meeting note.`);
  }
  return { words: body, identity: meetingIdentityOf(properties) };
}
