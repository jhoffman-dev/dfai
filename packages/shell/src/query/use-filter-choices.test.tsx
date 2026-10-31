// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { noteNames, type ObjectType } from '@dfai/domain';
import { fakeIndexPort, type IndexPort } from '@dfai/application';
import { useFilterChoices } from './use-filter-choices.ts';

/* #212: the Filter control's choices for each property of a view's type. */

const TASK: ObjectType = {
  name: 'task',
  label: 'Task',
  properties: [
    {
      key: 'status',
      kind: 'select',
      label: 'Status',
      required: false,
      options: ['next-action', 'archive'],
      target: null,
      many: false,
    },
    {
      key: 'project',
      kind: 'relation',
      label: 'Project',
      required: false,
      options: [],
      target: 'project',
      many: false,
    },
  ],
};

const NAMES = noteNames(null);

const projects = (titles: readonly string[]): IndexPort =>
  fakeIndexPort({
    notesOfType: async () => titles.map((title) => ({ path: `projects/${title}.md`, title })),
  });

describe('useFilterChoices', () => {
  it('offers a select’s options at once, and a relation’s notes once wanted and the index answers', async () => {
    const { result } = renderHook(() =>
      useFilterChoices({
        type: TASK,
        index: projects(['Larkspur launch']),
        indexKey: '1',
        names: NAMES,
      }),
    );

    expect(result.current.choices['status']).toEqual([
      { value: 'next-action', label: 'Next Action' },
      { value: 'archive', label: 'Archive' },
    ]);
    expect(result.current.choices['project']).toEqual([]);

    act(() => result.current.want('project'));
    await waitFor(() =>
      expect(result.current.choices['project']).toEqual([
        { value: '[[projects/Larkspur launch]]', label: 'Larkspur launch' },
      ]),
    );
  });

  it('asks the index nothing until a property’s choices are wanted, however often it changes', async () => {
    let asked = 0;
    const index = fakeIndexPort({
      notesOfType: async () => {
        asked += 1;
        return [];
      },
    });
    const { rerender } = renderHook(
      ({ indexKey, names }) => useFilterChoices({ type: TASK, index, indexKey, names }),
      { initialProps: { indexKey: '1', names: NAMES } },
    );
    rerender({ indexKey: '2', names: noteNames([]) });
    rerender({ indexKey: '3', names: noteNames([]) });
    await Promise.resolve();
    expect(asked).toBe(0);
  });

  it('reads the notes again when the index changes, once they are wanted', async () => {
    let titles = ['Larkspur launch'];
    const index = fakeIndexPort({
      notesOfType: async () => titles.map((title) => ({ path: `projects/${title}.md`, title })),
    });
    const { result, rerender } = renderHook(
      ({ indexKey }) => useFilterChoices({ type: TASK, index, indexKey, names: NAMES }),
      { initialProps: { indexKey: '1' } },
    );
    act(() => result.current.want('project'));
    await waitFor(() => expect(result.current.choices['project']).toHaveLength(1));

    titles = ['Larkspur launch', 'Quill audit'];
    rerender({ indexKey: '2' });
    await waitFor(() => expect(result.current.choices['project']).toHaveLength(2));
  });

  it('forgets what was wanted for another type', async () => {
    let asked = 0;
    const index = fakeIndexPort({
      notesOfType: async () => {
        asked += 1;
        return [];
      },
    });
    const { result, rerender } = renderHook(
      ({ type }) => useFilterChoices({ type, index, indexKey: '1', names: NAMES }),
      { initialProps: { type: TASK } },
    );
    act(() => result.current.want('project'));
    await waitFor(() => expect(asked).toBe(1));

    rerender({ type: { ...TASK, name: 'chore' } });
    await waitFor(() => expect(result.current.choices['project']).toEqual([]));
    expect(asked).toBe(1);
  });

  it('still offers the options when the index cannot answer', async () => {
    let asked = false;
    const { result } = renderHook(() =>
      useFilterChoices({
        type: TASK,
        index: fakeIndexPort({
          notesOfType: () => {
            asked = true;
            return Promise.reject(new Error('index not ready'));
          },
        }),
        indexKey: '1',
        names: NAMES,
      }),
    );
    act(() => result.current.want('project'));
    await waitFor(() => expect(asked).toBe(true));
    expect(result.current.choices['project']).toEqual([]);
    expect(result.current.choices['status']).toHaveLength(2);
  });

  it('offers nothing without a type', () => {
    const { result } = renderHook(() =>
      useFilterChoices({ type: null, index: projects([]), indexKey: '1', names: NAMES }),
    );
    expect(result.current.choices).toEqual({});
  });
});
