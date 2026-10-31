// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useChosenPeople, type ChosenPeopleMerge } from './use-chosen-people.ts';

function fakeMerge() {
  return { mergeMany: vi.fn(), noteChosen: vi.fn() } satisfies ChosenPeopleMerge;
}

const ROWS = ['Mara.md', 'Inbox/Marra Quill.md', 'Tobias Fenn.md'];

describe('people chosen in the Person table', () => {
  it('offers Merge into… for the rows chosen, says them to ⌘K as its tab’s, and lets go on leaving', () => {
    const merge = fakeMerge();
    const { result, unmount } = renderHook(() =>
      useChosenPeople({ tab: 'tab-1', resetKey: 'person', merge, present: ROWS }),
    );
    expect(result.current?.actions).toEqual([]);
    act(() => result.current?.selection.onToggle('Mara.md'));
    expect(result.current?.actions.map((action) => action.label)).toEqual(['Merge into…']);
    act(() => result.current?.selection.onToggle('Inbox/Marra Quill.md'));
    expect(result.current?.actions.map((action) => action.label)).toEqual(['Merge 2 people into…']);
    expect(merge.noteChosen).toHaveBeenLastCalledWith('tab-1', {
      paths: ['Mara.md', 'Inbox/Marra Quill.md'],
      settled: expect.any(Function),
    });
    act(() => result.current?.actions[0]?.onRun());
    expect(merge.mergeMany).toHaveBeenCalledWith(
      ['Mara.md', 'Inbox/Marra Quill.md'],
      expect.any(Function),
    );
    unmount();
    expect(merge.noteChosen).toHaveBeenLastCalledWith('tab-1', null);
  });

  it('lets go of the rows a merge answered, and chooses again one still in the vault', () => {
    const merge = fakeMerge();
    const { result } = renderHook(() =>
      useChosenPeople({ tab: 'tab-1', resetKey: 'person', merge, present: ROWS }),
    );
    act(() => result.current?.selection.onToggle('Mara.md'));
    act(() => result.current?.selection.onToggle('Tobias Fenn.md'));
    act(() => result.current?.actions[0]?.onRun());
    const settled = merge.mergeMany.mock.calls[0]![1] as (answer: unknown) => void;
    act(() => settled({ answered: ['Mara.md'], failed: ['Tobias Fenn.md'] }));
    expect([...result.current!.selection.selected]).toEqual(['Tobias Fenn.md']);
  });

  it('lets go of a chosen row once the table no longer shows it', () => {
    const merge = fakeMerge();
    const { result, rerender } = renderHook(
      ({ present }: { present: readonly string[] }) =>
        useChosenPeople({ tab: 'tab-1', resetKey: 'person', merge, present }),
      { initialProps: { present: ROWS } },
    );
    act(() => result.current?.selection.onToggle('Mara.md'));
    act(() => result.current?.selection.onToggle('Tobias Fenn.md'));
    rerender({ present: ['Tobias Fenn.md'] });
    expect([...result.current!.selection.selected]).toEqual(['Tobias Fenn.md']);
  });

  it('is nothing for a table that is not of people', () => {
    const { result } = renderHook(() =>
      useChosenPeople({ tab: 'tab-1', resetKey: 'task', merge: null, present: ROWS }),
    );
    expect(result.current).toBeNull();
  });
});
