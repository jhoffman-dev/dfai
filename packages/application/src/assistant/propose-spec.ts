import {
  ARCHIVED_KEY,
  checkSpec,
  compileProposalIdsQuery,
  createVaultPath,
  PROPOSAL_ID_KEY,
  specProposalFor,
  splitFrontmatter,
  type SpecProblem,
  type SpecProposalKind,
  type VaultPath,
} from '@dfai/domain';
import { readProposalsFolder } from '../proposals/proposals-folder.ts';
import { loadObjectTypes } from '../types/load-types.ts';
import { writeProposals, type ProposalWritePorts } from '../proposals/write-proposals.ts';

/** A spec refused by its checker, with every problem it found, in the checker's words. */
export class SpecRefusedError extends Error {
  constructor(readonly problems: readonly SpecProblem[]) {
    super(problems.map(({ at, message }) => `${at}: ${message}`).join(' '));
    this.name = 'SpecRefusedError';
  }
}

/** Why asking for a spec wrote no proposal, and the one that stands for it, when there is one. */
export interface SpecNotProposed {
  readonly message: string;
  readonly proposal: VaultPath | null;
}

/** What asking for a dashboard or a view came to. */
export interface ProposedSpec {
  readonly kind: SpecProposalKind;
  /** What it would be called: its name, as the proposal's title. */
  readonly title: string;
  /** The proposal written; null when none was, and `problem` says why. */
  readonly proposal: VaultPath | null;
  /** Why none was written: proposed before, and what became of it, or a write that failed. */
  readonly problem: SpecNotProposed | null;
}

/**
 * Checks a dashboard or view spec (P32-05) and leaves it in the Inbox as a
 * proposal — never in `.atlas`, which only the app's Accept writes
 * (ADR-0016). A spec its checker refuses is `SpecRefusedError`, with
 * nothing written. The same spec asked for again is proposed once, and the
 * answer says what became of the first: waiting, or accepted or rejected
 * and on what day.
 */
export async function proposeSpec({
  ports,
  spec,
  madeBy,
}: {
  ports: ProposalWritePorts;
  spec: unknown;
  /** Who asked, as the proposal's `made_by` says it. */
  madeBy: string;
}): Promise<ProposedSpec> {
  const types = await loadObjectTypes({ fs: ports.fs, markdown: ports.markdown });
  const reading = checkSpec(spec, { types });
  if (!reading.ok) throw new SpecRefusedError(reading.problems);
  const { checked } = reading;
  const proposal = specProposalFor({ checked, madeBy });
  const written = await writeProposals({ ...ports, proposals: [proposal] });
  const made = written.written[0] ?? null;
  const left = written.left[0];
  const problem =
    made !== null
      ? null
      : left !== undefined
        ? { message: left.reason, proposal: null }
        : await proposedBefore(ports, proposal.id);
  return { kind: checked.kind, title: checked.payload.title, proposal: made, problem };
}

/**
 * What became of the proposal made before for `id`: found by the index (the
 * Archive) or among the proposals folder's files (the index lags a write).
 */
async function proposedBefore(ports: ProposalWritePorts, id: string): Promise<SpecNotProposed> {
  const { sql, parameters } = compileProposalIdsQuery([id]);
  const indexed = await ports.index.query(sql, parameters);
  // The folder as the disk spells it, read once (the index lags a write); then the Archive's.
  const { notes: waiting } = await readProposalsFolder(ports);
  const archived = await ports.fs.readNotes(
    indexed.rows.map((row) => createVaultPath(String(row[0]))),
  );
  for (const note of [...waiting, ...archived]) {
    const properties = ports.markdown.frontmatterProperties(
      splitFrontmatter(note.text).frontmatter,
    );
    if (properties[PROPOSAL_ID_KEY] !== id) continue;
    return { message: whatBecameOf(properties), proposal: createVaultPath(note.path) };
  }
  return { message: 'It was proposed already.', proposal: null };
}

function whatBecameOf(properties: Readonly<Record<string, unknown>>): string {
  const state = properties['state'];
  if (state !== 'accepted' && state !== 'rejected')
    return 'It is proposed already, waiting in the Inbox.';
  const day = properties[ARCHIVED_KEY];
  return typeof day === 'string'
    ? `It was already ${state} on ${day}.`
    : `It was already ${state}.`;
}
