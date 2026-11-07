import {
  sumUsage,
  trimTranscript,
  type ModelMessage,
  type ModelUsage,
  type ToolCall,
  type ToolResult,
} from '@dfai/domain';
import { ChatCancelled, type ModelEvent, type ModelProvider } from './ports.ts';
import type { Proposal } from './proposals.ts';
import type { ChatToolbox } from './toolbox.ts';

/** Rounds of tool calls one question may take before the chat stops asking. */
export const MAX_TOOL_ROUNDS = 8;

/** What the panel hears as a turn goes. */
export type ChatTurnEvent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_started'; readonly call: ToolCall }
  | {
      readonly type: 'tool_finished';
      readonly call: ToolCall;
      readonly result: ToolResult;
      readonly proposal: Proposal | null;
    };

/** How many times a turn asked the model, and what that spent, summed (#788). */
export interface TurnSpend {
  readonly rounds: number;
  /** Null when any round's usage is unknown: a total is never too low. */
  readonly usage: ModelUsage | null;
}

export interface ChatTurnOutcome extends TurnSpend {
  /** What the turn added to the conversation, in order. */
  readonly added: readonly ModelMessage[];
  /** True when Stop ended it; what had arrived is kept. */
  readonly stopped: boolean;
}

/**
 * A turn that failed — its provider, or a tool it ran — after what it had
 * spent so far (#788): the rounds asked and their usage, the round that
 * failed counted with whatever it reported first. `cause` is what failed.
 */
export class ChatTurnFailed extends Error {
  readonly spend: TurnSpend;
  constructor(cause: unknown, spend: TurnSpend) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'ChatTurnFailed';
    this.spend = spend;
  }
}

/** What a failed turn had spent, and what failed it: the error itself when it is no `ChatTurnFailed`. */
export function turnFailureOf(error: unknown): { cause: unknown; spend: TurnSpend | null } {
  if (!(error instanceof ChatTurnFailed)) return { cause: error, spend: null };
  return { cause: error.cause, spend: error.spend };
}

/**
 * One question answered: the model is asked, any tools it calls are run and
 * their results sent back, until it answers without calling one — or Stop is
 * pressed, or the rounds run out. A failure rejects with `ChatTurnFailed`,
 * which says what the turn had spent; what it had added is lost, and Retry
 * asks again from the question.
 */
export async function runChatTurn(turn: TurnArgs): Promise<ChatTurnOutcome> {
  const readings: (ModelUsage | null)[] = [];
  try {
    return await askRounds(turn, readings);
  } catch (error) {
    throw new ChatTurnFailed(error, { rounds: readings.length, usage: sumUsage(readings) });
  }
}

interface TurnArgs {
  provider: ModelProvider;
  toolbox: ChatToolbox;
  model: string;
  system: string;
  /** The conversation so far, ending with the person's question. */
  history: readonly ModelMessage[];
  signal: AbortSignal;
  onEvent: (event: ChatTurnEvent) => void;
}

/** The turn's rounds, each one's usage added to `readings` as it ends — however it ends. */
async function askRounds(
  { provider, toolbox, model, system, history, signal, onEvent }: TurnArgs,
  readings: (ModelUsage | null)[],
): Promise<ChatTurnOutcome> {
  const added: ModelMessage[] = [];
  const ended = (stopped: boolean): ChatTurnOutcome => ({
    added,
    stopped,
    rounds: readings.length,
    usage: sumUsage(readings),
  });
  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const reply: Reply = { text: '', calls: [], malformed: [], usage: null };
    try {
      const messages = trimTranscript([...history, ...added]);
      const request = { model, system, messages, tools: toolbox.specs };
      for await (const event of provider.stream(request, signal)) take(event, reply, onEvent);
    } catch (error) {
      // A round cut off counts what it reported before it was: unknown when that was nothing.
      readings.push(reply.usage);
      if (!(error instanceof ChatCancelled)) throw error;
      if (reply.text !== '') added.push({ role: 'assistant', text: reply.text, toolCalls: [] });
      return ended(true);
    }
    readings.push(reply.usage);
    added.push({ role: 'assistant', text: reply.text, toolCalls: reply.calls });
    if (reply.calls.length === 0 && reply.malformed.length === 0) return ended(false);

    const results = await runCalls({ calls: reply.calls, toolbox, onEvent });
    added.push({ role: 'tool', results: [...results, ...reply.malformed.map(malformedResult)] });
    if (signal.aborted) return ended(true);
  }
  const gaveUp = `\n\n(I stopped after ${MAX_TOOL_ROUNDS} rounds of looking things up without an answer.)`;
  onEvent({ type: 'text', text: gaveUp });
  added.push({ role: 'assistant', text: gaveUp.trim(), toolCalls: [] });
  return ended(false);
}

/** What one round has said so far. */
interface Reply {
  text: string;
  calls: ToolCall[];
  malformed: string[];
  /** Its last reading of what it spent; null until one arrives. */
  usage: ModelUsage | null;
}

function take(event: ModelEvent, reply: Reply, onEvent: (event: ChatTurnEvent) => void): void {
  switch (event.type) {
    case 'text':
      reply.text += event.text;
      onEvent(event);
      return;
    case 'tool_call':
      reply.calls.push(event.call);
      return;
    case 'malformed':
      reply.malformed.push(event.problem);
      return;
    case 'usage':
      reply.usage = event.usage;
  }
}

/** Runs each call in the order the model made them, telling the panel as each starts and ends. */
async function runCalls({
  calls,
  toolbox,
  onEvent,
}: {
  calls: readonly ToolCall[];
  toolbox: ChatToolbox;
  onEvent: (event: ChatTurnEvent) => void;
}): Promise<ToolResult[]> {
  const results: ToolResult[] = [];
  for (const call of calls) {
    onEvent({ type: 'tool_started', call });
    const { result, proposal } = await toolbox.run(call);
    onEvent({ type: 'tool_finished', call, result, proposal });
    results.push(result);
  }
  return results;
}

function malformedResult(problem: string, at: number): ToolResult {
  return {
    callId: `malformed-${at + 1}`,
    name: 'invalid_tool_call',
    content: problem,
    isError: true,
  };
}
