// @vitest-environment jsdom
/**
 * The Inbox with hundreds waiting (#238): only the rows near what the page
 * shows are in the DOM, every row can still be reached from the keyboard
 * (#167), and the row focus is in outlasts a read of the Inbox.
 *
 * jsdom lays nothing out: `vitest.setup.ts` measures every element 800px
 * tall in an 800px window, so the list places its first row and its overscan.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createVaultPath, type InboxItem } from '@dfai/domain';
import { InboxPage, type InboxPageProps } from '../inbox-page.tsx';
import { startCountingRenders, stopCountingRenders } from '../testing/render-counter.ts';

// Before React loads, so every commit is handed to the counter.
await vi.hoisted(async () => {
  const { installRenderCounter } = await import('../testing/render-counter.ts');
  installRenderCounter();
});

const note = (title: string): InboxItem => ({
  path: createVaultPath(`Inbox/${title}.md`),
  title,
  type: 'meeting',
  arrivedIn: '',
  importOutcome: null,
  importError: null,
  task: null,
});
const notes = (count: number, prefix = 'Note') =>
  Array.from({ length: count }, (_, at) => note(`${prefix} ${at}`));
const task = (title: string): InboxItem => ({
  ...note(title),
  type: 'task',
  task: {
    status: 'inbox',
    project: null,
    waitingOn: null,
    waitingOnNames: '',
    defer: null,
    due: null,
  },
});
// Kept the same lists while they say the same, as the app keeps them.
const FILING = [{ path: 'Projects/DFAI.md', title: 'DFAI' }];
const PEOPLE = [{ path: 'People/Mara Quill.md', title: 'Mara Quill' }];

function given(
  items: readonly InboxItem[],
  onClarify: InboxPageProps['onClarify'] = vi.fn(async () => true),
): InboxPageProps {
  return {
    contents: { items: [...items], truncated: false, total: items.length },
    error: null,
    filing: FILING,
    people: PEOPLE,
    onOpen: vi.fn(),
    onShowMore: vi.fn(),
    onClarify,
    busy: false,
    problem: null,
  };
}

const pickers = () => screen.getAllByRole('combobox', { name: /^File .* under$/ });
/** The row the focus is in, by its place among the table's rows (the header is the first). */
const focusedRow = () => document.activeElement?.closest('tr')?.getAttribute('aria-rowindex');

/** Scrolls the page the list is in, as far as the virtualiser can tell: jsdom cannot scroll. */
function scrollPageTo(top: number) {
  const scroller = document.querySelector<HTMLElement>('.panel__body');
  if (scroller === null) throw new Error('no scroller');
  Object.defineProperty(scroller, 'scrollTop', { configurable: true, writable: true, value: top });
  act(() => {
    fireEvent.scroll(scroller);
  });
}

/** A walk of a hundred key presses takes seconds on a loaded CI shard. */
const KEYBOARD_WALK_MS = 30_000;

describe('InboxRows — an Inbox of hundreds (#238)', () => {
  it('puts only a screenful of 500 rows in the page, and says the table holds them all', () => {
    render(<InboxPage {...given(notes(500))} />);

    expect(pickers().length).toBeGreaterThan(0);
    expect(pickers().length).toBeLessThan(30);
    const table = screen.getByRole('table');
    expect(table.getAttribute('aria-rowcount')).toBe('501');
    expect(pickers()[0]?.closest('tr')?.getAttribute('aria-rowindex')).toBe('2');
  });

  it(
    'reaches the last row with Tab, each placed as the focus comes to it',
    async () => {
      render(<InboxPage {...given(notes(20))} />);
      expect(pickers().length).toBeLessThan(20);

      screen.getByRole('button', { name: 'Note 0' }).focus();
      const visited = new Set([focusedRow()]);
      for (let presses = 0; presses < 200 && focusedRow() !== '21'; presses += 1) {
        await userEvent.tab();
        visited.add(focusedRow());
      }

      expect(focusedRow()).toBe('21');
      // Every row on the way, none skipped past the rows first placed.
      expect([...visited].filter((row) => row !== undefined && row !== null)).toHaveLength(20);
      expect(document.activeElement?.closest('tr')?.textContent).toContain('Note 19');
      expect(pickers().length).toBeLessThan(20);
    },
    KEYBOARD_WALK_MS,
  );

  it('keeps the focused row in the page when a read puts it far from what is shown', () => {
    const items = notes(40);
    const view = render(<InboxPage {...given(items)} />);
    const picker = screen.getByRole('combobox', { name: 'File Note 5 under' });
    picker.focus();

    // Read again with thirty more waiting above it: its row is now the 36th, below the header.
    view.rerender(<InboxPage {...given([...notes(30, 'Earlier'), ...items])} />);

    expect(document.activeElement).toBe(picker);
    expect(focusedRow()).toBe('37');
  });

  it('moves the focus to the next row once one of 500 is filed, drawing one row', async () => {
    const items = notes(500);
    const view = render(<InboxPage {...given(items)} />);
    startCountingRenders();
    fireEvent.change(screen.getByRole('combobox', { name: 'File Note 0 under' }), {
      target: { value: 'Projects/DFAI.md' },
    });
    await act(async () => {});
    view.rerender(<InboxPage {...given(items.slice(1))} />);
    const { renders } = stopCountingRenders();

    expect(document.activeElement?.textContent).toContain('Note 1');
    // The one row that comes into the page at the bottom as the filed one leaves.
    expect(renders['InboxRow']).toBe(1);
  });

  it('keeps what was picked on a row that is scrolled out of the page and back (#225)', () => {
    const items = Array.from({ length: 500 }, (_, at) => task(`Task ${at}`));
    render(<InboxPage {...given(items)} />);
    const status = () => screen.queryByRole('combobox', { name: 'Status of Task 2' });
    fireEvent.change(status()!, { target: { value: 'someday' } });
    expect((status() as HTMLSelectElement).value).toBe('someday');

    scrollPageTo(200_000);
    // Gone from the page while the list is scrolled far below it, as a virtual row is.
    expect(status()).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Status of Task 499' })).toBeDefined();

    scrollPageTo(0);
    expect((status() as HTMLSelectElement).value).toBe('someday');
    expect(
      (screen.getByRole('combobox', { name: 'Status of Task 1' }) as HTMLSelectElement).value,
    ).toBe('inbox');
  });
});
