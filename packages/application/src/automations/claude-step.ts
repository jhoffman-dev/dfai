import {
  answeredMeetingOf,
  askedTurnsDigest,
  CITED_ITEMS_INSTRUCTIONS,
  CLAUDE_STEP_QUESTION,
  claudeAskRefusal,
  claudeAsks,
  claudeNewProposal,
  claudeRunAsks,
  claudeStepBudget,
  claudeStepModel,
  claudeStepOutput,
  claudeStepSystem,
  claudeSystemProblem,
  claudeWriteRefusal,
  createVaultPath,
  DIGEST_REDUCE_INSTRUCTIONS,
  DIGEST_REDUCE_PROMPT,
  digestReduceData,
  isPromptPath,
  keepCitedItems,
  MAX_PROPOSALS_PER_ANSWER,
  MEETING_TYPE,
  meetingSummaryOf,
  messageWithoutPaths,
  NOTE_ANSWER_INSTRUCTIONS,
  noteTitle,
  nothingCitedProblem,
  periodProperties,
  partSummaries,
  proposalSchemaNamed,
  readDigestReduce,
  readNoteAnswer,
  reducePartMark,
  renderSummaryBlock,
  splitFrontmatter,
  summarisedAlready,
  surestProjectChoice,
  transcriptDigestOf,
  truncated,
  withoutSummaryBlock,
  type AnsweredNote,
  type AnswerReading,
  type AnswerVault,
  type CheckedProposal,
  type ClaudeAction,
  type ClaudeRunInfo,
  type DoneAction,
  type DroppedItem,
  type LocalTime,
  type MeetingTally,
  type ModelMessage,
  type NewProposal,
  type NoteCut,
  type NoteSkipped,
  type ProjectChoice,
  type OutputPeriod,
  type PromptData,
  type RegisteredProposalSchema,
  type ReviewDraftData,
  type StoredAnswer,
  type StoredAnswerDraft,
  type SummaryOutcome,
  type SummaryReading,
  type VaultPath,
} from '@dfai/domain';
import { ModelProviderError, type ModelProvider, type ProviderStatus } from '../chat/ports.ts';
import { runChatTurn } from '../chat/run-chat-turn.ts';
import type { ChatToolbox, Toolboxes } from '../chat/toolbox.ts';
import { loadLinkDirectory } from '../meeting-links/link-directory.ts';
import type { Clock } from '../ports.ts';
import { loadTerms } from '../terms/terms.ts';
import { readReviewDraft } from '../review/read-review-draft.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import { loadObjectTypes } from '../types/load-types.ts';
import {
  pendingTermsIn,
  readProposalsFolder,
  type ProposalsFolder,
} from '../proposals/proposals-folder.ts';
import type { NoteWritePorts } from '../proposals/proposal-writes.ts';
import {
  planProposals,
  proposalMadeAlready,
  type ProposalWritePorts,
} from '../proposals/write-proposals.ts';
import type { VaultFsPort } from '../vault/ports.ts';
import { planNote, type PlannedNote } from './claude-writes.ts';
import { readMadeItems } from '../meetings/made-items.ts';
import { MeetingSummaryRefused, writeMeetingSummary } from '../meetings/write-meeting-summary.ts';
import { HeldForPullError } from './fresh-pull-hold.ts';
import { PeriodNoteArrived } from './period-state.ts';
import type { PropertyChange } from './apply-changes.ts';
import {
  fileChosenMeetings,
  loadProjectOptions,
  planProjectChoices,
  projectLeftWords,
  type PlannedFilings,
} from './meeting-project-choice.ts';
import {
  decideForMeeting,
  makeOwnersTasks,
  OwnersTasksStopped,
  type MeetingDecided,
  type PlannedTask,
} from './owners-tasks.ts';

/**
 * How long a whole run may take, every ask of it together, before it is
 * stopped and failed: one deadline, so a long meeting read in ten parts
 * cannot take ten times as long.
 */
export const CLAUDE_RUN_TIMEOUT_MS = 10 * 60_000;

/** The longest a prompt note may be: a rule's instructions, not a document. */
export const MAX_PROMPT_CHARACTERS = 20_000;

/**
 * The most proposals one run makes however many parts it read. Taken in the
 * order of the transcript; those past it are left out and the log says how
 * many.
 */
export const MAX_PROPOSALS_PER_RUN = MAX_PROPOSALS_PER_ANSWER;

/**
 * What a rule's Claude step reaches (P29-03): the provider and model chosen
 * in Settings → Claude as they are when it runs (the model, unless the rule
 * or its step's default names another), the read tools the chat's
 * toolbox is built from, and the clock and timer it is timed by.
 */
export interface ClaudeStepPorts {
  readonly provider: () => ModelProvider;
  readonly model: () => string;
  readonly toolboxes: Pick<Toolboxes, 'reading'>;
  /**
   * The vault owner's name, from their profile, as it is when the step runs;
   * null when the profile holds none. What an output that tells "mine" from
   * "someone else's" (P29-05) reads; never guessed (ADR-0024).
   */
  readonly selfName: () => string | null;
  /**
   * The vault owner's own addresses, the vault's `selfEmails`, as they are
   * when the step runs; none when it holds none. Never guessed (ADR-0024).
   */
  readonly selfEmails: () => readonly string[];
  readonly clock: Pick<Clock, 'now' | 'today'>;
  /** A signal that aborts once `ms` have passed: the step's time limit. */
  readonly deadline: (ms: number) => AbortSignal;
}

/** What a step that failed had done by then, and what stopped it when that was not the model's answer. */
export interface ClaudeStepAftermath {
  /** What it had made before it stopped: it stays, and the log must say so. */
  readonly made?: readonly DoneAction[];
  /** The error that stopped it, to be raised once the run is on record. */
  readonly cause?: unknown;
  /** The answers it read in full before it stopped, to be kept so its retry asks nothing again (ADR-0036). */
  readonly stored?: readonly StoredAnswerDraft[];
}

/**
 * A step that failed, with why — in words the person can act on, with no
 * path of this machine's in them, and bounded: a model's words can be long —
 * and the model it had asked.
 */
export class ClaudeStepFailed extends Error {
  readonly made: readonly DoneAction[];
  /** Set when an error other than the model's answer stopped it: raised after the log is written. */
  readonly interruption: unknown;
  readonly stored: readonly StoredAnswerDraft[];

  constructor(
    message: string,
    readonly claude: ClaudeRunInfo,
    { made = [], cause, stored = [] }: ClaudeStepAftermath = {},
  ) {
    super(truncated(message));
    this.name = 'ClaudeStepFailed';
    this.made = made;
    this.interruption = cause;
    this.stored = [...stored];
  }
}

/** A called tool the rule does not let the step use: the run fails rather than carry on. */
class ToolOutsideRule extends Error {}

export interface ClaudeStepOutcome {
  /** What it made: a proposal per line, or the one note. */
  readonly done: readonly DoneAction[];
  /** The notes it did not ask about, and why: a meeting with nothing in it to cite. */
  readonly left: readonly NoteSkipped[];
  readonly claude: ClaudeRunInfo;
}

interface StepArgs extends ProposalWritePorts {
  readonly markdown: MarkdownPort;
  /** The panes: a task is never made from a meeting with unsaved typing in one. */
  readonly editors: NoteWritePorts['editors'];
  readonly ports: ClaudeStepPorts;
  readonly action: ClaudeAction;
  /** The notes the run is about. */
  readonly paths: readonly VaultPath[];
  /** Every note in the vault: what a new note's name is numbered past. */
  readonly notePaths: readonly VaultPath[];
  /** The rule's id: what its proposals are for, so a retry makes none twice. */
  readonly rule: string;
  /** The rule and run, as each proposal's `made_by` says it. */
  readonly madeBy: string;
  /**
   * The asks the step's hourly allowance had spent in the hour before the
   * run, when it has one (#179): the run asks no more than is left. 0 if none.
   */
  readonly askedThisHour?: number;
  /**
   * Asked once every answer is read and planned, right before the first
   * write; it rejects to stop the run with nothing written — the gates of
   * ADR-0035 part 4, shut since the model was asked. Its error is raised as
   * it is, not as the step's failure.
   */
  readonly beforeWrite?: () => Promise<void>;
  /** More frontmatter every proposal it writes keeps (`NewProposal.stamp`); none, left out. */
  readonly stamp?: Readonly<Record<string, string>>;
  /**
   * For the declared step: the answers kept for a meeting's words, by the key
   * its schema knows them by, from a run that read them and could not finish
   * (ADR-0036); null when none are. Reused instead of asking again.
   */
  readonly storedAnswer?: (key: string) => Pick<StoredAnswer, 'answers' | 'parts'> | null;
  /**
   * For the declared step: when the rule's own file was last written, which
   * tells a meeting that arrived since from a backfill (ADR-0036); null when
   * it could not be read, and then every meeting is taken for a backfill.
   */
  readonly ruleSince?: number | null;
  /**
   * For a step that writes one note a period (#40): the period it writes for
   * and the wall clock now. The note carries the period in its own properties,
   * and a step handed data counts the week from it.
   */
  readonly period?: { readonly period: OutputPeriod; readonly at: LocalTime };
}

/**
 * Runs a rule's Claude step once (P29-03, ADR-0028): asks the model the
 * rule's prompt about the notes, through the chat's own turn and only the
 * read tools the rule names, and writes what its answer describes —
 * proposals, or one new note — never an edit.
 *
 * Fails with `ClaudeStepFailed` when the provider cannot be used (with the
 * chat's fix-it words), the action is not one a rule's file could have said,
 * the prompt cannot be read, the model calls a tool the rule does not list,
 * it is stopped or runs out of time, or its answer does not read as the
 * rule's output — in each, having written nothing. The answer is read whole,
 * and every note planned, before the first is written; its proposals are
 * planned by the writer every proposal goes through (`planProposals`), which
 * makes none twice. A meeting among the notes is shown by whole turns, and
 * named to the answer's check as the meeting it is, so a proposal may link
 * back to it; a note cut to fit is said in the run's record. A write that then
 * fails part-way fails the run too, with what it had made in `made` (it
 * stays, and the log says so) and the error in `interruption`; run again, the
 * proposals already made are not made twice.
 *
 * An output that reads meetings turn by turn (`meeting-items`, P29-05) is
 * asked about each note alone, and about a long meeting in parts
 * (`claudeAsks`): several asks, one run. Every answer is read before anything
 * is written, so one that does not read fails the run with nothing made. An
 * item such an output leaves out of an answer it keeps is in the run's record,
 * as is how many times it asked.
 *
 * It asks the model its rule names, else its default (`claudeStepModel`: Sonnet
 * for the declared step, #179), and never more often than its budget lets one
 * run, nor than its hourly allowance has left (`claudeRunAsks`): an ask past
 * either fails the run with nothing written. An output that summarises
 * plans one reduce for each meeting it reads in parts, out of the same asks (#184).
 *
 * The declared step (`apply: mine`, ADR-0036) makes the owner's own action
 * items into tasks, linked both ways, without a click: which ones is decided
 * in the domain (`decideMeetingItems`), per meeting; what the owner should
 * still see is one review proposal per meeting, and the rest is left out
 * (#226). The tasks are made first, then the proposals. A run
 * that read a meeting's answers in full and then failed keeps them
 * (`ClaudeStepFailed.stored`), and its retry reuses them rather than asking
 * again; one it made some tasks in names them in `made`, and the retry finds
 * them by their `atlas_item` and makes only the rest. It also files a meeting
 * with no project under the project Claude chose for it, when Claude is sure
 * — the step's one edit besides the tasks, which "Undo last run" reverses —
 * and proposes a less sure choice, once (#227, ADR-0039).
 */
export async function runClaudeStep(args: StepArgs): Promise<ClaudeStepOutcome> {
  const { ports, action } = args;
  const model = claudeStepModel(action, ports.model());
  const budget = claudeStepBudget(action);
  const { askedThisHour = 0 } = args;
  const started = ports.clock.now();
  let cut: readonly NoteCut[] = [];
  let asked = 0;
  const dropped: DroppedItem[] = [];
  const adjusted: DroppedItem[] = [];
  const warnings: string[] = [];
  let alreadyMade = 0;
  const toStore: StoredAnswerDraft[] = [];
  let meetings: readonly MeetingTally[] = [];
  const claudeRun = (): ClaudeRunInfo => ({
    model,
    ms: Math.max(0, ports.clock.now() - started),
    ...(cut.length > 0 && { cut }),
    ...(asked > 0 && { asks: asked }),
    ...(dropped.length > 0 && { dropped: [...dropped] }),
    ...(adjusted.length > 0 && { adjusted: [...adjusted] }),
    ...(warnings.length > 0 && { warnings: [...warnings] }),
    ...(alreadyMade > 0 && { alreadyMade }),
    ...(meetings.length > 0 && { meetings }),
  });
  const fail = (message: string): never => {
    throw new ClaudeStepFailed(message, claudeRun(), { stored: toStore });
  };
  // Defence in depth: the action a run is handed is checked as the file that wrote it was.
  const output = outputOf(action);
  if (typeof output === 'string') return fail(output);
  if (!isPromptPath(action.prompt)) {
    return fail(`Its prompt ${JSON.stringify(action.prompt)} is not a note in .atlas/prompts.`);
  }
  const provider = ports.provider();
  const status = await provider.status();
  if (!status.ready) return fail(fixIt(status));
  const prompt = await readPrompt(args.fs, createVaultPath(action.prompt));
  if (typeof prompt !== 'string') return fail(prompt.problem);
  const read = await readAnswered(args, args.paths);
  // Only the declared step writes a summary (ADR-0036): any other rule is told so, and asks for none.
  const named = output.kind === 'proposals' && output.schema.summarises;
  const summarises = named && action.apply === 'mine';
  if (named && !summarises) warnings.push(SUMMARY_ONLY_DECLARED);
  const { notes, summarised } = summarises
    ? toSummarise(read)
    : { notes: read.notes, summarised: [] };
  const inParts = output.kind === 'proposals' && output.schema.readsInParts;
  // A summarising output plans one reduce for each meeting read in parts, out of the same asks (#184).
  const plan = claudeAsks(notes, {
    inParts,
    asks: claudeRunAsks(budget, askedThisHour),
    reduces: summarises,
  });
  cut = plan.cut;
  const signal = ports.deadline(CLAUDE_RUN_TIMEOUT_MS);
  const asking = { ...args, provider, model, prompt, output, fail, signal };
  const counted = () => {
    const refused = claudeAskRefusal(budget, asked, askedThisHour);
    if (refused !== null) fail(refused);
    asked += 1;
  };
  if (output.kind === 'proposals')
    warnings.push(...(await missingRelations(args, notes, output.schema)));
  try {
    const answered =
      output.kind === 'note'
        ? await planNoteAnswer({ ...asking, output, notes, counted, dropped, adjusted })
        : await planProposalAnswers({
            ...asking,
            schema: output.schema,
            asks: plan.asks,
            read: notes,
            counted,
            dropped,
            adjusted,
            toStore,
          });
    const { planned, proposed, tasks = [], summaries = [], filings = [] } = answered;
    if (answered.meetings?.some(({ noTasksBecause }) => noTasksBecause === 'owner-unknown')) {
      warnings.push(OWNER_UNKNOWN_WARNING);
    }
    // What it proposed and the writer left out was made before: said, so a re-ask does not read as an empty answer.
    alreadyMade = Math.max(0, proposed - planned.length);
    await args.beforeWrite?.();
    const written = await writeAll({
      args,
      tasks,
      planned,
      summaries: action.apply === 'mine' ? summaries : [],
      filings,
      model,
      read: read.files,
      warnings,
      claudeRun,
      stored: toStore,
    });
    meetings = (answered.meetings ?? []).map((meeting) =>
      tallyOf(meeting, tasks, planned, summaries, written.summaries),
    );
    return { done: written.done, left: [...plan.skipped, ...summarised], claude: claudeRun() };
  } catch (error) {
    if (error instanceof ClaudeStepFailed || error instanceof HeldForPullError) throw error;
    if (error instanceof PeriodNoteArrived) throw new PeriodNoteArrived(claudeRun());
    // Anything else after the model was asked (the index, the disk) still cost an ask: on record, then raised.
    throw new ClaudeStepFailed(messageWithoutPaths(error), claudeRun(), {
      cause: error,
      stored: toStore,
    });
  }
}

/**
 * What the run says, on every run until it is fixed, when the vault does not
 * say who its owner is (#181): no task can be known to be theirs, so none is made.
 */
export const OWNER_UNKNOWN_WARNING =
  'DFAI can’t tell which action items are yours, so it made no tasks: add your name or emails in Settings → Profile.';

/**
 * What the declared step made of one meeting it read: its tasks, its
 * proposals written, what it left out (#226) and — when it summarises — what
 * its summary lists and what became of it.
 */
function tallyOf(
  { path, leftOut }: MeetingRead,
  tasks: readonly PlannedTask[],
  planned: readonly PlannedNote[],
  summaries: readonly PlannedSummary[],
  outcomes: ReadonlyMap<VaultPath, SummaryOutcome>,
): MeetingTally {
  const summary = summaries.find((each) => each.meeting === path);
  const outcome = outcomes.get(path);
  return {
    path,
    tasks: tasks.filter((task) => task.meeting.path === path).length,
    proposals: planned.filter((note) => note.meeting === path).length,
    ...(leftOut > 0 && { leftOut }),
    ...(summary !== undefined &&
      outcome !== undefined && { listed: summary.listed, summary: outcome }),
  };
}

/** What the run says when a rule that is not the declared step names a summarising output. */
const SUMMARY_ONLY_DECLARED =
  'Only a rule that says apply: mine writes a meeting’s summary; this one wrote none.';

/**
 * The meetings a summarising run asks about, each shown without the summary
 * block it wrote (the model never summarises its own summary), and those it
 * leaves: a meeting whose summary is of the words it holds now is skipped
 * without asking (#185).
 */
function toSummarise(read: ReadNotes): { notes: AnsweredNote[]; summarised: NoteSkipped[] } {
  const notes: AnsweredNote[] = [];
  const summarised: NoteSkipped[] = [];
  for (const note of read.notes) {
    const properties = read.files.get(note.path)?.properties ?? {};
    if (summarisedAlready(properties, note.text)) {
      summarised.push({ path: note.path, reason: SUMMARISED_ALREADY });
    } else {
      notes.push({ ...note, text: withoutSummaryBlock(note.text) });
    }
  }
  return { notes, summarised };
}

const SUMMARISED_ALREADY =
  'Its summary is of the words it holds now, so Claude was not asked about it again.';

/**
 * What the chat panel shows when the provider cannot be used, in one line.
 * The provider's words may name this machine's paths and are stripped; the
 * fix is DFAI's own command, and a URL in it is no path.
 */
function fixIt(status: Extract<ProviderStatus, { ready: false }>): string {
  const said = messageWithoutPaths(status.message);
  return status.fix === null ? said : `${said} Fix: ${status.fix}`;
}

async function readPrompt(
  fs: Pick<VaultFsPort, 'readTextFile'>,
  path: VaultPath,
): Promise<string | { problem: string }> {
  let text: string;
  try {
    text = (await fs.readTextFile(path)).text;
  } catch {
    // Gone or unreadable is the same to the person: the prompt the rule names is not there.
    return { problem: `Its prompt ${path} could not be read.` };
  }
  const body = splitFrontmatter(text).body.trim();
  if (body === '') return { problem: `Its prompt ${path} is empty.` };
  return body.length > MAX_PROMPT_CHARACTERS
    ? {
        problem: `Its prompt ${path} is ${body.length} characters; a prompt may be at most ${MAX_PROMPT_CHARACTERS}.`,
      }
    : body;
}

/** The notes a run read, and each one's file as it was read: when, and its properties. */
interface ReadNotes {
  readonly notes: readonly AnsweredNote[];
  readonly files: ReadonlyMap<VaultPath, ReadFile>;
}

/** A note's file as the run read it: a write to it later is refused if it changed since. */
interface ReadFile {
  readonly modified: number;
  readonly properties: Readonly<Record<string, unknown>>;
}

/**
 * The notes as they are on disk, each said to be a meeting — and which —
 * when its own frontmatter says so: the run's word, which no answer changes.
 */
async function readAnswered(
  { fs, markdown }: Pick<ProposalWritePorts, 'fs' | 'markdown'>,
  paths: readonly VaultPath[],
): Promise<ReadNotes> {
  const read = await fs.readNotes(paths);
  const files = new Map<VaultPath, ReadFile>();
  const notes = read.map((file) => {
    const path = createVaultPath(file.path);
    const properties = markdown.frontmatterProperties(splitFrontmatter(file.text).frontmatter);
    files.set(path, { modified: file.modified, properties });
    const meeting = answeredMeetingOf(properties);
    return { path, text: file.text, ...(meeting !== undefined && { meeting }) };
  });
  return { notes, files };
}

/** What every ask of one run shares: the step's arguments, and what it read before asking. */
type Asking = StepArgs & {
  provider: ModelProvider;
  model: string;
  prompt: string;
  output: StepOutput;
  fail: (message: string) => never;
  /** Aborts when the run's one deadline passes. */
  signal: AbortSignal;
};

/** The model's last word, after any tools it called. */
async function askModel({
  ports,
  action,
  provider,
  model,
  prompt,
  output,
  notes,
  data = [],
  fail,
  signal,
  counted,
}: Asking & {
  notes: readonly AnsweredNote[];
  /** What the output has DFAI say beside the notes. */
  data?: readonly PromptData[];
  /** Told as the model is asked: not before the system prompt was found to fit. */
  counted: () => void;
}): Promise<string> {
  const question: ModelMessage = { role: 'user', text: CLAUDE_STEP_QUESTION };
  const system = claudeStepSystem({
    today: ports.clock.today(),
    prompt,
    answer: output.instructions,
    notes,
    data,
  });
  const tooLong = claudeSystemProblem(system);
  if (tooLong !== null) return fail(tooLong);
  counted();
  try {
    const outcome = await runChatTurn({
      provider,
      toolbox: onlyRuleTools(ports.toolboxes.reading(action.tools), action.tools),
      model,
      system,
      history: [question],
      signal,
      onEvent: () => {
        // Nobody is watching a rule's run: only its last word counts.
      },
    });
    if (outcome.stopped) return fail(stoppedWords(signal));
    const last = outcome.added.findLast((message) => message.role === 'assistant');
    return last?.role === 'assistant' ? last.text : '';
  } catch (error) {
    if (error instanceof ToolOutsideRule) return fail(error.message);
    // Claude Code's own words can quote its stderr, paths and all.
    if (error instanceof ModelProviderError) return fail(messageWithoutPaths(error));
    throw error;
  }
}

function stoppedWords(signal: AbortSignal): string {
  return signal.aborted
    ? `Claude did not finish within ${CLAUDE_RUN_TIMEOUT_MS / 60_000} minutes.`
    : 'Claude’s run was stopped before it answered.';
}

/**
 * The rule's read tools, as the toolbox runs them. A call to any other —
 * one the chat has, or one that does not exist — fails the run: the model
 * reached past what the rule allows, and nothing it then says is trusted.
 */
function onlyRuleTools(toolbox: ChatToolbox, tools: readonly string[]): ChatToolbox {
  return {
    specs: toolbox.specs,
    run: async (call) => {
      if (!tools.includes(call.name)) {
        throw new ToolOutsideRule(
          `Claude called ${call.name}, which this rule does not let it use.`,
        );
      }
      return toolbox.run(call);
    },
  };
}

/** What a step's answer must be, and how it is read: one new note, or a schema's proposals. */
type StepOutput =
  | { readonly kind: 'note'; readonly instructions: string; readonly folder: VaultPath }
  | {
      readonly kind: 'proposals';
      readonly instructions: string;
      readonly schema: RegisteredProposalSchema;
    };

/** The rule's output as a run reads it, or why it cannot be run: a schema no longer registered, a folder no step writes in. */
function outputOf(action: ClaudeAction): StepOutput | string {
  const output = claudeStepOutput(action);
  if (output.kind === 'note') {
    const refusal = claudeWriteRefusal(output.folder);
    if (refusal !== null) return refusal;
    // A step handed data writes a note whose every item cites one of its notes (#40).
    const cites = action.data === undefined ? [] : [CITED_ITEMS_INSTRUCTIONS];
    return {
      kind: 'note',
      instructions: [NOTE_ANSWER_INSTRUCTIONS, ...cites].join('\n'),
      folder: createVaultPath(output.folder),
    };
  }
  const schema = proposalSchemaNamed(output.schema);
  return schema === null
    ? `There is no output called ${output.schema}.`
    : { kind: 'proposals', instructions: schema.instructions, schema };
}

const unreadWords = (problem: string): string =>
  `Claude’s answer is not what the rule asks for. ${problem}`;

/** The notes an answer makes, and how many proposals it held — more than are planned when some were made before. */
interface AnswerPlanned {
  readonly planned: readonly PlannedNote[];
  readonly proposed: number;
  /** For the declared step: the owner's tasks to make, before the proposals are written. */
  readonly tasks?: readonly PlannedTask[];
  /** For the declared step: each meeting it read, in order, for the log to say what it made of each. */
  readonly meetings?: readonly MeetingRead[];
  /** For the declared step whose output summarises: each meeting's summary, and what it lists. */
  readonly summaries?: readonly PlannedSummary[];
  /** For the declared step: the meetings to file under the project Claude was sure of (#227) that have no summary write to join. */
  readonly filings?: readonly PropertyChange[];
}

/** A meeting the declared step read: how many of its items it left out, and why it could make no task, if it could not. */
interface MeetingRead {
  readonly path: VaultPath;
  readonly leftOut: number;
  readonly noTasksBecause: MeetingDecided['noTasksBecause'];
}

/** A meeting's summary as planned, before anything is written (#185). */
interface PlannedSummary {
  readonly meeting: VaultPath;
  /** The block to write at its top; null when the answer's summary did not read. */
  readonly block: string | null;
  /** The digest of the transcript it is of. */
  readonly summaryOf: string | null;
  /** How many action items it lists. */
  readonly listed: number;
  /** Tasks made before for its items: its `tasks` joins them, if it does not yet. */
  readonly madeBefore: readonly VaultPath[];
  /** The project to file the meeting under in the same write (#227); null when it is not to be filed. */
  readonly project: PropertyChange | null;
}

/**
 * Asks once for the rule's one new note, and plans it: nothing is written
 * yet. A step handed data (#40) is asked with it beside the notes, and its
 * note keeps only the list items that link one of them or of its data's
 * notes; the rest go in `dropped`, and a note that kept none is refused.
 */
async function planNoteAnswer({
  notes,
  counted,
  dropped,
  adjusted,
  ...asking
}: Asking & {
  output: Extract<StepOutput, { kind: 'note' }>;
  notes: readonly AnsweredNote[];
  counted: () => void;
  /** Gains the list items left out for citing nothing. */
  dropped: DroppedItem[];
  /** Gains the list items kept after a link to a note it was not given was written as text. */
  adjusted: DroppedItem[];
}): Promise<AnswerPlanned> {
  const given = await readStepData(asking);
  const data = given?.data ?? [];
  const note = readNoteAnswer(await askModel({ ...asking, notes, counted, data }));
  if (!note.ok) return asking.fail(unreadWords(note.problem));
  let { body } = note.value;
  if (given !== null) {
    const sources = new Set<string>([...given.sources, ...notes.map(({ path }) => path)]);
    const cited = keepCitedItems({ body, sources, plain: given.plain });
    const problem = nothingCitedProblem(cited);
    if (problem !== null) return asking.fail(unreadWords(problem));
    dropped.push(...cited.dropped);
    adjusted.push(...cited.stripped);
    body = cited.body;
  }
  const planned = await planNote({
    ports: asking,
    notePaths: asking.notePaths,
    folder: asking.output.folder,
    note: {
      ...note.value,
      body,
      properties: { ...note.value.properties, ...stamp(asking.period, asking.rule) },
    },
  });
  return { planned: [planned], proposed: 0 };
}

/** The properties that say which period, and which rule, a note was made for, so the note itself can say so. */
const stamp = (period: StepArgs['period'], rule: string): Record<string, string> =>
  period === undefined ? {} : periodProperties(period.period, rule);

/** What DFAI reads and hands the step beside its notes; null for a step handed none. */
async function readStepData({
  action,
  index,
  fs,
  markdown,
  ports,
  period,
}: Asking): Promise<ReviewDraftData | null> {
  if (action.data === undefined) return null;
  const clock = ports.clock;
  // Counted from the slot the draft is for; a step with no period counts the week up to now.
  const wall = period?.at ?? `${clock.today()}T00:00:00`;
  return readReviewDraft({
    index,
    fs,
    markdown,
    clock,
    week: { slot: period?.period.slot ?? wall, localNow: wall },
  });
}

/** What every proposal answer of a run is read with. */
type ProposalAsking = Asking & {
  schema: RegisteredProposalSchema;
  asks: readonly (readonly AnsweredNote[])[];
  /** Every note the run read, whole: what a meeting's stored answers are read against. */
  read: readonly AnsweredNote[];
  /** Told each time the model is asked. */
  counted: () => void;
  /** Gains the items each answer left out. */
  dropped: DroppedItem[];
  /** Gains the items each answer kept with a fault put right. */
  adjusted: DroppedItem[];
  /** Gains the answers about each meeting the declared step read in full, to be kept if the run fails. */
  toStore: StoredAnswerDraft[];
};

/**
 * Reads every answer of the run as the schema's proposals, and plans them
 * all: nothing is written until every answer has read. An answer that does
 * not read fails the run, saying which part it was. The declared step then
 * decides, meeting by meeting, which of the owner's items are made tasks;
 * the rest are planned as proposals.
 */
async function planProposalAnswers(asking: ProposalAsking): Promise<AnswerPlanned> {
  const declared = asking.action.apply === 'mine';
  // Read once: what the run is told of the terms waiting there, and what it plans not to propose twice.
  const folder = await readProposalsFolder({ fs: asking.fs });
  const vault = asking.schema.readsVault
    ? await readVault({ ...asking, folder, withProjects: declared })
    : undefined;
  const answered = await readAnswers(asking, vault);
  const decided: readonly MeetingDecided[] = declared
    ? await decideOwnersItems(asking, answered, vault)
    : answered.map(({ path, proposals }) => ({
        meeting: path,
        tasks: [],
        proposals,
        leftOut: 0,
        noTasksBecause: null,
        listed: [],
        decisions: [],
        madeBefore: [],
      }));
  const filings = declared ? await planFilings(asking, answered) : NO_FILINGS;
  const meetingOf = new Map<string, VaultPath>();
  const drafted = [
    ...cappedForRun(
      decided.flatMap(({ meeting, proposals }) =>
        proposals.map((proposal) => {
          const drafted = {
            ...claudeNewProposal({ rule: asking.rule, madeBy: asking.madeBy, proposal }),
            ...(asking.stamp !== undefined && { stamp: asking.stamp }),
          };
          meetingOf.set(drafted.id, meeting);
          return drafted;
        }),
      ),
      asking.dropped,
    ),
    ...filings.proposals.map(({ meeting, proposal }) => {
      meetingOf.set(proposal.id, meeting);
      return proposal;
    }),
  ];
  const { planned, left } = await planProposals({
    fs: asking.fs,
    index: asking.index,
    markdown: asking.markdown,
    proposals: drafted,
    read: folder,
  });
  // One that cannot be made a note of fails the run before anything is written.
  if (left.length > 0) return asking.fail(`A proposal could not be written: ${left[0]!.reason}`);
  // An id given twice in one answer is one proposal: only those made before this run are "already made".
  const proposed = new Set(drafted.map(({ id }) => id)).size;
  const summaries = declared ? plannedSummaries(asking, answered, decided, filings.changes) : [];
  // A meeting with a summary is filed in that same write; one without is filed on its own.
  const unsummarised = filings.changes.filter(
    ({ path }) => !summaries.some(({ meeting }) => meeting === path),
  );
  return {
    planned: planned.map(({ path, contents, id }) => ({
      path,
      contents,
      made: { kind: 'proposed', path },
      id,
      ...(declared && { meeting: meetingOf.get(id)! }),
    })),
    proposed,
    ...(declared && {
      tasks: decided.flatMap(({ tasks }) => tasks),
      meetings: decided.map(({ meeting, leftOut, noTasksBecause }) => ({
        path: meeting,
        leftOut,
        noTasksBecause,
      })),
      summaries,
      filings: unsummarised,
    }),
  };
}

/**
 * Each meeting's summary block, with what the decisions made of its items,
 * for an output that summarises: rendered now, so what was cut to fit, and a
 * summary that did not read, are in the run's record.
 */
function plannedSummaries(
  asking: ProposalAsking,
  answered: readonly NoteAnswered[],
  decided: readonly MeetingDecided[],
  filings: readonly PropertyChange[],
): PlannedSummary[] {
  return decided.flatMap(({ meeting, listed, decisions, madeBefore }) => {
    const note = answered.find(({ path }) => path === meeting);
    const summary = note?.summary;
    if (summary === undefined) return [];
    const title = `The summary of ${noteTitle(meeting)}`;
    const text = asking.read.find(({ path }) => path === meeting)?.text ?? '';
    if (summary.kind !== 'read') {
      const reason = summary.kind === 'dropped' ? summary.problem : 'It has no "summary".';
      asking.dropped.push({ title, reason });
    }
    const rendered =
      summary.kind === 'read'
        ? renderSummaryBlock({
            model: asking.model,
            date: asking.ports.clock.today(),
            ...summary.value,
            decisions,
            actionItems: listed,
          })
        : null;
    asking.adjusted.push(...(rendered?.cut ?? []).map((reason) => ({ title, reason })));
    return [
      {
        meeting,
        block: rendered?.text ?? null,
        summaryOf: transcriptDigestOf(text),
        listed: listed.length,
        madeBefore,
        project: filings.find(({ path }) => path === meeting) ?? null,
      },
    ];
  });
}

/** The proposals the answers about one note hold, the project they chose for it, and its summary when the output summarises. */
interface NoteAnswered {
  readonly path: VaultPath;
  readonly proposals: readonly CheckedProposal[];
  /** The project it chose for the meeting, for a schema that chooses one; null when it chose none. */
  readonly project: ProjectChoice | null;
  readonly summary?: SummaryReading;
}

const NO_FILINGS: PlannedFilings = { changes: [], proposals: [] };

/** What the declared step does with the project Claude chose for each meeting it read (#227). */
function planFilings(
  asking: ProposalAsking,
  answered: readonly NoteAnswered[],
): Promise<PlannedFilings> {
  return planProjectChoices({
    ports: asking,
    choices: answered.map(({ path, project }) => ({ meeting: path, choice: project })),
    notePaths: asking.notePaths,
    madeBy: asking.madeBy,
  });
}

/**
 * Asks each of the run's asks in turn and reads every answer, note by note.
 * The declared step first looks for the answers kept for a meeting's words
 * (`storedAnswer`): when this run would ask about the very turns they
 * answered, they are read again as the domain reads them now and nothing is
 * asked. Kept answers to other turns — the meeting is cut differently now —
 * or that no longer read are asked again. The answers about each meeting it
 * asked are added to `toStore`, with the turns each part showed.
 */
async function readAnswers(
  asking: ProposalAsking,
  vault: AnswerVault | undefined,
): Promise<NoteAnswered[]> {
  const answered: NoteAnswered[] = [];
  const total = asking.asks.length;
  let at = 0;
  for (const group of asksByNote(asking.asks)) {
    const note = asking.read.find((each) => each.path === group.path);
    const key = asking.action.apply === 'mine' && note !== undefined ? keyOf(asking, note) : null;
    const kept = key === null ? null : (asking.storedAnswer?.(key) ?? null);
    const reused = kept === null ? null : rereadKept(asking, group.asks, kept, vault);
    if (reused !== null) {
      answered.push({ path: group.path, ...reused });
      continue;
    }
    const answers: string[] = [];
    const parts = group.asks.map((notes) => askedTurnsDigest(notes));
    const proposals: CheckedProposal[] = [];
    const summaries: SummaryReading[] = [];
    let data: readonly PromptData[] = [];
    const choices: (ProjectChoice | null)[] = [];
    for (const notes of group.asks) {
      at += 1;
      const context = { notes, ...(vault !== undefined && { vault }) };
      data = asking.schema.dataFor(context);
      const answer = await askModel({ ...asking, notes, data, counted: asking.counted });
      const reading = asking.schema.read(answer, context);
      if (!reading.ok) {
        const part = total > 1 ? `Ask ${at} of ${total}: ` : '';
        return asking.fail(unreadWords(`${part}${reading.problem}`));
      }
      proposals.push(...keptItems(asking, reading));
      summaries.push(reading.summary ?? { kind: 'absent' });
      choices.push(reading.project ?? null);
      answers.push(answer);
    }
    const merged = await reduceParts(asking, summaries, data);
    if (key !== null) {
      asking.toStore.push({
        key,
        answers: merged === null ? answers : [...answers, merged.answer],
        parts: merged === null ? parts : [...parts, reducePartMark(parts)],
      });
    }
    answered.push({
      path: group.path,
      proposals,
      project: surestProjectChoice(choices),
      ...summaryOf(asking, summaries, merged?.reading ?? null),
    });
  }
  return answered;
}

/**
 * A long meeting's parts' summaries merged by one more ask (#184): only for
 * an output that summarises, a meeting read in more than one part, and parts
 * whose summaries all read. Null when no reduce is asked. The answer is kept
 * with the parts', so a retry asks it no more than them.
 */
async function reduceParts(
  asking: ProposalAsking,
  summaries: readonly SummaryReading[],
  partData: readonly PromptData[],
): Promise<{ answer: string; reading: SummaryReading } | null> {
  const parts = summaries.length > 1 ? partSummaries(summaries) : null;
  if (!asking.schema.summarises || asking.action.apply !== 'mine' || parts === null) return null;
  const answer = await askModel({
    ...asking,
    prompt: DIGEST_REDUCE_PROMPT,
    output: { ...asking.output, instructions: DIGEST_REDUCE_INSTRUCTIONS },
    notes: [],
    data: digestReduceData(parts, partData),
    counted: asking.counted,
  });
  return { answer, reading: readDigestReduce(answer) };
}

/** A meeting's one summary from its parts' and its reduce's, for an output that summarises. */
function summaryOf(
  { schema }: ProposalAsking,
  parts: readonly SummaryReading[],
  reduced: SummaryReading | null,
): { summary?: SummaryReading } {
  return schema.summarises ? { summary: meetingSummaryOf(parts, reduced) } : {};
}

/** The key a meeting's words are known by, as the schema names them; null for a note it names none. */
function keyOf({ schema }: ProposalAsking, note: AnsweredNote): string | null {
  return schema.handledKeyOf?.(note) ?? null;
}

/**
 * A meeting's kept answers read again, each against the part this run would
 * ask it about, with the vault as it is now — only when those parts show the
 * very turns the answers were given about. Null otherwise, or when one no
 * longer reads, so the meeting is asked again rather than read in part.
 */
function rereadKept(
  asking: ProposalAsking,
  asks: readonly (readonly AnsweredNote[])[],
  kept: Pick<StoredAnswer, 'answers' | 'parts'>,
  vault: AnswerVault | undefined,
): Omit<NoteAnswered, 'path'> | null {
  const parts = asks.map((notes) => askedTurnsDigest(notes));
  const reduceMark = kept.parts.length === asks.length + 1 ? kept.parts.at(-1) : undefined;
  const sameTurns =
    (kept.parts.length === asks.length ||
      (asking.schema.summarises && reduceMark === reducePartMark(parts))) &&
    kept.answers.length === kept.parts.length &&
    parts.every((digest, at) => digest === kept.parts[at]);
  if (!sameTurns) return null;
  const readings = asks.map((notes, at) =>
    asking.schema.read(kept.answers[at]!, { notes, ...(vault !== undefined && { vault }) }),
  );
  if (readings.some((reading) => !reading.ok)) return null;
  const summaries = readings.map((reading) =>
    reading.ok && reading.summary !== undefined ? reading.summary : ({ kind: 'absent' } as const),
  );
  // A reduce owed and not kept: the parts are asked again, with it.
  const reduceOwed =
    asking.schema.summarises && asks.length > 1 && partSummaries(summaries) !== null;
  if (reduceOwed && reduceMark === undefined) return null;
  const reduced = reduceMark === undefined ? null : readDigestReduce(kept.answers.at(-1)!);
  return {
    proposals: readings.flatMap((reading) => (reading.ok ? keptItems(asking, reading) : [])),
    project: surestProjectChoice(
      readings.map((reading) => (reading.ok ? (reading.project ?? null) : null)),
    ),
    ...summaryOf(asking, summaries, reduced),
  };
}

/** An answer's proposals, with what it left out and put right added to the run's record. */
function keptItems(
  { dropped, adjusted }: ProposalAsking,
  reading: Extract<AnswerReading, { ok: true }>,
): readonly CheckedProposal[] {
  dropped.push(...reading.dropped);
  adjusted.push(...reading.adjusted);
  return reading.value;
}

/** The asks grouped by the note each is about, in order: a long meeting's parts are one group. */
function asksByNote(
  asks: readonly (readonly AnsweredNote[])[],
): { path: VaultPath; asks: (readonly AnsweredNote[])[] }[] {
  const groups: { path: VaultPath; asks: (readonly AnsweredNote[])[] }[] = [];
  for (const notes of asks) {
    const path = notes[0]?.path;
    if (path === undefined) continue;
    const last = groups.at(-1);
    if (last?.path === path) last.asks.push(notes);
    else groups.push({ path, asks: [notes] });
  }
  return groups;
}

/**
 * Decides, meeting by meeting, which of the owner's items become tasks
 * (`decideForMeeting`): the tasks already made are read once for them all.
 */
async function decideOwnersItems(
  asking: ProposalAsking,
  answered: readonly NoteAnswered[],
  vault: AnswerVault | undefined,
): Promise<MeetingDecided[]> {
  const made = await readMadeItems(asking);
  const owner = {
    selfName: vault?.selfName ?? null,
    selfEmails: vault?.selfEmails ?? [],
    people: vault?.people ?? [],
  };
  const decided: MeetingDecided[] = [];
  for (const { path, proposals } of answered) {
    decided.push(
      await decideForMeeting({
        ports: asking,
        meeting: path,
        proposals,
        owner,
        made,
        ruleSince: asking.ruleSince ?? null,
        notePaths: asking.notePaths,
        today: asking.ports.clock.today(),
      }),
    );
  }
  return decided;
}

/**
 * The first {@link MAX_PROPOSALS_PER_RUN} different proposals, in the order
 * they were read (the transcript's, part by part); the count left out is
 * added to `dropped`, so the log says it.
 */
function cappedForRun(proposals: readonly NewProposal[], dropped: DroppedItem[]): NewProposal[] {
  const unique = [...new Map(proposals.map((proposal) => [proposal.id, proposal])).values()];
  if (unique.length <= MAX_PROPOSALS_PER_RUN) return proposals as NewProposal[];
  const left = unique.length - MAX_PROPOSALS_PER_RUN;
  dropped.push({
    title: `${left} more ${left === 1 ? 'proposal' : 'proposals'}`,
    reason: `one run makes at most ${MAX_PROPOSALS_PER_RUN}, across all the parts it read; run again for the rest.`,
  });
  const kept = new Set(unique.slice(0, MAX_PROPOSALS_PER_RUN).map(({ id }) => id));
  return proposals.filter(({ id }) => kept.has(id));
}

/**
 * What the run says to the person when proposals could not be joined to
 * their meetings on Accept: the vault's Meeting type lacks a relation the
 * output links through. Said once for the run; the proposals are still made.
 */
async function missingRelations(
  { fs, markdown }: Pick<ProposalWritePorts, 'fs' | 'markdown'>,
  notes: readonly AnsweredNote[],
  schema: RegisteredProposalSchema,
): Promise<string[]> {
  if (schema.meetingRelations.length === 0 || !notes.some((note) => note.meeting?.identity)) {
    return [];
  }
  const types = await loadObjectTypes({ fs, markdown });
  const meetingType = types.find((type) => type.name.trim().toLowerCase() === MEETING_TYPE);
  const have = new Set(
    (meetingType?.properties ?? [])
      .filter((property) => property.kind === 'relation')
      .map((property) => property.key),
  );
  const missing = schema.meetingRelations.filter((relation) => !have.has(relation));
  if (missing.length === 0) return [];
  return [
    `The Meeting type has no ${missing.map((key) => `“${key}”`).join(' or ')} relation, so Accept cannot add what these proposals make to their meeting (and refuses them until it does).`,
  ];
}

/**
 * What the run knows of the vault for an output that reads it: its people,
 * terms and the vocabulary they make from the index, the term proposals
 * waiting in the Inbox (what a suggested term is held to, #19), its notes,
 * and its owner's name and addresses from the vault's settings.
 */
async function readVault({
  ports,
  index,
  markdown,
  folder,
  notePaths,
  withProjects,
}: Pick<StepArgs, 'ports' | 'index' | 'markdown' | 'notePaths'> & {
  /** The proposals folder, as this run read it once. */
  folder: ProposalsFolder;
  /** Whether to read the projects a meeting may be filed under: only for the step that files it (#227). */
  withProjects: boolean;
}): Promise<AnswerVault> {
  const { people } = await loadLinkDirectory({ index });
  const { terms, vocabulary } = await loadTerms({ index });
  const projects = withProjects ? await loadProjectOptions({ index }) : null;
  return {
    selfName: ports.selfName(),
    selfEmails: ports.selfEmails(),
    people,
    notePaths,
    terms: terms.map((term) => term.canonical),
    vocabulary,
    pendingTerms: pendingTermsIn(folder, markdown),
    ...(projects !== null && { projects }),
  };
}

/**
 * Makes the owner's tasks, then writes each planned note, then — for the
 * declared step whose output summarises — writes each meeting's summary and
 * `tasks` in one write (#185), last, so no summary lists a task that does
 * not exist. A task that cannot be made, a note the disk refuses, or a
 * meeting write refused stops the run with those already made reported —
 * they stay — so the log names everything the step left behind. A refusal in
 * words (the meeting was edited, or is being typed in) fails the run plainly
 * and keeps the answers, so the retry writes from them without asking; any
 * other fault is raised once the run is on record.
 */
async function writeAll({
  args,
  tasks,
  planned,
  summaries,
  model,
  read,
  filings,
  warnings,
  claudeRun,
  stored,
}: {
  args: StepArgs;
  tasks: readonly PlannedTask[];
  planned: readonly PlannedNote[];
  /** The summaries to write: none, unless the declared step's output summarises. */
  summaries: readonly PlannedSummary[];
  model: string;
  /** Each note's file as the run read it. */
  read: ReadonlyMap<VaultPath, ReadFile>;
  /** Meetings to file whose summary is not written with them (#227). */
  filings: readonly PropertyChange[];
  /** Gains what the person should know: a summary left as they have it. */
  warnings: string[];
  claudeRun: () => ClaudeRunInfo;
  stored: readonly StoredAnswerDraft[];
}): Promise<{ done: DoneAction[]; summaries: Map<VaultPath, SummaryOutcome> }> {
  let made: DoneAction[];
  // Each meeting's summary write joins its tasks; with none to write, each task joins as Accept's does.
  const joinsMeeting = summaries.length === 0;
  try {
    made = await makeOwnersTasks({
      ports: args,
      tasks,
      notePaths: args.notePaths,
      today: args.ports.clock.today(),
      joinsMeeting,
    });
  } catch (error) {
    if (!(error instanceof OwnersTasksStopped)) throw error;
    const cause = error.refused ? {} : { cause: error.reason };
    throw new ClaudeStepFailed(error.message, claudeRun(), { made: error.made, stored, ...cause });
  }
  const tasksMade = made.length;
  const taskPaths = made.flatMap((action) => (action.kind === 'created' ? [action.path] : []));
  for (const note of planned) {
    try {
      await args.fs.createNote({ path: note.path, contents: note.contents });
    } catch (cause) {
      // Two rules on one meeting at once: the other run made this very proposal a moment ago.
      if (
        note.id !== undefined &&
        // Unconfirmed when it cannot be read back: then the run fails on the create's own error.
        (await proposalMadeAlready(args, { path: note.path, id: note.id }).catch(() => false))
      ) {
        continue;
      }
      const notes = made.length - tasksMade;
      const said = `Made ${notes} of ${planned.length} notes, then the write failed: ${messageWithoutPaths(cause)}`;
      throw new ClaudeStepFailed(said, claudeRun(), { made, cause, stored });
    }
    made = [...made, note.made];
  }
  const outcomes = new Map<VaultPath, SummaryOutcome>();
  const notePaths = [...args.notePaths, ...taskPaths];
  for (const summary of summaries) {
    // Tasks are made in the planned order, one path each.
    const madeNow = taskPaths.filter((_, at) => tasks[at]?.meeting.path === summary.meeting);
    try {
      const written = await writeMeetingSummary(args, {
        meeting: summary.meeting,
        modified: read.get(summary.meeting)?.modified ?? Number.NaN,
        block: summary.block,
        summaryOf: summary.summaryOf,
        model,
        tasks: [...summary.madeBefore, ...madeNow],
        project: summary.project,
        notePaths,
      });
      outcomes.set(
        summary.meeting,
        summary.block === null ? 'dropped' : written.digest === null ? 'kept' : 'written',
      );
      if (written.kept !== null)
        warnings.push(`${noteTitle(summary.meeting)}: ${written.kept.reason}`);
      if (written.projectLeft !== null)
        warnings.push(projectLeftWords(summary.meeting, written.projectLeft));
      if (written.filed !== null) made = [...made, written.filed];
      if (written.digest !== null) {
        const replaced = written.replaced === null ? {} : { replaced: written.replaced };
        made = [
          ...made,
          { kind: 'summarised', path: summary.meeting, digest: written.digest, ...replaced },
        ];
      }
    } catch (cause) {
      if (!(cause instanceof MeetingSummaryRefused)) {
        throw new ClaudeStepFailed(messageWithoutPaths(cause), claudeRun(), {
          made,
          cause,
          stored,
        });
      }
      throw new ClaudeStepFailed(cause.message, claudeRun(), { made, stored });
    }
  }
  const today = args.ports.clock.today();
  made = [
    ...made,
    ...(await fileChosenMeetings({ ports: args, changes: filings, today, warnings })),
  ];
  return { done: made, summaries: outcomes };
}
