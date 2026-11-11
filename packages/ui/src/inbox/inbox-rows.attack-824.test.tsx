// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createVaultPath, type InboxItem, type InboxTask } from '@dfai/domain';
import { InboxPage, type InboxContents, type InboxPageProps } from '../inbox-page.tsx';
import type { RelationChoice } from '../properties-panel.tsx';
import { pickSuggestion } from '../link-suggest/link-suggest.test-support.ts';

/**
 * Attacks on #824 (issue #823): a row is never written over a link field that
 * holds text typed and not picked, by whichever way the row is committed; a
 * field shows what Save writes; and an open list stays under its field.
 */

const CAPTURED: InboxTask = {
  status: 'inbox',
  project: null,
  waitingOn: null,
  waitingOnNames: '',
  defer: null,
  due: null,
};

const task = (title: string): InboxItem => ({
  path: createVaultPath(`Inbox/${title}.md`),
  title,
  type: 'task',
  arrivedIn: '',
  importOutcome: null,
  importError: null,
  task: CAPTURED,
});

const contentsOf = (titles: readonly string[]): InboxContents => ({
  items: titles.map(task),
  truncated: false,
  total: titles.length,
});

const FILING: readonly RelationChoice[] = [
  { path: 'Projects/Larkspur Payroll.md', title: 'Larkspur Payroll', type: 'project' },
  { path: 'Areas/Garden.md', title: 'Garden', type: 'area' },
];
const PEOPLE: readonly RelationChoice[] = [
  { path: 'People/Mara Quill.md', title: 'Mara Quill', type: 'person' },
];

function page(overrides: Partial<InboxPageProps> = {}) {
  const props: InboxPageProps = {
    contents: contentsOf(['Call the bank', 'Chase the quote', 'Fix the gate']),
    error: null,
    filing: FILING,
    people: PEOPLE,
    onOpen: vi.fn(),
    onShowMore: vi.fn(),
    onClarify: vi.fn(async () => true),
    onUndo: vi.fn(async () => null),
    busy: false,
    problem: null,
    ...overrides,
  };
  const view = render(<InboxPage {...props} />);
  return {
    ...props,
    rerender: (next: Partial<InboxPageProps>) => view.rerender(<InboxPage {...props} {...next} />),
  };
}

const rowOf = (title: string) =>
  screen.getByRole('button', { name: title }).closest('tr') as HTMLElement;
const focusRow = (title: string) => act(() => rowOf(title).focus());
const control = (name: string) => screen.getByRole('combobox', { name }) as HTMLInputElement;
const save = (title: string) => within(rowOf(title)).getByRole('button', { name: 'Save' });
const clarified = (onClarify: InboxPageProps['onClarify']) =>
  (onClarify as ReturnType<typeof vi.fn>).mock.calls.map(([args]) => args);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('#824 attack — a row key commits past a link typed and not picked', () => {
  it('N on the row does not write it while a project is typed and not picked', async () => {
    const { onClarify } = page();
    await userEvent.type(control('File Call the bank under'), 'Lark');
    focusRow('Call the bank');
    expect(control('File Call the bank under').value).toBe('Lark');
    await userEvent.keyboard('n');
    expect(clarified(onClarify)).toEqual([]);
  });

  it('W on the row does not write Waiting while who it waits on is typed and not picked', async () => {
    const { onClarify } = page();
    await userEvent.selectOptions(control('Status of Call the bank'), 'Waiting');
    await userEvent.type(control('Who Call the bank waits on'), 'Mar');
    focusRow('Call the bank');
    expect(control('Who Call the bank waits on').value).toBe('Mar');
    await userEvent.keyboard('w');
    expect(clarified(onClarify)).toEqual([]);
  });

  it('↵ in the picker P opened does not write the held status while its project is typed and not picked', async () => {
    const { onClarify } = page();
    await userEvent.selectOptions(control('Status of Call the bank'), 'Next Action');
    focusRow('Call the bank');
    await userEvent.keyboard('p');
    expect(document.activeElement).toBe(control('File Call the bank under'));
    await userEvent.keyboard('Zephyr{Enter}');
    expect(clarified(onClarify)).toEqual([]);
  });

  it('↵ in the picker P opened says why nothing was written when its project is typed and not picked', async () => {
    page();
    focusRow('Call the bank');
    await userEvent.keyboard('p');
    await userEvent.keyboard('Zephyr{Enter}');
    expect(within(rowOf('Call the bank')).queryByRole('alert')?.textContent ?? '').toContain(
      '“Zephyr”',
    );
  });
});

describe('#824 attack — a link field shows what Save writes', () => {
  it('a project picked, then cleared from its field, is not written by Save behind an empty field', async () => {
    // Read as the row is written: once it is, the row holds no pick, and the field is the task's again.
    let shownAtSave: string | null = null;
    const { onClarify } = page({
      onClarify: vi.fn(async () => {
        shownAtSave = control('File Call the bank under').value;
        return true;
      }),
    });
    const under = control('File Call the bank under');
    await pickSuggestion(under, 'Garden');
    await userEvent.clear(under);
    await userEvent.click(save('Call the bank'));
    const written = clarified(onClarify)[0]?.clarification.project;
    expect(written).toBe('Areas/Garden.md');
    expect(shownAtSave).toBe('Garden');
  });

  it('a person picked, then typed over with spaces alone, is not written by Save behind a blank field', async () => {
    let shownAtSave: string | null = null;
    const { onClarify } = page({
      onClarify: vi.fn(async () => {
        shownAtSave = control('Who Call the bank waits on').value;
        return true;
      }),
    });
    await userEvent.selectOptions(control('Status of Call the bank'), 'Waiting');
    const who = control('Who Call the bank waits on');
    await pickSuggestion(who, 'Mara Quill');
    await userEvent.clear(who);
    await userEvent.type(who, '  ');
    await userEvent.click(save('Call the bank'));
    const written = clarified(onClarify)[0]?.clarification.waitingOn;
    expect(written).toBe('People/Mara Quill.md');
    expect(shownAtSave).toBe('Mara Quill');
  });
});

describe('#824 attack — probes found sound', () => {
  it('Tab on a title typed in full picks it, and Save writes it', async () => {
    const { onClarify } = page();
    await userEvent.type(control('File Call the bank under'), 'Garden');
    await userEvent.tab();
    await userEvent.click(save('Call the bank'));
    expect(clarified(onClarify)).toEqual([
      { path: 'Inbox/Call the bank.md', clarification: { project: 'Areas/Garden.md' } },
    ]);
  });

  it('Save over a title typed in full and not picked is refused, not written without it', async () => {
    const { onClarify } = page();
    await userEvent.selectOptions(control('Status of Call the bank'), 'Next Action');
    await userEvent.type(control('File Call the bank under'), 'Garden');
    await userEvent.click(save('Call the bank'));
    expect(clarified(onClarify)).toEqual([]);
    expect(within(rowOf('Call the bank')).getByRole('alert').textContent).toContain('“Garden”');
  });

  it('with two fields typed, picking one still leaves Save refused over the other', async () => {
    const { onClarify } = page();
    await userEvent.selectOptions(control('Status of Call the bank'), 'Waiting');
    await userEvent.type(control('Who Call the bank waits on'), 'Mar');
    await userEvent.type(control('File Call the bank under'), 'Zeph');
    await userEvent.click(save('Call the bank'));
    expect(within(rowOf('Call the bank')).getByRole('alert').textContent).toContain('“Mar”');
    await pickSuggestion(control('Who Call the bank waits on'), 'Mara Quill');
    await userEvent.click(save('Call the bank'));
    expect(clarified(onClarify)).toEqual([]);
    expect(within(rowOf('Call the bank')).getByRole('alert').textContent).toContain('“Zeph”');
  });

  it('a re-read that reorders the rows keeps what is typed, and Save is still refused', async () => {
    const view = page();
    await userEvent.selectOptions(control('Status of Chase the quote'), 'Next Action');
    await userEvent.type(control('File Chase the quote under'), 'Zeph');
    view.rerender({ contents: contentsOf(['Fix the gate', 'Chase the quote', 'Call the bank']) });
    expect(control('File Chase the quote under').value).toBe('Zeph');
    await userEvent.click(save('Chase the quote'));
    expect(clarified(view.onClarify)).toEqual([]);
  });

  it('Enter in the date field is refused while a project is typed and not picked', async () => {
    const { onClarify } = page();
    await userEvent.selectOptions(control('Status of Call the bank'), 'Next Action');
    await userEvent.type(control('File Call the bank under'), 'Zeph');
    const dates = rowOf('Call the bank').querySelectorAll<HTMLInputElement>('input[type="date"]');
    expect(dates.length).toBeGreaterThan(0);
    await userEvent.type(dates[0] as HTMLInputElement, '{Enter}');
    expect(clarified(onClarify)).toEqual([]);
  });

  it('a row that leaves on a re-read and comes back holds no stale refusal', async () => {
    const view = page();
    await userEvent.selectOptions(control('Status of Call the bank'), 'Next Action');
    await userEvent.type(control('File Call the bank under'), 'Zeph');
    await userEvent.click(save('Call the bank'));
    view.rerender({ contents: contentsOf(['Chase the quote', 'Fix the gate']) });
    view.rerender({ contents: contentsOf(['Call the bank', 'Chase the quote', 'Fix the gate']) });
    expect(within(rowOf('Call the bank')).queryByRole('alert')).toBeNull();
    expect(control('File Call the bank under').value).toBe('');
  });
});

describe('#824 attack — the list stays under its field', () => {
  it('follows its field when a re-read reorders the rows and nothing changes size', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    // Rows that swap places resize nothing that holds them: the observer has nothing to say.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    let fieldTop = 100;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.getAttribute('aria-label') === 'File Chase the quote under') {
        return DOMRect.fromRect({ x: 100, y: fieldTop, width: 120, height: 24 });
      }
      if (this.getAttribute('role') === 'listbox') {
        const left = Number.parseFloat(this.style.left || '0');
        const top = Number.parseFloat(this.style.top || '0');
        return DOMRect.fromRect({ x: left, y: top, width: 260, height: 120 });
      }
      return DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 });
    });
    const view = page();
    await userEvent.type(control('File Chase the quote under'), 'gar');
    const list = screen.getByRole('listbox', { name: 'Suggested notes' });
    expect(Number.parseFloat(list.style.top)).toBe(128);

    // The row moves down one place: its field is 40px lower, and no holder is a pixel taller.
    fieldTop = 140;
    view.rerender({ contents: contentsOf(['Call the bank', 'Fix the gate', 'Chase the quote']) });

    expect(Number.parseFloat(screen.getByRole('listbox').style.top)).toBe(168);
  });
});
