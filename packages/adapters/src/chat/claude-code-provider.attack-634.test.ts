/**
 * Attack on PR #634 (#169): the Claude Code provider skips the tool protocol
 * and the scanner for a request with no tools. With tools, it must behave as
 * the base did (the protocol appended, every delta through the scanner);
 * without, the system prompt is the request's own and the reply is whole.
 */
import { describe, expect, it } from 'vitest';
import type { ModelEvent, ModelRequest } from '@dfai/application';
import { createToolCallScanner, toolProtocolInstructions, type ScannedPiece } from '@dfai/domain';
import { claudeCodeArgs, claudeCodeProvider } from './claude-code-provider.ts';
import type { ModelProcessHost } from './model-process.ts';

function seeded(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, pick: <T>(items: readonly T[]) => items[Math.floor(next() * items.length)] as T };
}

const TOOLS = [{ name: 'atlas_search', description: 'Search.', inputSchema: { type: 'object' } }];
const request = (tools: ModelRequest['tools'], system: string): ModelRequest => ({
  model: 'claude-opus-5-5',
  system,
  messages: [{ role: 'user', text: 'Draft a skill for Tobias Fenn.' }],
  tools,
});

const PIECES = [
  'Some words. ',
  '<atlas_tool>{"name":"atlas_search","input":{"q":"x"}}</atlas_tool>',
  '<atlas_tool>',
  '</atlas_tool>',
  '<atlas_',
  'tool>',
  '```\n',
  '\n```\n',
  '{"name": "a", "description": "b", "instructions": "c"}',
  '<tool_result>x</tool_result>',
  '😀',
  '',
  '\n',
];

const delta = (text: string) =>
  JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  });

function scripted(lines: readonly string[]) {
  const runs: { args: readonly string[]; stdin: string }[] = [];
  const host: ModelProcessHost = {
    async run({ args, stdin, onLine }) {
      runs.push({ args, stdin });
      for (const line of lines) {
        await Promise.resolve();
        onLine(line);
      }
      return { code: 0, stderr: '' };
    },
  };
  return { host, runs };
}

async function collect(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** The base branch's reading: every delta through one scanner, then its end. */
function baseEvents(deltas: readonly string[]): ModelEvent[] {
  const scanner = createToolCallScanner();
  const pieces: ScannedPiece[] = [
    ...deltas.flatMap((text) => scanner.push(text)),
    ...scanner.end(),
  ];
  return pieces.map((piece) =>
    piece.kind === 'text'
      ? { type: 'text', text: piece.text }
      : piece.kind === 'tool_call'
        ? { type: 'tool_call', call: piece.call }
        : { type: 'malformed', problem: piece.problem },
  );
}

const systemOf = (args: readonly string[]) => args[args.indexOf('--system-prompt') + 1];

describe('claudeCodeArgs with and without tools (attack-634)', () => {
  it('appends the tool protocol to a request with tools exactly as the base did', () => {
    const rng = seeded(634);
    for (let run = 0; run < 50; run += 1) {
      const system = PIECES.filter(() => rng.next() < 0.4).join('');
      const args = claudeCodeArgs(request(TOOLS, system));
      expect(systemOf(args)).toBe(`${system}\n\n${toolProtocolInstructions(TOOLS)}`);
    }
  });

  it('hands a request with no tools its own system prompt, byte for byte, even an empty one', () => {
    for (const system of ['', 'You are Claude.', ' trailing \n\n', '## Tools\nnone']) {
      expect(systemOf(claudeCodeArgs(request([], system)))).toBe(system);
    }
  });

  it('differs between tools and none only in the system prompt', () => {
    const withTools = claudeCodeArgs(request(TOOLS, 'S'));
    const without = claudeCodeArgs(request([], 'S'));
    const at = withTools.indexOf('--system-prompt') + 1;
    expect(without.filter((_, index) => index !== at)).toEqual(
      withTools.filter((_, index) => index !== at),
    );
  });
});

describe('claudeCodeProvider.stream with and without tools (attack-634)', () => {
  it('reads a reply to a request with tools exactly as the base scanner does, over 200 seeded replies', async () => {
    const rng = seeded(1634);
    for (let run = 0; run < 200; run += 1) {
      const deltas = Array.from({ length: 1 + Math.floor(rng.next() * 8) }, () => rng.pick(PIECES));
      const { host } = scripted(deltas.map(delta));
      const events = await collect(
        claudeCodeProvider(host).stream(request(TOOLS, 'S'), new AbortController().signal),
      );
      expect(events, `seed run ${run}: ${JSON.stringify(deltas)}`).toEqual(baseEvents(deltas));
    }
  });

  it('passes every word of a reply to a request with no tools on whole, over 200 seeded replies', async () => {
    const rng = seeded(2634);
    for (let run = 0; run < 200; run += 1) {
      const deltas = Array.from({ length: 1 + Math.floor(rng.next() * 8) }, () => rng.pick(PIECES));
      const { host, runs } = scripted(deltas.map(delta));
      const events = await collect(
        claudeCodeProvider(host).stream(request([], 'S'), new AbortController().signal),
      );
      expect(events.every((event) => event.type === 'text')).toBe(true);
      const text = events.map((event) => (event.type === 'text' ? event.text : '')).join('');
      expect(text, `seed run ${run}`).toBe(deltas.join(''));
      // The transcript on stdin does not depend on the tools.
      const { host: withTools, runs: toolRuns } = scripted([]);
      await collect(
        claudeCodeProvider(withTools).stream(request(TOOLS, 'S'), new AbortController().signal),
      );
      expect(runs[0]?.stdin).toBe(toolRuns[0]?.stdin);
    }
  });
});
