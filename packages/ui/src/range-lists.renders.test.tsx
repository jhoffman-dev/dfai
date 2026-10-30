// @vitest-environment jsdom
/**
 * The virtualised lists draw by range (#238): a scroll that keeps the same
 * rows drawn draws none of the list again — `useVirtualizer` drew it twice,
 * as the scroll started and as it settled — and a scroll that brings rows in
 * draws them. One case per list on `useRangeVirtualizer`: the table's flat
 * and grouped rows, the Inbox and Today (through `useVirtualRows`), and the
 * PDF reader's page pictures.
 *
 * jsdom lays nothing out: `vitest.setup.ts` measures every element 800px
 * tall, and the table's sheet is given its own layout by `scrollableSheet`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import {
  createVaultPath,
  groupResultRows,
  parseObjectType,
  todayLists,
  toBoardRows,
  viewGroupLevels,
  type InboxItem,
  type ReviewTask,
} from '@dfai/domain';
import type { TodayReport } from '@dfai/application';
import { TableView, type TableResult } from './table-view.tsx';
import { ROW_ESTIMATE } from './grouped-rows.tsx';
import { InboxPage } from './inbox-page.tsx';
import { TodayPage } from './today-page.tsx';
import { ReaderSidebar } from './reader/reader-sidebar.tsx';
import type { ReaderDocument } from './reader/reader-types.ts';
import { startCountingRenders, stopCountingRenders } from './testing/render-counter.ts';
import { scrollableSheet } from './testing/scrollable-sheet.ts';

// Before React loads, so every commit is handed to the counter.
await vi.hoisted(async () => {
  const { installRenderCounter } = await import('./testing/render-counter.ts');
  installRenderCounter();
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Scrolls `scroller` to `top`, then lets the scroll settle as it would. */
function scrollTo(scroller: HTMLElement, top: number) {
  Object.defineProperty(scroller, 'scrollTop', { configurable: true, writable: true, value: top });
  act(() => {
    fireEvent.scroll(scroller);
  });
  act(() => vi.advanceTimersByTime(500));
}

/** How many times `component` rendered while `act` ran. */
function rendersOf(component: string, act: () => void): number {
  startCountingRenders();
  act();
  return stopCountingRenders().renders[component] ?? 0;
}

/**
 * The furthest row drawn, by the number in its name, short of the list's
 * last row, which stays drawn for the keyboard to reach.
 */
function furthestBeforeLast(rows: readonly HTMLElement[], numbered: RegExp, last: number): number {
  const numbers = rows.map((row) =>
    Number(numbered.exec(row.getAttribute('aria-label') ?? row.textContent ?? '')?.[1]),
  );
  return Math.max(-1, ...numbers.filter((at) => at !== last));
}

const scrollerOf = (selector: string): HTMLElement => {
  const scroller = document.querySelector<HTMLElement>(selector);
  if (scroller === null) throw new Error(`no ${selector}`);
  return scroller;
};

describe('a table’s rows — what a scroll draws', () => {
  const { sheetOf, scrollSheet } = scrollableSheet();
  const ROWS = 300;
  const result: TableResult = {
    columns: ['path', 'title', 'status'],
    rows: Array.from({ length: ROWS }, (_, at) => [
      `r${at}.md`,
      `Row ${at}`,
      at < ROWS / 2 ? 'backlog' : 'doing',
    ]),
    truncated: false,
    sql: '',
  };
  const TASK = parseObjectType({
    name: 'task',
    properties: { status: { kind: 'select', options: ['backlog', 'doing'] } },
  });
  const groups = groupResultRows({
    rows: toBoardRows(result),
    groups: viewGroupLevels({ type: TASK, groupBy: 'status', subGroupBy: null, sorts: [] }),
  });

  function Table({ grouped }: { grouped: boolean }) {
    return (
      <TableView
        result={result}
        sorts={[]}
        error={null}
        schema={{ kinds: { status: 'select' }, labels: {}, noun: 'task' }}
        onOpenNote={() => {}}
        onEditCell={() => {}}
        onToggleSort={() => {}}
        {...(grouped && {
          grouping: { groups, collapsed: new Set(), onToggle: () => {}, onNew: () => {} },
        })}
      />
    );
  }

  /** Scrolls the sheet and lets it settle. */
  function scrollSheetTo(top: number) {
    act(() => scrollSheet(sheetOf(), top));
    act(() => vi.advanceTimersByTime(500));
  }

  for (const [label, grouped, holder] of [
    ['flat', false, 'FlatRows'],
    ['grouped', true, 'GroupedRows'],
  ] as const) {
    it(`draws none of the ${label} rows again for a scroll that keeps the same rows`, () => {
      render(<Table grouped={grouped} />);
      const drawn = screen.getAllByRole('button', { name: /^Row \d+$/ }).length;
      expect(drawn).toBeGreaterThan(0);
      expect(rendersOf(holder, () => scrollSheetTo(4))).toBe(0);
      expect(screen.getAllByRole('button', { name: /^Row \d+$/ })).toHaveLength(drawn);
    });

    it(`draws the ${label} rows a long scroll brings in`, () => {
      render(<Table grouped={grouped} />);
      expect(screen.queryByRole('button', { name: 'Row 200' })).toBeNull();
      scrollSheetTo(200 * ROW_ESTIMATE);
      expect(screen.getByRole('button', { name: 'Row 200' })).toBeTruthy();
    });
  }
});

describe('the Inbox’s rows — what a scroll draws', () => {
  const note = (at: number): InboxItem => ({
    path: createVaultPath(`Inbox/Note ${at}.md`),
    title: `Note ${at}`,
    type: 'meeting',
    arrivedIn: '',
    importOutcome: null,
    importError: null,
    task: null,
  });
  const items = Array.from({ length: 500 }, (_, at) => note(at));
  const page = () => (
    <InboxPage
      contents={{ items, truncated: false, total: items.length }}
      error={null}
      filing={[]}
      people={[]}
      onOpen={() => {}}
      onShowMore={() => {}}
      onClarify={async () => true}
      busy={false}
      problem={null}
    />
  );

  it('draws no row again for a scroll that keeps the same rows', () => {
    render(page());
    // Off the top first: the scroll counted then crosses no row's edge.
    scrollTo(scrollerOf('.panel__body'), 100);
    expect(rendersOf('InboxRows', () => scrollTo(scrollerOf('.panel__body'), 110))).toBe(0);
  });

  it('draws the rows a long scroll brings in', () => {
    render(page());
    const notes = () => screen.getAllByRole('button', { name: /^Note \d+$/ });
    expect(furthestBeforeLast(notes(), /^Note (\d+)$/, 499)).toBeLessThan(50);
    scrollTo(scrollerOf('.panel__body'), 50_000);
    expect(furthestBeforeLast(notes(), /^Note (\d+)$/, 499)).toBeGreaterThan(100);
  });
});

describe('Today’s rows — what a scroll draws', () => {
  const TODAY = '2026-10-13';
  const NOW = Date.UTC(2026, 9, 13, 15);
  const name = (at: number) => `Task ${String(at).padStart(3, '0')}`;
  const task = (at: number): ReviewTask => ({
    path: createVaultPath(`Tasks/${name(at)}.md`),
    title: name(at),
    status: 'next-action',
    due: null,
    defer: null,
    waitingOn: '',
    contexts: [],
    project: null,
    projectTitle: null,
    modified: NOW,
  });
  const today: TodayReport = {
    ...todayLists({
      tasks: Array.from({ length: 500 }, (_, at) => task(at)),
      projects: [],
      at: { today: TODAY, now: NOW },
    }),
    today: TODAY,
    choosing: true,
    inbox: { count: 0, toFile: 0, toAnswer: 0, more: false },
    truncated: false,
    stalledProjects: 0,
  };
  const page = () => (
    <TodayPage
      today={today}
      error={null}
      busy={false}
      problem={null}
      view={null}
      onOpen={() => {}}
      onOpenInbox={() => {}}
      onOpenReview={() => {}}
      onOpenDailyNote={() => {}}
      onDone={() => {}}
      onSetStatus={() => {}}
      onDefer={() => {}}
      onChoose={() => {}}
    />
  );
  const ticks = () => screen.getAllByRole('checkbox', { name: /^Mark Task \d+ done$/ });

  it('draws neither the groups nor the rows again for a scroll that keeps the same rows', () => {
    render(page());
    // Off the top first: the scroll counted then crosses no row's edge.
    scrollTo(scrollerOf('.panel__body'), 100);
    const drawn = ticks().length;
    startCountingRenders();
    scrollTo(scrollerOf('.panel__body'), 110);
    const { renders } = stopCountingRenders();
    expect(renders['SectionGroups'] ?? 0).toBe(0);
    expect(renders['Group'] ?? 0).toBe(0);
    expect(ticks()).toHaveLength(drawn);
  });

  it('draws the rows a long scroll brings in', () => {
    render(page());
    const numbered = /^Mark Task (\d+) done$/;
    expect(furthestBeforeLast(ticks(), numbered, 499)).toBeLessThan(50);
    scrollTo(scrollerOf('.panel__body'), 50_000);
    expect(furthestBeforeLast(ticks(), numbered, 499)).toBeGreaterThan(100);
  });
});

describe('the PDF reader’s page pictures — what a scroll draws', () => {
  const pdf: ReaderDocument = {
    pageCount: 500,
    pageSize: async () => ({ width: 612, height: 792 }),
    pageText: async () => ({ items: [] }) as never,
    drawPage: () => ({ done: Promise.resolve(), cancel: () => {} }),
  };
  const sidebar = () => (
    <ReaderSidebar
      pdf={pdf}
      outline={[]}
      estimate={{ width: 612, height: 792 }}
      tab="pages"
      currentPage={1}
      onTab={() => {}}
      onGoTo={() => {}}
    />
  );
  const pictures = () =>
    within(screen.getByRole('navigation')).getAllByRole('button', { name: /^Go to page/ });

  it('draws no picture again for a scroll that keeps the same pages', () => {
    render(sidebar());
    const drawn = pictures().length;
    expect(drawn).toBeGreaterThan(0);
    expect(rendersOf('Thumbnails', () => scrollTo(scrollerOf('.pdf-thumbs'), 10))).toBe(0);
    expect(pictures()).toHaveLength(drawn);
  });

  it('draws the pictures a long scroll brings in', () => {
    render(sidebar());
    expect(screen.queryByRole('button', { name: 'Go to page 250' })).toBeNull();
    scrollTo(scrollerOf('.pdf-thumbs'), 250 * 172);
    expect(screen.getByRole('button', { name: 'Go to page 250' })).toBeTruthy();
  });
});
