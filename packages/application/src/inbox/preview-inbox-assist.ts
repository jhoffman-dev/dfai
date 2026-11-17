import {
  ASSIST_ANSWER_SHAPE,
  assistAllowance,
  assistAllowanceWords,
  assistBatch,
  assistPlan,
  assistQuietSkip,
  assistSummary,
  CLAUDE_STEP_QUESTION,
  claudeStepSystem,
  claudeSystemProblem,
  createVaultPath,
  DECLARED_STEP_MODEL,
  FILED_UNDER_TYPES,
  filingRefusal,
  INBOX_ASSIST_PROMPT,
  INBOX_ASSIST_ROLE,
  inboxAssistData,
  localTimeMs,
  messageWithoutPaths,
  PERSON_TYPE,
  readAssistAnswer,
  waitingOnRefusal,
  type AnsweredNote,
  type AssistFacts,
  type AssistItemAnswer,
  type AssistRow,
  type AssistTarget,
  type InboxItem,
  type VaultPath,
} from '@dfai/domain';
import { notesInUseOfTypes } from '../archive/notes-in-use.ts';
import { allowanceAskTimes } from '../automations/ask-allowance.ts';
import { CLAUDE_RUN_TIMEOUT_MS } from '../automations/claude-step.ts';
import {
  ChatCancelled,
  ModelProviderError,
  type ModelProvider,
  type ProviderStatus,
} from '../chat/ports.ts';
import type { IndexPort } from '../index/ports.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import type { Clock } from '../ports.ts';
import type { VaultFsPort } from '../vault/ports.ts';

/**
 * What Inbox assist's preview reaches (#899, #900). Every one of them is
 * read; nothing here writes: no note, no log, no proposal.
 */
export interface InboxAssistPorts {
  readonly provider: () => ModelProvider;
  /** A signal that aborts once `ms` have passed. */
  readonly deadline: (ms: number) => AbortSignal;
  readonly clock: Pick<Clock, 'now' | 'today' | 'localNow'>;
  readonly fs: VaultFsPort;
  readonly markdown: MarkdownPort;
  readonly index: Pick<IndexPort, 'notesOfType' | 'query'>;
  /** Whether a pane holds typing in the note not saved yet. */
  readonly unsaved: (path: VaultPath) => boolean;
  /**
   * Keeps the moment an ask is sent, in wall-clock milliseconds, before it
   * is sent: an ask counts against the hour however it ends. Suggest writes
   * no log, so its caller keeps these.
   */
  readonly recordAsk: (at: number) => void;
}

export interface InboxAssistRequest {
  /** The items in view, in the Inbox's order. */
  readonly items: readonly InboxItem[];
  /**
   * When the preview asked before, in wall-clock milliseconds: it keeps no
   * log, so its caller counts its asks against the hourly allowance.
   */
  readonly previewed: readonly number[];
  /** Aborts the ask: the person dismissed it. It still counts. */
  readonly signal?: AbortSignal;
}

/** What a preview came to. */
export type InboxAssistOutcome =
  | {
      readonly kind: 'plan';
      readonly summary: string;
      readonly rows: readonly AssistRow[];
      /** Items after those planned, not looked at in this ask. */
      readonly notConsidered: number;
    }
  /** It did not ask, or its answer was not used; `message` says why, plainly. */
  | { readonly kind: 'not-now'; readonly message: string };

/**
 * A plan for the items in view, from one ask to Claude about at most ten of
 * them, written nowhere (#900). Proposals, briefs, meetings, notes with
 * typing not saved and notes changed in the last ten minutes are left out
 * and said so. The ask spends the vault's hourly allowance and is refused
 * when it has none left; Claude has no tools, and its answer is read as a
 * closed shape and every path in it checked against the vault.
 */
export async function previewInboxAssist(
  ports: InboxAssistPorts,
  { items, previewed, signal }: InboxAssistRequest,
): Promise<InboxAssistOutcome> {
  const batch = assistBatch(items, (path) => ports.unsaved(path));
  const open = batch.considered.filter(({ skip }) => skip === null).map(({ item }) => item);
  const { notes, quiet } = await quietNotes(ports, open);
  const skipOf = (item: InboxItem, listed: string | null) => listed ?? quiet.get(item.path) ?? null;
  const plan = (row: (item: InboxItem) => AssistRow): InboxAssistOutcome => {
    const rows = batch.considered.map(({ item, skip }) => {
      const because = skipOf(item, skip);
      return because === null ? row(item) : leftRow(item, because);
    });
    return {
      kind: 'plan',
      summary: assistSummary(rows),
      rows,
      notConsidered: batch.notConsidered,
    };
  };
  // Every item considered was skipped: nothing is asked.
  if (notes.length === 0) return plan((item) => leftRow(item, ''));
  const held = await allowanceHeld(ports, previewed);
  if (held !== null) return { kind: 'not-now', message: held };
  const asking = await askClaude(ports, { notes, signal });
  if (asking.kind === 'not-now') return asking;
  const entries = new Map(asking.entries.map((entry) => [entry.item, entry]));
  return plan((item) => assistPlan(item, entries.get(item.path)!, asking.facts));
}

function leftRow(item: InboxItem, because: string): AssistRow {
  return { path: item.path, title: item.title, step: { kind: 'leave', because }, why: null };
}

/** The open items' notes as read, and why each one changed too lately, or gone since, is left out. */
async function quietNotes(
  ports: InboxAssistPorts,
  open: readonly InboxItem[],
): Promise<{ notes: AnsweredNote[]; quiet: Map<string, string> }> {
  const quiet = new Map<string, string>();
  if (open.length === 0) return { notes: [], quiet };
  const read = await ports.fs.readNotes(open.map((item) => item.path));
  const now = ports.clock.now();
  const notes = open.flatMap((item) => {
    const file = read.find((each) => each.path === item.path);
    const skip =
      file === undefined
        ? 'It is no longer there.'
        : assistQuietSkip({ modified: file.modified, now });
    if (skip !== null) quiet.set(item.path, skip);
    return skip === null && file !== undefined ? [{ path: item.path, text: file.text }] : [];
  });
  return { notes, quiet };
}

/** What the Inbox says while the hour's asks are spent; null while one is left. */
async function allowanceHeld(
  ports: InboxAssistPorts,
  previewed: readonly number[],
): Promise<string | null> {
  const local = ports.clock.localNow();
  const logged = await allowanceAskTimes(ports, local);
  const allowance = assistAllowance({ logged, previewed, now: localTimeMs(local) ?? 0 });
  return allowance.ok ? null : assistAllowanceWords(allowance.until);
}

type Asking =
  | {
      readonly kind: 'answered';
      readonly entries: readonly AssistItemAnswer[];
      readonly facts: AssistFacts;
    }
  | Extract<InboxAssistOutcome, { kind: 'not-now' }>;

const notUsed = (problem: string): Asking => ({
  kind: 'not-now',
  message: `Claude’s answer was not used: ${problem} Nothing changed.`,
});

/** One ask about `notes`, with no tools, counted before it is sent, and its answer read whole or refused. */
async function askClaude(
  ports: InboxAssistPorts,
  { notes, signal }: { notes: readonly AnsweredNote[]; signal: AbortSignal | undefined },
): Promise<Asking> {
  const provider = ports.provider();
  const status = await provider.status();
  if (!status.ready) return { kind: 'not-now', message: unreachableWords(status) };
  const facts = await vaultFacts(ports);
  const system = claudeStepSystem({
    today: facts.today,
    prompt: INBOX_ASSIST_PROMPT,
    answer: ASSIST_ANSWER_SHAPE,
    notes,
    data: inboxAssistData(facts),
    role: INBOX_ASSIST_ROLE,
  });
  const tooLong = claudeSystemProblem(system);
  if (tooLong !== null) return { kind: 'not-now', message: tooLong };
  ports.recordAsk(localTimeMs(ports.clock.localNow()) ?? ports.clock.now());
  const said = await oneRound(provider, {
    system,
    signal: linked(ports.deadline(CLAUDE_RUN_TIMEOUT_MS), signal),
  });
  if (!said.ok) return { kind: 'not-now', message: said.message };
  const read = readAssistAnswer(
    said.text,
    notes.map((note) => note.path),
  );
  return read.ok ? { kind: 'answered', entries: read.value, facts } : notUsed(read.problem);
}

/**
 * Claude's answer in one round, or why there is none. Suggest sends one
 * request and reads what comes back: a tool call, or a call written so badly
 * it could not be read, refuses the answer rather than start another round,
 * so one ask is one request.
 */
async function oneRound(
  provider: ModelProvider,
  { system, signal }: { system: string; signal: AbortSignal },
): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  const request = {
    model: DECLARED_STEP_MODEL,
    system,
    messages: [{ role: 'user' as const, text: CLAUDE_STEP_QUESTION }],
    tools: [],
  };
  let text = '';
  try {
    for await (const event of provider.stream(request, signal)) {
      if (event.type === 'text') text += event.text;
      if (event.type === 'tool_call' || event.type === 'malformed') {
        return { ok: false, message: TOOL_REFUSED };
      }
    }
  } catch (thrown) {
    if (thrown instanceof ChatCancelled) return { ok: false, message: STOPPED };
    if (!(thrown instanceof ModelProviderError)) throw thrown;
    return {
      ok: false,
      message: `Not now: Claude could not be reached (${messageWithoutPaths(thrown)}). Nothing changed.`,
    };
  }
  return signal.aborted ? { ok: false, message: STOPPED } : { ok: true, text };
}

const STOPPED = 'Claude did not finish. Nothing changed.';
const TOOL_REFUSED =
  'Claude’s answer was not used: it reached for a tool, and Suggest gives it none. Nothing changed.';

/** A signal that aborts when either does: the time limit, or the person dismissing the ask. */
function linked(deadline: AbortSignal, dismissed: AbortSignal | undefined): AbortSignal {
  if (dismissed === undefined) return deadline;
  const both = new AbortController();
  const stop = () => both.abort();
  for (const signal of [deadline, dismissed]) {
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  }
  return both.signal;
}

function unreachableWords(status: Extract<ProviderStatus, { ready: false }>): string {
  const fix = status.fix === null ? '' : ` Fix: ${status.fix}`;
  return `Not now: Claude can’t be reached. ${messageWithoutPaths(status.message)}${fix} Nothing was asked; nothing changed.`;
}

/** The projects, areas and people clarifying offers: what an answer's names are checked against. */
async function vaultFacts(ports: InboxAssistPorts): Promise<AssistFacts> {
  const [projects, people] = await Promise.all([
    notesInUseOfTypes({ index: ports.index, types: FILED_UNDER_TYPES }),
    notesInUseOfTypes({ index: ports.index, types: [PERSON_TYPE] }),
  ]);
  const target = (note: { path: string; title: string }): AssistTarget => ({
    path: createVaultPath(note.path),
    title: note.title,
  });
  return {
    today: ports.clock.today(),
    filingTargets: projects
      .filter(
        (note) => filingRefusal({ path: createVaultPath(note.path), type: note.type }) === null,
      )
      .map(target),
    people: people
      .filter(
        (note) => waitingOnRefusal({ path: createVaultPath(note.path), type: note.type }) === null,
      )
      .map(target),
  };
}
