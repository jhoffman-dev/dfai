// @vitest-environment jsdom
/**
 * Attack on PR #612 (#225): the virtual Inbox with 2,000 rows — what a row
 * holds while it is scrolled out of the page and back, a row written while
 * out of view, and a row sync takes away while it holds a pick. Fictional
 * data only.
 *
 * jsdom lays nothing out: `vitest.setup.ts` measures every element 800px
 * tall in an 800px window, so the list places a screenful and its overscan.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createVaultPath, type InboxItem } from '@dfai/domain';
import { InboxPage, type InboxPageProps } from '../inbox-page.tsx';

const task = (title: string): InboxItem => ({
  path: createVaultPath(`Inbox/${title}.md`),
  title,
  type: 'task',
  arrivedIn: '',
  importOutcome: null,
  importError: null,
  task: {
    status: 'inbox',
    project: null,
    waitingOn: null,
    waitingOnNames: '',
    defer: null,
    due: null,
  },
});
const tasks = (count: number) => Array.from({ length: count }, (_, at) => task(`Task ${at}`));
const FILING = [{ path: 'Projects/Larkspur.md', title: 'Larkspur' }];
const PEOPLE = [{ path: 'People/Wren Ashby.md', title: 'Wren Ashby' }];

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

function scrollPageTo(top: number) {
  const scroller = document.querySelector<HTMLElement>('.panel__body');
  if (scroller === null) throw new Error('no scroller');
  Object.defineProperty(scroller, 'scrollTop', { configurable: true, writable: true, value: top });
  act(() => {
    fireEvent.scroll(scroller);
  });
}

const BOTTOM = 10_000_000;
const status = (title: string) =>
  screen.queryByRole<HTMLSelectElement>('combobox', { name: `Status of ${title}` });

describe('InboxRows — 2,000 rows (#225, PR #612)', () => {
  it('keeps the last row’s pick when it is scrolled out of the page and back', () => {
    render(<InboxPage {...given(tasks(2_000))} />);
    scrollPageTo(BOTTOM);
    fireEvent.change(status('Task 1999')!, { target: { value: 'someday' } });

    scrollPageTo(0);
    expect(status('Task 0')).not.toBeNull();

    scrollPageTo(BOTTOM);
    expect(status('Task 1999')?.value).toBe('someday');
    expect(status('Task 1998')?.value).toBe('inbox');
  });

  it('keeps a pick whose write was refused while its row was out of the page', async () => {
    let refuse: (written: boolean) => void = () => {};
    const onClarify = vi.fn(
      () =>
        new Promise<boolean>((settle) => {
          refuse = settle;
        }),
    );
    render(<InboxPage {...given(tasks(2_000), onClarify)} />);
    fireEvent.change(status('Task 3')!, { target: { value: 'someday' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Clarify Task 3' }));
    expect(onClarify).toHaveBeenCalledTimes(1);

    scrollPageTo(BOTTOM);
    expect(status('Task 3')).toBeNull();
    await act(async () => refuse(false));
    scrollPageTo(0);

    expect(status('Task 3')?.value).toBe('someday');
  });

  it('keeps the pick of a row taken off the list while written, once its write is refused', async () => {
    let refuse: (written: boolean) => void = () => {};
    const onClarify = vi.fn(
      () =>
        new Promise<boolean>((settle) => {
          refuse = settle;
        }),
    );
    const items = tasks(2_000);
    const view = render(<InboxPage {...given(items, onClarify)} />);
    fireEvent.change(status('Task 2')!, { target: { value: 'someday' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Clarify Task 2' }));
    // The app takes the row off the list while it is written…
    view.rerender(
      <InboxPage
        {...given(
          items.filter((item) => item.title !== 'Task 2'),
          onClarify,
        )}
      />,
    );
    // …and brings it back when the write is refused.
    view.rerender(<InboxPage {...given(items, onClarify)} />);
    await act(async () => refuse(false));

    expect(status('Task 2')?.value).toBe('someday');
  });

  it('gives a new note at a path sync emptied nothing the old one picked', () => {
    const items = tasks(2_000);
    const view = render(<InboxPage {...given(items)} />);
    fireEvent.change(status('Task 2')!, { target: { value: 'someday' } });

    // Sync takes the note away while its row holds the pick…
    const without = items.filter((item) => item.title !== 'Task 2');
    view.rerender(<InboxPage {...given(without)} />);
    expect(status('Task 2')).toBeNull();
    // …and a capture lands later at the same path: a note of its own, never picked.
    view.rerender(<InboxPage {...given([...without, task('Task 2')])} />);
    scrollPageTo(BOTTOM);

    expect(status('Task 2')?.value).toBe('inbox');
  });
});
