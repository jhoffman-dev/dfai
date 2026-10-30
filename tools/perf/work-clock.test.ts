// @vitest-environment jsdom
/**
 * The work clock's rules (`work-clock.ts`), in a stand-in window: time moves
 * only when the harness moves it, timers fire in the order they are due, and
 * the host's answers reach the app in the order it asked, however they arrive.
 */
import { setTimeout as wallClockDelay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { installWorkClock } from './work-clock.ts';

interface Clock {
  run(
    source: string | null,
    arg: unknown,
    settleMs: number,
    limitMs: number,
    untrackedMs?: number,
  ): Promise<{ readyAfterMs: number }>;
  startCounting(): void;
  stopCounting(): Record<string, number>;
}

const STARTS_AT = Date.UTC(2026, 5, 15, 9);
const realSetTimeout = globalThis.setTimeout;

/** A host whose answers come back when the test says, not in the order asked. */
function installSlowHost() {
  const pending = new Map<string, (value: unknown) => void>();
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    invoke: (command: string) =>
      new Promise((resolve) => {
        pending.set(command, resolve);
      }),
  };
  return {
    answer: (command: string) => pending.get(command)?.(`${command} answered`),
  };
}

/**
 * A worker that answers when the test says, as the index's script does: one
 * answer per `begin`, `derive` or `chunk`, in the order they were posted.
 */
class StandInWorker {
  readonly posted: unknown[] = [];
  #heard: ((event: MessageEvent) => void) | null = null;
  get onmessage() {
    return this.#heard;
  }
  set onmessage(heard: ((event: MessageEvent) => void) | null) {
    this.#heard = heard;
  }
  postMessage(message: unknown) {
    this.posted.push(message);
  }
  answer(data: unknown) {
    this.#heard?.({ data } as MessageEvent);
  }
}
(window as unknown as { Worker: unknown }).Worker = StandInWorker;

/**
 * A layout observer whose reports come when the test says, as a browser's
 * come on a rendering step of its own: jsdom has neither kind.
 */
class StandInObserver {
  readonly #report: (entries: readonly { target: Element }[], observer: unknown) => void;
  constructor(report: (entries: readonly { target: Element }[], observer: unknown) => void) {
    this.#report = report;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  /** What the browser does on a rendering step: hands the observer what changed. */
  reportOn(...targets: Element[]) {
    this.#report(
      targets.map((target) => ({ target, size: target.getAttribute('data-size') })),
      this,
    );
  }
}
Object.assign(window, {
  ResizeObserver: class extends StandInObserver {},
  IntersectionObserver: class extends StandInObserver {},
});

const clock = () => (window as unknown as { __workClock: Clock }).__workClock;
const invoke = (command: string) =>
  (
    window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string) => Promise<unknown> } }
  ).__TAURI_INTERNALS__.invoke(command);
const aMoment = () => new Promise((resolve) => realSetTimeout(resolve, 20));

describe('the work clock', () => {
  const host = installSlowHost();
  // jsdom draws its frames on the page's own timers, which the clock holds: it waits on plain ones instead.
  Reflect.deleteProperty(window, 'requestAnimationFrame');
  installWorkClock({ startsAt: STARTS_AT, virtual: true });

  it('holds every timer until time is moved on, then fires them in the order they are due', async () => {
    const fired: string[] = [];
    setTimeout(() => fired.push('late'), 300);
    setTimeout(() => fired.push('early'), 100);
    requestAnimationFrame(() => fired.push('frame'));
    await aMoment();
    expect(fired).toEqual([]);
    await clock().run(null, null, 200, 0);
    expect(fired).toEqual(['frame', 'early']);
    await clock().run(null, null, 200, 0);
    expect(fired).toEqual(['frame', 'early', 'late']);
  });

  it('gives Date the virtual time from the day it starts at', async () => {
    const before = Date.now();
    expect(before).toBeGreaterThanOrEqual(STARTS_AT);
    await clock().run(null, null, 5_000, 0);
    expect(Date.now() - before).toBe(5_000);
    expect(new Date().getTime()).toBe(Date.now());
  });

  it('hands the host’s answers over in the order they were asked for', async () => {
    const heard: unknown[] = [];
    void invoke('first').then((value) => heard.push(value));
    void invoke('second').then((value) => heard.push(value));
    host.answer('second');
    await aMoment();
    host.answer('first');
    await clock().run(null, null, 0, 0);
    expect(heard).toEqual(['first answered', 'second answered']);
  });

  it.each(['derive', 'chunk'])(
    'moves no time on while the worker has a %s to answer, whenever its answer comes',
    async (kind) => {
      const heard: string[] = [];
      const worker = new Worker('note-derivation.worker.ts') as unknown as StandInWorker;
      worker.onmessage = () => heard.push('answer');
      worker.postMessage({ kind, id: 1 });
      setTimeout(() => heard.push('timer'), 100);
      // The note is cut on the wall clock, after the clock has had time to move on without it.
      void wallClockDelay(200).then(() => worker.answer({ kind: `${kind} done`, id: 1 }));
      await clock().run(null, null, 1_000, 0);
      expect(heard).toEqual(['answer', 'timer']);
    },
  );

  it('runs until the page says it is ready, and says how long that took', async () => {
    setTimeout(() => document.body.setAttribute('data-ready', 'yes'), 250);
    const ran = await clock().run(
      '() => document.body.getAttribute("data-ready") === "yes"',
      null,
      0,
      1_000,
    );
    expect(ran.readyAfterMs).toBe(250);
  });

  it('waits on the wall clock, time held still, for work it does not hold', async () => {
    const timerFired: string[] = [];
    setTimeout(() => timerFired.push('timer'), 100);
    // Work the clock does not hold (a read of a Blob, in the app): it settles on the wall clock.
    void wallClockDelay(300).then(() => document.body.setAttribute('data-read', 'yes'));
    const ran = await clock().run(
      '() => document.body.getAttribute("data-read") === "yes"',
      null,
      0,
      1_000,
      5_000,
    );
    expect(ran.readyAfterMs).toBe(0);
    expect(timerFired).toEqual([]);
  });

  it('fails, rather than waits for ever, when the page is never ready', async () => {
    await expect(clock().run('() => false', null, 0, 500)).rejects.toThrow(
      'not ready after 500 ms of the work clock',
    );
  });

  it.each([
    ['just after it starts', 59_999],
    ['in its middle', 59_500],
    ['on its last moment', 59_000],
  ])(
    'never fires a timer of a minute or more while counting, its due time %s (#243)',
    async (_where, countFrom) => {
      const fired: string[] = [];
      const base = Date.now() - STARTS_AT;
      const tick = setInterval(() => fired.push('minute tick'), 60_000);
      setTimeout(() => fired.push('a minute later'), 60_000);
      // Up to the window's start, uncounted, as the harness's set-up moves time on.
      await clock().run(null, null, countFrom, 0);
      expect(fired).toEqual([]);
      clock().startCounting();
      setTimeout(() => fired.push('autosave'), 300);
      // A counted action: its own short timers fire, the minute's do not.
      await clock().run(null, null, 1_000, 0);
      clock().stopCounting();
      expect(Date.now() - STARTS_AT - base).toBe(countFrom + 1_000);
      expect(fired).toEqual(['autosave']);
      // The next uncounted step takes them, once each, before anything else.
      await clock().run(null, null, 0, 0);
      expect(fired).toEqual(['autosave', 'minute tick', 'a minute later']);
      clearInterval(tick);
    },
  );

  it('keeps a held minute tick on its minute: due plus a minute, not released plus a minute (#243)', async () => {
    const base = Date.now() - STARTS_AT;
    const firedAt: number[] = [];
    const tick = setInterval(() => firedAt.push(Date.now() - STARTS_AT - base), 60_000);
    await clock().run(null, null, 59_500, 0);
    // Due at 60,000, inside a window that runs to 60,500: held.
    clock().startCounting();
    await clock().run(null, null, 1_000, 0);
    clock().stopCounting();
    expect(firedAt).toEqual([]);
    // Released on the next uncounted step, at 60,500.
    await clock().run(null, null, 0, 0);
    expect(firedAt).toEqual([60_500]);
    // Up to the next minute: it fires once more, on the minute it always had.
    await clock().run(null, null, 59_500, 0);
    expect(firedAt).toEqual([60_500, 120_000]);
    clearInterval(tick);
  });

  describe.each(['ResizeObserver', 'IntersectionObserver'] as const)('a %s', (kind) => {
    type Entry = { readonly target: Element; readonly size: string | null };
    const observerOf = (heard: string[]) =>
      new (
        window as unknown as Record<
          typeof kind,
          new (report: (entries: Entry[]) => void) => StandInObserver
        >
      )[kind]((entries) =>
        heard.push(entries.map(({ target, size }) => `${target.id} ${size}`).join(', ')),
      );
    const element = (id: string, size: string) => {
      const made = document.createElement('div');
      Object.assign(made, { id });
      made.setAttribute('data-size', size);
      return made;
    };

    it('holds a report that comes while counting, and hands it over once the clock has drawn a frame (#243)', async () => {
      const heard: string[] = [];
      const observer = observerOf(heard);
      clock().startCounting();
      // A rendering step between two inputs: in a page it can land before
      // React's work or after it, so the app must not see it then.
      observer.reportOn(element('card', '38'));
      expect(heard).toEqual([]);
      await clock().run(null, null, 0, 0);
      clock().stopCounting();
      expect(heard).toEqual(['card 38']);
    });

    it('hands over the reports it held for one observer as one, the latest for each element (#243)', async () => {
      const heard: string[] = [];
      const observer = observerOf(heard);
      const [card, column] = [element('card', '38'), element('column', '723')];
      clock().startCounting();
      observer.reportOn(card);
      observer.reportOn(column);
      card.setAttribute('data-size', '40');
      observer.reportOn(card);
      await clock().run(null, null, 0, 0);
      clock().stopCounting();
      expect(heard).toEqual(['card 40, column 723']);
    });

    it('drops a held report once its observer is disconnected, as a browser does (#243)', async () => {
      const heard: string[] = [];
      const observer = observerOf(heard);
      clock().startCounting();
      observer.reportOn(element('card', '38'));
      observer.disconnect();
      await clock().run(null, null, 0, 0);
      clock().stopCounting();
      expect(heard).toEqual([]);
    });

    it("hands a report over at once outside counting and the clock's runs", () => {
      const heard: string[] = [];
      observerOf(heard).reportOn(element('card', '38'));
      expect(heard).toEqual(['card 38']);
    });
  });

  it('counts the host commands sent while counting, by name', async () => {
    clock().startCounting();
    void invoke('read_note');
    void invoke('read_note');
    void invoke('list_notes');
    expect(clock().stopCounting()).toEqual({ read_note: 2, list_notes: 1 });
  });
});
