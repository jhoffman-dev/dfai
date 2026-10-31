import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEAST_WORK_WIDTH, SIDEBAR_WIDTH, collapseFor } from './collapse.ts';

const styles = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'shell',
  'src',
  'styles',
);
const read = (file: string) => readFileSync(join(styles, file), 'utf8');

describe('collapseFor at every boundary (attack #353)', () => {
  it.each([
    [1020, true, false],
    [1019, true, true],
    [1020, false, false],
    [1019, false, false],
    [796, false, false],
    [795, false, true],
    [796, true, true],
    [795, true, true],
    [720, true, true],
    [720, false, true],
  ] as const)(
    'at %ipx with the sidebar open=%s, collapses the aside: %s',
    (width, sidebarOpen, aside) => {
      expect(collapseFor({ width, sidebarOpen })).toEqual({ aside });
    },
  );

  it('answers only for the aside: there is no left-sidebar fold to read', () => {
    expect(Object.keys(collapseFor({ width: 0, sidebarOpen: true }))).toEqual(['aside']);
  });
});

/**
 * Every width the slot can take (aside.css: 300px, and 340px for the type
 * editor's `.aside--type`), held against the narrowest window shell.css still
 * shows that aside in: the work beside it must keep its least width. Each
 * width has its own pair of queries (sidebar open, sidebar hidden), told apart
 * by the selector each hides — a `.aside--type` query is the 340px one.
 */
describe('shell.css keeps the work at its least width beside every aside (attack #353)', () => {
  const shell = read('shell.css');
  const aside = read('aside.css');
  const slotWidths = [...aside.matchAll(/--aside-width:\s*(\d+)px/g)].map((m) => Number(m[1]));
  const queries = [...shell.matchAll(/@media \(max-width: (\d+)px\)\s*\{\s*([^{]+?)\s*\{/g)].map(
    (m) => ({ breakpoint: Number(m[1]), selector: m[2]!, type: m[2]!.includes('.aside--type') }),
  );
  const breakpointsFor = (slot: number) =>
    queries.filter((q) => q.type === (slot === 340)).map((q) => q.breakpoint);

  it('reads both slot widths and a pair of breakpoints for each', () => {
    expect(slotWidths).toEqual([300, 340]);
    expect(breakpointsFor(300)).toHaveLength(2);
    expect(breakpointsFor(340)).toHaveLength(2);
  });

  /** The one query for this slot width with the left sidebar open (not `.shell--narrow`) or hidden. */
  const breakpointFor = (slot: number, sidebar: 'open' | 'hidden') => {
    const [query, ...more] = queries.filter(
      (q) =>
        q.type === (slot === 340) &&
        q.selector.startsWith('.shell--narrow') === (sidebar === 'hidden'),
    );
    expect(more).toEqual([]);
    return query!.breakpoint;
  };

  it.each([300, 340])(
    'a %ipx aside never squeezes the work under its least, sidebar open',
    (slot) => {
      // The narrowest window that still draws this aside with the left sidebar open.
      const narrowest = breakpointFor(slot, 'open') + 1;
      expect(narrowest - SIDEBAR_WIDTH - slot).toBeGreaterThanOrEqual(LEAST_WORK_WIDTH);
    },
  );

  it.each([300, 340])(
    'a %ipx aside never squeezes the work under its least, sidebar hidden',
    (slot) => {
      const narrowest = breakpointFor(slot, 'hidden') + 1;
      expect(narrowest - slot).toBeGreaterThanOrEqual(LEAST_WORK_WIDTH);
    },
  );
});

// Known from review: the collapse queries hide today's chat slot too. Pinned here.
describe('shell.css collapse spares the chat until 8b moves it (attack #353)', () => {
  it('scopes every collapse query to a slot holding the right sidebar', () => {
    const shell = read('shell.css');
    const selectors = [...shell.matchAll(/@media \(max-width: \d+px\)\s*\{([^}]*)\{/g)].map((m) =>
      m[1]!.trim(),
    );
    expect(selectors).toHaveLength(4);
    for (const selector of selectors) expect(selector).toMatch(/:has\(> \.aside(--type)?\)$/);
  });
});
