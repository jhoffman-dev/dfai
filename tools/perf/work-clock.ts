import { expect, type Page } from '@playwright/test';

/*
 * The work clock: what makes a count of the app's work the same on every run
 * and every machine (`budgets.spec.ts`).
 *
 * Counted against the wall clock, the same action made different numbers of
 * React commits and host calls from run to run: two host answers that land
 * in one task are one commit, in two tasks two; a refresh still in flight
 * when the next change arrives is run once or twice; a 300 ms timer fires
 * before the host's answer or after it. None of that is the app doing more
 * work, and a gate that fails on it is a flaky gate.
 *
 * So, in the page, before the app loads:
 * - **Time is virtual.** `setTimeout`, `setInterval` and
 *   `requestAnimationFrame` are kept in a list and run only when the harness
 *   moves time on (`runUntil`), in the order they are due. `Date` is
 *   `startsAt` plus that time. Nothing the app schedules fires on its own.
 * - **The host answers one at a time, in the order it was asked.** A host
 *   command (and a request to the index worker) is sent at once, but its
 *   answer is handed to the app only when the page is quiet — and the oldest
 *   question first, whenever the answers arrived.
 * - **Animations a script starts** (`element.animate`) are held, and finish
 *   when their time on the work clock is up.
 * - **Quiet** means no React or `MessageChannel` task pending, the answer
 *   just handed over drawn, one frame after it so that layout observers have
 *   run, and no finite animation still playing.
 * The host is, in effect, infinitely fast, and time moves only when the page
 * has nothing left to do: the work an action causes is a function of the
 * action alone.
 *
 * With `virtual: false` only `Date` changes (to `startsAt`, moving with the
 * wall clock), for a run that is timed rather than counted.
 *
 * Test support only: the app never installs it.
 */

export interface WorkClockOptions {
  /** Epoch milliseconds the page's `Date` starts at. */
  readonly startsAt: number;
  /** Whether time and the host's answers are held, for counting; false only fixes the date. */
  readonly virtual: boolean;
  /**
   * Real milliseconds every host answer is held back before it counts as
   * arrived: a slower host. The counts must not move with it
   * (`PERF_HOST_DELAY_MS`, to check that they do not).
   */
  readonly hostDelayMs?: number;
}

/** What the clock counted between `startCounting` and `stopCounting`. */
export interface Counted {
  readonly commits: number;
  readonly renders: Record<string, number>;
  readonly calls: Record<string, number>;
}

/** What `runUntil` says: how much virtual time passed before the page was ready. */
export interface Ran {
  readonly readyAfterMs: number;
}

/**
 * Installs the clock in the page; give it to `page.addInitScript` after the
 * stand-in host's own script, whose IPC it wraps. Everything it uses is
 * inside it, since it crosses into the page as its source.
 */
export function installWorkClock({ startsAt, virtual, hostDelayMs = 0 }: WorkClockOptions): void {
  if (window !== window.top) return;
  const RealDate = Date;
  const realStart = performance.now();
  const state = {
    now: 0,
    order: 0,
    nextId: 1_000_000_000,
    timers: new Map<number, Timer>(),
    /** `MessageChannel` messages posted and not yet handled: React's scheduler and the index's breaths. */
    tasks: 0,
    /** Questions to the host and the worker not yet answered to the app, oldest first. */
    waiting: [] as Question[],
    running: false,
    counting: false,
    calls: {} as Record<string, number>,
    lastCommitSeen: null as number | null,
  };
  interface Timer {
    readonly id: number;
    due: number;
    order: number;
    readonly run: () => void;
    readonly every: number | null;
  }
  interface Question {
    readonly command: string;
    answer: (() => void) | null;
  }

  const clockNow = () => startsAt + (virtual ? state.now : performance.now() - realStart);
  function FixedDate(this: unknown, ...args: unknown[]): unknown {
    if (new.target === undefined) return new RealDate(clockNow()).toString();
    if (args.length === 0) return new RealDate(clockNow());
    return new (RealDate as unknown as new (...given: unknown[]) => Date)(...args);
  }
  FixedDate.prototype = RealDate.prototype;
  Object.assign(FixedDate, { now: clockNow, parse: RealDate.parse, UTC: RealDate.UTC });
  window.Date = FixedDate as unknown as DateConstructor;
  if (!virtual) return;

  const realSetTimeout = window.setTimeout.bind(window);
  const realFrame =
    typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame.bind(window)
      : (callback: () => void) => realSetTimeout(callback, 16);

  const addTimer = (run: () => void, delay: unknown, every: number | null) => {
    const id = state.nextId++;
    const wait = Math.max(0, Number(delay) || 0);
    state.timers.set(id, { id, due: state.now + wait, order: state.order++, run, every });
    return id;
  };
  const call = (handler: unknown, args: unknown[]) => () => {
    if (typeof handler === 'function') (handler as (...given: unknown[]) => void)(...args);
  };
  const clear = (id: unknown) => void state.timers.delete(Number(id));
  Object.assign(window, {
    setTimeout: (handler: unknown, delay?: unknown, ...args: unknown[]) =>
      addTimer(call(handler, args), delay, null),
    // Never every 0 ms: an interval that is always due would never let time move on.
    setInterval: (handler: unknown, delay?: unknown, ...args: unknown[]) =>
      addTimer(call(handler, args), delay, Math.max(1, Number(delay) || 0)),
    clearTimeout: clear,
    clearInterval: clear,
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      addTimer(() => callback(realStart + state.now), 16 - (state.now % 16), null),
    cancelAnimationFrame: clear,
  });

  // A script's own animation (`element.animate`, as dnd-kit's drop) runs on the
  // work clock too: held where it starts, and finished when its time is up,
  // rather than ending on the wall clock before or after a host answer.
  const realAnimate = Element.prototype.animate as ((...given: unknown[]) => Animation) | undefined;
  if (typeof realAnimate === 'function') {
    Element.prototype.animate = function heldAnimation(this: Element, ...given: unknown[]) {
      const animation = realAnimate.apply(this, given);
      animation.pause();
      const ends = Number(animation.effect?.getComputedTiming().endTime ?? 0);
      // One that never ends stays held where it started.
      if (Number.isFinite(ends)) addTimer(() => animation.finish(), ends, null);
      return animation;
    } as typeof Element.prototype.animate;
  }

  // React's scheduler and the index's breaths post themselves messages: counted, to be waited for.
  const RealChannel = window.MessageChannel;
  const onmessage = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage');
  const tracked = (port: MessagePort, handled: MessagePort) => {
    const post = port.postMessage.bind(port) as (...given: unknown[]) => void;
    port.postMessage = (...given: unknown[]) => {
      state.tasks += 1;
      post(...given);
    };
    let handler: ((event: MessageEvent) => void) | null = null;
    Object.defineProperty(handled, 'onmessage', {
      configurable: true,
      get: () => handler,
      set: (next: ((event: MessageEvent) => void) | null) => {
        handler = next;
        onmessage?.set?.call(handled, (event: MessageEvent) => {
          try {
            handler?.call(handled, event);
          } finally {
            state.tasks -= 1;
          }
        });
      },
    });
  };
  if (typeof RealChannel === 'function')
    window.MessageChannel = function TrackedChannel() {
      const channel = new RealChannel();
      tracked(channel.port1, channel.port2);
      tracked(channel.port2, channel.port1);
      return channel;
    } as unknown as typeof MessageChannel;

  // The index worker answers `begin` and `derive` once each, in order, and
  // `end` not at all (`packages/adapters/src/index/worker-note-deriver.ts`).
  const RealWorker = window.Worker as typeof Worker | undefined;
  const workerOnmessage =
    RealWorker === undefined
      ? undefined
      : Object.getOwnPropertyDescriptor(RealWorker.prototype, 'onmessage');
  if (RealWorker !== undefined)
    window.Worker = function TrackedWorker(url: string | URL, options?: WorkerOptions) {
      const worker = new RealWorker(url, options);
      const asked: Question[] = [];
      const post = worker.postMessage.bind(worker) as (...given: unknown[]) => void;
      worker.postMessage = (message: unknown, ...rest: unknown[]) => {
        const kind = (message as { kind?: unknown } | null)?.kind;
        if (kind === 'begin' || kind === 'derive') {
          const question: Question = { command: `worker ${kind}`, answer: null };
          state.waiting.push(question);
          asked.push(question);
        }
        post(message, ...rest);
      };
      let handler: ((event: MessageEvent) => void) | null = null;
      Object.defineProperty(worker, 'onmessage', {
        configurable: true,
        get: () => handler,
        set: (next: ((event: MessageEvent) => void) | null) => {
          handler = next;
          workerOnmessage?.set?.call(worker, (event: MessageEvent) => {
            const question = asked.shift();
            if (question === undefined) handler?.call(worker, event);
            else question.answer = () => handler?.call(worker, event);
          });
        },
      });
      return worker;
    } as unknown as typeof Worker;

  const internals = (
    window as unknown as {
      __TAURI_INTERNALS__?: { invoke: (command: string, ...rest: unknown[]) => Promise<unknown> };
    }
  ).__TAURI_INTERNALS__;
  if (internals === undefined) throw new Error('install the work clock after the stand-in host');
  const invoke = internals.invoke;
  const arrived = (then: () => void) =>
    hostDelayMs > 0 ? void realSetTimeout(then, hostDelayMs) : then();
  internals.invoke = (command, ...rest) => {
    if (command.startsWith('plugin:event')) return invoke(command, ...rest);
    if (state.counting) state.calls[command] = (state.calls[command] ?? 0) + 1;
    const question: Question = { command, answer: null };
    state.waiting.push(question);
    return new Promise((resolve, reject) => {
      invoke(command, ...rest).then(
        (value) => {
          arrived(() => Object.assign(question, { answer: () => resolve(value) }));
        },
        (error: unknown) => {
          arrived(() => Object.assign(question, { answer: () => reject(error) }));
        },
      );
    });
  };

  // Every key and pointer event the page has been given, so a harness can wait
  // for its input to have arrived before it moves time on.
  let inputs = 0;
  for (const kind of ['keydown', 'pointerdown', 'pointermove', 'pointerup']) {
    window.addEventListener(kind, () => void (inputs += 1), { capture: true });
  }

  const counter = () =>
    (window as unknown as { __renderCounter?: { lastCommitAt: number | null } }).__renderCounter;
  const aTurn = () => new Promise((resolve) => realSetTimeout(resolve, 0));
  const aFrame = () => new Promise((resolve) => realFrame(() => realSetTimeout(resolve, 0)));
  const animating = () =>
    (document.getAnimations?.() ?? []).some(
      (animation) =>
        animation.playState === 'running' &&
        animation.effect?.getComputedTiming().iterations !== Infinity,
    );
  /** Hands over the oldest answer, if it has come, and says whether it did. */
  const answerOldest = () => {
    const oldest = state.waiting[0];
    if (oldest === undefined || oldest.answer === null) return false;
    state.waiting.shift();
    oldest.answer();
    return true;
  };

  /** Waits, without moving time, until the page has nothing left to do. */
  async function quiet(): Promise<void> {
    const since = performance.now();
    let busy = true;
    for (;;) {
      await aTurn();
      if (performance.now() - since > 120_000) {
        const on = state.waiting[0]?.command ?? (state.tasks > 0 ? 'a task' : 'an animation');
        throw new Error(`the work clock waited two minutes for ${on}`);
      }
      if (state.tasks > 0 || answerOldest()) {
        busy = true;
        continue;
      }
      if (state.waiting.length > 0) continue;
      const committed = counter()?.lastCommitAt ?? null;
      if (committed !== state.lastCommitSeen) {
        state.lastCommitSeen = committed;
        busy = true;
      }
      if (!busy && !animating()) return;
      busy = false;
      // Drawn, so that resize and intersection observers have seen it.
      await aFrame();
    }
  }

  /** The timer due first, by `horizon` at the latest. */
  const dueBy = (horizon: number): Timer | undefined => {
    let first: Timer | undefined;
    for (const timer of state.timers.values()) {
      if (timer.due > horizon) continue;
      if (
        first === undefined ||
        timer.due < first.due ||
        (timer.due === first.due && timer.order < first.order)
      ) {
        first = timer;
      }
    }
    return first;
  };
  const fire = (timer: Timer) => {
    state.now = Math.max(state.now, timer.due);
    if (timer.every === null) state.timers.delete(timer.id);
    else Object.assign(timer, { due: timer.due + timer.every, order: state.order++ });
    try {
      timer.run();
    } catch (error) {
      // Thrown again outside, as a timer's error reaches `window.onerror` in a real page.
      realSetTimeout(() => {
        throw error;
      }, 0);
    }
  };

  /**
   * Waits on the wall clock, time held still, until `ready` holds or
   * `untrackedMs` pass: for work the clock does not hold — a read of a
   * `Blob`, a stream — which finishes on its own time. No timer fires
   * meanwhile, so what the app does is the same however long that takes;
   * its tasks and the host's answers are taken as they come, as ever.
   */
  async function untrackedWork(
    ready: (given: unknown) => boolean,
    arg: unknown,
    untrackedMs: number,
  ): Promise<void> {
    const since = performance.now();
    for (;;) {
      await quiet();
      if (ready(arg) || performance.now() - since > untrackedMs) return;
      await aFrame();
    }
  }

  // Outside `run`, answers are handed over as they come, so that setting up
  // the next action works the way it does in a real page.
  void (async () => {
    for (;;) {
      await aTurn();
      if (!state.running && !state.counting) answerOldest();
    }
  })();

  (window as unknown as { __workClock: unknown }).__workClock = {
    /**
     * Moves time on, a timer at a time, until `ready` holds (at most `limitMs`
     * of virtual time), then `settleMs` more, so the work that follows is in.
     */
    async run(
      source: string | null,
      arg: unknown,
      settleMs: number,
      limitMs: number,
      untrackedMs = 0,
    ) {
      const ready =
        source === null
          ? null
          : (new Function(`return (${source})`)() as (given: unknown) => boolean);
      state.running = true;
      try {
        if (ready !== null && untrackedMs > 0) await untrackedWork(ready, arg, untrackedMs);
        const start = state.now;
        let readyAt: number | null = ready === null ? start : null;
        for (;;) {
          await quiet();
          if (readyAt === null && ready?.(arg) === true) readyAt = state.now;
          const horizon = readyAt === null ? start + limitMs : readyAt + settleMs;
          const next = dueBy(horizon);
          if (next === undefined) {
            if (readyAt === null)
              throw new Error(`not ready after ${limitMs} ms of the work clock`);
            state.now = horizon;
            return { readyAfterMs: readyAt - start };
          }
          fire(next);
        }
      } finally {
        state.running = false;
      }
    },
    inputsSeen: () => inputs,
    /** The host commands counted so far, by name: for a ready test that the action itself caused. */
    callsSoFar: () => ({ ...state.calls }),
    startCounting() {
      Object.assign(state, { counting: true, calls: {} });
    },
    stopCounting() {
      state.counting = false;
      return { ...state.calls };
    },
  };
}

interface ClockWindow {
  __workClock: {
    run(
      source: string | null,
      arg: unknown,
      settleMs: number,
      limitMs: number,
      untrackedMs?: number,
    ): Promise<Ran>;
    inputsSeen(): number;
    callsSoFar(): Record<string, number>;
    startCounting(): void;
    stopCounting(): Record<string, number>;
  };
  __renderCounter?: {
    on: boolean;
    commits: number;
    renders: Record<string, number>;
    changedProps: Record<string, unknown>;
  };
}

/** How long, on the work clock, the work after an action is waited for: past the 300 ms writes, short of autosave's 1.2 s. */
export const SETTLE_MS = 1_000;

/**
 * Moves the page's time on until `ready(arg)` holds in the page, then
 * `settleMs` more. With no `ready`, only `settleMs`.
 */
export function runUntil<Arg>(
  page: Page,
  {
    ready,
    arg,
    settleMs = SETTLE_MS,
    limitMs = 60_000,
    untrackedMs = 0,
  }: {
    ready?: (arg: Arg) => boolean;
    arg?: Arg;
    settleMs?: number;
    limitMs?: number;
    /** Real milliseconds to wait, time held still, for work the clock does not hold (`untrackedWork`). */
    untrackedMs?: number;
  },
): Promise<Ran> {
  return page.evaluate(
    ({ source, given, settle, limit, untracked }) =>
      (window as unknown as ClockWindow).__workClock.run(source, given, settle, limit, untracked),
    {
      source: ready?.toString() ?? null,
      given: (arg ?? null) as unknown,
      settle: settleMs,
      limit: limitMs,
      untracked: untrackedMs,
    },
  );
}

/** How long a quick hand takes between one key or pointer move and the next, on the work clock. */
export const BETWEEN_MS = 50;

/** How many key and pointer events the page has been given so far. */
export const inputsSeen = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as ClockWindow).__workClock.inputsSeen());

/**
 * Gives one input, waits until the page has had it — the browser can hand an
 * event over after the call that sent it returns — and lets it take it in for
 * `BETWEEN_MS` of the work clock before the next.
 */
export async function oneInput(page: Page, give: () => Promise<void>): Promise<Ran> {
  const before = await inputsSeen(page);
  await give();
  await expect.poll(() => inputsSeen(page), { intervals: [5] }).toBeGreaterThan(before);
  return runUntil(page, { settleMs: BETWEEN_MS });
}

/** Starts counting commits, renders and host calls from nothing, and holds the host's answers for `runUntil`. */
export async function startCounting(page: Page): Promise<void> {
  await page.evaluate(() => {
    const clock = window as unknown as ClockWindow;
    clock.__workClock.startCounting();
    const counter = clock.__renderCounter;
    if (counter === undefined) throw new Error('the render counter was not installed');
    Object.assign(counter, { on: true, commits: 0, renders: {}, changedProps: {} });
  });
}

/** Stops counting, and says what was counted. */
export function stopCounting(page: Page): Promise<Counted> {
  return page.evaluate(() => {
    const clock = window as unknown as ClockWindow;
    const counter = clock.__renderCounter;
    if (counter === undefined) throw new Error('the render counter was not installed');
    counter.on = false;
    return {
      commits: counter.commits,
      renders: { ...counter.renders },
      calls: clock.__workClock.stopCounting(),
    };
  });
}
