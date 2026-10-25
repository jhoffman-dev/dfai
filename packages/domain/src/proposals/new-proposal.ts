import type { CompiledQuery } from '../query/view-query.ts';
import { digestOf } from '../sources/merge.ts';
import { withoutLatinAccents } from '../terms/spelling-folds.ts';
import { fitFileNameStem } from '../vault/file-name-bytes.ts';
import { cleanEntryName, NUMBERED_NOTE_ENDING } from '../vault/new-note.ts';
import { joinVaultPath, createVaultPath, type VaultPath } from '../vault/vault-path.ts';
import {
  payloadRecord,
  PROPOSAL_TYPE,
  PROPOSALS_FOLDER,
  type ProposalConfidence,
  type ProposalNote,
} from './proposal.ts';

/**
 * The key naming what a proposal is for, so a step that runs again proposes
 * nothing twice — even once the first was answered and archived, since a
 * rejection is an answer too.
 */
export const PROPOSAL_ID_KEY = 'proposal_id';

/** A proposal a step makes, before it is written. */
export type NewProposal = Pick<ProposalNote, 'kind' | 'payload'> & {
  readonly confidence: ProposalConfidence | null;
  /** What it cites, as a link; null when it cites none. */
  readonly source: string | null;
  readonly madeBy: string;
  /** What it is for: the same for the same proposal however often its step runs. */
  readonly id: string;
  /** Its file's name, without `.md`: what it is about, in a few words. */
  readonly name: string;
  /** Why it is proposed, in a sentence or two: the proposal note's body. */
  readonly reason: string;
  /**
   * More frontmatter its maker keeps on it — what it was drafted from
   * (`meeting_digest`, P32-05). Never one of the keys above, which win.
   */
  readonly stamp?: Readonly<Record<string, string>>;
};

/** A proposal as a note: where it goes in `Inbox/Proposals/`, its frontmatter and its body. */
export interface NewProposalFile {
  readonly path: VaultPath;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly body: string;
}

/**
 * The note a new proposal is written as, open and waiting in the Inbox
 * (ADR-0028). Its name leaves room for the number a name already taken is
 * given, so the numbered name fits a disk too. The name is spelt without
 * accents on Latin letters, as a suggested term's id compares titles (#19):
 * two runs naming one term `José` and `Jose` at once plan one path, and the
 * disk's exclusive create makes it once. The proposal's title keeps them.
 */
export function proposalFileFor(proposal: NewProposal): NewProposalFile {
  const name = cleanEntryName(withoutLatinAccents(proposal.name));
  const stem = fitFileNameStem(name || 'Proposal', NUMBERED_NOTE_ENDING);
  return {
    path: joinVaultPath(createVaultPath(PROPOSALS_FOLDER), `${stem}.md`),
    properties: {
      ...proposal.stamp,
      type: PROPOSAL_TYPE,
      kind: proposal.kind,
      state: 'open',
      ...(proposal.confidence !== null && { confidence: proposal.confidence }),
      ...(proposal.source !== null && { source: proposal.source }),
      made_by: proposal.madeBy,
      [PROPOSAL_ID_KEY]: proposal.id,
      payload: payloadRecord(proposal.payload),
    },
    body: proposal.reason === '' ? '' : `${proposal.reason}\n`,
  };
}

/**
 * The key a proposal drafted from a meeting on demand keeps what it was
 * drafted from by (P32-05): asked again about the same meeting with the same
 * words, nothing is asked.
 */
export const MEETING_DIGEST_KEY = 'meeting_digest';

/**
 * What a meeting was drafted from: which meeting — its provider and id when
 * the import gave it them, which filing does not change, else its path — and
 * its words. Two hashes of the same text, as a Claude proposal's id is, so
 * two meetings' collision needs both to meet; JSON, so no meeting's name can
 * be taken for another's words.
 */
export function meetingDraftDigest({
  meeting,
  words,
}: {
  meeting: { readonly provider: string; readonly externalId: string } | { readonly path: string };
  words: string;
}): string {
  const which =
    'path' in meeting ? ['path', meeting.path] : ['meeting', meeting.provider, meeting.externalId];
  const what = JSON.stringify([...which, words]);
  return `meeting-${digestOf(`a${what}`)}${digestOf(`b${what}`)}`;
}

/**
 * The proposals, anywhere in the vault — the Archive too — whose `key` is
 * `value`: notes of the proposal type only, so another note carrying the key
 * never counts. Columns: path.
 */
export function compileProposalsStampedQuery(key: string, value: string): CompiledQuery {
  return {
    sql: `/* proposals: stamped */ SELECT stamped.path AS "path" FROM props AS stamped
 JOIN props AS kind ON kind.path = stamped.path AND kind.key = 'type'
  AND lower(trim(kind.value_text)) = ?
 WHERE stamped.key = ? AND stamped.value_text = ? ORDER BY stamped.path`,
    parameters: [PROPOSAL_TYPE, key, value],
  };
}

/**
 * The proposals, anywhere in the vault — the Archive too, where answered ones
 * go — that are for any of these ids. Columns: path, id. Every id is bound.
 */
export function compileProposalIdsQuery(ids: readonly string[]): CompiledQuery {
  return {
    sql: `/* proposals: ids */ SELECT path AS "path", value_text AS "id" FROM props
 WHERE key = ? AND value_text IN (${ids.map(() => '?').join(', ')}) ORDER BY path`,
    parameters: [PROPOSAL_ID_KEY, ...ids],
  };
}
