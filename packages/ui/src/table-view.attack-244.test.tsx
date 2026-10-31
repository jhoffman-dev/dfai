// @vitest-environment jsdom
/**
 * Attack on #244 (memoised, virtualised table rows): whatever changes, the
 * rows on screen are the rows a fresh render of the same data draws. And the
 * arrow keys never move the focus on their own, later, for a move that was
 * already overtaken.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { PropertyKind } from '@dfai/domain';
import type { CellEdit } from './cells/cell-editing.ts';
import { TableView, type TableResult, type TableViewProps } from './table-view.tsx';
import { ROW_ESTIMATE } from './grouped-rows.tsx';
import { scrollableSheet } from './testing/scrollable-sheet.ts';

afterEach(cleanup);

/** mulberry32: a seeded RNG, so a failing sequence is replayed exactly. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Model {
  columns: string[];
  rows: unknown[][];
  hidden: string[];
  kinds: Record<string, PropertyKind>;
  selected: string[];
}

const BASE_COLUMNS = ['path', 'title', 'status', 'points', 'due', 'tags', 'owner', 'flag'];

function startModel(count: number): Model {
  return {
    columns: [...BASE_COLUMNS],
    rows: Array.from({ length: count }, (_, at) => [
      `r${at}.md`,
      `Row ${at}`,
      at % 2 === 0 ? 'doing' : 'done',
      at,
      `2026-03-${String((at % 28) + 1).padStart(2, '0')}`,
      ['home', 'work'],
      ['[[Fern]]'],
      at % 3 === 0,
    ]),
    hidden: [],
    kinds: {
      status: 'select',
      points: 'number',
      due: 'date',
      tags: 'multiSelect',
      owner: 'relation',
      flag: 'checkbox',
    },
    selected: [],
  };
}

/** Props as the app hands them over: everything made anew, from the model. */
function propsOf(model: Model): TableViewProps {
  const result: TableResult = {
    columns: [...model.columns],
    rows: model.rows.map((row) => [...row]),
    truncated: false,
    sql: '',
  };
  return {
    result,
    sorts: [],
    error: null,
    schema: { kinds: { ...model.kinds }, labels: {}, noun: 'Row' },
    onOpenNote: () => {},
    onEditCell: () => {},
    onToggleSort: () => {},
    hiddenColumns: [...model.hidden],
    ticks: { isDone: (values) => values['status'] === 'done', onToggle: () => {} },
    selection: {
      selected: new Set(model.selected),
      onToggle: () => {},
      onToggleAll: () => {},
    },
  };
}

/** What a reader sees of the rows: each row's class, its boxes, and its cells' text. */
function seen(root: ParentNode): string[] {
  return [...root.querySelectorAll('tr.table__row')].map((row) => {
    const boxes = [...row.querySelectorAll('input[type="checkbox"]')]
      .map(
        (box) => `${box.getAttribute('aria-label')}=${String((box as HTMLInputElement).checked)}`,
      )
      .join(',');
    const cells = [...row.querySelectorAll('td')].map((cell) => cell.textContent).join('|');
    return `${row.className} [${boxes}] ${cells}`;
  });
}

function col(model: Model, name: string): number {
  return model.columns.indexOf(name);
}

type Step = (model: Model, rng: () => number) => string;

const pick = <T,>(rng: () => number, items: readonly T[]): T =>
  items[Math.floor(rng() * items.length)] as T;

const STEPS: readonly Step[] = [
  (m, rng) => {
    const row = pick(rng, m.rows);
    row[col(m, 'title')] = `Renamed ${Math.floor(rng() * 1000)}`;
    return 'title edited';
  },
  (m, rng) => {
    const row = pick(rng, m.rows);
    const at = col(m, 'points');
    // 1 vs "1": the same text, a different type, then a different number.
    row[at] = typeof row[at] === 'number' ? String(row[at]) : Math.floor(rng() * 50);
    return 'number <-> string';
  },
  (m, rng) => {
    const row = pick(rng, m.rows);
    row[col(m, 'due')] = `2027-01-${String(Math.floor(rng() * 28) + 1).padStart(2, '0')}`;
    return 'date edited';
  },
  (m, rng) => {
    const row = pick(rng, m.rows);
    const at = col(m, 'status');
    row[at] = row[at] === 'done' ? 'doing' : 'done';
    return 'select / done toggled';
  },
  (m, rng) => {
    const row = pick(rng, m.rows);
    const at = col(m, 'tags');
    row[at] = [...(row[at] as string[])].reverse();
    return 'multi-select reordered';
  },
  (m, rng) => {
    const row = pick(rng, m.rows);
    const at = col(m, 'owner');
    const links = row[at] as string[];
    row[at] = links.length > 1 ? links.slice(0, 1) : [...links, '[[Moss]]'];
    return 'relation added / removed';
  },
  (m, rng) => {
    const row = pick(rng, m.rows);
    const at = col(m, 'flag');
    row[at] = row[at] !== true;
    return 'checkbox toggled';
  },
  (m, rng) => {
    const column = pick(rng, ['points', 'due', 'tags', 'owner']);
    m.hidden = m.hidden.includes(column)
      ? m.hidden.filter((each) => each !== column)
      : [...m.hidden, column];
    return 'column hidden / shown';
  },
  (m) => {
    // Columns reordered: points and due swap places, in every row.
    const a = col(m, 'points');
    const b = col(m, 'due');
    [m.columns[a], m.columns[b]] = [m.columns[b] as string, m.columns[a] as string];
    for (const row of m.rows) [row[a], row[b]] = [row[b], row[a]];
    return 'columns reordered';
  },
  (m) => {
    m.rows.reverse();
    return 'sort reversed';
  },
  (m) => {
    m.kinds = { ...m.kinds, status: m.kinds['status'] === 'select' ? 'text' : 'select' };
    return 'kind changed';
  },
  (m, rng) => {
    const path = String(pick(rng, m.rows)[0]);
    m.selected = m.selected.includes(path)
      ? m.selected.filter((each) => each !== path)
      : [...m.selected, path];
    return 'selection toggled';
  },
  (m) => {
    // A column added at the end, then the same name holding a value in every row.
    if (m.columns.includes('extra')) {
      const at = col(m, 'extra');
      m.columns.splice(at, 1);
      for (const row of m.rows) row.splice(at, 1);
      return 'column removed';
    }
    m.columns.push('extra');
    for (const [at, row] of m.rows.entries()) row.push(`x${at}`);
    return 'column added';
  },
];

describe('TableView (#244) — memoised rows never go stale', () => {
  for (const seed of [1, 2, 3, 42, 2026]) {
    // Under 0.5 s on a Mac, up to 4.0 s on a loaded 4-core CI runner (#648): the default 5 s is too close.
    it(`after every random change, the rows equal a fresh render of the same data (seed ${seed})`, () => {
      const rng = seeded(seed);
      const model = startModel(8);
      const live = render(<TableView {...propsOf(model)} />);
      for (let step = 0; step < 60; step += 1) {
        const what = pick(rng, STEPS)(model, rng);
        live.rerender(<TableView {...propsOf(model)} />);
        const fresh = render(<TableView {...propsOf(model)} />);
        expect(seen(live.container), `step ${step}: ${what}`).toEqual(seen(fresh.container));
        fresh.unmount();
      }
    }, 15_000);
  }

  it('shows "1" after 1 when a cell becomes the string of the same number, and 2 after that', () => {
    const model = startModel(2);
    const view = render(<TableView {...propsOf(model)} />);
    const at = col(model, 'points');
    (model.rows[1] as unknown[])[at] = '1';
    view.rerender(<TableView {...propsOf(model)} />);
    (model.rows[1] as unknown[])[at] = 2;
    view.rerender(<TableView {...propsOf(model)} />);
    expect(seen(view.container)[1]).toContain('|2|');
  });
});

describe('TableView (#244) — the arrow keys in a long, virtualised table', () => {
  const { sheetOf, scrollSheet } = scrollableSheet();

  /** The highest row index drawn now. */
  function lastDrawn(): number {
    const drawn = [...document.querySelectorAll('tr.table__row')].map((row) =>
      Number(row.getAttribute('data-index')),
    );
    return Math.max(...drawn);
  }

  it('a move to an undrawn row that a later move overtook does not steal the focus when that row is drawn', () => {
    const model = startModel(300);
    render(<TableView {...propsOf(model)} />);
    const sheet = sheetOf();
    const first = screen.getByRole('button', { name: 'Row 0' });
    first.focus();

    // End asks for row 299, not drawn yet; before its scroll lands, Home
    // brings the focus back to row 0, which is drawn.
    fireEvent.keyDown(first, { key: 'End' });
    fireEvent.keyDown(document.activeElement as Element, { key: 'Home' });
    expect(document.activeElement).toBe(first);

    // The reader now scrolls to the bottom by hand, with the focus left on row 0.
    scrollSheet(sheet, 300 * ROW_ESTIMATE);

    expect(document.querySelector('tr[data-index="299"]')).not.toBeNull();
    // Home was the last key: the focus must not jump to row 299 by itself.
    const focusedRow = document.activeElement?.closest('tr')?.getAttribute('data-index');
    expect(focusedRow).not.toBe('299');
  });

  it('a focus move left pending does not later yank the focus out of a cell being edited', () => {
    const model = startModel(300);
    render(<TableView {...propsOf(model)} />);
    const sheet = sheetOf();
    const edge = lastDrawn();
    const last = screen.getByRole('button', { name: `Row ${edge}` });
    last.focus();
    // Down asks for the next row, not yet drawn; the reader clicks a cell to edit instead.
    fireEvent.keyDown(last, { key: 'ArrowDown' });
    const cell = screen.getAllByRole('button', { name: /2026-03-0/ })[0] as HTMLElement;
    fireEvent.click(cell);
    const input = document.querySelector('.table__input') as HTMLInputElement;
    expect(document.activeElement).toBe(input);

    // Any redraw that brings that row in — a little scroll — must leave the edit alone.
    // A few rows: enough to draw the next line, not so far that the edited row leaves the page.
    scrollSheet(sheet, 4 * ROW_ESTIMATE);
    expect(document.querySelector(`tr[data-index="${edge + 1}"]`)).not.toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it('a move left pending is dropped once the focus leaves its row for anywhere else', () => {
    const model = startModel(300);
    render(<TableView {...propsOf(model)} />);
    const edge = lastDrawn();
    const last = screen.getByRole('button', { name: `Row ${edge}` });
    last.focus();
    fireEvent.keyDown(last, { key: 'End' });
    // A click on nothing in particular, or the window's focus moved on: the row keeps its place.
    last.blur();
    expect(document.activeElement).toBe(document.body);

    scrollSheet(sheetOf(), 300 * ROW_ESTIMATE);
    expect(document.querySelector('tr[data-index="299"]')).not.toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it('a row edited while scrolled out of the page shows the edit when scrolled back', () => {
    const model = startModel(300);
    const view = render(<TableView {...propsOf(model)} />);
    const sheet = sheetOf();
    scrollSheet(sheet, 250 * ROW_ESTIMATE);
    expect(document.querySelector('tr[data-index="0"]')).toBeNull();
    (model.rows[0] as unknown[])[col(model, 'title')] = 'Row zero, renamed';
    view.rerender(<TableView {...propsOf(model)} />);
    scrollSheet(sheet, 0);
    expect(screen.getByRole('button', { name: 'Row zero, renamed' })).toBeDefined();
  });

  it('every row chosen by select-all shows its box ticked once scrolled into the page', () => {
    const model = startModel(300);
    const view = render(<TableView {...propsOf(model)} />);
    model.selected = model.rows.map((row) => String(row[0]));
    view.rerender(<TableView {...propsOf(model)} />);
    scrollSheet(sheetOf(), 280 * ROW_ESTIMATE);
    const box = screen.getByRole('checkbox', { name: 'Select Row 290' }) as HTMLInputElement;
    expect(box.checked).toBe(true);
  });

  it('a cell being edited when its row is scrolled out of the page keeps what was typed, and shows it again once scrolled back', () => {
    const model = startModel(300);
    const edits: CellEdit[] = [];
    render(<TableView {...propsOf(model)} onEditCell={(edit) => edits.push(edit)} />);
    const sheet = sheetOf();
    fireEvent.click(screen.getAllByRole('button', { name: '2026-03-01' })[0] as HTMLElement);
    const input = document.querySelector('.table__input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '2026-04-01' } });
    scrollSheet(sheet, 250 * ROW_ESTIMATE);
    expect(document.querySelector('tr[data-index="0"]')).toBeNull();
    expect(document.querySelector('.table__input')).toBeNull();
    // Nothing is written for an edit still in progress.
    expect(edits).toEqual([]);

    scrollSheet(sheet, 0);
    const back = document.querySelector('tr[data-index="0"] .table__input') as HTMLInputElement;
    expect(back.value).toBe('2026-04-01');
    fireEvent.keyDown(back, { key: 'Enter' });
    expect(edits).toEqual([
      { path: 'r0.md', column: 'due', value: '2026-04-01', began: { value: '2026-03-01' } },
    ]);
  });

  it('a draft left in a row scrolled out is written once when another cell is opened', () => {
    const model = startModel(300);
    const edits: CellEdit[] = [];
    render(<TableView {...propsOf(model)} onEditCell={(edit) => edits.push(edit)} />);
    const sheet = sheetOf();
    fireEvent.click(screen.getAllByRole('button', { name: '2026-03-01' })[0] as HTMLElement);
    fireEvent.change(document.querySelector('.table__input') as HTMLInputElement, {
      target: { value: '2026-04-01' },
    });
    scrollSheet(sheet, 250 * ROW_ESTIMATE);
    expect(document.querySelector('tr[data-index="0"]')).toBeNull();

    const drawn = document.querySelector('tr[data-index] [data-cell-stop="due"]') as HTMLElement;
    // The cell's button gives way to the field, so its line is read before the click.
    const line = drawn.closest('tr');
    fireEvent.click(drawn);
    expect(edits).toEqual([
      { path: 'r0.md', column: 'due', value: '2026-04-01', began: { value: '2026-03-01' } },
    ]);
    const opened = document.querySelector('.table__input') as HTMLInputElement;
    expect(opened.closest('tr')).toBe(line);
    expect(document.activeElement).toBe(opened);
  });

  it('a field drawn again when its row scrolls back does not take the focus from elsewhere', () => {
    const model = startModel(300);
    const view = render(
      <>
        <input aria-label="Search" />
        <TableView {...propsOf(model)} onEditCell={() => {}} />
      </>,
    );
    const sheet = sheetOf();
    fireEvent.click(screen.getAllByRole('button', { name: '2026-03-01' })[0] as HTMLElement);
    fireEvent.change(document.querySelector('.table__input') as HTMLInputElement, {
      target: { value: '2026-04-01' },
    });
    scrollSheet(sheet, 250 * ROW_ESTIMATE);
    const search = screen.getByRole('textbox', { name: 'Search' });
    search.focus();

    scrollSheet(sheet, 0);
    const back = document.querySelector('tr[data-index="0"] .table__input') as HTMLInputElement;
    expect(back.value).toBe('2026-04-01');
    expect(document.activeElement).toBe(search);
    view.unmount();
  });
});
