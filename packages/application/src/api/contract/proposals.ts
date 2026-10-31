/**
 * The local API's contract for proposals waiting in the Inbox.
 *
 * One area of `../contract.ts`, which composes every area's routes and
 * answers. Everything here is data. No behaviour belongs in this file.
 */

/**
 * A proposal waiting in `Inbox/Proposals/` (P29-02, ADR-0028): what Claude or
 * an automation suggested, and what accepting it would write.
 */
export interface ApiProposal {
  readonly path: string;
  readonly kind:
    | 'task'
    | 'decision'
    | 'follow-up'
    | 'person'
    | 'link'
    | 'term'
    | 'project'
    | 'dashboard'
    | 'view';
  /** What it would do, in one line: a note's title, or `Note · property → [[Link]]`. */
  readonly headline: string;
  readonly confidence: 'high' | 'medium' | 'low' | null;
  /** The block it cites, as a link — `[[2026-10-01 Standup#^t0003]]` — or null when it cites none. */
  readonly source: string | null;
  /** The rule and run that made it. */
  readonly madeBy: string | null;
  /**
   * Why it was proposed, as the proposal's body says it — for a meeting's
   * item, whose it is and how sure that is. Empty when the body is.
   */
  readonly reason: string;
  /** What Accept writes, as the note holds it. */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly modified: number;
}

/** What answering a proposal did to the proposal: archived, or left where it was and why. */
export interface ApiProposalArchived {
  readonly proposal: string;
  /** Where it went in the Archive; null when it could not move (it is decided all the same). */
  readonly archivedAt: string | null;
  readonly archiveProblem: string | null;
}

/** What accepting a proposal wrote. */
export interface ApiAcceptedProposal extends ApiProposalArchived {
  readonly headline: string;
  /** Each note it made (`created`) or changed (`edited`). */
  readonly wrote: readonly { readonly kind: 'created' | 'edited'; readonly path: string }[];
}

/** What the routes for proposals waiting in the Inbox answer with. */
export type ApiProposalSuccessBody =
  | {
      readonly proposals: readonly ApiProposal[];
      /** Answered, yet still in Inbox/Proposals: the Archive refused them. */
      readonly stranded: readonly {
        readonly path: string;
        readonly headline: string;
        readonly state: 'accepted' | 'rejected';
      }[];
      /** Notes there that say they are proposals and cannot be read, with why. */
      readonly unreadable: readonly { readonly path: string; readonly problem: string }[];
    }
  | { readonly accepted: ApiAcceptedProposal }
  | { readonly rejected: ApiProposalArchived };

/** The routes for proposals waiting in the Inbox. */
export const PROPOSAL_ROUTES = [
  {
    method: 'GET',
    path: '/v1/proposals',
    summary: 'The open proposals in Inbox/Proposals, newest first, with what each would write.',
  },
  {
    method: 'POST',
    path: '/v1/proposals/{path}/accept',
    summary: 'Accept a proposal, as its Accept button does: write its payload, then archive it.',
  },
  {
    method: 'POST',
    path: '/v1/proposals/{path}/reject',
    summary: 'Reject a proposal: write nothing it proposed, and archive it as rejected.',
  },
] as const;
