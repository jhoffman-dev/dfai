import { describe, expect, it } from 'vitest';
import type { ModelUsage, ToolCall } from '@dfai/domain';
import { fakeModel, type ScriptedRound } from '../testing/fake-model.ts';
import type { ModelEvent } from './ports.ts';
import { MAX_TOOL_ROUNDS, runChatTurn } from './run-chat-turn.ts';
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
