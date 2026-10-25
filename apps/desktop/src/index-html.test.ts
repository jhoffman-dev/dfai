import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * The classic script in `index.html` that reports a failure to the host
 * (`report_error`) before the bundle has loaded. Run here in a stand-in
 * window that behaves as WebKit does: a rejection nobody handles is
 * dispatched as `unhandledrejection` — the report's own included.
 */
const PAGE = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const REPORTER = [...PAGE.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((found) => found[1])[0];

/** How many reports the stand-in lets through before calling it a loop. */
const LOOP_LIMIT = 50;

function windowWithHost(invoke: (command: string, args: unknown) => unknown) {
  const warned: unknown[][] = [];
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const dispatch = (kind: string, event: unknown) => {
    for (const listener of listeners.get(kind) ?? []) listener(event);
  };
  const sent: string[] = [];
  const window = {
    addEventListener: (kind: string, listener: (event: unknown) => void) =>
      listeners.set(kind, [...(listeners.get(kind) ?? []), listener]),
    __TAURI_INTERNALS__: {
      invoke: (command: string, args: { message: string }) => {
        sent.push(args.message);
        if (sent.length > LOOP_LIMIT) throw new Error('report_error looped');
        return invoke(command, args);
      },
    },
  };
  const console = { warn: (...said: unknown[]) => warned.push(said) };
  runInNewContext(REPORTER ?? '', { window, String, console });
  return { dispatch, sent, warned };
}

/**
 * A promise that rejects with `reason`, and — as WebKit does once a turn has
 * passed — dispatches `unhandledrejection` if nothing has taken the rejection.
 */
function rejectedUnlessHandled(
  reason: Error,
  dispatch: (kind: string, event: unknown) => void,
): Promise<never> {
  let handled = false;
  const rejected = Promise.reject(reason);
  // Node's own tracking stands down: `handled` is what plays the browser's part here.
  rejected.catch(() => undefined);
  queueMicrotask(() => {
    if (!handled) dispatch('unhandledrejection', { reason });
  });
  return {
    then: (onFulfilled?: unknown, onRejected?: unknown) => {
      if (typeof onRejected === 'function') handled = true;
      return rejected.then(onFulfilled as never, onRejected as never);
    },
    catch: (onRejected?: unknown) => {
      if (typeof onRejected === 'function') handled = true;
      return rejected.catch(onRejected as never);
    },
    finally: (onFinally?: () => void) => rejected.finally(onFinally),
    [Symbol.toStringTag]: 'Promise',
  } as Promise<never>;
}

const turns = async (count: number) => {
  for (let at = 0; at < count; at += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('index.html — reporting a failure to the host', () => {
  it('found the reporting script in the page', () => {
    expect(REPORTER).toContain('report_error');
  });

  it('reports an unhandled rejection once', async () => {
    const { dispatch, sent } = windowWithHost(() => Promise.resolve(null));
    dispatch('unhandledrejection', { reason: new Error('the vault went away') });
    await turns(3);
    expect(sent).toEqual(['unhandled rejection: the vault went away']);
  });

  it('does not report its own report failing, round and round, when report_error rejects', async () => {
    const harness: { dispatch?: (kind: string, event: unknown) => void } = {};
    const { dispatch, sent } = windowWithHost(() =>
      rejectedUnlessHandled(new Error('no such command: report_error'), (kind, event) =>
        harness.dispatch?.(kind, event),
      ),
    );
    harness.dispatch = dispatch;

    dispatch('unhandledrejection', { reason: new Error('the vault went away') });
    await turns(10);

    expect(sent).toEqual(['unhandled rejection: the vault went away']);
  });

  it('says on the console what could not be reported, and why', async () => {
    const harness: { dispatch?: (kind: string, event: unknown) => void } = {};
    const refusal = new Error('no such command: report_error');
    const { dispatch, warned } = windowWithHost(() =>
      rejectedUnlessHandled(refusal, (kind, event) => harness.dispatch?.(kind, event)),
    );
    harness.dispatch = dispatch;

    dispatch('error', { message: 'first', filename: 'main.js', lineno: 7 });
    await turns(3);

    expect(warned).toEqual([
      ['This error could not be reported to DFAI:', 'first @ main.js:7', refusal],
    ]);
  });

  it('does not report an error raised while it is reporting one', async () => {
    const harness: { dispatch?: (kind: string, event: unknown) => void } = {};
    const { dispatch, sent } = windowWithHost(() => {
      // The host's bridge throwing an error event of its own, mid-report.
      harness.dispatch?.('error', { message: 'bridge broke', filename: 'ipc.js', lineno: 1 });
      return Promise.resolve(null);
    });
    harness.dispatch = dispatch;

    dispatch('error', { message: 'first', filename: 'main.js', lineno: 7 });
    await turns(3);

    expect(sent).toEqual(['first @ main.js:7']);
  });

  it('still reports the next failure once the last report is done', async () => {
    const { dispatch, sent } = windowWithHost(() => Promise.resolve(null));
    dispatch('error', { message: 'first', filename: 'main.js', lineno: 7 });
    await turns(2);
    dispatch('error', { message: 'second', filename: 'main.js', lineno: 9 });
    await turns(2);
    expect(sent).toEqual(['first @ main.js:7', 'second @ main.js:9']);
  });
});

describe("index.html — the app's own policy on frames", () => {
  /** The policies the page sets for itself, in order. */
  const policies = [
    ...PAGE.matchAll(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"\s*\/?>/g),
  ].map((found) => found[1]);

  it("refuses every frame a page in the app would load, the book reader's included", () => {
    // A layer under the EPUB frame's opaque origin and its own policy (ADR-0045), not instead of them.
    expect(policies).toEqual(["frame-src 'none'"]);
    expect(PAGE.indexOf('Content-Security-Policy')).toBeLessThan(PAGE.indexOf('<script'));
  });
});
