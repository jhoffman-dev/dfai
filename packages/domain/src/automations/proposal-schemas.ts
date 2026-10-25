/**
 * The proposal schemas a rule's `output:` can name (P29-03). `proposals` is
 * the general one: any note a proposal can make, said field by field;
 * `meeting-items` (P29-05, `meeting-items.ts`) is what Claude pulls out of a
 * meeting, and `meeting-digest` (#184, `meeting-digest.ts`) is that with a
 * summary of the meeting beside it. A new kind of answer is a schema of its own
 * (`ProposalSchema`: its item keys, its `readItem`, its `draftsOf` — any number
 * per item — and, if it cites differently, its own `citation` words), added to
 * {@link PROPOSAL_SCHEMAS} under its name. One whose proposals should be linked
 * from the meeting they came from lists the meeting's relations in
 * `meetingRelations` and sets `joinsMeeting` on a draft: the shared check adds
 * the link, for the meeting the draft cites, by the identity the run read.
 */

import {
  isSpecProposalKind,
  PROPOSAL_KINDS,
  type NoteProposalKind,
} from '../proposals/proposal.ts';
import { MEETING_DIGEST } from './meeting-digest.ts';
import { MEETING_ITEMS } from './meeting-items.ts';
import {
  isRecord,
  refused,
  registerProposalSchema,
  type ProposalSchema,
  type Reading,
  type RegisteredProposalSchema,
} from './proposal-schema.ts';

/**
 * The kinds the general schema proposes: every kind that makes a note in user
 * space. Never a dashboard or a view: an unattended step does not ask for
 * entries in `.atlas` (P32-05).
 */
const NOTE_KINDS = PROPOSAL_KINDS.filter(
  (kind): kind is NoteProposalKind => kind !== 'link' && !isSpecProposalKind(kind),
);

interface GeneralItem {
  readonly kind: NoteProposalKind;
  readonly title: unknown;
  readonly folder: unknown;
  readonly properties: unknown;
  readonly body: unknown;
  readonly source: string;
  readonly confidence: string;
  readonly why: string;
}

const GENERAL: ProposalSchema<GeneralItem> = {
  name: 'proposals',
  key: 'proposals',
  itemShape:
    `{ "kind": one of ${NOTE_KINDS.join(', ')}; "title": the note's name; ` +
    '"properties": optional { key: text, number, true/false or list of text }; "folder": optional folder; "body": optional markdown; ' +
    '"source": the block it came from; "confidence": high, medium or low; "why": one sentence }.',
  itemKeys: ['kind', 'title', 'folder', 'properties', 'body', 'source', 'confidence', 'why'],
  readItem: readGeneralItem,
  draftsOf: (item) => [
    {
      kind: item.kind,
      payload: {
        title: item.title,
        ...(item.folder !== undefined && { folder: item.folder }),
        ...(item.properties !== undefined && { properties: item.properties }),
        ...(item.body !== undefined && { body: item.body }),
      },
      source: item.source,
      confidence: item.confidence,
      why: item.why,
    },
  ],
};

function readGeneralItem(value: unknown): Reading<GeneralItem> {
  if (!isRecord(value)) return refused('It is not an object.');
  const kind = NOTE_KINDS.find((known) => known === value['kind']);
  if (kind === undefined) return refused(`Its kind is not one of ${NOTE_KINDS.join(', ')}.`);
  const { source, confidence, why = '' } = value;
  if (typeof source !== 'string') return refused('It has no "source".');
  if (typeof confidence !== 'string') return refused('It has no "confidence".');
  if (typeof why !== 'string') return refused('Its "why" is not text.');
  return {
    ok: true,
    value: {
      kind,
      title: value['title'],
      folder: value['folder'],
      properties: value['properties'],
      body: value['body'],
      source,
      confidence,
      why,
    },
  };
}

/** Every schema a rule can name, by the name its `output:` writes. */
export const PROPOSAL_SCHEMAS: Readonly<Record<string, RegisteredProposalSchema>> = {
  [GENERAL.name]: registerProposalSchema(GENERAL),
  [MEETING_ITEMS.name]: registerProposalSchema(MEETING_ITEMS),
  [MEETING_DIGEST.name]: MEETING_DIGEST,
};

/** The schema a rule's `output:` names, or null when there is none by that name. */
export function proposalSchemaNamed(name: string): RegisteredProposalSchema | null {
  return Object.hasOwn(PROPOSAL_SCHEMAS, name) ? PROPOSAL_SCHEMAS[name]! : null;
}
