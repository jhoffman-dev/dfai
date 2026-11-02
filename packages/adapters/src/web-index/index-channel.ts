import type { WasmIndexHost } from './wasm-index-host.ts';

/**
 * The boundary between the window and the index worker (#666): the host's
 * calls, posted as messages and answered by id. A `Worker`, the worker's own
 * scope and a `MessagePort` are each an endpoint, so a test runs both ends
 * over a real `MessageChannel`, structured cloning and all, with no worker.
 */
export interface IndexEndpoint {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

/** The host's calls, as the window makes them: each answered later. */
export type IndexHostCalls = {
  readonly [Call in keyof WasmIndexHost]: (
    ...args: Parameters<WasmIndexHost[Call]>
  ) => Promise<ReturnType<WasmIndexHost[Call]>>;
};

type HostCall = keyof WasmIndexHost;

interface Request {
  readonly id: number;
  readonly call: HostCall;
  readonly args: readonly unknown[];
}

type Answer =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly message: string };

const CALLS: readonly HostCall[] = [
  'open',
  'clear',
  'manifest',
  'put',
  'remove',
  'search',
  'notesOfType',
  'backlinks',
  'rebuildViews',
  'query',
  'stats',
];

/** Answers each call that arrives on `endpoint` from `host`, in the order they came. */
export function serveIndexHost(endpoint: IndexEndpoint, host: () => Promise<WasmIndexHost>): void {
  // Made on the first call, not on load: the WebAssembly is fetched only once the index is asked for.
  let ready: Promise<WasmIndexHost> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  endpoint.addEventListener('message', (event) => {
    const request = event.data as Request;
    // Not a call of the index's, so not this channel's to answer.
    if (!CALLS.includes(request.call)) return;
    queue = queue.then(async () => {
      try {
        ready ??= host();
        const answered = await ready;
        const run = answered[request.call] as (...args: readonly unknown[]) => unknown;
        endpoint.postMessage({ id: request.id, ok: true, value: run(...request.args) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        endpoint.postMessage({ id: request.id, ok: false, message } satisfies Answer);
      }
    });
  });
}

/** The host's calls made over `endpoint`; each settles when its answer comes back. */
export function indexHostOver(endpoint: IndexEndpoint): IndexHostCalls {
  let next = 0;
  const waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  endpoint.addEventListener('message', (event) => {
    const answer = event.data as Answer;
    const caller = waiting.get(answer.id);
    if (caller === undefined) return;
    waiting.delete(answer.id);
    if (answer.ok) caller.resolve(answer.value);
    else caller.reject(new Error(answer.message));
  });
  const send =
    (call: HostCall) =>
    (...args: readonly unknown[]) =>
      new Promise((resolve, reject) => {
        const id = next++;
        waiting.set(id, { resolve, reject });
        endpoint.postMessage({ id, call, args } satisfies Request);
      });
  return Object.fromEntries(CALLS.map((call) => [call, send(call)])) as unknown as IndexHostCalls;
}
