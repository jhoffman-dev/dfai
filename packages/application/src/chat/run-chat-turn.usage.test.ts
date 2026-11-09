import { describe, expect, it } from 'vitest';
import type { ModelUsage, ToolCall } from '@dfai/domain';
import { fakeModel, type ScriptedRound } from '../testing/fake-model.ts';
import { ModelProviderError, type ModelEvent } from './ports.ts';
import { ChatTurnFailed, MAX_TOOL_ROUNDS, runChatTurn, turnFailureOf } from './run-chat-turn.ts';
import type { ChatToolbox } from './toolbox.ts';

/** #788: what a turn spent, summed over its rounds, and how many rounds it took. */

const search: ToolCall = { id: 'call-1', name: 'atlas_search', input: { q: 'Mara Quill' } };
const toolbox: ChatToolbox = {
  specs: [{ name: 'atlas_search', description: 'Search.', inputSchema: {} }],
  run: async (call) => ({
    result: { callId: call.id, name: call.name, content: 'no hits', isError: false },
    proposal: null,
  }),
};

const FIRST: ModelUsage = { input: 900, cacheCreation: 2100, cacheRead: 15_000, output: 640 };
const SECOND: ModelUsage = { input: 8100, cacheCreation: 0, cacheRead: 15_100, output: 1500 };
const spent = (usage: ModelUsage): ModelEvent => ({ type: 'usage', usage });

function turn(rounds: readonly ScriptedRound[], signal = new AbortController().signal) {
  return runChatTurn({
    provider: fakeModel(rounds),
    toolbox,
    model: 'claude-opus-5-5',
    system: 'System.',
    history: [{ role: 'user', text: 'Who is Mara Quill?' }],
    signal,
    onEvent: () => {
      // The words are not what these tests are about.
    },
  });
}

describe('runChatTurn’s usage', () => {
  it('sums what each round spent, and counts the rounds', async () => {
    const outcome = await turn([
      [{ type: 'tool_call', call: search }, spent(FIRST)],
      [{ type: 'text', text: 'Mara leads payroll.' }, spent(SECOND)],
    ]);
    expect(outcome.rounds).toBe(2);
    expect(outcome.usage).toEqual({
      input: 9000,
      cacheCreation: 2100,
      cacheRead: 30_100,
      output: 2140,
    });
  });

  it('is unknown when one round said nothing of its usage, never a total too low', async () => {
    const outcome = await turn([
      [{ type: 'tool_call', call: search }, spent(FIRST)],
      [{ type: 'text', text: 'Mara leads payroll.' }],
    ]);
    expect(outcome.rounds).toBe(2);
    expect(outcome.usage).toBeNull();
  });

  it('takes the last reading when a round says two', async () => {
    const outcome = await turn([[{ type: 'text', text: 'Hi.' }, spent(FIRST), spent(SECOND)]]);
    expect(outcome.usage).toEqual(SECOND);
  });

  it('is unknown for a round Stop cut off', async () => {
    const stop = new AbortController();
    const outcome = await turn(
      [
        async function* () {
          yield { type: 'text', text: 'Mara' } as const;
          stop.abort();
          yield spent(FIRST);
        },
      ],
      stop.signal,
    );
    expect(outcome).toMatchObject({ stopped: true, rounds: 1, usage: null });
  });

  it('counts every round when they run out', async () => {
    const looking: ScriptedRound = [{ type: 'tool_call', call: search }, spent(FIRST)];
    const outcome = await turn(Array.from({ length: MAX_TOOL_ROUNDS }, () => looking));
    expect(outcome.rounds).toBe(MAX_TOOL_ROUNDS);
    expect(outcome.usage?.output).toBe(640 * MAX_TOOL_ROUNDS);
  });
});

describe('runChatTurn’s usage when the turn fails (#794)', () => {
  const failure = async (promise: Promise<unknown>) => {
    const thrown = await promise.then(
      () => null,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(ChatTurnFailed);
    return turnFailureOf(thrown);
  };

  it('carries the rounds and what they spent, the failing round with what it reported first', async () => {
    const broke = new ModelProviderError('failed', 'Overloaded.');
    const { cause, spend } = await failure(
      turn([
        [{ type: 'tool_call', call: search }, spent(FIRST)],
        async function* () {
          yield spent(SECOND);
          throw broke;
        },
      ]),
    );
    expect(cause).toBe(broke);
    expect(spend).toEqual({
      rounds: 2,
      usage: { input: 9000, cacheCreation: 2100, cacheRead: 30_100, output: 2140 },
    });
  });

  it('is unknown when the failing round said nothing of what it spent', async () => {
    const { spend } = await failure(
      turn([[{ type: 'tool_call', call: search }, spent(FIRST)], new Error('down')]),
    );
    expect(spend).toEqual({ rounds: 2, usage: null });
  });

  it('carries what was spent when a tool fails the turn after its round ended', async () => {
    const refusing: ChatToolbox = {
      ...toolbox,
      run: async () => {
        throw new Error('This rule does not let it use that tool.');
      },
    };
    const thrown = await runChatTurn({
      provider: fakeModel([[{ type: 'tool_call', call: search }, spent(FIRST)]]),
      toolbox: refusing,
      model: 'claude-opus-5-5',
      system: 'System.',
      history: [{ role: 'user', text: 'Who is Mara Quill?' }],
      signal: new AbortController().signal,
      onEvent: () => {
        // The words are not what this test is about.
      },
    }).catch((error: unknown) => error);
    expect(thrown).toMatchObject({ message: 'This rule does not let it use that tool.' });
    expect(turnFailureOf(thrown).spend).toEqual({ rounds: 1, usage: FIRST });
  });

  it('reads any other error as one with no spend, itself the cause', () => {
    const other = new Error('disk full');
    expect(turnFailureOf(other)).toEqual({ cause: other, spend: null });
  });
});
