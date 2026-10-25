import { ANSWERED_VIA_KEY, messageOf, type ProposalAnswerer, type VaultPath } from '@dfai/domain';
import { ProposalRefused } from '../chat/proposals.ts';
import { backFromArchive, reopen } from './accept-proposal.ts';
import {
  archiveProposal,
  readOpenProposal,
  refuseUnsaved,
  stampProposal,
  type ProposalArchived,
  type ProposalPorts,
} from './proposal-file.ts';

/**
 * Rejects the proposal at `path`: writes nothing it proposed, marks it
 * `state: rejected` and files it in the Archive, where it is kept rather than
 * deleted (P29-02).
 */
export async function rejectProposalNote({
  ports,
  path,
  today,
  via,
}: {
  ports: ProposalPorts;
  path: VaultPath;
  today: string;
  /** Who answered — the app's buttons or the local API — recorded on the proposal as `answered_via`. */
  via: ProposalAnswerer;
}): Promise<RejectedProposal> {
  const file = await readOpenProposal(ports, path);
  refuseUnsaved(ports.editors, path);
  await stampProposal(
    ports,
    { ...file, path },
    {
      state: 'rejected',
      [ANSWERED_VIA_KEY]: via,
    },
  );
  const archived = await archiveProposal({ ports, path, today });
  return { proposal: path, ...archived };
}

/** What rejecting a proposal did, kept so it can be taken back. */
export interface RejectedProposal extends ProposalArchived {
  /** Where the proposal was while it waited. */
  readonly proposal: VaultPath;
}

/**
 * Takes back a reject: the proposal leaves the Archive and is open again, as
 * if never answered. Answers where it is now.
 */
export async function undoRejectedProposal({
  ports,
  rejected,
}: {
  ports: ProposalPorts;
  rejected: RejectedProposal;
}): Promise<VaultPath> {
  const back = await backFromArchive(ports, rejected, 'The proposal stays in the Archive');
  await reopen(ports, back).catch((cause: unknown) => {
    throw new ProposalRefused(
      `The proposal is back at ${back}, but it could not be marked open again: ${messageOf(cause)}`,
    );
  });
  return back;
}
