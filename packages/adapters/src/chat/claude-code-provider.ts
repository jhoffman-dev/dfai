import {
  createToolCallScanner,
  renderTranscript,
  toolProtocolInstructions,
  type ScannedPiece,
  type ToolCallScanner,
} from '@dfai/domain';
import {
  ChatCancelled,
  ModelProviderError,
  type ModelEvent,
  type ModelProvider,
  type ModelRequest,
  type ProviderStatus,
} from '@dfai/application';
import { createEventQueue } from './event-queue.ts';
import { ProgramNotFound, type ModelProcessHost, type ProcessExit } from './model-process.ts';
import { isLoginProblem, readStreamJsonLine } from './stream-json.ts';

/** What fixes each problem, as the panel shows it to copy. */
export const INSTALL_CLAUDE_CODE = 'curl -fsSL https://claude.ai/install.sh | bash';
export const LOG_IN_TO_CLAUDE_CODE = 'claude auth login';

/** How long `claude` is given, in milliseconds, before DFAI kills it and says so. */
export interface ClaudeCodeTimeouts {
  /** `claude auth status`, which answers at once unless something is wrong. */
  readonly status: number;
  /** One round of a turn, however long the answer. */
  readonly run: number;
}

export const CLAUDE_CODE_TIMEOUTS: ClaudeCodeTimeouts = { status: 15_000, run: 10 * 60_000 };

/**
 * The model, reached through the person's own Claude Code (ADR-0021). DFAI
 * never sees their login: it starts `claude` in print mode with every one of
 * Claude Code's own tools off, sends the conversation on stdin, and reads the
 * streamed reply. DFAI's tools are described in the system prompt and read
 * back out of the text.
 */
export function claudeCodeProvider(
  host: ModelProcessHost,
  { timeouts = CLAUDE_CODE_TIMEOUTS }: { timeouts?: ClaudeCodeTimeouts } = {},
): ModelProvider {
  return {
    id: 'claude-code',
    status: () => claudeCodeStatus(host, timeouts.status),
    stream: (request, signal) => streamReply({ host, request, signal, limit: timeouts.run }),
  };
}

/**
 * The arguments for one turn. The host refuses any shape but this one; in
 * particular `--tools ""` must be there, which turns off Bash, file access and
 * web fetch, so what the model can reach is only what DFAI runs for it.
 */
export function claudeCodeArgs(request: ModelRequest): string[] {
  // A request with no tools is told of no protocol for calling one (#169).
  const system =
    request.tools.length === 0
      ? request.system
      : `${request.system}\n\n${toolProtocolInstructions(request.tools)}`;
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model',
    request.model,
    '--tools',
    '',
    '--system-prompt',
    system,
    '--no-session-persistence',
    '--setting-sources',
    '',
    '--strict-mcp-config',
  ];
}

function transcriptPrompt(request: ModelRequest): string {
  return `${renderTranscript(request.messages)}\n\nReply as the assistant to the last message.`;
}

async function* streamReply({
  host,
  request,
  signal,
  limit,
}: {
  host: ModelProcessHost;
  request: ModelRequest;
  signal: AbortSignal;
  limit: number;
}): AsyncGenerator<ModelEvent> {
  const deadline = withDeadline(signal, limit);
  const queue = createEventQueue<ModelEvent>();
  const scanner = request.tools.length === 0 ? TEXT_ONLY : createToolCallScanner();
  let verdict: { isError: boolean; message: string } | null = null;
  const onLine = (line: string) => {
    const read = readStreamJsonLine(line);
    if (read.kind === 'text')
      for (const piece of scanner.push(read.text)) queue.push(eventOf(piece));
    else if (read.kind === 'result') verdict = read;
  };
  const running = host
    .run({
      args: claudeCodeArgs(request),
      stdin: transcriptPrompt(request),
      onLine,
      signal: deadline.signal,
    })
    .then(
      (exit) => {
        for (const piece of scanner.end()) queue.push(eventOf(piece));
        queue.close(deadline.expired() ? ranOut(limit) : failureOf({ exit, verdict, signal }));
      },
      (error: unknown) =>
        queue.close(deadline.expired() ? ranOut(limit) : hostFailure(error, signal)),
    )
    .finally(deadline.clear);
  yield* queue.drain();
  await running;
}

/** With no tools to call, nothing in a reply is a call: its words are passed on whole. */
const TEXT_ONLY: ToolCallScanner = {
  push: (text) => [{ kind: 'text', text }],
  end: () => [],
};

/**
 * `signal`, aborted also once `limit` has passed — which kills the process —
 * and able to say which of the two it was: a Stop is not a failure.
 */
function withDeadline(signal: AbortSignal, limit: number) {
  const inner = new AbortController();
  let expired = false;
  const abort = () => inner.abort();
  const timer = setTimeout(() => {
    expired = true;
    inner.abort();
  }, limit);
  if (signal.aborted) inner.abort();
  else signal.addEventListener('abort', abort, { once: true });
  return {
    signal: inner.signal,
    expired: () => expired,
    clear: () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    },
  };
}

const ranOut = (limit: number) =>
  new ModelProviderError('failed', `Claude Code did not finish within ${spoken(limit)}.`);

function spoken(ms: number): string {
  const [amount, unit] = ms < 60_000 ? [ms / 1000, 'second'] : [ms / 60_000, 'minute'];
  return `${amount} ${unit}${amount === 1 ? '' : 's'}`;
}

function eventOf(piece: ScannedPiece): ModelEvent {
  if (piece.kind === 'text') return { type: 'text', text: piece.text };
  if (piece.kind === 'tool_call') return { type: 'tool_call', call: piece.call };
  return { type: 'malformed', problem: piece.problem };
}

function failureOf({
  exit,
  verdict,
  signal,
}: {
  exit: ProcessExit;
  verdict: { isError: boolean; message: string } | null;
  signal: AbortSignal;
}): Error | null {
  if (signal.aborted) return new ChatCancelled();
  const said = verdict?.isError === true ? verdict.message : exit.code === 0 ? null : exit.stderr;
  if (said === null) return null;
  if (isLoginProblem(said)) return notLoggedIn();
  return new ModelProviderError(
    'failed',
    `Claude Code could not answer: ${said.trim() || `it exited with ${exit.code}`}`,
  );
}

function hostFailure(error: unknown, signal: AbortSignal): Error {
  if (signal.aborted) return new ChatCancelled();
  if (error instanceof ProgramNotFound) return notInstalled();
  const message = error instanceof Error ? error.message : String(error);
  return new ModelProviderError('failed', `Claude Code could not be started: ${message}`);
}

const notInstalled = () =>
  new ModelProviderError(
    'not_installed',
    'Claude Code is not installed on this Mac, or not where DFAI looks for it.',
  );

const notLoggedIn = () =>
  new ModelProviderError('not_logged_in', 'Claude Code is installed but not logged in.');

/** Asks `claude auth status`. Only `loggedIn` is read: the rest names the account. */
async function claudeCodeStatus(host: ModelProcessHost, limit: number): Promise<ProviderStatus> {
  const lines: string[] = [];
  const deadline = withDeadline(new AbortController().signal, limit);
  try {
    await host.run({
      args: ['auth', 'status'],
      stdin: '',
      onLine: (line) => lines.push(line),
      signal: deadline.signal,
    });
  } catch (error) {
    if (deadline.expired()) return silentStatus(limit);
    if (error instanceof ProgramNotFound) {
      return {
        ready: false,
        problem: 'not_installed',
        message: notInstalled().message,
        fix: INSTALL_CLAUDE_CODE,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      ready: false,
      problem: 'unavailable',
      message: `Claude Code could not be asked: ${message}`,
      fix: null,
    };
  } finally {
    deadline.clear();
  }
  if (deadline.expired()) return silentStatus(limit);
  if (loggedIn(lines.join('\n'))) return { ready: true };
  return {
    ready: false,
    problem: 'not_logged_in',
    message: notLoggedIn().message,
    fix: LOG_IN_TO_CLAUDE_CODE,
  };
}

function silentStatus(limit: number): ProviderStatus {
  return {
    ready: false,
    problem: 'unavailable',
    message: `Claude Code did not say whether it is logged in within ${spoken(limit)}.`,
    fix: null,
  };
}

function loggedIn(output: string): boolean {
  try {
    return (JSON.parse(output) as { loggedIn?: unknown }).loggedIn === true;
  } catch {
    // An older Claude Code answers in words rather than JSON.
    return /logged in/i.test(output) && !/not logged in/i.test(output);
  }
}
