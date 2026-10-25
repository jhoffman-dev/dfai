import {
  isProposalPath,
  noteTitle,
  payloadRecord,
  proposalHeadline,
  type VaultPath,
} from '@dfai/domain';
import { ProposalRefused } from '../chat/proposals.ts';
import {
  AcceptedOnlyInAppError,
  acceptProposalNote,
  listProposals,
  rejectProposalNote,
  type ListedProposal,
  type ProposalArchived,
  type ProposalPorts,
} from '../proposals/index.ts';
import { ApiError } from './api-error.ts';
import { archivePorts } from './archive.ts';
import type { ApiProposal, ApiProposalArchived } from './contract.ts';
import { notePathOf, readNote } from './note-io.ts';
import type { RouteResult, VaultRequest } from './vault-request.ts';

/**
 * Proposals through the API (P29-02, ADR-0028): listed, accepted and
 * rejected by the same use-cases as the Inbox's Proposals section. Accepting writes a
 * note in user space through the byte-preserving paths and moves only the
 * proposal, into the Archive (ADR-0016's amendment).
 */

/** The open proposals, newest first, and the proposal notes that cannot be read. */
export async function proposalsRoute(request: VaultRequest): Promise<RouteResult> {
  const listing = await listProposals({ fs: request.fs, markdown: request.markdown });
  request.assertStillOpen();
  return {
    status: 200,
    body: {
      proposals: listing.open.map(apiProposal),
      stranded: listing.stranded.map(({ proposal }) => ({
        path: proposal.path,
        headline: proposalHeadline(proposal),
        state: proposal.state === 'rejected' ? ('rejected' as const) : ('accepted' as const),
      })),
      unreadable: listing.unreadable,
    },
  };
}

/** Accepts a proposal as its Accept button does: what it proposes is written, and it is archived. */
export async function acceptProposalRoute(request: VaultRequest): Promise<RouteResult> {
  const { ports, path } = await answerable(request);
  const accepted = await answered(() =>
    acceptProposalNote({ ports, path, today: request.clock.today(), via: 'api' }),
  );
  return {
    status: 200,
    body: {
      accepted: {
        ...archived(path, accepted),
        headline: accepted.headline,
        wrote: accepted.wrote.map(({ kind, path: wrote }) => ({ kind, path: wrote })),
      },
    },
  };
}

/** Rejects a proposal: nothing it proposed is written, and it is archived as rejected. */
export async function rejectProposalRoute(request: VaultRequest): Promise<RouteResult> {
  const { ports, path } = await answerable(request);
  const rejected = await answered(() =>
    rejectProposalNote({ ports, path, today: request.clock.today(), via: 'api' }),
  );
  return { status: 200, body: { rejected: archived(path, rejected) } };
}

/**
 * The proposal a request names, and the ports to answer it through, refused
 * as the caller can act on it: a path outside `Inbox/Proposals` is `invalid`,
 * one with no note `not_found`, and one with typing unsaved in DFAI
 * `unsaved_in_app` — the API never saves someone's typing.
 */
async function answerable(
  request: VaultRequest,
): Promise<{ ports: ProposalPorts; path: VaultPath }> {
  const path = await notePathOf(request);
  if (!isProposalPath(path)) throw new ApiError('invalid', `${path} is not in Inbox/Proposals`);
  await readNote(request, path);
  const ports = archivePorts(request);
  if (ports.editors.state(path) === 'dirty') {
    throw new ApiError(
      'unsaved_in_app',
      `${noteTitle(path)} is open in DFAI with unsaved typing; it was left as it is.`,
    );
  }
  return { ports, path };
}

/**
 * Runs an answer, turning a refusal into `conflict`: each one — decided
 * already, a note already where one would go, a note changed since the
 * proposal was made — says the vault is not as the proposal expected.
 * Anything else, a vault switched part-way among it, is the router's to
 * answer. An answer that finished is given even after a switch: what it
 * wrote landed in the vault it named, as an archive batch's moves do.
 */
async function answered<T>(answer: () => Promise<T>): Promise<T> {
  try {
    return await answer();
  } catch (error) {
    // A dashboard or a view is written into .atlas, which only the app's own Accept writes.
    if (error instanceof AcceptedOnlyInAppError) throw new ApiError('forbidden', error.message);
    if (error instanceof ProposalRefused) throw new ApiError('conflict', error.message);
    throw error;
  }
}

function archived(path: VaultPath, outcome: ProposalArchived): ApiProposalArchived {
  return {
    proposal: path,
    archivedAt: outcome.archivedAt,
    archiveProblem: outcome.archiveProblem,
  };
}

function apiProposal({ proposal, modified, reason }: ListedProposal): ApiProposal {
  return {
    path: proposal.path,
    kind: proposal.kind,
    headline: proposalHeadline(proposal),
    confidence: proposal.confidence,
    source: proposal.source,
    madeBy: proposal.madeBy,
    reason,
    payload: payloadRecord(proposal.payload),
    modified,
  };
}
