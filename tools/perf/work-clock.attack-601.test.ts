// @vitest-environment jsdom
/**
 * Attacks on the work clock's held minute timers (#243, PR #601): random
 * timers and counted windows over a seeded RNG, the edges of a timer's delay,
 * and the ready check while a minute timer is held.
 */
import { beforeAll, describe, expect, it } from 'vitest';
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

const STARTS_AT = Date.UTC(2026, 5, 15, 9);
const MINUTE = 60_000;
const realSetImmediate = globalThis.setImmediate;

(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: () => Promise.resolve(null),
};
// The clock's own frames, on the wall clock: one macrotask, so that a seeded run of hundreds of firings stays quick.
window.requestAnimationFrame = (callback: FrameRequestCallback) =>
  Number(realSetImmediate(() => callback(0)));
installWorkClock({ startsAt: STARTS_AT, virtual: true });

const clock = () => (window as unknown as { __workClock: Clock }).__workClock;
const elapsed = (base: number) => Date.now() - base;

/** mulberry32: a small seeded RNG, the same sequence for the same seed. */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const SPECIAL_DELAYS = [0, 1, 59_999, MINUTE, 60_001, 120_000, 300_000];
const SPECIAL_WINDOWS = [0, 59_999, MINUTE, 60_001, 90_000];

type Invariant =
  | 'no timer of a minute or more fires while counting'
  | 'a timer under a minute fires exactly when due'
  | 'a held timer fires once, at the first uncounted step, on its phase'
  | 'no timer is lost'
  | 'a cleared timer never fires'
  | 'virtual time never goes backwards';

interface Made {
  readonly label: string;
  readonly id: number;
  readonly every: number | null;
  readonly long: boolean;
  /** When it is next due, by its phase: created + delay + k * every. */
  phase: number;
  cleared: boolean;
}

interface Span {
  readonly from: number;
  readonly counted: boolean;
}

interface Outcome {
  readonly log: string[];
  readonly broken: Map<Invariant, string[]>;
  /** Firings of a long timer after its due time: the held path this attack is about. */
  readonly releases: number;
}

/**
 * One seeded case: timers made, cleared and moved on through counted and
 * uncounted windows, every firing checked against what the clock promises.
 */
async function simulate(seed: number): Promise<Outcome> {
  const random = seeded(seed);
  const pick = <T>(from: readonly T[]) => from[Math.floor(random() * from.length)] as T;
  const aDelay = () => (random() < 0.4 ? pick(SPECIAL_DELAYS) : Math.floor(random() * 300_001));
  const aWindow = () => (random() < 0.3 ? pick(SPECIAL_WINDOWS) : Math.floor(random() * 90_001));
  const base = Date.now();
  const made: Made[] = [];
  const log: string[] = [];
  const spans: Span[] = [];
  const broken = new Map<Invariant, string[]>();
  let counting = false;
  let last = 0;
  let releases = 0;
  const breaks = (invariant: Invariant, what: string) =>
    broken.set(invariant, [...(broken.get(invariant) ?? []), what]);

  /** When a long timer due at `due` should fire: then, or at the first uncounted step after. */
  const releasedAt = (due: number) => {
    for (let index = 0; index < spans.length; index += 1) {
      const span = spans[index] as Span;
      const until = spans[index + 1]?.from ?? Infinity;
      if (!span.counted && until >= due) return Math.max(due, span.from);
    }
    return Infinity;
  };

  const heard = (timer: Made) => {
    const at = elapsed(base);
    log.push(`${timer.label}@${at}${counting ? ' counted' : ''}`);
    if (at < last)
      breaks('virtual time never goes backwards', `${timer.label} at ${at} after ${last}`);
    last = at;
    if (timer.cleared) breaks('a cleared timer never fires', `${timer.label} at ${at}`);
    if (timer.long && counting)
      breaks('no timer of a minute or more fires while counting', `${timer.label} at ${at}`);
    const expected = timer.long ? releasedAt(timer.phase) : timer.phase;
    if (timer.long && at > timer.phase) releases += 1;
    if (at !== expected) {
      const invariant = timer.long
        ? 'a held timer fires once, at the first uncounted step, on its phase'
        : 'a timer under a minute fires exactly when due';
      breaks(invariant, `${timer.label} (due ${timer.phase}) at ${at}, expected ${expected}`);
    }
    // The next due on its phase, after this firing: a missed period is skipped, not caught up.
    if (timer.every === null) timer.phase = Infinity;
    else while (timer.phase <= at) timer.phase += timer.every;
    if (made.length < 40 && random() < 0.25) makeTimer(`${timer.label}>`);
    if (timer.every !== null && random() < 0.1) clearTimer(timer);
  };

  function makeTimer(label: string) {
    const repeats = random() < 0.4;
    const delay = repeats ? Math.max(5_000, aDelay()) : aDelay();
    const named = `${label}${made.length}${repeats ? 'i' : 't'}${delay}`;
    const timer = {
      label: named,
      every: repeats ? delay : null,
      long: delay >= MINUTE,
      phase: elapsed(base) + delay,
      cleared: false,
    } as Omit<Made, 'id'> & { id: number };
    // The page's timers, which the clock has replaced: their ids are numbers.
    timer.id = Number(
      repeats ? setInterval(() => heard(timer), delay) : setTimeout(() => heard(timer), delay),
    );
    made.push(timer);
  }
  function clearTimer(timer: Made) {
    timer.cleared = true;
    clearTimeout(timer.id);
  }
  const moveOn = async (counted: boolean, settleMs: number) => {
    spans.push({ from: elapsed(base), counted });
    counting = counted;
    if (counted) clock().startCounting();
    await clock().run(null, null, settleMs, 0);
    if (counted) clock().stopCounting();
    counting = false;
  };

  const timersAtStart = 3 + Math.floor(random() * 4);
  for (let index = 0; index < timersAtStart; index += 1) makeTimer('');
  for (let step = 0; step < 16; step += 1) {
    if (random() < 0.5) makeTimer('');
    const live = made.filter((timer) => !timer.cleared);
    if (live.length > 0 && random() < 0.3) clearTimer(pick(live));
    await moveOn(random() < 0.6, aWindow());
  }
  // The last uncounted step: whatever was held is released now.
  await moveOn(false, 0);
  const end = elapsed(base);
  for (const timer of made) {
    if (!timer.cleared && timer.phase <= end)
      breaks('no timer is lost', `${timer.label} due ${timer.phase}, never fired by ${end}`);
    clearTimer(timer);
  }
  return { log, broken, releases };
}

const SEEDS = Array.from({ length: 40 }, (_, index) => 601 + index * 7919);

describe('the work clock, over random timers and windows (seeded)', () => {
  const outcomes = new Map<number, Outcome>();
  beforeAll(async () => {
    for (const seed of SEEDS) outcomes.set(seed, await simulate(seed));
  }, 120_000);

  const brokenAcross = (invariant: Invariant) =>
    SEEDS.flatMap((seed) =>
      (outcomes.get(seed)?.broken.get(invariant) ?? [])
        .slice(0, 3)
        .map((what) => `seed ${seed}: ${what}`),
    );

  it.each<Invariant>([
    'no timer of a minute or more fires while counting',
    'a timer under a minute fires exactly when due',
    'a held timer fires once, at the first uncounted step, on its phase',
    'no timer is lost',
    'a cleared timer never fires',
    'virtual time never goes backwards',
  ])('%s', (invariant) => {
    expect(brokenAcross(invariant)).toEqual([]);
  });

  it('releases held minute timers often enough to test the held path', () => {
    const releases = SEEDS.reduce((sum, seed) => sum + (outcomes.get(seed)?.releases ?? 0), 0);
    expect(releases).toBeGreaterThanOrEqual(20);
  });

  it('fires the same timers at the same times for the same seed', async () => {
    const seed = SEEDS[1] as number;
    const again = await simulate(seed);
    expect(again.log).toEqual(outcomes.get(seed)?.log);
    expect(again.log.length).toBeGreaterThan(0);
  }, 120_000);
});

describe('the work clock, at the edges of a held minute', () => {
  it('fires a minute setTimeout made in a counted window that ends after it was due, once, on release', async () => {
    const base = Date.now();
    const firedAt: string[] = [];
    clock().startCounting();
    setTimeout(() => firedAt.push(`${elapsed(base)}`), MINUTE);
    await clock().run(null, null, 75_000, 0);
    clock().stopCounting();
    expect(firedAt).toEqual([]);
    await clock().run(null, null, 0, 0);
    await clock().run(null, null, 120_000, 0);
    expect(firedAt).toEqual(['75000']);
  });

  it('fires a held minute interval once on release, however many of its minutes a counted stretch spans', async () => {
    const base = Date.now();
    const firedAt: number[] = [];
    const tick = setInterval(() => firedAt.push(elapsed(base)), MINUTE);
    // Two counted windows back to back, 150 s in all: the minutes at 60 s and 120 s both pass held.
    clock().startCounting();
    await clock().run(null, null, 75_000, 0);
    clock().stopCounting();
    clock().startCounting();
    await clock().run(null, null, 75_000, 0);
    clock().stopCounting();
    await clock().run(null, null, 0, 0);
    // Once on release, then on its own minute: as a browser does, never a burst of the missed ones.
    await clock().run(null, null, 30_000, 0);
    clearInterval(tick);
    expect(firedAt).toEqual([150_000, 180_000]);
  });

  it('holds an interval re-set from half a minute to a minute while counting', async () => {
    const base = Date.now();
    const fired: string[] = [];
    let tick = setInterval(() => fired.push(`half@${elapsed(base)}`), 30_000);
    clock().startCounting();
    await clock().run(null, null, 30_000, 0);
    clearInterval(tick);
    tick = setInterval(() => fired.push(`minute@${elapsed(base)}`), MINUTE);
    await clock().run(null, null, 61_000, 0);
    clock().stopCounting();
    expect(fired).toEqual(['half@30000']);
    await clock().run(null, null, 0, 0);
    clearInterval(tick);
    expect(fired).toEqual(['half@30000', 'minute@91000']);
  });

  it('holds a minute setTimeout made by a released timer, when the next window is counted', async () => {
    const base = Date.now();
    const fired: string[] = [];
    clock().startCounting();
    setTimeout(() => {
      fired.push(`outer@${elapsed(base)}`);
      setTimeout(() => fired.push(`inner@${elapsed(base)}`), MINUTE);
    }, MINUTE);
    await clock().run(null, null, 61_000, 0);
    clock().stopCounting();
    await clock().run(null, null, 0, 0);
    expect(fired).toEqual(['outer@61000']);
    clock().startCounting();
    await clock().run(null, null, 61_000, 0);
    clock().stopCounting();
    expect(fired).toEqual(['outer@61000']);
    await clock().run(null, null, 0, 0);
    expect(fired).toEqual(['outer@61000', 'inner@122000']);
  });

  it('never fires a held minute timer cleared while it was held', async () => {
    const fired: string[] = [];
    clock().startCounting();
    const once = setTimeout(() => fired.push('timeout'), MINUTE);
    const tick = setInterval(() => fired.push('interval'), MINUTE);
    await clock().run(null, null, 61_000, 0);
    clearTimeout(once);
    clearInterval(tick);
    clock().stopCounting();
    await clock().run(null, null, 120_000, 0);
    expect(fired).toEqual([]);
  });

  it('never fires a held interval again once it clears itself from its own callback', async () => {
    const fired: number[] = [];
    const base = Date.now();
    clock().startCounting();
    const tick = setInterval(() => {
      fired.push(elapsed(base));
      clearInterval(tick);
    }, MINUTE);
    await clock().run(null, null, 61_000, 0);
    clock().stopCounting();
    await clock().run(null, null, 0, 0);
    await clock().run(null, null, 300_000, 0);
    expect(fired).toEqual([61_000]);
  });

  it.each([
    ['-1', -1],
    ['-60000', -MINUTE],
    ['-0', -0],
    ['NaN', Number.NaN],
  ])('fires a timer of delay %s at once, as a browser clamps it to 0', async (_name, delay) => {
    const fired: string[] = [];
    setTimeout(() => fired.push('fired'), delay);
    await clock().run(null, null, 0, 0);
    expect(fired).toEqual(['fired']);
  });

  it.each([
    ['Number.MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER],
    ['2 ** 31', 2 ** 31],
    ['Infinity', Infinity],
  ])(
    'fires a timer of delay %s within a millisecond, as a browser does once it overflows a 32-bit long',
    async (_name, delay) => {
      const fired: string[] = [];
      const id = setTimeout(() => fired.push('fired'), delay);
      await clock().run(null, null, 1, 0);
      clearTimeout(id);
      expect(fired).toEqual(['fired']);
    },
  );

  it.each([
    ['"60000"', true, '60000'],
    ['" 6e4 "', true, ' 6e4 '],
    ['"59999"', false, '59999'],
    ['"a minute"', false, 'a minute'],
  ])(
    'coerces a string delay %s as a browser does: held while counting is %s',
    async (_name, held, delay) => {
      const fired: string[] = [];
      clock().startCounting();
      // A string delay, as a browser coerces it with Number().
      const id = setTimeout(() => fired.push('fired'), delay as unknown as number);
      await clock().run(null, null, MINUTE, 0);
      clock().stopCounting();
      expect(fired).toEqual(held ? [] : ['fired']);
      await clock().run(null, null, 0, 0);
      clearTimeout(id);
      expect(fired).toEqual(['fired']);
    },
  );
});

describe('the ready check while a minute timer is held', () => {
  it('fails loudly when only a held minute timer could make a counted action ready', async () => {
    document.body.removeAttribute('data-minute');
    const id = setTimeout(() => document.body.setAttribute('data-minute', 'yes'), MINUTE);
    clock().startCounting();
    try {
      await expect(
        clock().run('() => document.body.getAttribute("data-minute") === "yes"', null, 0, 120_000),
      ).rejects.toThrow('not ready after 120000 ms of the work clock');
      expect(document.body.getAttribute('data-minute')).toBeNull();
    } finally {
      clock().stopCounting();
      clearTimeout(id);
    }
  });

  it('fails loudly when only a held minute interval could make it ready, with short work still firing', async () => {
    document.body.removeAttribute('data-tick');
    const fired: string[] = [];
    const tick = setInterval(() => document.body.setAttribute('data-tick', 'yes'), MINUTE);
    const save = setInterval(() => fired.push('save'), 20_000);
    clock().startCounting();
    try {
      await expect(
        clock().run('() => document.body.getAttribute("data-tick") === "yes"', null, 0, 90_000),
      ).rejects.toThrow('not ready after 90000 ms of the work clock');
      expect(document.body.getAttribute('data-tick')).toBeNull();
      expect(fired).toEqual(['save', 'save', 'save', 'save']);
    } finally {
      clock().stopCounting();
      clearInterval(tick);
      clearInterval(save);
    }
  });
});
