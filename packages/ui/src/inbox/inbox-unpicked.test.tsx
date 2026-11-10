// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createVaultPath, type InboxItem, type InboxTask } from '@dfai/domain';
import { InboxPage, type InboxContents, type InboxPageProps } from '../inbox-page.tsx';
import type { RelationChoice } from '../properties-panel.tsx';
import { pickSuggestion } from '../link-suggest/link-suggest.test-support.ts';

/**
 * A link typed and not picked (#823), by every way a row is written: the one
 * guard refuses each, says why in the row's one refusal, and drops nothing.
 */

const CAPTURED: InboxTask = {
  status: 'inbox',
  project: null,
  waitingOn: null,
  waitingOnNames: '',
  defer: null,
  due: null,
};

const TASK = createVaultPath('Inbox/Call the bank.md');
const task = (title: string): InboxItem => ({
  path: createVaultPath(`Inbox/${title}.md`),
  title,
  type: 'task',
  arrivedIn: '',
  importOutcome: null,
  importError: null,
  task: CAPTURED,
});
const contents: InboxContents = {
  items: ['Call the bank', 'Chase the quote'].map(task),
  truncated: false,
  total: 2,
};

const FILING: readonly RelationChoice[] = [
  { path: 'Projects/Larkspur Payroll.md', title: 'Larkspur Payroll', type: 'project' },
  { path: 'Areas/Garden.md', title: 'Garden', type: 'area' },
];
const PEOPLE: readonly RelationChoice[] = [
  { path: 'People/Mara Quill.md', title: 'Mara Quill', type: 'person' },
];

function page(overrides: Partial<InboxPageProps> = {}) {
  const props: InboxPageProps = {
    contents,
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
  render(<InboxPage {...props} />);
  return props;
}

const row = () =>
  screen.getByRole('button', { name: 'Call the bank' }).closest('tr') as HTMLElement;
const focusRow = () => act(() => row().focus());
const control = (name: string) => screen.getByRole('combobox', { name }) as HTMLInputElement;
const status = () => control('Status of Call the bank');
const who = () => control('Who Call the bank waits on');
const under = () => control('File Call the bank under');
const save = () => within(row()).getByRole('button', { name: 'Save' });
const refusal = () => within(row()).queryByRole('alert')?.textContent ?? null;
const clarified = (onClarify: InboxPageProps['onClarify']) =>
  (onClarify as ReturnType<typeof vi.fn>).mock.calls.map(([args]) => args);

afterEach(cleanup);

describe('a link typed and not picked — every way a row is written', () => {
  it('holds a project picked from the picker P opened while who it waits on is typed, and Save then writes both', async () => {
    const { onClarify } = page();
    await userEvent.selectOptions(status(), 'Waiting');
    await userEvent.type(who(), 'Mar');
    focusRow();
    await userEvent.keyboard('p');
    await userEvent.keyboard('gar{Enter}');

    expect(clarified(onClarify)).toEqual([]);
    expect(refusal()).toBe('“Mar” is typed but not picked. Pick it from the list, or clear it.');
    expect(under().value).toBe('Garden');

    await pickSuggestion(who(), 'Mara Quill');
    await userEvent.click(save());
    expect(clarified(onClarify)).toEqual([
      {
        path: TASK,
        clarification: {
          status: 'waiting',
          project: 'Areas/Garden.md',
          waitingOn: 'People/Mara Quill.md',
        },
      },
    ]);
  });

  it('says why ↵ wrote nothing in a field nobody armed, with nothing else picked on the row', async () => {
    const { onClarify } = page();
    await userEvent.type(under(), 'Zephyr{Enter}');
    expect(clarified(onClarify)).toEqual([]);
    expect(refusal()).toContain('“Zephyr”');
  });
});

describe('a link typed and not picked — the row’s one refusal', () => {
  it('says it in the one place the row says the app’s own refusal', async () => {
    page({ refusals: [{ path: TASK, reason: 'The note changed on disk.' }] });
    expect(within(row()).getAllByRole('alert')).toHaveLength(1);
    await userEvent.selectOptions(status(), 'Next Action');
    await userEvent.type(under(), 'Zeph');
    await userEvent.click(save());

    const said = within(row()).getAllByRole('alert');
    expect(said).toHaveLength(1);
    expect(said[0]?.textContent).toContain('“Zeph”');
  });

  it('keeps the refusal over one field while the other is typed in', async () => {
    page();
    await userEvent.selectOptions(status(), 'Waiting');
    await userEvent.type(who(), 'Mar');
    await userEvent.type(under(), 'Zeph');
    await userEvent.click(save());
    expect(refusal()).toContain('“Mar”');

    await userEvent.type(under(), 'yr');
    expect(under().value).toBe('Zephyr');
    expect(refusal()).toContain('“Mar”');
  });

  it('takes the refusal away once the field it is over is typed in again', async () => {
    page();
    await userEvent.selectOptions(status(), 'Waiting');
    await userEvent.type(who(), 'Mar');
    await userEvent.click(save());
    expect(refusal()).toContain('“Mar”');

    await userEvent.type(who(), 'a');
    expect(refusal()).toBeNull();
  });
});

describe('a link typed and not picked — a field taken away', () => {
  it('forgets a person typed once Who goes with the status: Who comes back empty, and Save writes', async () => {
    const { onClarify } = page();
    await userEvent.selectOptions(status(), 'Waiting');
    await userEvent.type(who(), 'Mar');
    await userEvent.selectOptions(status(), 'Someday');
    await userEvent.selectOptions(status(), 'Waiting');
    expect(who().value).toBe('');

    await userEvent.click(save());
    expect(clarified(onClarify)).toEqual([{ path: TASK, clarification: { status: 'waiting' } }]);
  });
});
