import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  API_REQUEST_EVENT,
  API_RESPOND_COMMAND,
  type ApiRequest,
  type ApiResponse,
} from '@dfai/application';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

/** The one handler `listen` was given, so a test can deliver an event to it. */
let deliver: ((event: { payload: ApiRequest }) => void) | null = null;
const unlisten = vi.fn();
const listen = vi.fn(
  // Typed as Tauri's `UnlistenFn` is used: whatever it returns, the bridge ignores.
  async (
    _event: string,
    handler: (event: { payload: ApiRequest }) => void,
  ): Promise<() => unknown> => {
    deliver = handler;
    return unlisten;
  },
);
vi.mock('@tauri-apps/api/event', () => ({
  listen: (event: string, handler: (event: { payload: ApiRequest }) => void) =>
    listen(event, handler),
}));

const { tauriApiBridge } = await import('./tauri-api-bridge.ts');
const { tauriApiSettings } = await import('./tauri-api-settings.ts');

const REQUEST: ApiRequest = { id: 'r7', method: 'GET', path: '/v1/status', query: {}, body: null };
const ANSWER: ApiResponse = {
  id: 'r7',
  status: 200,
  body: {
    app: 'atlas',
    version: '1',
    build: null,
    vault: null,
    index: { ready: false, notes: 0 },
    googleCalendar: null,
  },
};

/** The host's side of `api_router_register`: ids that count up, as Rust's do. */
let nextRouterId = 0;
const hostAnswer = (command: string) =>
  Promise.resolve(command === 'api_router_register' ? nextRouterId++ : null);

/** Lets the promise chain started by a delivered event run to its end. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('tauriApiBridge', () => {
  beforeEach(() => {
    invoke.mockReset();
    nextRouterId = 40;
    invoke.mockImplementation(hostAnswer);
    listen.mockClear();
    unlisten.mockReset();
    deliver = null;
  });

  it('listens for requests on the event the host emits them on', async () => {
    await tauriApiBridge.serve(async () => ANSWER);
    expect(listen).toHaveBeenCalledWith(API_REQUEST_EVENT, expect.any(Function));
  });

  it('hands each request to the handler and sends back its answer', async () => {
    const answer = vi.fn(async () => ANSWER);
    await tauriApiBridge.serve(answer);

    deliver?.({ payload: REQUEST });
    await settle();

    expect(answer).toHaveBeenCalledWith(REQUEST);
    expect(invoke).toHaveBeenCalledWith(API_RESPOND_COMMAND, {
      id: 'r7',
      status: 200,
      body: ANSWER.body,
    });
  });

  it('stops listening when the function it handed back is called', async () => {
    const stop = await tauriApiBridge.serve(async () => ANSWER);
    stop();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it('tells the host the router is ready only once it is listening', async () => {
    const order: string[] = [];
    listen.mockImplementationOnce(async (_event, handler) => {
      order.push('listen');
      deliver = handler;
      return unlisten;
    });
    invoke.mockImplementation(async (command: string) => {
      order.push(command);
      return hostAnswer(command);
    });

    await tauriApiBridge.serve(async () => ANSWER);

    expect(order).toEqual(['api_router_register', 'listen', 'api_router_ready']);
  });

  // #161: a page load makes the host refuse every id it gave before, which
  // only works if the router names itself by the host's id and no other.
  it('names itself to the host by the id the host gave it', async () => {
    await tauriApiBridge.serve(async () => ANSWER);

    expect(invoke).toHaveBeenCalledWith('api_router_ready', { listener: 40, ready: true });
  });

  it('never listens when the host gives it no id', async () => {
    invoke.mockRejectedValueOnce('the API is not ready yet');

    await expect(tauriApiBridge.serve(async () => ANSWER)).rejects.toBe('the API is not ready yet');

    expect(listen).not.toHaveBeenCalled();
  });

  it('tells the host the router it named is gone when it stops', async () => {
    const stop = await tauriApiBridge.serve(async () => ANSWER);
    const [, started] = invoke.mock.lastCall as [string, { listener: number }];
    invoke.mockClear();

    stop();

    expect(invoke).toHaveBeenCalledWith('api_router_ready', {
      listener: started.listener,
      ready: false,
    });
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it('names each listener differently, so the host can tell them apart', async () => {
    await tauriApiBridge.serve(async () => ANSWER);
    await tauriApiBridge.serve(async () => ANSWER);

    const named = invoke.mock.calls
      .filter(([command]) => command === 'api_router_ready')
      .map(([, args]) => (args as { listener: number }).listener);
    expect(named).toEqual([40, 41]);
  });

  it('stops listening and fails when the host cannot be told it is ready', async () => {
    invoke.mockImplementation((command: string) =>
      command === 'api_router_ready'
        ? Promise.reject('the API is not ready yet')
        : hostAnswer(command),
    );

    await expect(tauriApiBridge.serve(async () => ANSWER)).rejects.toBe('the API is not ready yet');

    expect(unlisten).toHaveBeenCalledOnce();
  });

  /**
   * React StrictMode starts serving twice and abandons the first: its stop
   * lands after the second has said it listens. The host below keeps readiness
   * per listener, as the Rust host does, and answers the `api_router_ready`
   * calls in the order given rather than the order they were made.
   */
  it.each([
    ['in order', (pending: (() => void)[]) => pending.splice(0).forEach((answer) => answer())],
    [
      'out of order',
      (pending: (() => void)[]) =>
        pending
          .splice(0)
          .reverse()
          .forEach((answer) => answer()),
    ],
  ])(
    'one listener stopping never clears the readiness of another still listening (%s)',
    async (_order, answerPending) => {
      const live = new Set<unknown>();
      const pending: (() => void)[] = [];
      invoke.mockImplementation((command: string, args: { listener?: unknown; ready: boolean }) => {
        if (command !== 'api_router_ready') return hostAnswer(command);
        if (args.ready) live.add(args.listener);
        else live.delete(args.listener);
        return new Promise<null>((resolve) => pending.push(() => resolve(null)));
      });

      const first = tauriApiBridge.serve(async () => ANSWER);
      const second = tauriApiBridge.serve(async () => ANSWER);
      await settle();
      answerPending(pending);
      const stopFirst = await first;
      await second;

      stopFirst();
      await settle();
      answerPending(pending);

      expect(live.size, 'the listener still serving lost its readiness').toBe(1);
    },
  );

  it('keeps serving when an answer cannot be sent back', async () => {
    const answer = vi.fn(async (request: ApiRequest) => ({ ...ANSWER, id: request.id }));
    await tauriApiBridge.serve(answer);
    invoke.mockRejectedValueOnce('no one is waiting on r7');

    deliver?.({ payload: REQUEST });
    await settle();
    deliver?.({ payload: { ...REQUEST, id: 'r8' } });
    await settle();

    expect(invoke).toHaveBeenLastCalledWith(API_RESPOND_COMMAND, {
      id: 'r8',
      status: 200,
      body: ANSWER.body,
    });
  });

  it('sends nothing back for a request whose handler failed', async () => {
    await tauriApiBridge.serve(async () => {
      throw new Error('boom');
    });

    invoke.mockClear();
    deliver?.({ payload: REQUEST });
    await settle();

    expect(invoke).not.toHaveBeenCalled();
  });

  /** Rejections nobody handled while `during` ran and the turn after it. */
  async function unhandledDuring(during: () => Promise<unknown>): Promise<unknown[]> {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', record);
    try {
      await during().catch(() => undefined);
      await settle();
      await settle();
    } finally {
      process.off('unhandledRejection', record);
    }
    return unhandled;
  }

  // A plain function, not a `vi.fn`: a spy attaches its own handler to the
  // promise it returns, which would hide the rejection this looks for.
  const unlistenThatCannotReachTheHost = () => Promise.reject('the page is going away');

  // Tauri's real unlisten is async: it asks the host (`plugin:event|unlisten`)
  // and rejects when that IPC fails, as it can while the page goes away.
  it('leaves no rejection unhandled when stopping cannot reach the host', async () => {
    listen.mockImplementationOnce(async () => unlistenThatCannotReachTheHost);
    const stop = await tauriApiBridge.serve(async () => ANSWER);

    const unhandled = await unhandledDuring(async () => stop());

    expect(unhandled, 'stop() leaked an unhandled rejection').toEqual([]);
  });

  it('leaves no rejection unhandled when it cannot stop listening after the host refused ready', async () => {
    listen.mockImplementationOnce(async () => unlistenThatCannotReachTheHost);
    invoke.mockImplementation((command: string) =>
      command === 'api_router_ready'
        ? Promise.reject('the API is not ready yet')
        : hostAnswer(command),
    );

    const unhandled = await unhandledDuring(() => tauriApiBridge.serve(async () => ANSWER));

    expect(unhandled, 'the failed serve leaked an unhandled rejection').toEqual([]);
  });

  it('never tells the host it listens when listening fails', async () => {
    listen.mockRejectedValueOnce('no event plugin');

    await expect(tauriApiBridge.serve(async () => ANSWER)).rejects.toBe('no event plugin');

    expect(invoke).not.toHaveBeenCalledWith('api_router_ready', expect.anything());
  });
});

describe('tauriApiSettings', () => {
  const STATUS = { enabled: true, port: 7420, running: true, file: '/tmp/api.json' };

  beforeEach(() => {
    invoke.mockReset();
  });

  it('reads the status', async () => {
    invoke.mockResolvedValue(STATUS);
    await expect(tauriApiSettings.status()).resolves.toEqual(STATUS);
    expect(invoke).toHaveBeenCalledWith('api_status');
  });

  it('switches the API and answers with the status after', async () => {
    invoke.mockResolvedValue(STATUS);
    await expect(tauriApiSettings.setEnabled(true)).resolves.toEqual(STATUS);
    expect(invoke).toHaveBeenCalledWith('api_set_enabled', { enabled: true });
  });

  it('reads the token', async () => {
    invoke.mockResolvedValue('secret');
    await expect(tauriApiSettings.token()).resolves.toBe('secret');
    expect(invoke).toHaveBeenCalledWith('api_token');
  });

  it('rotates the token and answers with the new one', async () => {
    invoke.mockResolvedValue('fresh');
    await expect(tauriApiSettings.rotateToken()).resolves.toBe('fresh');
    expect(invoke).toHaveBeenCalledWith('api_rotate_token');
  });

  it('turns the host refusing to start into an Error with its words', async () => {
    invoke.mockRejectedValue('cannot listen on 127.0.0.1: address in use');
    const failure = tauriApiSettings.setEnabled(true);
    await expect(failure).rejects.toThrow('cannot listen on 127.0.0.1: address in use');
    await expect(failure).rejects.toBeInstanceOf(Error);
  });
});
