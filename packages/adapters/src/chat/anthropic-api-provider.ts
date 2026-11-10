import type { ModelMessage, TemplatePart } from '@dfai/domain';
import {
  ChatCancelled,
  ModelProviderError,
  type ModelEvent,
  type ModelProvider,
  type ModelRequest,
  type ProviderStatus,
  type SecretStorePort,
} from '@dfai/application';
import { readApiUsage } from './api-usage.ts';

/** The secret the key is kept under, and the one site it may go to (ADR-0017). */
export const ANTHROPIC_SECRET = 'anthropic';
export const ANTHROPIC_ORIGIN = 'https://api.anthropic.com';
const MESSAGES_URL = `${ANTHROPIC_ORIGIN}/v1/messages`;
const API_VERSION = '2023-06-01';
const MAX_TOKENS = 8192;

/**
 * A POST whose headers may name secrets. The host fills them in from the
 * Keychain as the request leaves, sends a secret only to the sites it is bound
 * to, and strikes it from the answer; this side never holds the value.
 */
export interface ModelHttpHost {
  post(args: {
    readonly vault: string;
    readonly url: string;
    readonly headers: readonly { readonly name: string; readonly value: readonly TemplatePart[] }[];
    readonly body: string;
  }): Promise<{ readonly status: number; readonly body: string }>;
}

/**
 * The fallback provider: the Anthropic API with a key the person keeps as a
 * secret (ADR-0021). It answers whole, not word by word — the host's HTTP
 * command returns a finished body.
 */
export function anthropicApiProvider({
  http,
  secrets,
  vault,
}: {
  http: ModelHttpHost;
  secrets: Pick<SecretStorePort, 'list'>;
  /** The vault open now, whose secret is used; null when none is. */
  vault: () => string | null;
}): ModelProvider {
  return {
    id: 'anthropic-api',
    status: () => keyStatus({ secrets, vault }),
    stream: (request, signal) => reply({ http, vault, request, signal }),
  };
}

const ADD_KEY = `Settings → Secrets: add "${ANTHROPIC_SECRET}" with your API key, for the site api.anthropic.com`;

async function keyStatus({
  secrets,
  vault,
}: {
  secrets: Pick<SecretStorePort, 'list'>;
  vault: () => string | null;
}): Promise<ProviderStatus> {
  if (vault() === null) {
    return { ready: false, problem: 'unavailable', message: 'Open a vault first.', fix: null };
  }
  const stored = (await secrets.list()).find((secret) => secret.name === ANTHROPIC_SECRET);
  if (stored?.origins.includes(ANTHROPIC_ORIGIN) === true) return { ready: true };
  return {
    ready: false,
    problem: 'no_key',
    message:
      stored === undefined
        ? 'No Anthropic API key is set for this vault.'
        : `The "${ANTHROPIC_SECRET}" secret is not bound to api.anthropic.com.`,
    fix: ADD_KEY,
  };
}

async function* reply({
  http,
  vault,
  request,
  signal,
}: {
  http: ModelHttpHost;
  vault: () => string | null;
  request: ModelRequest;
  signal: AbortSignal;
}): AsyncGenerator<ModelEvent> {
  const open = vault();
  if (open === null) throw new ModelProviderError('unavailable', 'Open a vault first.');
  const answer = await untilAborted(
    http.post({
      vault: open,
      url: MESSAGES_URL,
      headers: [
        { name: 'x-api-key', value: [{ secret: ANTHROPIC_SECRET }] },
        { name: 'anthropic-version', value: [{ text: API_VERSION }] },
        { name: 'content-type', value: [{ text: 'application/json' }] },
      ],
      body: JSON.stringify(messagesBody(request)),
    }),
    signal,
  );
  yield* eventsOf(answer);
}

/** The request body, DFAI's conversation translated into the API's messages. */
export function messagesBody(request: ModelRequest): Record<string, unknown> {
  return {
    model: request.model,
    max_tokens: MAX_TOKENS,
    system: request.system,
    messages: apiMessages(request.messages),
    tools: request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    })),
  };
}

function apiMessages(messages: readonly ModelMessage[]): unknown[] {
  const called = new Set<string>();
  return messages.map((message) => {
    if (message.role === 'user') return { role: 'user', content: message.text };
    if (message.role === 'assistant') {
      for (const call of message.toolCalls) called.add(call.id);
      const text = message.text === '' ? [] : [{ type: 'text', text: message.text }];
      const uses = message.toolCalls.map((call) => ({
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: call.input,
      }));
      const content = [...text, ...uses];
      return { role: 'assistant', content: content.length > 0 ? content : '(no reply)' };
    }
    // A result for a call the API never made — a malformed one read from text — has no pair.
    const results = message.results
      .filter((result) => called.has(result.callId))
      .map((result) => ({
        type: 'tool_result',
        tool_use_id: result.callId,
        content: result.content,
        is_error: result.isError,
      }));
    return { role: 'user', content: results.length > 0 ? results : '(no results)' };
  });
}

function* eventsOf(answer: { status: number; body: string }): Generator<ModelEvent> {
  const parsed = parse(answer.body);
  if (answer.status >= 400) {
    const message =
      (parsed as { error?: { message?: string } } | null)?.error?.message ??
      `status ${answer.status}`;
    if (answer.status === 401 || answer.status === 403) {
      throw new ModelProviderError('no_key', `The Anthropic API refused the key: ${message}`);
    }
    throw new ModelProviderError('failed', `The Anthropic API could not answer: ${message}`);
  }
  const content = (parsed as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) {
    throw new ModelProviderError('failed', 'The Anthropic API answered with something unreadable.');
  }
  for (const block of content as Record<string, unknown>[]) {
    if (block['type'] === 'text' && typeof block['text'] === 'string') {
      yield { type: 'text', text: block['text'] };
    } else if (block['type'] === 'tool_use' && typeof block['name'] === 'string') {
      const input = block['input'];
      yield {
        type: 'tool_call',
        call: {
          id: String(block['id']),
          name: block['name'],
          input:
            typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {},
        },
      };
    }
  }
  // The API says no cost; usage that does not read is unknown, and no event says it.
  const usage = readApiUsage((parsed as { usage?: unknown }).usage);
  if (usage !== null) yield { type: 'usage', usage };
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The request's answer, or `ChatCancelled` the moment Stop is pressed. The
 * request itself runs on in the host; its answer is then dropped.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new ChatCancelled());
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new ChatCancelled());
    signal.addEventListener('abort', stop, { once: true });
    work
      .then(resolve, (error: unknown) =>
        reject(
          new ModelProviderError(
            'failed',
            `The Anthropic API could not be reached: ${String(error instanceof Error ? error.message : error)}`,
          ),
        ),
      )
      .finally(() => signal.removeEventListener('abort', stop));
  });
}
