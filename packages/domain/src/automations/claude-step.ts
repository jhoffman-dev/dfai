/**
 * A rule's Claude step (P29-03, ADR-0028), as its file writes it:
 *
 * ```yaml
 * do: claude
 * prompt: .atlas/prompts/meeting-actions.md
 * tools: [atlas_read_note, atlas_search]
 * output: proposals
 * ```
 *
 * The prompt is a note in `.atlas/prompts/`; the tools are some of the chat's
 * read tools; the output names a proposal schema, or `note` with the folder
 * the one new note goes in under `folder:`. A Claude step never edits a note
 * — an output that would is refused here, before the rule can be saved.
 *
 * Two keys are optional (#179, ADR-0036). `apply: mine` makes the step the
 * declared one: the owner's own action items out of a meeting may become
 * tasks without a click, and it has its own ask budget and default model
 * (`claude-step-budget.ts`). `model:` names the model it asks.
 *
 * `data: weekly-review` (#40) hands the step what DFAI reads itself beside
 * the notes: the weekly review, each item with its note's path. It goes with
 * `output: note`, and every list item of that note must link one of those
 * notes (`cited-items.ts`). A step with data needs no query: `which:` may be
 * left out, and it reads its data alone.
 */

import { isChatReadTool, CHAT_READ_TOOLS, type ChatReadTool } from '../chat/read-tool-names.ts';
import { createVaultPath, InvalidVaultPathError, type VaultPath } from '../vault/vault-path.ts';
import { claudeWriteRefusal } from './claude-write-folder.ts';
import { PROPOSAL_SCHEMAS } from './proposal-schemas.ts';

/** Where a rule's prompts live. */
export const PROMPTS_DIRECTORY = '.atlas/prompts';

/**
 * The longest a prompt note may be: a rule's instructions, not a document. A
 * skill's instructions are held to the same length (ADR-0050), since either
 * is handed to the model as one argument (ADR-0021).
 */
export const MAX_PROMPT_CHARACTERS = 20_000;

/** The most notes one Claude step reads: each is a model's reading, not a file move. */
export const CLAUDE_NOTES_PER_RUN = 10;

/**
 * What a Claude step writes: proposals of a schema, or one new note in a
 * folder. The folder, like the prompt, is text as the editor holds it while
 * it is typed; a rule read from its file has both as vault paths.
 */
export type ClaudeOutput =
  | { readonly kind: 'proposals'; readonly schema: string }
  | { readonly kind: 'note'; readonly folder: string };

export interface ClaudeAction {
  readonly kind: 'claude';
  /** The prompt note, in {@link PROMPTS_DIRECTORY}. */
  readonly prompt: string;
  /**
   * The read tools it may call; none, and it reads only the notes it is
   * handed. Each is one of {@link CHAT_READ_TOOLS} once read from its file.
   */
  readonly tools: readonly string[];
  readonly output: ClaudeOutput;
  /**
   * `mine`: the declared step (ADR-0036), whose owner's own action items may
   * become tasks. Left out, every item is a proposal.
   */
  readonly apply?: ClaudeApply;
  /** The model it asks; left out, the default (`claudeStepModel`). */
  readonly model?: string;
  /** What DFAI reads and hands it beside the notes (#40); left out, the notes alone. */
  readonly data?: ClaudeData;
}

/**
 * What a step may be handed beside its notes: the weekly review (#40), or
 * what `brief()` says of the people and companies of each of today's
 * meetings (#39), one note a meeting.
 */
export const CLAUDE_DATA = ['weekly-review', 'meeting-briefs'] as const;

export type ClaudeData = (typeof CLAUDE_DATA)[number];

/** What a step may apply without a click: the owner's own action items. */
export type ClaudeApply = 'mine';

/** The longest model id a rule may name: an id, not a sentence. */
const MAX_MODEL_LENGTH = 100;

/** What a model id is written in: letters, digits, and `.`, `_`, `:`, `@`, `/`, `-`, `[`, `]`. */
const MODEL_ID = /^[A-Za-z0-9._:@/[\]-]+$/;

const NEVER_EDITS =
  'A Claude step never edits a note: it writes proposals for you to accept, or one new note.';

/** The Claude step a rule's frontmatter describes, or why it cannot be one. */
export function readClaudeAction(
  frontmatter: Readonly<Record<string, unknown>>,
): ClaudeAction | string {
  const prompt = readPrompt(frontmatter['prompt']);
  if (typeof prompt === 'string') return prompt;
  const tools = readTools(frontmatter['tools']);
  if (typeof tools === 'string') return tools;
  const output = readOutput(frontmatter);
  if (typeof output === 'string') return output;
  const apply = readApply(frontmatter['apply'], output);
  if (isRefusal(apply)) return apply.problem;
  const model = readModel(frontmatter['model']);
  if (isRefusal(model)) return model.problem;
  const data = readData(frontmatter['data'], output);
  if (isRefusal(data)) return data.problem;
  return {
    kind: 'claude',
    prompt: prompt.path,
    tools,
    output,
    ...(apply !== null && { apply }),
    ...(model !== null && { model }),
    ...(data !== null && { data }),
  };
}

/** The data a rule hands its step, null for none, or why it cannot be. */
function readData(value: unknown, output: ClaudeOutput): ClaudeData | null | Refusal {
  const written = typeof value === 'string' ? value.trim().toLowerCase() : value;
  if (written === undefined || written === null || written === '') return null;
  const data = CLAUDE_DATA.find((each) => each === written);
  if (data === undefined) {
    return { problem: `Write data: ${CLAUDE_DATA.join(' or ')}, or leave it out.` };
  }
  return output.kind === 'note'
    ? data
    : { problem: `data: ${data} goes with output: note, the one note it is written into.` };
}

/** Whether a step reads what DFAI hands it, so it runs with no notes and needs no query. */
export function readsData(action: { readonly kind: string; readonly data?: ClaudeData }): boolean {
  return action.kind === 'claude' && action.data !== undefined;
}

/** Why a key cannot be read; set apart from text, which is a key's value. */
interface Refusal {
  readonly problem: string;
}

function isRefusal(read: string | null | Refusal): read is Refusal {
  return typeof read === 'object' && read !== null;
}

/** The apply a rule says, null for none, or why it cannot be one. */
function readApply(value: unknown, output: ClaudeOutput): ClaudeApply | null | Refusal {
  const written = typeof value === 'string' ? value.trim().toLowerCase() : value;
  if (written === undefined || written === null || written === '') return null;
  if (written !== 'mine') {
    return {
      problem:
        'Write apply: mine to make your own action items into tasks, or leave it out for proposals only.',
    };
  }
  return outputHasItems(output) ? 'mine' : { problem: applyNeedsItems() };
}

/** Whether a step's answer is a meeting's action items, which `apply` acts on. */
export function outputHasItems(output: ClaudeOutput): boolean {
  return output.kind === 'proposals' && PROPOSAL_SCHEMAS[output.schema]?.readsInParts === true;
}

function applyNeedsItems(): string {
  const named = Object.values(PROPOSAL_SCHEMAS)
    .filter((schema) => schema.readsInParts)
    .map((schema) => `output: ${schema.name}`);
  return `apply: mine makes your own action items out of a meeting into tasks; it needs ${named.join(' or ')}.`;
}

/**
 * The model a rule names, null for none, or why it cannot be one. The host
 * passes it as `--model`'s value and refuses one that reads as a flag, so
 * that is refused here first, with anything that is not one plain id: only
 * the characters a model id or alias is written in (`claude-sonnet-5-5`,
 * `claude-opus-5-5[1m]`, a provider's `vendor/model:tag`), so no control,
 * format or invisible character reaches the host looking like a valid id.
 */
function readModel(value: unknown): string | null | Refusal {
  if (value === undefined || value === null) return null;
  // Only plain spaces and line ends are trimmed: an invisible character at either end is refused.
  const written = typeof value === 'string' ? value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '') : null;
  if (written === '') return null;
  const plain =
    written !== null &&
    written.length <= MAX_MODEL_LENGTH &&
    !written.startsWith('-') &&
    MODEL_ID.test(written);
  return plain
    ? written
    : {
        problem:
          'Write model: as one model’s id, like claude-sonnet-5-5, or leave it out for the default.',
      };
}

function readPrompt(value: unknown): { path: VaultPath } | string {
  const written = typeof value === 'string' ? value.trim() : '';
  const wanted = 'Name its prompt: prompt: .atlas/prompts/<name>.md.';
  if (written === '') return wanted;
  const full = written.includes('/') ? written : `${PROMPTS_DIRECTORY}/${written}`;
  const path = pathOrNull(/\.md$/i.test(full) ? full : `${full}.md`);
  return path !== null && isPromptPath(path) ? { path } : wanted;
}

/**
 * Whether `path` is a prompt note: a note directly in {@link PROMPTS_DIRECTORY}.
 * Asked when a rule is read, and again when its step runs: the action that
 * runs need not be one a file could have written.
 */
export function isPromptPath(path: string): boolean {
  return (
    path.startsWith(`${PROMPTS_DIRECTORY}/`) &&
    !path.slice(PROMPTS_DIRECTORY.length + 1).includes('/') &&
    /\.md$/i.test(path)
  );
}

function readTools(value: unknown): ChatReadTool[] | string {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return 'Write tools: as a list, like tools: [atlas_read_note].';
  const tools: ChatReadTool[] = [];
  for (const each of value) {
    const name = typeof each === 'string' ? each.trim() : '';
    if (!isChatReadTool(name)) {
      return `A Claude step may use only the read tools (${CHAT_READ_TOOLS.join(', ')}); “${String(each)}” is not one.`;
    }
    if (!tools.includes(name)) tools.push(name);
  }
  return tools;
}

/** Only what a step may write is accepted; anything else — `edit`, `append` — is refused for not being one of these. */
function readOutput(frontmatter: Readonly<Record<string, unknown>>): ClaudeOutput | string {
  const word = String(frontmatter['output'] ?? '')
    .trim()
    .toLowerCase();
  if (word === 'note') return readNoteOutput(frontmatter);
  if (Object.hasOwn(PROPOSAL_SCHEMAS, word)) return { kind: 'proposals', schema: word };
  const named = ['note', ...Object.keys(PROPOSAL_SCHEMAS)].join(', ');
  return `Say what Claude writes: output: one of ${named}. ${NEVER_EDITS}`;
}

function readNoteOutput(frontmatter: Readonly<Record<string, unknown>>): ClaudeOutput | string {
  // A path names a note already there: writing it would be an edit.
  if (frontmatter['path'] !== undefined && frontmatter['path'] !== null) return NEVER_EDITS;
  const written = typeof frontmatter['folder'] === 'string' ? frontmatter['folder'].trim() : '';
  const folder = written === '' ? null : pathOrNull(written.replace(/\/+$/, ''));
  if (folder === null) return 'Say which folder its note goes in: folder: Briefs.';
  return claudeWriteRefusal(folder) ?? { kind: 'note', folder };
}

function pathOrNull(raw: string): VaultPath | null {
  try {
    return createVaultPath(raw);
  } catch (error) {
    if (error instanceof InvalidVaultPathError) return null;
    throw error;
  }
}

/** The step as its rule's file writes it; every key, so a rule that stops being one loses them. */
export function claudeActionFields(action: ClaudeAction | null): Record<string, unknown> {
  return {
    prompt: action?.prompt ?? null,
    tools: action === null ? null : [...action.tools],
    output: action === null ? null : outputName(action.output),
    folder: action?.output.kind === 'note' ? action.output.folder : null,
    apply: action?.apply ?? null,
    model: action?.model ?? null,
    data: action?.data ?? null,
  };
}

/**
 * The step with the editor's apply and model: none, or a blank model, each
 * the key left out, as a file that does not write it is read. The model is
 * kept as typed; the rule's own reading says what is wrong with it.
 */
export function withClaudeChoices(
  action: ClaudeAction,
  { apply, model }: { apply: ClaudeApply | null; model: string },
): ClaudeAction {
  return {
    kind: 'claude',
    prompt: action.prompt,
    tools: action.tools,
    output: action.output,
    ...(apply !== null && { apply }),
    ...(model !== '' && { model }),
    ...(action.data !== undefined && { data: action.data }),
  };
}

/** The step handed `data` beside its notes, or none: the key left out, as a file that does not write it is read. */
export function withClaudeData(action: ClaudeAction, data: ClaudeData | null): ClaudeAction {
  return {
    kind: 'claude',
    prompt: action.prompt,
    tools: action.tools,
    output: action.output,
    ...(action.apply !== undefined && { apply: action.apply }),
    ...(action.model !== undefined && { model: action.model }),
    ...(data !== null && { data }),
  };
}

function outputName(output: ClaudeOutput): string {
  return output.kind === 'note' ? 'note' : output.schema;
}

/** The step in a few words: "Ask Claude (meeting-actions) for proposals". */
export function describeClaudeAction(action: ClaudeAction): string {
  const what =
    action.output.kind === 'note' ? `a note in ${action.output.folder}` : action.output.schema;
  const name = action.prompt.slice(action.prompt.lastIndexOf('/') + 1).replace(/\.md$/i, '');
  return `Ask Claude (${name}) for ${what}`;
}
