import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ASIDE_COLLAPSES_BELOW,
  ASIDE_COLLAPSES_BELOW_ALONE,
  ASIDE_WIDTH_TYPE,
  SIDEBAR_WIDTH,
  WINDOW_MIN_WIDTH,
  asideCollapsesBelow,
  collapseFor,
} from './collapse.ts';

describe('collapseFor', () => {
  it('keeps the aside where it fits beside the sidebar and the work', () => {
    expect(collapseFor({ width: 1440, sidebarOpen: true })).toEqual({ aside: false });
    expect(collapseFor({ width: ASIDE_COLLAPSES_BELOW, sidebarOpen: true })).toEqual({
      aside: false,
    });
  });

  it('collapses the aside one pixel under that, before anything else', () => {
    expect(collapseFor({ width: ASIDE_COLLAPSES_BELOW - 1, sidebarOpen: true })).toEqual({
      aside: true,
    });
  });

  it('keeps the aside longer when the left sidebar is already hidden by hand', () => {
    expect(collapseFor({ width: ASIDE_COLLAPSES_BELOW - 1, sidebarOpen: false })).toEqual({
      aside: false,
    });
    expect(collapseFor({ width: ASIDE_COLLAPSES_BELOW_ALONE, sidebarOpen: false })).toEqual({
      aside: false,
    });
    expect(collapseFor({ width: ASIDE_COLLAPSES_BELOW_ALONE - 1, sidebarOpen: false })).toEqual({
      aside: true,
    });
  });

  it('folds the 340px type editor 40px sooner, in either state of the left', () => {
    const type = { asideWidth: ASIDE_WIDTH_TYPE };
    expect(asideCollapsesBelow({ sidebarOpen: true, ...type })).toBe(ASIDE_COLLAPSES_BELOW + 40);
    expect(asideCollapsesBelow({ sidebarOpen: false, ...type })).toBe(
      ASIDE_COLLAPSES_BELOW_ALONE + 40,
    );
    expect(collapseFor({ width: ASIDE_COLLAPSES_BELOW, sidebarOpen: true, ...type })).toEqual({
      aside: true,
    });
    expect(collapseFor({ width: ASIDE_COLLAPSES_BELOW + 40, sidebarOpen: true, ...type })).toEqual({
      aside: false,
    });
  });

  it('never folds the left sidebar: the window’s minimum is what the sidebar fits in', () => {
    // #332 holds every bar tidy at 720 with the sidebar open; the aside is
    // long gone by then, in either state of the left.
    expect(ASIDE_COLLAPSES_BELOW_ALONE).toBeGreaterThan(WINDOW_MIN_WIDTH);
    expect(ASIDE_COLLAPSES_BELOW - ASIDE_COLLAPSES_BELOW_ALONE).toBe(SIDEBAR_WIDTH);
  });
});

/**
 * The rule is drawn by shell.css, so the media queries there must break at
 * the same widths and hide the same slot, or the function would say one thing
 * and the window another.
 */
describe('shell.css collapse order', () => {
  const css = readFileSync(
    join(
      import.meta.dirname,
      '..',
      '..',
      '..',
      '..',
      'packages',
      'shell',
      'src',
      'styles',
      'shell.css',
    ),
    'utf8',
  );
  /** Each query: the width it starts at, and the one selector it hides. */
  const queries = [...css.matchAll(/@media \(max-width: (\d+)px\)\s*\{\s*([^{]+?)\s*\{/g)].map(
    (m) => ({ below: Number(m[1]) + 1, hides: m[2]! }),
  );

  it('draws one query per aside width and state of the left, and no others', () => {
    const type = { asideWidth: ASIDE_WIDTH_TYPE };
    expect(queries).toEqual([
      {
        below: asideCollapsesBelow({ sidebarOpen: true, ...type }),
        hides: '.shell:not(.shell--narrow) > .shell__aside:has(> .aside--type)',
      },
      {
        below: ASIDE_COLLAPSES_BELOW,
        hides: '.shell:not(.shell--narrow) > .shell__aside:has(> .aside)',
      },
      {
        below: asideCollapsesBelow({ sidebarOpen: false, ...type }),
        hides: '.shell--narrow > .shell__aside:has(> .aside--type)',
      },
      {
        below: ASIDE_COLLAPSES_BELOW_ALONE,
        hides: '.shell--narrow > .shell__aside:has(> .aside)',
      },
    ]);
  });

  it('hides only a slot holding the right sidebar, never the chat’s slot or the left sidebar', () => {
    for (const { hides } of queries) {
      expect(hides).toMatch(/\.shell__aside:has\(> \.aside(--type)?\)$/);
      expect(hides).not.toContain('.shell__sidebar');
    }
  });
});
