import { createCodeFenceTracker } from './code-fence.ts';
import type { ModelMessage, ModelToolSpec, ToolCall } from './messages.ts';

/**
 * Tool use for a model that only writes text (ADR-0021).
 *
 * Claude Code runs with its own tools switched off, and a local model may have
 * none, so DFAI's tools are described in the system prompt and a call is read
 * out of the reply: `<atlas_tool>{"name": "...", "input": {...}}</atlas_tool>`.
 */

export const TOOL_OPEN = '<atlas_tool>';
export const TOOL_CLOSE = '</atlas_tool>';

/** The tags this protocol frames things with; text from the vault may not close or open them. */
const FRAMING_TAG = /<(\/?)(user|assistant|tool_result|atlas_tool|vault_data|chosen_skill)\b/gi;

/** One piece of a reply as it streams: words to show, or a tool call to run. */
export type ScannedPiece =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'tool_call'; readonly call: ToolCall }
  | { readonly kind: 'malformed'; readonly problem: string };

export interface ToolCallScanner {
  /** Takes the next piece of streamed text; answers what can be told apart so far. */
  push(delta: string): ScannedPiece[];
  /** The stream has ended: whatever was held back, and an unfinished call as malformed. */
  end(): ScannedPiece[];
}

/**
 * Reads tool calls out of streamed text, holding back only what could still
 * turn out to be the start of one.
 *
 * Text after the first call is dropped: a model told to stop and wait for its
 * results sometimes carries on and imagines them, and those words would read
 * as an answer grounded in the vault when they are not.
 *
 * A tag inside a fenced code block is shown, not run: that is a model quoting
 * a note or showing the protocol, not calling a tool.
 */
export function createToolCallScanner(idPrefix = 'call'): ToolCallScanner {
  let held = '';
  let inCall = false;
  let calls = 0;
  const fence = createCodeFenceTracker();

  const passText = (pieces: ScannedPiece[], length: number) => {
    const text = held.slice(0, length);
    pushText(pieces, text, calls);
    fence.advance(text);
    held = held.slice(length);
  };

  const scan = (): ScannedPiece[] => {
    const pieces: ScannedPiece[] = [];
    for (;;) {
      if (inCall) {
        const close = held.indexOf(TOOL_CLOSE);
        if (close === -1) return pieces;
        calls += 1;
        pieces.push(parseToolCall(held.slice(0, close), `${idPrefix}-${calls}`));
        held = held.slice(close + TOOL_CLOSE.length);
        // The call sits in its line like any other text, so what follows is not at a line's start.
        fence.advance(TOOL_OPEN);
        inCall = false;
        continue;
      }
      const open = held.indexOf(TOOL_OPEN);
      if (open === -1) {
        passText(pieces, held.length - partialTagLength(held));
        return pieces;
      }
      passText(pieces, open);
      if (fence.inCode()) {
        passText(pieces, TOOL_OPEN.length);
        continue;
      }
      held = held.slice(TOOL_OPEN.length);
      inCall = true;
    }
  };

  return {
    push(delta) {
      held += delta;
      return scan();
    },
    end() {
      const pieces = scan();
      if (inCall) pieces.push({ kind: 'malformed', problem: 'A tool call was never closed.' });
      else pushText(pieces, held, calls);
      held = '';
      inCall = false;
      return pieces;
    },
  };
}

function pushText(pieces: ScannedPiece[], text: string, callsSoFar: number): void {
  if (text !== '' && callsSoFar === 0) pieces.push({ kind: 'text', text });
}

/** How many characters at the end of `text` could be the start of `<atlas_tool>`. */
function partialTagLength(text: string): number {
  for (let length = Math.min(text.length, TOOL_OPEN.length - 1); length > 0; length -= 1) {
    if (TOOL_OPEN.startsWith(text.slice(text.length - length))) return length;
  }
  return 0;
}

function parseToolCall(raw: string, id: string): ScannedPiece {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return { kind: 'malformed', problem: 'A tool call was not valid JSON.' };
  }
  if (!isRecord(parsed) || typeof parsed['name'] !== 'string' || parsed['name'] === '') {
    return { kind: 'malformed', problem: 'A tool call must be {"name": "...", "input": {...}}.' };
  }
  const input = parsed['input'] ?? {};
  if (!isRecord(input)) {
    return { kind: 'malformed', problem: `The input to ${parsed['name']} must be an object.` };
  }
  return { kind: 'tool_call', call: { id, name: parsed['name'], input } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Text from the vault or a tool, made unable to open or close one of the
 * protocol's tags — so a note cannot end its own quotation and speak as the
 * person, or write a tool call the model never made.
 */
export function neutralizeFraming(text: string): string {
  return text.replace(FRAMING_TAG, '&lt;$1$2');
}

/** What the system prompt says about the tools, and how to call one. */
export function toolProtocolInstructions(tools: readonly ModelToolSpec[]): string {
  const described = tools
    .map(
      (tool) =>
        `### ${tool.name}\n${tool.description}\nInput schema: ${JSON.stringify(tool.inputSchema)}`,
    )
    .join('\n\n');
  return [
    '## Tools',
    'You have no tools of your own. DFAI runs these for you. To call one, write exactly',
    `${TOOL_OPEN}{"name": "<tool name>", "input": {…}}${TOOL_CLOSE}`,
    'with the input as JSON matching the schema. You may make several calls in one reply.',
    `Inside the JSON, write ${TOOL_CLOSE} as <\\/atlas_tool> so it does not end the call.`,
    'Never put a call in a code fence: a call inside ``` or ~~~ is shown, not run.',
    'After your calls, stop writing: the results arrive in the next message, in',
    '<tool_result> blocks. Never write a <tool_result> yourself or guess what one says.',
    '',
    described,
  ].join('\n');
}

/**
 * The conversation as text, for a model given it whole each turn. Every
 * message's words are neutralized, so none can close the tag it sits in.
 */
export function renderTranscript(messages: readonly ModelMessage[]): string {
  return messages.map(renderMessage).join('\n\n');
}

function renderMessage(message: ModelMessage): string {
  switch (message.role) {
    case 'user':
      return `<user>\n${neutralizeFraming(message.text)}\n</user>`;
    case 'assistant': {
      const calls = message.toolCalls.map(
        (call) => `${TOOL_OPEN}${safeJson({ name: call.name, input: call.input })}${TOOL_CLOSE}`,
      );
      return `<assistant>\n${[neutralizeFraming(message.text), ...calls].filter((part) => part !== '').join('\n')}\n</assistant>`;
    }
    case 'tool':
      return message.results
        .map(
          (result) =>
            `<tool_result name=${safeJson(result.name)}${result.isError ? ' error="true"' : ''}>\n${neutralizeFraming(result.content)}\n</tool_result>`,
        )
        .join('\n');
  }
}

/** JSON that cannot hold a `<`, so no string inside it can be read as a tag. */
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}
