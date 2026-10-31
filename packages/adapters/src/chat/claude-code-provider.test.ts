import { describe, expect, it } from 'vitest';
import {
  ChatCancelled,
  ModelProviderError,
  type ModelEvent,
  type ModelRequest,
} from '@dfai/application';
import { claudeCodeArgs, claudeCodeProvider } from './claude-code-provider.ts';
import { ProgramNotFound, type ModelProcessHost, type ProcessExit } from './model-process.ts';

const REQUEST: ModelRequest = {
  model: 'claude-opus-5-5',
  system: 'You are Claude in DFAI.',
  messages: [{ role: 'user', text: 'Who is Sam?' }],
  tools: [{ name: 'atlas_search', description: 'Search.', inputSchema: { type: 'object' } }],
};

const delta = (text: string) =>
  JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  });
const result = (isError: boolean, text: string) =>
  JSON.stringify({ type: 'result', is_error: isError, result: text });

/**
 * A fake child process: prints the scripted lines, then exits. `hold` keeps it
 * running after the lines until the signal aborts, as a slow model would.
 */
function fakeClaude({
  lines = [] as string[],
  exit = { code: 0, stderr: '' } as ProcessExit,
  hold = false,
  fail = null as Error | null,
} = {}) {
  const runs: { args: readonly string[]; stdin: string }[] = [];
  const host: ModelProcessHost = {
    async run({ args, stdin, onLine, signal }) {
      runs.push({ args, stdin });
      if (fail !== null) throw fail;
      for (const line of lines) {
        await Promise.resolve();
        onLine(line);
      }
      if (hold) {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
        return { code: null, stderr: '' };
      }
      return exit;
    },
  };
  return { host, runs };
}

async function collect(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('claudeCodeArgs', () => {
  it('turns every Claude Code tool off and loads no settings, hooks or MCP servers', () => {
    const args = claudeCodeArgs(REQUEST);
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--no-session-persistence');
    expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-5-5');
    expect(args.slice(0, 3)).toEqual(['-p', '--output-format', 'stream-json']);
  });

  it("puts DFAI's tools in the system prompt, after what DFAI said", () => {
    const system = claudeCodeArgs(REQUEST)[claudeCodeArgs(REQUEST).indexOf('--system-prompt') + 1];
    expect(system).toMatch(/^You are Claude in DFAI\.\n\n## Tools/);
    expect(system).toContain('### atlas_search');
  });

  it('says nothing of a tool protocol to a request with no tools (#169)', () => {
    const bare = { ...REQUEST, tools: [] };
    const args = claudeCodeArgs(bare);
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('You are Claude in DFAI.');
  });
});

describe('claudeCodeProvider.stream', () => {
  it('streams the words as they arrive, and sends the conversation on stdin', async () => {
    const { host, runs } = fakeClaude({
      lines: [
        '{"type":"system","subtype":"init"}',
        delta('Sam is '),
        delta('a friend.'),
        result(false, 'Sam is a friend.'),
      ],
    });
    const events = await collect(
      claudeCodeProvider(host).stream(REQUEST, new AbortController().signal),
    );
    expect(events).toEqual([
      { type: 'text', text: 'Sam is ' },
      { type: 'text', text: 'a friend.' },
    ]);
    expect(runs[0]?.stdin).toBe(
      '<user>\nWho is Sam?\n</user>\n\nReply as the assistant to the last message.',
    );
  });

  it('reads a tool call out of the streamed text', async () => {
    const { host } = fakeClaude({
      lines: [
        delta('Looking.<atlas_'),
        delta('tool>{"name":"atlas_search","input":{"q":"Sam"}}</atlas_tool>'),
      ],
    });
    const events = await collect(
      claudeCodeProvider(host).stream(REQUEST, new AbortController().signal),
    );
    expect(events).toEqual([
      { type: 'text', text: 'Looking.' },
      { type: 'tool_call', call: { id: 'call-1', name: 'atlas_search', input: { q: 'Sam' } } },
    ]);
  });

  it('reads a reply to a request with no tools whole, a literal tool tag and all (#169)', async () => {
    const said = [
      'Write ',
      '<atlas_tool>{"name":"atlas_search","input":{}}</atlas_tool>',
      ' to call one.',
    ];
    const { host } = fakeClaude({ lines: said.map(delta) });
    const events = await collect(
      claudeCodeProvider(host).stream({ ...REQUEST, tools: [] }, new AbortController().signal),
    );
    expect(events.every((event) => event.type === 'text')).toBe(true);
    expect(events.map((event) => (event.type === 'text' ? event.text : '')).join('')).toBe(
      said.join(''),
    );
  });

  it('says Claude Code is not logged in when that is why it failed', async () => {
    const { host } = fakeClaude({
      lines: [result(true, 'Invalid API key · Please run /login')],
      exit: { code: 1, stderr: '' },
    });
    const failure = collect(claudeCodeProvider(host).stream(REQUEST, new AbortController().signal));
    await expect(failure).rejects.toMatchObject({ problem: 'not_logged_in' });
  });

  it('passes any other failure on in its own words', async () => {
    const { host } = fakeClaude({ exit: { code: 2, stderr: 'model not found: claude-nope\n' } });
    const failure = collect(claudeCodeProvider(host).stream(REQUEST, new AbortController().signal));
    await expect(failure).rejects.toThrow(
      'Claude Code could not answer: model not found: claude-nope',
    );
  });

  it('says Claude Code is not installed when the host found no claude', async () => {
    const { host } = fakeClaude({ fail: new ProgramNotFound('no claude in ~/.local/bin') });
    const failure = collect(claudeCodeProvider(host).stream(REQUEST, new AbortController().signal));
    await expect(failure).rejects.toBeInstanceOf(ModelProviderError);
    await expect(
      collect(claudeCodeProvider(host).stream(REQUEST, new AbortController().signal)),
    ).rejects.toMatchObject({ problem: 'not_installed' });
  });

  it('stops when Stop is pressed, keeping the words already given', async () => {
    const { host } = fakeClaude({ lines: [delta('Half')], hold: true });
    const stop = new AbortController();
    const events: ModelEvent[] = [];
    const reading = (async () => {
      for await (const event of claudeCodeProvider(host).stream(REQUEST, stop.signal)) {
        events.push(event);
        stop.abort();
      }
    })();
    await expect(reading).rejects.toBeInstanceOf(ChatCancelled);
    expect(events).toEqual([{ type: 'text', text: 'Half' }]);
  });
});

describe('claudeCodeProvider.status', () => {
  it('is ready when claude auth status says logged in, reading nothing else', async () => {
    const { host, runs } = fakeClaude({
      lines: ['{', '"loggedIn": true,', '"email": "someone@example.com"', '}'],
    });
    expect(await claudeCodeProvider(host).status()).toEqual({ ready: true });
    expect(runs[0]?.args).toEqual(['auth', 'status']);
  });

  it('says how to log in when it is not', async () => {
    const { host } = fakeClaude({ lines: ['{"loggedIn": false}'], exit: { code: 1, stderr: '' } });
    expect(await claudeCodeProvider(host).status()).toMatchObject({
      ready: false,
      problem: 'not_logged_in',
      fix: 'claude auth login',
    });
  });

  it('says how to install it when there is none', async () => {
    const { host } = fakeClaude({ fail: new ProgramNotFound('none') });
    expect(await claudeCodeProvider(host).status()).toMatchObject({
      problem: 'not_installed',
      fix: expect.stringContaining('claude.ai/install.sh'),
    });
  });

  it('reports any other trouble without a fix', async () => {
    const { host } = fakeClaude({ fail: new Error('spawn failed') });
    expect(await claudeCodeProvider(host).status()).toMatchObject({
      problem: 'unavailable',
      message: expect.stringContaining('spawn failed'),
      fix: null,
    });
  });

  it('reads an older, worded answer', async () => {
    expect(
      await claudeCodeProvider(fakeClaude({ lines: ['Logged in as x'] }).host).status(),
    ).toEqual({
      ready: true,
    });
    expect(
      await claudeCodeProvider(fakeClaude({ lines: ['Not logged in'] }).host).status(),
    ).toMatchObject({ ready: false });
  });
});
