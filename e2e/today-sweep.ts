import type { Page } from './fixtures.ts';

// The 500-row Tab sweeps of today.attack-247 and the attack on them (#644)
// share one recorder, so the attack tests the sweep that ships.

/** Every stop a sweep made, as the page recorded them. */
interface SweepLog {
  moves: number;
  /** Tabs refused while the page settled. */
  held: number;
  rows: string[];
  offScreen: string[];
  lostAfter: string | null;
  last: string;
  done: boolean;
}

/**
 * Records a sweep inside the page: at every Tab, before it moves the focus,
 * the stop the last Tab reached is read — on the page or lost, which row, in
 * view. Read once the page has settled from the key: every stop waits out a
 * rendering step, so what a focus sets off at the next frame (a transition, an
 * observer's callback) has happened. A key that moved anything (a scroll, a
 * size, a change in the page, work left for later, a transition or animation
 * begun, an observer made or called) holds the next Tab back, refused, until
 * two frames have passed with nothing changing, so the scroll the focus asked
 * for has been made and the rows it places are placed and measured.
 *
 * Reading in the page instead of a round trip and two frames for each of some
 * 3,300 stops is what takes a sweep from two minutes to one (shard 4).
 */
// One self-contained function, however long: page.evaluate sends its source
// alone, so nothing outside it can be called from inside.
function recordSweep(): void {
  const host = window as unknown as { todaySweep?: SweepLog; stopTodaySweep?: () => void };
  const log: SweepLog = {
    moves: 0,
    held: 0,
    rows: [],
    offScreen: [],
    lostAfter: null,
    last: '',
    done: false,
  };
  host.todaySweep = log;
  const scroller = () => document.querySelector('.panel__body');
  const shape = () => `${scroller()?.scrollTop}/${scroller()?.scrollHeight}`;
  const nextFrame = window.requestAnimationFrame.bind(window);
  let frame = 0;
  let stopped = false;
  const tick = () => {
    frame += 1;
    if (!stopped) nextFrame(tick);
  };
  nextFrame(tick);
  let changed = false;
  const mutations = new MutationObserver(() => {
    changed = true;
  });
  mutations.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  // Work a key leaves for later — a frame callback, a timer, a task (React's
  // scheduler posts to a MessagePort) — changes nothing yet, so asking for it
  // counts as a change: a focus that blurs itself a frame later is still caught.
  const restores: (() => void)[] = [];
  const scheduling = (owner: object, name: string) => {
    const table = owner as Record<string, (...args: unknown[]) => unknown>;
    const original = table[name];
    if (original === undefined) return;
    table[name] = function (this: unknown, ...args: unknown[]) {
      changed = true;
      return original.apply(this, args);
    };
    restores.push(() => {
      table[name] = original;
    });
  };
  scheduling(window, 'requestAnimationFrame');
  scheduling(window, 'setTimeout');
  scheduling(window, 'setInterval');
  scheduling(window, 'requestIdleCallback');
  scheduling(MessagePort.prototype, 'postMessage');
  // What only the rendering step does — a CSS transition or animation set off,
  // an observer called back — counts as a change too. Observers made before
  // the sweep are not wrapped; what their callbacks do still shows as a
  // change, as every stop waits out a frame (below).
  const observing = (name: 'ResizeObserver' | 'IntersectionObserver') => {
    const table = window as unknown as Record<string, unknown>;
    const Original = table[name] as new (
      callback: (...args: unknown[]) => void,
      options?: unknown,
    ) => object;
    table[name] = class extends Original {
      constructor(callback: (...args: unknown[]) => void, options?: unknown) {
        changed = true;
        super((...args: unknown[]) => {
          changed = true;
          callback(...args);
        }, options);
      }
    };
    restores.push(() => {
      table[name] = Original;
    });
  };
  observing('ResizeObserver');
  observing('IntersectionObserver');
  const onRender = () => {
    changed = true;
  };
  const renderEvents = ['transitionrun', 'transitionstart', 'animationstart'];
  for (const name of renderEvents) document.addEventListener(name, onRender, { capture: true });
  const animations = new WeakSet<Animation>();
  const animationBegun = () => {
    let begun = false;
    for (const animation of document.getAnimations()) {
      if (animations.has(animation)) continue;
      animations.add(animation);
      begun = true;
    }
    return begun;
  };
  let seen = shape();
  // The focus the sweep starts from settles too.
  let changedAt: number | null = frame;
  // Every stop waits out at least this many rendering steps before it is read,
  // as the per-press sweep did, so what a focus sets off at the next frame has
  // happened (or has shown up as a change, which waits two more).
  const FRAMES_PER_STOP = 1;
  let movedAt = frame;
  const settling = () => {
    if (frame < movedAt + FRAMES_PER_STOP) return true;
    if (changed || shape() !== seen || animationBegun()) {
      changed = false;
      seen = shape();
      changedAt = frame;
    }
    if (changedAt !== null && frame < changedAt + 2) return true;
    changedAt = null;
    return false;
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Tab') return;
    if (log.done || settling()) {
      if (!log.done) log.held += 1;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const stop = readStop();
    if (log.moves > 0) {
      if (stop === null) log.lostAfter = log.last;
      if (stop === null || !stop.inPage) {
        log.done = true;
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (stop.row !== null && !log.rows.includes(stop.row)) log.rows.push(stop.row);
      if (!stop.inView) log.offScreen.push(stop.label);
      log.last = stop.label;
    }
    log.moves += 1;
    movedAt = frame;
  };
  document.addEventListener('keydown', onKey, { capture: true });
  // Ends the sweep: the page is left as it was found, Tab and all.
  host.stopTodaySweep = () => {
    stopped = true;
    document.removeEventListener('keydown', onKey, { capture: true });
    mutations.disconnect();
    for (const name of renderEvents)
      document.removeEventListener(name, onRender, { capture: true });
    for (const restore of restores) restore();
  };

  function readStop() {
    const at = document.activeElement;
    const article = document.querySelector('article[aria-label="Today"]');
    const port = scroller();
    if (at === null || at === document.body || article === null || port === null) return null;
    const box = at.getBoundingClientRect();
    const portBox = port.getBoundingClientRect();
    return {
      inPage: article.contains(at),
      row: at.closest('[data-today-row]')?.getAttribute('data-today-row') ?? null,
      label: at.getAttribute('aria-label') ?? at.textContent?.trim().slice(0, 60) ?? '',
      inView:
        box.height > 0 &&
        box.top >= Math.max(portBox.top, 0) - 1 &&
        box.bottom <= Math.min(portBox.bottom, window.innerHeight) + 1,
    };
  }
}

const readSweep = (page: Page) =>
  page.evaluate(() => (window as unknown as { todaySweep: SweepLog }).todaySweep);

/** Tabs pressed between two reads of the sweep's record. */
const BATCH = 40;

/** Presses `key` until the focus leaves the page, recording every stop. */
export async function sweep(page: Page, key: 'Tab' | 'Shift+Tab', limit: number) {
  await page.evaluate(recordSweep);
  // Option+Tab: WebKit's Tab alone skips buttons and checkboxes, as Safari does
  // until Keyboard navigation is turned on; with it, every control is a stop.
  // Held for the whole sweep, so each stop is one key and not four.
  const held = key === 'Tab' ? ['Alt'] : ['Alt', 'Shift'];
  for (const modifier of held) await page.keyboard.down(modifier);
  let log = await readSweep(page);
  // Refused Tabs (the page settling) count against `limit` too: every stop waits
  // out a frame, a dozen or two Tabs, so forty to a stop leaves room.
  let presses = 0;
  while (!log.done && log.moves < limit && presses < limit * 40) {
    for (let at = 0; at < BATCH; at += 1, presses += 1) await page.keyboard.press('Tab');
    log = await readSweep(page);
  }
  for (const modifier of held.reverse()) await page.keyboard.up(modifier);
  await page.evaluate(() => (window as unknown as { stopTodaySweep: () => void }).stopTodaySweep());
  // Out of presses before the focus left the page: say so, rather than fail
  // later as rows missing, or pass without the last stop read.
  if (!log.done) {
    throw new Error(
      `sweep did not finish: ${log.moves} stops, ${presses} presses, ${log.held} held`,
    );
  }
  return {
    rows: new Set(log.rows),
    offScreen: log.offScreen,
    lostAfter: log.lostAfter,
    last: log.last,
  };
}
