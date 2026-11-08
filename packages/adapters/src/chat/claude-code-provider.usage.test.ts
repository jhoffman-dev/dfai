import { describe, expect, it } from 'vitest';
import { ModelProviderError, type ModelEvent, type ModelRequest } from '@dfai/application';
import { claudeCodeProvider } from './claude-code-provider.ts';
import type { ModelProcessHost } from './model-process.ts';

/**
 * #788: the tokens a call spent, read from the result line Claude Code
 * prints last — or nothing, when that line says none that reads.
 */

const REQUEST: ModelRequest = {
  model: 'claude-opus-5-5',
  system: 'You are Claude in DFAI.',
  messages: [{ role: 'user', text: 'Who is Mara Quill?' }],
  tools: [],
};

const USAGE = {
  input_tokens: 9000,
  cache_creation_input_tokens: 2100,
  cache_read_input_tokens: 30_100,
  output_tokens: 2140,
};
const delta = (text: string) =>
  JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  });
const resultLine = (fields: Record<string, unknown>) =>
  JSON.stringify({ type: 'result', is_error: false, result: 'Mara leads payroll.', ...fields });

function printing(lines: string[], code = 0): ModelProcessHost {
  return {
    async run({ onLine }) {
      for (const line of lines) onLine(line);
      return { code, stderr: '' };
    },
  };
}

async function eventsOf(host: ModelProcessHost): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of claudeCodeProvider(host).stream(REQUEST, new AbortController().signal))
    events.push(event);
  return events;
}

const usageEvents = (events: ModelEvent[]) => events.filter((event) => event.type === 'usage');

describe('Claude Code’s usage', () => {
  it('reads every count and the cost from the result line, after the words', async () => {
    const events = await eventsOf(
      printing([delta('Mara leads payroll.'), resultLine({ usage: USAGE, total_cost_usd: 0.41 })]),
    );
    expect(events).toEqual([
      { type: 'text', text: 'Mara leads payroll.' },
      {
        type: 'usage',
        usage: { input: 9000, cacheCreation: 2100, cacheRead: 30_100, output: 2140, costUsd: 0.41 },
      },
    ]);
  });

  it('says none when the result line has no usage', async () => {
    expect(usageEvents(await eventsOf(printing([delta('Hi.'), resultLine({})])))).toEqual([]);
  });

  it('says none when a count is missing, rather than taking it for zero', async () => {
    const withoutOutput: Record<string, number> = { ...USAGE };
    delete withoutOutput['output_tokens'];
    const events = await eventsOf(printing([resultLine({ usage: withoutOutput })]));
    expect(usageEvents(events)).toEqual([]);
  });

  it.each([
    ['a count that is text', { ...USAGE, input_tokens: '9000' }],
    ['a negative count', { ...USAGE, output_tokens: -1 }],
    ['usage that is no object', 'lots'],
  ])('says none for %s, and still answers', async (_, usage) => {
    const events = await eventsOf(printing([delta('Hi.'), resultLine({ usage })]));
    expect(usageEvents(events)).toEqual([]);
    expect(events).toEqual([{ type: 'text', text: 'Hi.' }]);
  });

  it('keeps the counts but not a cost that does not read', async () => {
    const events = await eventsOf(printing([resultLine({ usage: USAGE, total_cost_usd: 'free' })]));
    expect(usageEvents(events)).toEqual([
      {
        type: 'usage',
        usage: { input: 9000, cacheCreation: 2100, cacheRead: 30_100, output: 2140 },
      },
    ]);
  });

  it('says what a failed call spent, then fails', async () => {
    const failed = JSON.stringify({
      type: 'result',
      is_error: true,
      result: 'Overloaded.',
      usage: USAGE,
    });
    const seen: ModelEvent[] = [];
    const run = (async () => {
      for await (const event of claudeCodeProvider(printing([failed], 1)).stream(
        REQUEST,
        new AbortController().signal,
      ))
        seen.push(event);
    })();
    await expect(run).rejects.toBeInstanceOf(ModelProviderError);
    expect(usageEvents(seen)).toHaveLength(1);
  });
});
