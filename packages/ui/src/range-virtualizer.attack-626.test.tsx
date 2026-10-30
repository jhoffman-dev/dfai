// @vitest-environment jsdom
/**
 * Attack on PR #626 (#169): `useRangeVirtualizer` beside the library's own
 * `useVirtualizer`, driven by the same seeded sequence of count changes,
 * scrolls, resizes, scrollToIndex calls, held rows and a scroller swapped
 * for another. After every step both must draw the same rows at the same
 * places, and the wrapper must never have drawn more often than the library.
 */
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import {
  defaultRangeExtractor,
  useVirtualizer,
  type Range,
  type Rect,
  type Virtualizer,
} from '@tanstack/react-virtual';
import { useRangeVirtualizer } from './range-virtualizer.ts';

const ROW = 20;

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Two scrollers whose size and place the test sets; each hook's observers report them. */
function scrollers() {
  const elements = [document.createElement('div'), document.createElement('div')] as const;
  const rects = new Map<Element, Rect>(elements.map((el) => [el, { width: 200, height: 90 }]));
  const offsets = new Map<Element, number>(elements.map((el) => [el, 0]));
  type Listener = {
    el: Element;
    rect: (rect: Rect) => void;
    offset: (o: number, s: boolean) => void;
  };
  /** Live listeners by hook: 'wrapper' or 'library'. */
  const listeners = { wrapper: [] as Listener[], library: [] as Listener[] };
  const optionsFor = (who: 'wrapper' | 'library') => {
    return {
      observeElementRect: (
        instance: Virtualizer<HTMLElement, Element>,
        cb: (rect: Rect) => void,
      ) => {
        const el = instance.scrollElement as Element;
        const entry = { el, rect: cb, offset: () => {} } as Listener;
        listeners[who].push(entry);
        cb(rects.get(el) ?? { width: 0, height: 0 });
        return () => {
          listeners[who] = listeners[who].filter((each) => each !== entry);
        };
      },
      observeElementOffset: (
        instance: Virtualizer<HTMLElement, Element>,
        cb: (offset: number, isScrolling: boolean) => void,
      ) => {
        const el = instance.scrollElement as Element;
        const entry = { el, rect: () => {}, offset: cb } as Listener;
        listeners[who].push(entry);
        return () => {
          listeners[who] = listeners[who].filter((each) => each !== entry);
        };
      },
      scrollToFn: (offset: number) => {
        pending[who] = offset;
      },
    };
  };
  const pending: { wrapper: number | null; library: number | null } = {
    wrapper: null,
    library: null,
  };
  const resize = (el: Element, rect: Rect) => {
    rects.set(el, rect);
    for (const who of ['wrapper', 'library'] as const) {
      for (const each of listeners[who]) if (each.el === el) each.rect(rect);
    }
  };
  const scroll = (el: Element, offset: number, isScrolling: boolean) => {
    offsets.set(el, offset);
    for (const who of ['wrapper', 'library'] as const) {
      for (const each of listeners[who]) if (each.el === el) each.offset(offset, isScrolling);
    }
  };
  /** The scroll events a scrollToIndex asked for, arriving at each scroller. */
  const deliverScrollTo = (el: Element) => {
    for (const who of ['wrapper', 'library'] as const) {
      const offset = pending[who];
      pending[who] = null;
      if (offset === null) continue;
      for (const each of listeners[who]) if (each.el === el) each.offset(offset, true);
    }
  };
  return { elements, optionsFor, resize, scroll, deliverScrollTo, pending };
}

interface Shared {
  count: number;
  which: 0 | 1;
  held: number;
  scrollMargin: number;
}

const withIndex = (indexes: number[], index: number) =>
  index < 0 || indexes.includes(index) ? indexes : [...indexes, index].sort((a, b) => a - b);

/** One list: draws its rows as vault-tree does, and counts its renders. */
function makeList(useHook: typeof useRangeVirtualizer | typeof useVirtualizer, who: string) {
  return function List({
    shared,
    els,
    extra,
    renders,
    expose,
  }: {
    shared: Shared;
    els: readonly Element[];
    extra: object;
    renders: { count: number };
    expose: (instance: Virtualizer<HTMLElement, Element>) => void;
  }) {
    const virtualizer = (useHook as typeof useRangeVirtualizer)({
      count: shared.count,
      getScrollElement: () => els[shared.which] as HTMLElement,
      estimateSize: () => ROW,
      overscan: 3,
      scrollMargin: shared.scrollMargin,
      // As vault-tree's held row: always one of the rows there are.
      rangeExtractor: (range: Range) =>
        withIndex(defaultRangeExtractor(range), shared.held < shared.count ? shared.held : -1),
      ...extra,
    });
    renders.count += 1;
    expose(virtualizer);
    return (
      <div data-list={who} style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => (
          <div key={item.key} data-index={item.index} data-top={item.start - shared.scrollMargin} />
        ))}
      </div>
    );
  };
}

const WrapperList = makeList(useRangeVirtualizer, 'wrapper');
const LibraryList = makeList(useVirtualizer, 'library');

const drawn = (who: string) => {
  const list = document.querySelector(`[data-list="${who}"]`);
  if (list === null) return 'gone';
  const rows = [...list.querySelectorAll('[data-index]')]
    .map((row) => `${row.getAttribute('data-index')}@${row.getAttribute('data-top')}`)
    .join(',');
  return `${(list as HTMLElement).style.height}|${rows}`;
};

function harness(strict: boolean) {
  const scroll = scrollers();
  const renders = { wrapper: { count: 0 }, library: { count: 0 } };
  const instances: {
    wrapper?: Virtualizer<HTMLElement, Element>;
    library?: Virtualizer<HTMLElement, Element>;
  } = {};
  let setShared: (change: (was: Shared) => Shared) => void = () => {};
  function Both() {
    const [shared, set] = useState<Shared>({ count: 200, which: 0, held: -1, scrollMargin: 0 });
    setShared = set;
    return (
      <>
        <WrapperList
          shared={shared}
          els={scroll.elements}
          extra={scroll.optionsFor('wrapper')}
          renders={renders.wrapper}
          expose={(instance) => {
            instances.wrapper = instance;
          }}
        />
        <LibraryList
          shared={shared}
          els={scroll.elements}
          extra={scroll.optionsFor('library')}
          renders={renders.library}
          expose={(instance) => {
            instances.library = instance;
          }}
        />
      </>
    );
  }
  // Mounted twice as main.tsx mounts the app: a <StrictMode> in the tree does not run
  // effects twice under React 19, the option does (#159).
  const view = render(<Both />, { reactStrictMode: strict });
  let shared: Shared = { count: 200, which: 0, held: -1, scrollMargin: 0 };
  const update = (change: Partial<Shared>) => {
    shared = { ...shared, ...change };
    act(() => setShared((was) => ({ ...was, ...change })));
  };
  return { ...view, scroll, renders, instances, update, current: () => shared };
}

type Op = (h: ReturnType<typeof harness>, random: () => number) => string;
const OPS: Op[] = [
  (h, r) => {
    const count = Math.floor(r() * 400);
    h.update({ count });
    return `count ${count}`;
  },
  (h, r) => {
    const el = h.scroll.elements[h.current().which];
    const offset = Math.floor(r() * 9000);
    const moving = r() < 0.7;
    act(() => h.scroll.scroll(el, offset, moving));
    return `scroll ${offset} ${moving}`;
  },
  (h, r) => {
    const el = h.scroll.elements[h.current().which];
    const offset = Math.floor(r() * 5);
    act(() => h.scroll.scroll(el, offset, false));
    return `nudge ${offset}`;
  },
  (h, r) => {
    const which = (r() < 0.5 ? 0 : 1) as 0 | 1;
    const height = 20 + Math.floor(r() * 900);
    act(() => h.scroll.resize(h.scroll.elements[which], { width: 200, height }));
    return `resize ${which} ${height}`;
  },
  (h, r) => {
    const index = Math.floor(r() * Math.max(1, h.current().count));
    act(() => {
      h.instances.wrapper?.scrollToIndex(index);
      h.instances.library?.scrollToIndex(index);
    });
    act(() => h.scroll.deliverScrollTo(h.scroll.elements[h.current().which]));
    return `scrollToIndex ${index}`;
  },
  (h) => {
    const which = h.current().which === 0 ? 1 : 0;
    h.update({ which });
    return `scroller ${which}`;
  },
  (h, r) => {
    const held = r() < 0.3 ? -1 : Math.floor(r() * Math.max(1, h.current().count));
    h.update({ held });
    return `held ${held}`;
  },
  (h, r) => {
    const scrollMargin = Math.floor(r() * 4) * 40;
    h.update({ scrollMargin });
    return `margin ${scrollMargin}`;
  },
  () => {
    act(() => vi.advanceTimersByTime(200));
    return 'settle';
  },
];

function walk(seed: number, steps: number, strict: boolean): string | null {
  const random = mulberry32(seed);
  const h = harness(strict);
  const trail: string[] = [];
  try {
    for (let step = 0; step < steps; step += 1) {
      const op = OPS[Math.floor(random() * OPS.length)] as Op;
      trail.push(op(h, random));
      const left = drawn('wrapper');
      const right = drawn('library');
      if (left !== right) {
        return `rows differ after ${trail.slice(-3).join('; ')}:\n wrapper ${left}\n library ${right}`;
      }
      if (h.renders.wrapper.count > h.renders.library.count) {
        return `wrapper drew ${h.renders.wrapper.count} > library ${h.renders.library.count} after ${trail.slice(-3).join('; ')}`;
      }
    }
    return null;
  } finally {
    h.unmount();
  }
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useRangeVirtualizer against useVirtualizer, seeded (#626 attack)', () => {
  it('draws the rows the library draws, and never more often, over 150 walks', () => {
    vi.useFakeTimers();
    const broken: string[] = [];
    for (let seed = 1; seed <= 150; seed += 1) {
      const found = walk(seed, 40, false);
      if (found !== null) broken.push(`seed ${seed}: ${found}`);
    }
    expect(broken.slice(0, 3)).toEqual([]);
  }, 60_000);

  it('draws the rows the library draws under StrictMode, over 60 walks', () => {
    vi.useFakeTimers();
    const broken: string[] = [];
    for (let seed = 1000; seed < 1060; seed += 1) {
      const found = walk(seed, 30, true);
      if (found !== null) broken.push(`seed ${seed}: ${found}`);
    }
    expect(broken.slice(0, 3)).toEqual([]);
  }, 60_000);

  it('says nothing to the console when unmounted in the middle of a scroll', () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness(false);
    act(() => h.scroll.scroll(h.scroll.elements[0], 3000, true));
    h.unmount();
    act(() => vi.advanceTimersByTime(1000));
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
