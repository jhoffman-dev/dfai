import { describe, expect, it } from 'vitest';
import { ModelProviderError, type ModelEvent, type ModelRequest } from '@dfai/application';
import {
  ANTHROPIC_ORIGIN,
  anthropicApiProvider,
  type ModelHttpHost,
} from './anthropic-api-provider.ts';

/** #788: the tokens a call spent, read from the API's `usage` — or nothing, when it does not read. */

const REQUEST: ModelRequest = {
  model: 'claude-opus-5-5',
  system: 'System.',
  messages: [{ role: 'user', text: 'Who is Tobias Fenn?' }],
  tools: [],
};

const USAGE = {
  input_tokens: 9000,
  cache_creation_input_tokens: 2100,
  cache_read_input_tokens: 30_100,
  output_tokens: 2140,
};

function answering(status: number, body: unknown): ModelHttpHost {
  return { post: async () => ({ status, body: JSON.stringify(body) }) };
}

async function eventsOf(http: ModelHttpHost): Promise<ModelEvent[]> {
  const provider = anthropicApiProvider({
    http,
    secrets: { list: async () => [{ name: 'anthropic', origins: [ANTHROPIC_ORIGIN] }] },
    vault: () => '/v',
  });
  const events: ModelEvent[] = [];
  for await (const event of provider.stream(REQUEST, new AbortController().signal))
    events.push(event);
  return events;
}

const TEXT = [{ type: 'text', text: 'Tobias runs the vendor calls.' }];
const usageEvents = (events: ModelEvent[]) => events.filter((event) => event.type === 'usage');

describe('the Anthropic API’s usage', () => {
  it('reads every count, after the words, with no cost: the API says none', async () => {
    const events = await eventsOf(answering(200, { content: TEXT, usage: USAGE }));
    expect(events).toEqual([
      { type: 'text', text: 'Tobias runs the vendor calls.' },
      {
        type: 'usage',
        usage: { input: 9000, cacheCreation: 2100, cacheRead: 30_100, output: 2140 },
      },
    ]);
  });

  it('counts the cache as none when the API says null for it, as it does when no cache was used', async () => {
    const usage = { ...USAGE, cache_creation_input_tokens: null, cache_read_input_tokens: null };
    const events = await eventsOf(answering(200, { content: TEXT, usage }));
    expect(usageEvents(events)).toEqual([
      { type: 'usage', usage: { input: 9000, cacheCreation: 0, cacheRead: 0, output: 2140 } },
    ]);
  });

  it('says none when the answer has no usage', async () => {
    expect(usageEvents(await eventsOf(answering(200, { content: TEXT })))).toEqual([]);
  });

  it('says none when the input count is missing, rather than taking it for zero', async () => {
    const withoutInput: Record<string, number> = { ...USAGE };
    delete withoutInput['input_tokens'];
    const events = await eventsOf(answering(200, { content: TEXT, usage: withoutInput }));
    expect(usageEvents(events)).toEqual([]);
  });

  it.each([
    ['a fractional count', { ...USAGE, output_tokens: 2.5 }],
    ['a cache count that is text', { ...USAGE, cache_read_input_tokens: 'many' }],
    ['usage that is a list', [USAGE]],
    ['a count past the safe integers', { ...USAGE, cache_read_input_tokens: 2 ** 53 }],
  ])('says none for %s, and still answers', async (_, usage) => {
    const events = await eventsOf(answering(200, { content: TEXT, usage }));
    expect(events).toEqual([{ type: 'text', text: 'Tobias runs the vendor calls.' }]);
  });

  it('fails an error answer as before, saying no usage', async () => {
    const seen: ModelEvent[] = [];
    const run = (async () => {
      for (const event of await eventsOf(
        answering(529, { error: { message: 'Overloaded' }, usage: USAGE }),
      ))
        seen.push(event);
    })();
    await expect(run).rejects.toBeInstanceOf(ModelProviderError);
    expect(seen).toEqual([]);
  });
});
