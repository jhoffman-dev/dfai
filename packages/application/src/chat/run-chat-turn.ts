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

export interface ChatTurnOutcome {
  /** What the turn added to the conversation, in order. */
  readonly added: readonly ModelMessage[];
  /** True when Stop ended it; what had arrived is kept. */
  readonly stopped: boolean;
  /** How many times the model was asked. */
  readonly rounds: number;
  /** What its rounds spent, summed; null when any round's usage is unknown (#788). */
  readonly usage: ModelUsage | null;
}

/**
 * One question answered: the model is asked, any tools it calls are run and
 * their results sent back, until it answers without calling one — or Stop is
 * pressed, or the rounds run out. A provider failure rejects; what the turn
 * had added is then lost, and Retry asks again from the question.
 */
export async function runChatTurn({
  provider,
  toolbox,
  model,
  system,
  history,
  signal,
  onEvent,
}: {
  provider: ModelProvider;
  toolbox: ChatToolbox;
  model: string;
  system: string;
  /** The conversation so far, ending with the person's question. */
  history: readonly ModelMessage[];
  signal: AbortSignal;
  onEvent: (event: ChatTurnEvent) => void;
}): Promise<ChatTurnOutcome> {
  const added: ModelMessage[] = [];
  const readings: (ModelUsage | null)[] = [];
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
      if (!(error instanceof ChatCancelled)) throw error;
      // A round Stop cut off said nothing of what it spent: the turn's usage is unknown.
      readings.push(null);
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
