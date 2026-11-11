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
const task = (title: string, held: InboxTask = CAPTURED): InboxItem => ({
  path: createVaultPath(`Inbox/${title}.md`),
  title,
  type: 'task',
  arrivedIn: '',
  importOutcome: null,
  importError: null,
  task: held,
});
const contentsOf = (items: readonly InboxItem[]): InboxContents => ({
  items,
  truncated: false,
  total: items.length,
});
const OTHER = task('Chase the quote');
const contents = contentsOf([task('Call the bank'), OTHER]);
/** The list as a re-read finds it, the first task saying `status` on disk. */
const reread = (status: InboxTask['status']): InboxContents =>
  contentsOf([task('Call the bank', { ...CAPTURED, status }), OTHER]);

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
  const view = render(<InboxPage {...props} />);
  return {
    ...props,
    rerender: (next: Partial<InboxPageProps>) => view.rerender(<InboxPage {...props} {...next} />),
  };
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

  it('says nothing of the other field when ↵ picks from the list of one nobody armed', async () => {
    const { onClarify } = page();
    await userEvent.selectOptions(status(), 'Waiting');
    await userEvent.type(who(), 'Mar');
    await userEvent.type(under(), 'Gar{Enter}');

    expect(under().value).toBe('Garden');
    expect(refusal()).toBeNull();
    expect(clarified(onClarify)).toEqual([]);
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

describe('a link typed and not picked — a field a re-read takes away', () => {
  it('refuses nothing over a person typed once a re-read finds the task no longer Waiting: Save writes', async () => {
    const view = page({ contents: reread('waiting') });
    await userEvent.type(who(), 'Mar');
    await pickSuggestion(under(), 'Garden');
    view.rerender({ contents: reread('next-action') });
    expect(screen.queryByRole('combobox', { name: 'Who Call the bank waits on' })).toBeNull();

    await userEvent.click(save());
    expect(refusal()).toBeNull();
    expect(clarified(view.onClarify)).toEqual([
      { path: TASK, clarification: { project: 'Areas/Garden.md' } },
    ]);
  });

  it('lets a status key write the row a re-read took Who from', async () => {
    const view = page({ contents: reread('waiting') });
    await userEvent.type(who(), 'Mar');
    view.rerender({ contents: reread('next-action') });
    focusRow();
    await userEvent.keyboard('s');

    expect(refusal()).toBeNull();
    expect(clarified(view.onClarify)).toEqual([
      { path: TASK, clarification: { status: 'someday' } },
    ]);
  });

  it('takes the refusal over a person typed away with Who, and brings Who back empty', async () => {
    const view = page({ contents: reread('waiting') });
    await userEvent.type(who(), 'Mar');
    await pickSuggestion(under(), 'Garden');
    await userEvent.click(save());
    expect(refusal()).toContain('“Mar”');

    view.rerender({ contents: reread('next-action') });
    expect(refusal()).toBeNull();
    view.rerender({ contents: reread('waiting') });
    expect(who().value).toBe('');
    expect(refusal()).toBeNull();
  });
});

describe('a link typed and not picked — a row that is gone', () => {
  it('forgets what a row held typed when a re-read takes it off the list: back, its field is empty and Save writes', async () => {
    const view = page();
    await userEvent.type(under(), 'Zeph');
    view.rerender({ contents: contentsOf([OTHER]) });
    view.rerender({ contents });
    expect(under().value).toBe('');

    await userEvent.selectOptions(status(), 'Next Action');
    await userEvent.click(save());
    expect(refusal()).toBeNull();
    expect(clarified(view.onClarify)).toEqual([
      { path: TASK, clarification: { status: 'next-action' } },
    ]);
  });

  it('forgets what a row held typed when its write is refused with the row taken away meanwhile', async () => {
    let refuse = (): void => undefined;
    const onClarify = vi
      .fn<InboxPageProps['onClarify']>(async () => true)
      .mockImplementationOnce(() => new Promise((answer) => (refuse = () => answer(false))));
    const view = page({ onClarify });
    await userEvent.selectOptions(status(), 'Next Action');
    await userEvent.click(save());
    await userEvent.type(under(), 'Zeph');
    // The app takes the row off as it writes; refused, it would bring it back, but sync took it meanwhile.
    view.rerender({ contents: contentsOf([OTHER]) });
    await act(async () => refuse());
    view.rerender({ contents });
    expect(under().value).toBe('');
    expect(status().value).toBe('inbox');

    await userEvent.selectOptions(status(), 'Someday');
    await userEvent.click(save());
    expect(refusal()).toBeNull();
    expect(clarified(onClarify)).toEqual([
      { path: TASK, clarification: { status: 'next-action' } },
      { path: TASK, clarification: { status: 'someday' } },
    ]);
  });

  it('forgets what a row held typed once it is written: brought back, its field is empty and Save writes', async () => {
    let finish = (): void => undefined;
    const onClarify = vi
      .fn<InboxPageProps['onClarify']>(async () => true)
      .mockImplementationOnce(() => new Promise((answer) => (finish = () => answer(true))));
    const view = page({ onClarify });
    await userEvent.selectOptions(status(), 'Next Action');
    await userEvent.click(save());
    await userEvent.type(under(), 'Zeph');
    view.rerender({ contents: contentsOf([OTHER]) });
    await act(async () => finish());
    // An undo, say, brings the written row back.
    view.rerender({ contents });
    expect(under().value).toBe('');

    await userEvent.selectOptions(status(), 'Someday');
    await userEvent.click(save());
    expect(refusal()).toBeNull();
    expect(clarified(onClarify)).toHaveLength(2);
  });
});
