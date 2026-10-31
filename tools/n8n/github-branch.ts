import { MAP_MEETING_NODE } from './code-node.ts';
import { codeNode, endNode, ERROR_OUTPUT, ifNode, to, type Position } from './n8n-nodes.ts';

/*
 * The GitHub half both workflows end in (P28-02, P28-14): from the mapped
 * file in "Map meeting to DFAI file" to a commit in pkm-space, a skip, or
 * the failure email. Idempotent: a meeting already at its path, or at its
 * own collision path, is skipped; a different meeting at its path sends it
 * to the collision path; only a free path is written.
 */

/** The vault's sync repository, which DFAI pulls every minute (ADR-0025). */
export const VAULT_REPO = { owner: 'jhoffman-dev', repository: 'pkm-space' } as const;

/**
 * The n8n credential the GitHub nodes use, by name only: the token lives in
 * n8n's credential store, never in this file.
 */
export const GITHUB_CREDENTIAL = 'GitHub pkm-space (contents)';

/** Where "DFAI commit failed" sends its email. A placeholder: put your own address in. */
export const NOTIFY_TO = 'you@example.com';

/** The n8n Gmail credential the notification sends with, by name. */
export const GMAIL_CREDENTIAL = 'Gmail account';

export const BRANCH_NODES = {
  getPath: 'Is the path taken?',
  same: 'Same meeting?',
  ifSame: 'Already in the vault?',
  getCollision: 'Is the other path taken?',
  sameOther: 'Same meeting at the other path?',
  create: 'Commit meeting file',
  createCollision: 'Commit meeting file (other path)',
  skip: 'Skip: already in the vault',
  failed: 'DFAI commit failed',
  notify: 'Email me: meeting not in DFAI',
} as const;

/** Where a workflow draws the branch and what it calls its nodes. */
export interface BranchLayout {
  /** A node's id from its four-hex-digit serial, unique within the workflow. */
  readonly id: (serial: string) => string;
  /** How far right of the Gemini workflow's layout the branch is drawn. */
  readonly shift: number;
}

/** What the failure email names the meeting by: n8n expressions, without their `{{ }}`. */
export interface FailureEmail {
  readonly title: string;
  readonly sourceId: string;
}

export interface GitHubBranchSpec {
  readonly layout: BranchLayout;
  readonly scripts: { readonly same: string; readonly sameOther: string };
  readonly email: FailureEmail;
}

const locator = (value: string) => ({ __rl: true, value, mode: 'name' });
const mapped = (field: string) => `={{ $('${MAP_MEETING_NODE}').item.json.${field} }}`;

interface GitHubNodeSpec {
  readonly name: string;
  readonly id: string;
  readonly position: Position;
  readonly parameters: object;
}

function githubNode({ name, id, position, parameters }: GitHubNodeSpec) {
  return {
    id,
    name,
    type: 'n8n-nodes-base.github',
    typeVersion: 1.1,
    position,
    parameters: {
      resource: 'file',
      owner: locator(VAULT_REPO.owner),
      repository: locator(VAULT_REPO.repository),
      ...parameters,
    },
    credentials: { githubApi: { name: GITHUB_CREDENTIAL } },
  };
}

type FileNodeSpec = Omit<GitHubNodeSpec, 'parameters'> & { readonly path: string };

/** Fetch the file at `path`; "not found" leaves by the error output, meaning the path is free. */
const fileLookup = ({ path, ...spec }: FileNodeSpec) => ({
  ...githubNode({
    ...spec,
    parameters: {
      operation: 'get',
      filePath: path,
      asBinaryProperty: false,
      additionalParameters: {},
    },
  }),
  onError: 'continueErrorOutput',
});

/** Commit a new file at `path` on the default branch. A failure goes to "DFAI commit failed". */
const fileCreate = ({ path, ...spec }: FileNodeSpec) => ({
  ...githubNode({
    ...spec,
    parameters: {
      operation: 'create',
      filePath: path,
      fileContent: mapped('content'),
      commitMessage: mapped('commitMessage'),
      additionalParameters: {},
    },
  }),
  ...ERROR_OUTPUT,
});

/**
 * An n8n expression's value as one line of the email: every control
 * character (CR, LF, tab, NUL, C1, the Unicode line and paragraph
 * separators) as a space, so no value — a meeting's title, an error — can
 * forge another line. One that cannot be read (a node that never ran) is
 * empty rather than failing the email.
 */
export function emailValue(expression: string): string {
  return `{{ (() => { try { return String(${expression} ?? ''); } catch (error) { return ''; } })().replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]+/g, ' ') }}`;
}

/** What went wrong, as the failing node's error output carries it. */
const WHY = emailValue(
  'typeof $json.error === "string" ? $json.error : JSON.stringify($json.error ?? $json)',
);

/**
 * An email to you when a meeting did not reach DFAI. It says nothing of
 * Notion: DFAI runs first, so Notion may not have the meeting yet. A
 * notification that cannot be sent stops nothing.
 */
function notifyNode(id: string, position: Position, email: FailureEmail) {
  return {
    id,
    name: BRANCH_NODES.notify,
    type: 'n8n-nodes-base.gmail',
    typeVersion: 2.1,
    position,
    parameters: {
      resource: 'message',
      operation: 'send',
      sendTo: NOTIFY_TO,
      subject: `=DFAI did not get a meeting: ${emailValue(email.title)}`,
      emailType: 'text',
      message: [
        `=This meeting did not reach DFAI: ${WHY}`,
        '',
        `Meeting: ${emailValue(email.title)}`,
        `Source ID: ${emailValue(email.sourceId)}`,
        `Execution: ${emailValue('$workflow.name')} #${emailValue('$execution.id')}`,
      ].join('\n'),
      options: { appendAttribution: false },
    },
    credentials: { gmailOAuth2: { name: GMAIL_CREDENTIAL } },
    ...ERROR_OUTPUT,
  };
}

/** The branch's nodes, entered at "Is the path taken?" and failed into at "DFAI commit failed". */
function branchNodes({ layout, scripts, email }: GitHubBranchSpec) {
  const { id } = layout;
  const at = (x: number, y: number): Position => [x + layout.shift, y];
  const names = BRANCH_NODES;
  return [
    fileLookup({ name: names.getPath, id: id('0003'), path: mapped('path'), position: at(440, 0) }),
    codeNode({ name: names.same, id: id('0004'), jsCode: scripts.same, position: at(660, -120) }),
    ifNode({
      name: names.ifSame,
      id: id('0005'),
      position: at(880, -120),
      conditionId: id('c001'),
      leftValue: '={{ $json.duplicate }}',
      rightValue: '',
      operator: { type: 'boolean', operation: 'true', singleValue: true },
    }),
    fileLookup({
      name: names.getCollision,
      id: id('0006'),
      path: mapped('collisionPath'),
      position: at(1100, -40),
    }),
    codeNode({
      name: names.sameOther,
      id: id('000a'),
      jsCode: scripts.sameOther,
      position: at(1320, -120),
    }),
    fileCreate({
      name: names.create,
      id: id('0007'),
      path: mapped('path'),
      position: at(660, 120),
    }),
    fileCreate({
      name: names.createCollision,
      id: id('0008'),
      path: mapped('collisionPath'),
      position: at(1320, 40),
    }),
    endNode(names.skip, id('0009'), at(1540, -200)),
    endNode(names.failed, id('000b'), at(1540, 240)),
    notifyNode(id('000c'), at(1760, 240), email),
  ];
}

const BRANCH_CONNECTIONS = {
  [BRANCH_NODES.getPath]: { main: [to(BRANCH_NODES.same), to(BRANCH_NODES.create)] },
  [BRANCH_NODES.same]: { main: [to(BRANCH_NODES.ifSame), to(BRANCH_NODES.failed)] },
  [BRANCH_NODES.ifSame]: { main: [to(BRANCH_NODES.skip), to(BRANCH_NODES.getCollision)] },
  [BRANCH_NODES.getCollision]: {
    main: [to(BRANCH_NODES.sameOther), to(BRANCH_NODES.createCollision)],
  },
  [BRANCH_NODES.sameOther]: { main: [to(BRANCH_NODES.skip), to(BRANCH_NODES.failed)] },
  [BRANCH_NODES.create]: { main: [[], to(BRANCH_NODES.failed)] },
  [BRANCH_NODES.createCollision]: { main: [[], to(BRANCH_NODES.failed)] },
  [BRANCH_NODES.failed]: { main: [to(BRANCH_NODES.notify)] },
};

/**
 * The GitHub branch's nodes and their wiring. Nothing in it stops the run:
 * every failure — a file it cannot read, both paths taken by others, a
 * failed commit — goes to "DFAI commit failed", which emails you.
 */
export function githubBranch(spec: GitHubBranchSpec) {
  return { nodes: branchNodes(spec), connections: BRANCH_CONNECTIONS };
}
