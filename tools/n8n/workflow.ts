import { MAP_MEETING_NODE } from './code-node.ts';
import { BRANCH_NODES, githubBranch } from './github-branch.ts';
import { codeNode, ERROR_OUTPUT, to } from './n8n-nodes.ts';

export { GITHUB_CREDENTIAL, GMAIL_CREDENTIAL, NOTIFY_TO, VAULT_REPO } from './github-branch.ts';

export const NODES = {
  fields: 'Meeting fields for DFAI',
  map: MAP_MEETING_NODE,
  ...BRANCH_NODES,
} as const;

/**
 * Where the DFAI branch reads a meeting in your workflow, by node name, so
 * a field reads the same whichever node's output the branch hangs off
 * (paired items carry each meeting through).
 */
export interface MeetingSources {
  /**
   * The node whose output is the assembled meeting, before any Notion step
   * (the People lookups and creates): `title`, `attendees`
   * (`[{ name, email }]`), `summaryMd`, `transcriptMd`, `source`, `sourceId`,
   * `category`. The branch is wired from this node too, so a Notion failure,
   * or a meeting with no people, cannot keep it from running. Its date is
   * when the notes arrived, so it is not read.
   */
  readonly meetingNode: string;
  /** The node whose output is the notes email itself, for its subject and arrival. */
  readonly emailNode: string;
  /** The email's subject field, which states the meeting's day (and time, if any). */
  readonly subjectField: string;
  /** The email's arrival field: an instant, the fallback for an approximate start. */
  readonly arrivedField: string;
}

/** Example names: a Gmail trigger's own fields are `subject` and `date`. Edit them to yours. */
export const EXAMPLE_SOURCES: MeetingSources = {
  meetingNode: 'Assembled meeting',
  emailNode: 'Notes email',
  subjectField: 'subject',
  arrivedField: 'date',
};

const read = (node: string, field: string) => `$('${node}').item.json["${field}"]`;

interface FieldRow {
  readonly name: string;
  readonly value: string;
  readonly type: 'string' | 'array';
}

/** The fields the mapper reads, each from your workflow's nodes by name. */
export function fieldRows(sources: MeetingSources): readonly FieldRow[] {
  const meeting = (field: string) => `={{ ${read(sources.meetingNode, field)} }}`;
  const email = (field: string) => `={{ ${read(sources.emailNode, field)} }}`;
  const text = (name: string, value: string): FieldRow => ({ name, value, type: 'string' });
  return [
    text('title', meeting('title')),
    // The email's subject states the meeting's day; its arrival, less the
    // transcript's length, the start. Never the meeting item's date: that is the arrival.
    text('stated', email(sources.subjectField)),
    text('arrived', email(sources.arrivedField)),
    { name: 'attendees', value: meeting('attendees'), type: 'array' },
    text('sections', meeting('summaryMd')),
    text('transcript', meeting('transcriptMd')),
    text('category', meeting('category')),
    text('source', meeting('source')),
    text('sourceId', meeting('sourceId')),
  ];
}

function fieldsNode(sources: MeetingSources) {
  return {
    id: 'a7c0e5b1-0001-4c1d-9e57-5f1b2c3d4e01',
    name: NODES.fields,
    type: 'n8n-nodes-base.set',
    typeVersion: 3.4,
    position: [0, 0],
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: fieldRows(sources).map(({ name, value, type }, index) => ({
          id: `a7c0e5b1-f${String(index).padStart(3, '0')}-4c1d-9e57-5f1b2c3d4e01`,
          name,
          value,
          type,
        })),
      },
      includeOtherFields: false,
      options: {},
    },
    ...ERROR_OUTPUT,
  };
}

/** Node ids in this workflow: `a7c0e5b1-<serial>-…`. */
const geminiId = (serial: string) => `a7c0e5b1-${serial}-4c1d-9e57-5f1b2c3d4e01`;

/**
 * The nodes to paste beside the Notion steps, wired from the assembled
 * meeting, with the mapper's scripts in them, ending in the GitHub branch
 * (github-branch.ts). Nothing in it stops the run: a refused meeting, like
 * every failure in the branch, goes to "DFAI commit failed", which emails you.
 */
export function meetingWorkflow(
  scripts: { map: string; same: string; sameOther: string },
  sources: MeetingSources = EXAMPLE_SOURCES,
) {
  const branch = githubBranch({
    layout: { id: geminiId, shift: 0 },
    scripts,
    email: {
      title: read(sources.meetingNode, 'title'),
      sourceId: read(sources.meetingNode, 'sourceId'),
    },
  });
  return {
    name: 'Meeting to DFAI (commit to pkm-space)',
    nodes: [
      fieldsNode(sources),
      codeNode({ name: NODES.map, id: geminiId('0002'), jsCode: scripts.map, position: [220, 0] }),
      ...branch.nodes,
    ],
    connections: {
      [NODES.fields]: { main: [to(NODES.map), to(NODES.failed)] },
      [NODES.map]: { main: [to(NODES.getPath), to(NODES.failed)] },
      ...branch.connections,
    },
    settings: { executionOrder: 'v1' },
  };
}
