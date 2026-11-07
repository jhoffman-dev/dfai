import { describe, expect, it } from 'vitest';
import type { ToolCall } from '@dfai/domain';
import { fakeModel } from '../testing/fake-model.ts';
import { ChatCancelled, ModelProviderError, type ModelEvent } from './ports.ts';
import { MAX_TOOL_ROUNDS, runChatTurn, type ChatTurnEvent } from './run-chat-turn.ts';
import type { ChatToolbox } from './toolbox.ts';

const search: ToolCall = { id: 'call-1', name: 'atlas_search', input: { q: 'Sam' } };

/** A toolbox that answers every call with its name, and records the order they ran in. */
function echoToolbox(): ChatToolbox & { ran: string[] } {
  const ran: string[] = [];
  return {
    ran,
    specs: [{ name: 'atlas_search', description: 'Search.', inputSchema: {} }],
    run: async (call) => {
      ran.push(call.name);
      return {
        result: { callId: call.id, name: call.name, content: `ran ${call.name}`, isError: false },
        proposal: null,
      };
    },
  };
}

async function turn(
  rounds: Parameters<typeof fakeModel>[0],
  signal = new AbortController().signal,
) {
  const provider = fakeModel(rounds);
  const toolbox = echoToolbox();
  const events: ChatTurnEvent[] = [];
  const outcome = await runChatTurn({
    provider,
    toolbox,
    model: 'claude-opus-5-5',
    system: 'System.',
    history: [{ role: 'user', text: 'Who is Sam?' }],
    signal,
    onEvent: (event) => events.push(event),
  });
  return { outcome, events, provider, toolbox };
}

describe('runChatTurn', () => {
  it('streams an answer that calls no tool, and ends', async () => {
    const { outcome, events, provider } = await turn([
      [
        { type: 'text', text: 'Sam is ' },
        { type: 'text', text: 'a friend.' },
      ],
    ]);
    expect(events).toEqual([
      { type: 'text', text: 'Sam is ' },
      { type: 'text', text: 'a friend.' },
    ]);
    expect(outcome).toEqual({
      added: [{ role: 'assistant', text: 'Sam is a friend.', toolCalls: [] }],
      stopped: false,
      rounds: 1,
      usage: null,
    });
    expect(provider.requests[0]).toMatchObject({
      model: 'claude-opus-5-5',
      system: 'System.',
      tools: [{ name: 'atlas_search' }],
    });
  });

  it('runs the tools a reply calls, sends the results back, and asks again', async () => {
    const { outcome, events, provider, toolbox } = await turn([
      [
        { type: 'text', text: 'Looking.' },
        { type: 'tool_call', call: search },
      ],
      [{ type: 'text', text: 'Found him.' }],
    ]);

    expect(toolbox.ran).toEqual(['atlas_search']);
    expect(events.map((event) => event.type)).toEqual([
      'text',
      'tool_started',
      'tool_finished',
      'text',
    ]);
    expect(provider.requests[1]?.messages).toEqual([
      { role: 'user', text: 'Who is Sam?' },
      { role: 'assistant', text: 'Looking.', toolCalls: [search] },
      {
        role: 'tool',
        results: [
          { callId: 'call-1', name: 'atlas_search', content: 'ran atlas_search', isError: false },
        ],
      },
    ]);
    expect(outcome.added).toHaveLength(3);
  });

  it('tells the model when it wrote a tool call that could not be read', async () => {
    const { provider } = await turn([
      [{ type: 'malformed', problem: 'A tool call was not valid JSON.' }],
      [{ type: 'text', text: 'Sorry.' }],
    ]);
    expect(provider.requests[1]?.messages.at(-1)).toEqual({
      role: 'tool',
      results: [
        {
          callId: 'malformed-1',
          name: 'invalid_tool_call',
          content: 'A tool call was not valid JSON.',
          isError: true,
        },
      ],
    });
  });

  it(`stops after ${MAX_TOOL_ROUNDS} rounds of tools and says so`, async () => {
    const looping: ModelEvent[] = [{ type: 'tool_call', call: search }];
    const { outcome, provider } = await turn(
      Array.from({ length: MAX_TOOL_ROUNDS }, () => looping),
    );
    expect(provider.requests).toHaveLength(MAX_TOOL_ROUNDS);
    expect(outcome.added.at(-1)).toMatchObject({
      role: 'assistant',
      text: expect.stringContaining('stopped after 8'),
    });
  });

  it('keeps what arrived when Stop is pressed mid-answer', async () => {
    const stop = new AbortController();
    const { outcome } = await turn(
      [
        async function* () {
          yield { type: 'text', text: 'Half an ' } as const;
          stop.abort();
          yield { type: 'text', text: 'answer' } as const;
        },
      ],
      stop.signal,
    );
    expect(outcome).toEqual({
      added: [{ role: 'assistant', text: 'Half an ', toolCalls: [] }],
      stopped: true,
      rounds: 1,
      usage: null,
    });
  });

  it('adds nothing when Stop comes before any words', async () => {
    const { outcome } = await turn([new ChatCancelled()]);
    expect(outcome).toEqual({ added: [], stopped: true, rounds: 1, usage: null });
  });

  it('passes a provider failure on to the panel', async () => {
    await expect(
      turn([new ModelProviderError('not_logged_in', 'Log in to Claude Code.')]),
    ).rejects.toThrow('Log in to Claude Code.');
  });
});
