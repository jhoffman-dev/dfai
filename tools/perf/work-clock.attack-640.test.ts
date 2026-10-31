// @vitest-environment jsdom
/**
 * Attacks on the work clock's held layout-observer reports (#243, PR #640):
 * a report that lands as a task after the frame the clock drew, a report
 * still held when counting stops, the callback's `this`, and an intersection
 * crossing queued before a disconnect.
 */
import { describe, expect, it } from 'vitest';
import { installWorkClock } from './work-clock.ts';

interface Clock {
  run(
    source: string | null,
    arg: unknown,
    settleMs: number,
    limitMs: number,
  ): Promise<{ readyAfterMs: number }>;
  startCounting(): void;
  stopCounting(): Record<string, number>;
}

type Entry = { readonly target: Element; readonly size: string | null };
type Report = (this: unknown, entries: Entry[], observer: unknown) => void;

/** A layout observer whose reports come when the test says. */
class StandInObserver {
  readonly #report: Report;
  constructor(report: Report) {
    this.#report = report;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  reportOn(...targets: Element[]) {
    this.#report.call(
      this,
      targets.map((target) => ({ target, size: target.getAttribute('data-size') })),
      this,
    );
  }
}
Object.assign(window, {
  ResizeObserver: class extends StandInObserver {},
  IntersectionObserver: class extends StandInObserver {},
});
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: () => Promise.resolve(null),
};

/**
 * The page's own timer queue, before the clock holds it, and a frame that
 * models a browser's rendering step: the frame callbacks run, then whatever
 * the step queued as a task of its own (an intersection observer's
 * notification is a queued task, not part of the step) goes on the task queue
 * after the clock's own `setTimeout(resolve, 0)`.
 */
const pageTimer = window.setTimeout.bind(window);
const queuedByTheNextStep: (() => void)[] = [];
window.requestAnimationFrame = (callback: FrameRequestCallback) =>
  pageTimer(() => {
    callback(0);
    for (const task of queuedByTheNextStep.splice(0)) pageTimer(task, 0);
  }, 0);
installWorkClock({ startsAt: Date.UTC(2026, 5, 15, 9), virtual: true });

const clock = () => (window as unknown as { __workClock: Clock }).__workClock;
const observerOf = (kind: 'ResizeObserver' | 'IntersectionObserver', report: Report) =>
  new (window as unknown as Record<typeof kind, new (report: Report) => StandInObserver>)[kind](
    report,
  );
const element = (id: string, size: string) => {
  const made = document.createElement('div');
  Object.assign(made, { id });
  made.setAttribute('data-size', size);
  return made;
};
const aTurn = () => new Promise((resolve) => pageTimer(resolve, 0));

describe('the work clock, attacked on held observer reports (#243, PR #640)', () => {
  it('hands over an intersection report queued as a task after the frame it drew, before run returns', async () => {
    const heard: string[] = [];
    const observer = observerOf('IntersectionObserver', (entries) =>
      heard.push(...entries.map(({ target }) => target.id)),
    );
    clock().startCounting();
    // The commit's layout crosses a threshold: the browser queues the
    // notification as a task once the rendering step is done.
    queuedByTheNextStep.push(() => observer.reportOn(element('card', '38')));
    await clock().run(null, null, 0, 0);
    // Observed: quiet returned with the report still held, and it reaches the
    // app only after counting stops, so its work is never counted.
    expect(heard).toEqual(['card']);
    clock().stopCounting();
    await aTurn();
  });

  it('never hands an app an older size after a newer one, when a report comes just after counting stops', async () => {
    const heard: string[] = [];
    const observer = observerOf('ResizeObserver', (entries) =>
      heard.push(...entries.map(({ target, size }) => `${target.id} ${size}`)),
    );
    const card = element('card', '38');
    clock().startCounting();
    observer.reportOn(card);
    clock().stopCounting();
    // A rendering step between the evaluate that stopped counting and the
    // clock's next turn: the card has grown since.
    card.setAttribute('data-size', '40');
    observer.reportOn(card);
    await aTurn();
    await aTurn();
    // Observed: ['card 40', 'card 38'] — the stale held size lands last.
    expect(heard.at(-1)).toBe('card 40');
  });

  it('does not hand a report held in one count over inside the next', async () => {
    let countNumber = 1;
    const heardIn: number[] = [];
    const observer = observerOf('ResizeObserver', () => heardIn.push(countNumber));
    clock().startCounting();
    await clock().run(null, null, 0, 0);
    // After the last quiet, before counting stops.
    observer.reportOn(element('card', '38'));
    clock().stopCounting();
    countNumber = 2;
    clock().startCounting();
    await clock().run(null, null, 0, 0);
    clock().stopCounting();
    // Observed: [2] — the first count's report is worked on, and counted, in the second.
    expect(heardIn).not.toContain(2);
  });

  it.each(['ResizeObserver', 'IntersectionObserver'] as const)(
    'calls a held %s report with the observer as `this`, as a browser does',
    async (kind) => {
      const thisSeen: unknown[] = [];
      const observer = observerOf(kind, function (this: unknown) {
        thisSeen.push(this);
      });
      clock().startCounting();
      observer.reportOn(element('card', '38'));
      await clock().run(null, null, 0, 0);
      clock().stopCounting();
      // Observed: `this` is the clock's internal held record, so a
      // `function` callback calling `this.unobserve(...)` throws.
      expect(thisSeen).toEqual([observer]);
    },
  );

  it('still delivers an intersection crossing queued before a disconnect, as the spec does', async () => {
    const heard: string[] = [];
    const observer = observerOf('IntersectionObserver', (entries) =>
      heard.push(...entries.map(({ target }) => target.id)),
    );
    clock().startCounting();
    observer.reportOn(element('card', '38'));
    // The intersection observer spec's disconnect() clears the targets, not
    // [[QueuedEntries]]: a crossing already queued still reaches the callback.
    observer.disconnect();
    await clock().run(null, null, 0, 0);
    clock().stopCounting();
    expect(heard).toEqual(['card']);
  });
});
